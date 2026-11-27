import type { ModalRerunBinding, Stage } from "@stateaction/contracts";
import {
  ObjectHashError,
  objectVerificationMs,
} from "../acceptance/storage.js";
import { TransportError } from "../transport/errors.js";
import type { StageRerunPlan } from "./stage-reruns.js";
import { boundedRun, type JobsDeps } from "./service.js";

export type RerunPreparation =
  | { state: "regular" }
  | { state: "copying" }
  | { state: "failed" }
  | {
      state: "ready";
      execute: Stage[];
      functions: Partial<
        Record<"segment" | "caption" | "handPose", ModalRerunBinding>
      >;
    };

export async function prepareStageRerun(
  deps: JobsDeps,
  jobId: string,
  owner: string,
): Promise<RerunPreparation> {
  const planResult = await deps.pool.query<{
    derived_from_job_id: string | null;
    plan: StageRerunPlan | null;
    state: string;
    submission_intent_at: Date | null;
    execution_deadline: Date | null;
    owns_lease: boolean;
  }>(
    `SELECT j.derived_from_job_id, p.plan, j.state, j.submission_intent_at, j.execution_deadline,
            coalesce(j.controller_lease_owner = $2 AND j.controller_lease_expires_at > now(), false) AS owns_lease
     FROM jobs j LEFT JOIN job_rerun_plans p ON p.job_id = j.id WHERE j.id = $1`,
    [jobId, owner],
  );
  const job = planResult.rows[0];
  if (!job) throw new TransportError("not_found", "Run not found");
  if (!job.derived_from_job_id) return { state: "regular" };
  if (!job.owns_lease || !job.plan)
    throw new TransportError("forbidden", "Rerun preparation unavailable");
  const graph = (job.plan as { schemaVersion?: number }).schemaVersion === 3;
  const ready = (): RerunPreparation => ({
    state: "ready",
    execute: job.plan!.execute,
    functions: Object.fromEntries(
      Object.entries(job.plan!.bindings).map(([stage, binding]) => [
        stage === "hand_pose" ? "handPose" : stage,
        binding,
      ]),
    ),
  });
  if (job.submission_intent_at) return ready();
  if (job.state === "failed") return { state: "failed" };
  if (!deps.acceptance || !deps.rerunCopy || !job.execution_deadline) {
    throw new TransportError(
      "provider_unavailable",
      "Rerun copy service unavailable",
    );
  }
  await boundedRun(deps.pool, (tx) =>
    tx.query(
      graph
        ? "SELECT job_graph_reserve_copies($1, $2)"
        : "SELECT job_rerun_reserve_copies($1, $2)",
      [jobId, owner],
    ),
  );
  const {
    rows: [copy],
  } = await deps.pool.query<{
    file_id: string;
    source_key: string;
    target_key: string;
    size_bytes: string;
    sha256: string;
    copy_revision: number;
    source_checked: boolean;
    provider_upload_id: string | null;
    provider_part_tags: string[];
    target_ready: boolean;
  }>(
    `SELECT c.file_id, src.object_key AS source_key, dst.object_key AS target_key,
            c.size_bytes::text, c.sha256, c.copy_revision, c.source_checked,
            c.provider_upload_id, c.provider_part_tags, c.target_ready
     FROM job_rerun_copies c JOIN files src ON src.id = c.source_file_id
     JOIN files dst ON dst.id = c.file_id
     WHERE c.job_id = $1 AND dst.state = 'reserved'
     ORDER BY c.slot LIMIT 1`,
    [jobId],
  );
  if (!copy) {
    if (graph)
      await boundedRun(deps.pool, (tx) =>
        tx.query("SELECT job_graph_finish_copies($1, $2)", [jobId, owner]),
      );
    return ready();
  }
  const size = Number(copy.size_bytes);
  const deadline = job.execution_deadline;
  const { hasher } = deps.acceptance;
  const progress = {
    uploadId: copy.provider_upload_id,
    partTags: copy.provider_part_tags,
    targetReady: copy.target_ready,
  };
  const update = (sourceChecked: boolean, next: typeof progress) =>
    boundedRun(
      deps.pool,
      async (tx) =>
        (
          await tx.query<{ updated: boolean }>(
            "SELECT job_rerun_copy_progress($1, $2, $3, $4, $5, $6, $7, $8) AS updated",
            [
              jobId,
              owner,
              copy.file_id,
              copy.copy_revision,
              sourceChecked,
              next.uploadId,
              next.partTags,
              next.targetReady,
            ],
          )
        ).rows[0]?.updated === true,
    );
  const requireLease = async () => {
    const {
      rows: [row],
    } = await deps.pool.query<{ ok: boolean }>(
      "SELECT job_rerun_preparation_ok($1, $2) AS ok",
      [jobId, owner],
    );
    if (!row?.ok)
      throw new TransportError("forbidden", "Rerun preparation lease changed");
  };
  const reject = async (
    reason: "reuse_unavailable" | "copy_digest_mismatch",
  ) => {
    await boundedRun(deps.pool, async (tx) => {
      await tx.query("SELECT 1 FROM jobs WHERE id = $1 FOR UPDATE", [jobId]);
      const {
        rows: [current],
      } = await tx.query<{ ok: boolean }>(
        "SELECT job_rerun_preparation_ok($1, $2) AS ok",
        [jobId, owner],
      );
      if (!current?.ok)
        throw new TransportError(
          "forbidden",
          "Rerun preparation lease changed",
        );
      await tx.query(
        `INSERT INTO job_execution_evidence (job_id, kind, recorded_by, detail)
         VALUES ($1, 'pre_submission_rejected', $2, jsonb_build_object('reason', $3::text))`,
        [jobId, owner, reason],
      );
      await tx.query(
        "UPDATE jobs SET state = 'failed', error_code = $2, finished_at = now() WHERE id = $1",
        [jobId, reason],
      );
    });
    return { state: "failed" } as const;
  };
  const matches = async (key: string) => {
    try {
      return (
        (await hasher.hash(key, size, objectVerificationMs(size, deadline)))
          .sha256 === copy.sha256
      );
    } catch (error) {
      if (
        error instanceof ObjectHashError &&
        error.code !== "object_read_failed"
      )
        return false;
      throw new TransportError(
        "provider_unavailable",
        "Copy verification unavailable",
        { cause: error },
      );
    }
  };

  await requireLease();
  if (!copy.source_checked) {
    if (!(await matches(copy.source_key))) return reject("reuse_unavailable");
    await update(true, progress);
    return { state: "copying" };
  }
  if (!copy.target_ready) {
    const storage = deps.rerunCopy;
    let next;
    try {
      next = await storage.advance(
        { source: copy.source_key, target: copy.target_key, size },
        progress,
      );
    } catch (error) {
      throw new TransportError(
        "provider_unavailable",
        "Reuse copy unavailable",
        { cause: error },
      );
    }
    const recorded = await update(true, next);
    if (!recorded && next.uploadId && next.uploadId !== progress.uploadId)
      await storage
        .abort(copy.target_key, next.uploadId)
        .catch(() => undefined);
    return { state: "copying" };
  }
  if (!(await matches(copy.target_key))) return reject("copy_digest_mismatch");

  await boundedRun(deps.pool, async (tx) => {
    const {
      rows: [row],
    } = await tx.query<{ ok: boolean }>(
      "SELECT job_rerun_complete_copy($1, $2, $3) AS ok",
      [jobId, owner, copy.file_id],
    );
    if (!row?.ok)
      throw new TransportError("conflict", "Copy could not be recorded");
  });
  return { state: "copying" };
}
