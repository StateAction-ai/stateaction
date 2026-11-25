import {
  requestSha256,
  type RecipeV1,
  type Stage,
} from "@stateaction/contracts";
import { randomUUID } from "node:crypto";
import { stageHasFailedOutputs } from "../pipeline/model.js";
import {
  CLIP_STATUS_LATERAL,
  clipCanRetrySql,
} from "../pipeline/operations-status.js";
import { TransportError } from "../transport/errors.js";
import { SOURCE_REUPLOAD_ERROR_CODES } from "./recovery.js";
import { boundedRun } from "./service.js";
import { dollars } from "./stage-rerun-bindings.js";
import {
  loadRerunParent,
  resolveRerunWork,
  type RerunParent,
  type RerunRead,
  type StageRerunDeps,
  type StageRerunWork,
} from "./stage-reruns.js";

export type StageRerunRequestV2 =
  | {
      schemaVersion: 2;
      scope: "clip";
      clipId: string;
      parentJobId: string;
      stages: Stage[];
    }
  | { schemaVersion: 2; scope: "failed_clips" };

export type StageRerunCommandV2 = StageRerunRequestV2 & {
  requestId: string;
  expectedPlanSha256: string;
  expectedMaxComputeCostUsd: string;
  expectedMaxGpuCostUsd: string;
  reason: string;
};

type RetryTarget = {
  clipId: string;
  parentJobId: string;
  ordinal: number;
  startTsNs: string | null;
  endTsNs: string | null;
  reportedStage: Stage | null;
};

type ClipPlan = StageRerunWork & {
  schemaVersion: 2;
  recordingId: string;
  clipId: string;
  parentJobId: string;
  sourceManifestSha256: string;
  selectionSeq: number;
  clipSelectionSeq: number;
};

type RetryJob = { clipId: string; parentJobId: string; jobId: string };

const maxBatchClips = 1000;
const refused = (code: string) => new TransportError("conflict", code);
const cents = (value: string) => BigInt(value.replace(".", ""));

export function retryExecutionStages(
  recipe: RecipeV1,
  stages: Stage[],
): Stage[] {
  const selected = new Set(stages);
  if (
    !selected.size ||
    selected.size !== stages.length ||
    stages.some(
      (stage) =>
        !recipe.stages.some((entry) => entry.enabled && entry.stage === stage),
    )
  ) {
    throw refused("stage_disabled");
  }
  if (
    selected.has("segment") &&
    recipe.stages.some((entry) => entry.enabled && entry.stage === "caption")
  ) {
    selected.add("caption");
  }
  return recipe.stages
    .filter((entry) => selected.has(entry.stage))
    .map((entry) => entry.stage);
}

async function loadTargets(
  db: RerunRead,
  actorId: string,
  recordingId: string,
  input: StageRerunRequestV2,
): Promise<RetryTarget[]> {
  const recording = await db.query(
    "SELECT 1 FROM recordings WHERE id = $1 AND deleted_at IS NULL AND catalog_has_role($2, 'staff')",
    [recordingId, actorId],
  );
  if (!recording.rowCount)
    throw new TransportError("not_found", "Recording not found");

  const { rows } = await db.query<RetryTarget>(
    `SELECT c.id AS "clipId", live.id AS "parentJobId", c.ordinal,
            c.start_ts_ns::text AS "startTsNs", c.end_ts_ns::text AS "endTsNs",
            clip_status.failure_stage AS "reportedStage"
     FROM review_clips c JOIN jobs live ON live.id = c.live_job_id
     LEFT JOIN jobs chosen ON chosen.id = c.selected_job_id
     ${CLIP_STATUS_LATERAL}
     WHERE c.recording_id = $1
       AND c.plan_version = (SELECT max(version) FROM clip_plans WHERE recording_id = $1)
       AND (
         c.id = $2::uuid OR ($2::uuid IS NULL AND (${clipCanRetrySql}))
       )
     ORDER BY c.ordinal, c.id LIMIT $3`,
    [
      recordingId,
      input.scope === "clip" ? input.clipId : null,
      maxBatchClips + 1,
    ],
  );
  if (!rows.length) {
    if (input.scope === "clip")
      throw new TransportError("not_found", "Clip not found");
    throw refused("no_failed_clips");
  }
  if (rows.length > maxBatchClips) throw refused("too_many_failed_clips");
  if (input.scope === "clip" && rows[0]!.parentJobId !== input.parentJobId)
    throw refused("stale_current_job");
  return rows;
}

async function loadRetryParent(
  db: RerunRead,
  deps: StageRerunDeps,
  actorId: string,
  recordingId: string,
  target: RetryTarget,
): Promise<RerunParent> {
  const parent = await loadRerunParent(
    db,
    actorId,
    recordingId,
    target.parentJobId,
    deps,
    target.clipId,
  );
  if (!parent.is_current) throw refused("stale_current_job");
  if (parent.error_code && SOURCE_REUPLOAD_ERROR_CODES.has(parent.error_code))
    throw refused("source_reupload_required");
  return parent;
}

async function failedStages(
  db: RerunRead,
  parent: RerunParent,
  reportedStage: Stage | null,
): Promise<Stage[]> {
  const { rows } = await db.query<SuccessfulStage>(
    "SELECT stage, counts FROM job_effective_stage_runs WHERE job_id = $1 AND state = 'succeeded'",
    [parent.id],
  );
  return retryStagesForOutputs(
    parent.recipe!,
    rows,
    parent.state === "succeeded",
    reportedStage,
  );
}

type SuccessfulStage = { stage: Stage; counts: Record<string, number> | null };

export function retryStagesForOutputs(
  recipe: RecipeV1,
  rows: readonly SuccessfulStage[],
  accepted: boolean,
  reportedStage: Stage | null,
): Stage[] {
  const succeeded = new Set(
    rows
      .filter(
        ({ stage, counts }) => !stageHasFailedOutputs(stage, counts ?? {}),
      )
      .map(({ stage }) => stage),
  );
  // Hand reuse needs an accepted result manifest. A failed parent can still
  // supply independent segment or caption receipts, but needs a fresh seal.
  if (!accepted) succeeded.delete("hand_pose");
  const enabled = recipe.stages
    .filter((stage) => stage.enabled)
    .map((stage) => stage.stage);
  const stages = enabled.filter((stage) => !succeeded.has(stage));
  if (
    reportedStage &&
    enabled.includes(reportedStage) &&
    !stages.includes(reportedStage)
  )
    stages.push(reportedStage);
  // A job can fail while sealing even when every stage wrote successful evidence.
  if (!stages.length && !accepted && enabled.length)
    stages.push(enabled.at(-1)!);
  // If a prior attempt produced zero segments, caption cannot reuse them.
  // Selecting segmentation explicitly adds it and its caption dependency.
  if (
    stages.includes("caption") &&
    !stages.includes("segment") &&
    !(
      (rows.find(({ stage }) => stage === "segment")?.counts?.segments ?? 0) > 0
    )
  )
    stages.push("segment");
  return stages;
}

async function resolveBatch(
  deps: StageRerunDeps,
  actorId: string,
  recordingId: string,
  input: StageRerunRequestV2,
) {
  const targets = await loadTargets(deps.pool, actorId, recordingId, input);
  const plans: ClipPlan[] = [];
  for (const target of targets) {
    const parent = await loadRetryParent(
      deps.pool,
      deps,
      actorId,
      recordingId,
      target,
    );
    const stages =
      input.scope === "clip"
        ? input.stages
        : await failedStages(deps.pool, parent, target.reportedStage);
    const execute = retryExecutionStages(parent.recipe!, stages);
    const work = await resolveRerunWork(
      deps,
      parent,
      recordingId,
      parent.recipe!,
      execute,
      true,
    );
    plans.push({
      schemaVersion: 2,
      recordingId,
      clipId: target.clipId,
      parentJobId: parent.id,
      sourceManifestSha256: parent.source_manifest_sha256,
      selectionSeq: parent.selection_seq,
      clipSelectionSeq: parent.clip_selection_seq,
      ...work,
    });
  }
  const gpu = plans.reduce(
    (total, plan) => total + cents(plan.maxGpuCostUsd),
    0n,
  );
  const compute = plans.reduce(
    (total, plan) => total + cents(plan.maxComputeCostUsd),
    0n,
  );
  const environments = new Set(
    plans.flatMap((plan) =>
      Object.values(plan.bindings).map((binding) => binding.environment),
    ),
  );
  if (environments.size > 1) throw refused("deployment_binding_unavailable");
  if (
    compute > 0n &&
    !(
      await deps.pool.query(
        "SELECT 1 FROM job_rerun_available_spend($1, $2::uuid, $3::bigint, $4::bigint) LIMIT 1",
        [[...environments][0], recordingId, gpu.toString(), compute.toString()],
      )
    ).rowCount
  ) {
    throw refused("cost_cap_missing");
  }
  const estimated = plans.reduce<bigint | null>(
    (sum, plan) =>
      sum === null || plan.estimatedComputeCostUsd === null
        ? null
        : sum + cents(plan.estimatedComputeCostUsd),
    0n,
  );
  const summary = {
    schemaVersion: 2 as const,
    scope: input.scope,
    planSha256: requestSha256({
      schemaVersion: 2,
      scope: input.scope,
      targets,
      plans,
    }),
    maxGpuCostUsd: dollars(gpu),
    maxComputeCostUsd: dollars(compute),
    estimatedComputeCostUsd: estimated === null ? null : dollars(estimated),
  };
  return { targets, plans, summary };
}

export async function planStageRerunV2(
  deps: StageRerunDeps,
  actorId: string,
  recordingId: string,
  input: StageRerunRequestV2,
) {
  const { plans, targets, summary } = await resolveBatch(
    deps,
    actorId,
    recordingId,
    input,
  );
  return {
    ...summary,
    clips: plans.map((plan, index) => ({
      clipId: plan.clipId,
      parentJobId: plan.parentJobId,
      ordinal: targets[index]!.ordinal,
      startTsNs: targets[index]!.startTsNs,
      endTsNs: targets[index]!.endTsNs,
      execute: plan.recipe.stages.filter((entry) =>
        plan.execute.includes(entry.stage),
      ),
      reuse: plan.reuse.map(
        ({
          files,
          receipt: _receipt,
          fingerprintSha256: _fingerprint,
          importedCounts: _counts,
          ...evidence
        }) => ({
          ...evidence,
          copyBytes: files
            .reduce((total, file) => total + BigInt(file.sizeBytes), 0n)
            .toString(),
        }),
      ),
      maxGpuCostUsd: plan.maxGpuCostUsd,
      maxComputeCostUsd: plan.maxComputeCostUsd,
      estimatedComputeCostUsd: plan.estimatedComputeCostUsd,
      estimatedSeconds: plan.estimatedSeconds,
    })),
  };
}

async function replay(
  db: RerunRead,
  actorId: string,
  recordingId: string,
  requestId: string,
  requestHash: string,
): Promise<RetryJob[] | null> {
  const {
    rows: [row],
  } = await db.query<{
    recording_id: string;
    actor_id: string | null;
    request_sha256: string | null;
    jobs: RetryJob[] | null;
  }>(
    `SELECT j.recording_id, p.actor_id, p.request_sha256, p.plan -> 'batchJobs' AS jobs
     FROM jobs j LEFT JOIN job_rerun_plans p ON p.job_id = j.id
     WHERE j.id = $1 AND catalog_has_role($2, 'staff')`,
    [requestId, actorId],
  );
  if (!row) return null;
  if (
    row.recording_id !== recordingId ||
    row.actor_id !== actorId ||
    row.request_sha256 !== requestHash ||
    !row.jobs
  )
    throw refused("request_id_in_use");
  return row.jobs;
}

export async function confirmStageRerunV2(
  deps: StageRerunDeps,
  actorId: string,
  recordingId: string,
  input: StageRerunCommandV2,
) {
  if (!input.reason.trim())
    throw new TransportError("invalid_request", "A reason is required");
  const requestHash = requestSha256(
    input.scope === "clip"
      ? { ...input, stages: input.stages.toSorted() }
      : input,
  );
  const lookup = (db: RerunRead) =>
    replay(db, actorId, recordingId, input.requestId, requestHash);
  const result = (jobs: RetryJob[], replayed: boolean) => ({
    schemaVersion: 2 as const,
    jobs,
    replayed,
  });
  const existing = await lookup(deps.pool);
  if (existing) return result(existing, true);

  // A matching replay may commit while the request reads source objects.
  const preview = await resolveBatch(deps, actorId, recordingId, input).catch(
    async (error: unknown) => {
      const concurrent = await lookup(deps.pool);
      if (concurrent) return { concurrent };
      throw error;
    },
  );
  if ("concurrent" in preview) return result(preview.concurrent, true);

  return boundedRun(deps.pool, async (tx) => {
    await tx.query("SELECT 1 FROM recordings WHERE id = $1 FOR UPDATE", [
      recordingId,
    ]);
    const concurrent = await lookup(tx);
    if (concurrent) return result(concurrent, true);
    const { summary, plans, targets } = preview;
    if (
      summary.planSha256 !== input.expectedPlanSha256 ||
      summary.maxGpuCostUsd !== input.expectedMaxGpuCostUsd ||
      summary.maxComputeCostUsd !== input.expectedMaxComputeCostUsd
    ) {
      throw refused("plan_changed");
    }
    await tx.query(
      "SELECT id FROM review_clips WHERE recording_id = $1 AND ($2::uuid IS NULL OR id = $2) ORDER BY id FOR UPDATE",
      [recordingId, input.scope === "clip" ? input.clipId : null],
    );
    const current = await loadTargets(tx, actorId, recordingId, input);
    if (requestSha256(current) !== requestSha256(targets))
      throw refused("plan_changed");

    const jobs = targets.map(({ clipId, parentJobId }, index) => ({
      clipId,
      parentJobId,
      jobId: index === 0 ? input.requestId : randomUUID(),
    }));
    for (const [index, plan] of plans.entries()) {
      const target = targets[index]!;
      const parent = await loadRetryParent(
        tx,
        deps,
        actorId,
        recordingId,
        target,
      );
      if (
        parent.source_manifest_sha256 !== plan.sourceManifestSha256 ||
        parent.selection_seq !== plan.selectionSeq ||
        parent.clip_selection_seq !== plan.clipSelectionSeq
      )
        throw refused("plan_changed");
      const { jobId } = jobs[index]!;
      const inserted = await tx.query(
        `INSERT INTO jobs (id, kind, recording_id, derived_from_job_id, source_manifest_sha256, profile_revision, clip_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
        [
          jobId,
          parent.kind,
          recordingId,
          parent.id,
          parent.source_manifest_sha256,
          parent.profile_revision,
          target.clipId,
        ],
      );
      if (inserted.rowCount !== 1) throw refused("request_id_in_use");
      await tx.query(
        `INSERT INTO job_rerun_plans (job_id, actor_id, request_sha256, plan_sha256, plan)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [
          jobId,
          actorId,
          requestHash,
          requestSha256(plan),
          JSON.stringify({
            ...plan,
            reason: input.reason,
            batchPlanSha256: summary.planSha256,
            ...(index === 0 ? { batchJobs: jobs } : {}),
          }),
        ],
      );
      if (plan.maxComputeCostUsd !== "0.00") {
        const reserved = await tx.query<{ ok: boolean }>(
          "SELECT job_rerun_reserve_spend($1, $2, $3::bigint, $4::bigint) AS ok",
          [
            jobId,
            Object.values(plan.bindings)[0]?.environment,
            cents(plan.maxGpuCostUsd).toString(),
            cents(plan.maxComputeCostUsd).toString(),
          ],
        );
        if (!reserved.rows[0]?.ok) throw refused("cost_cap_missing");
      }
      if (parent.kind === "clip_pipeline") {
        await tx.query(
          "UPDATE review_clips SET live_job_id = $2 WHERE id = $1",
          [target.clipId, jobId],
        );
      } else {
        await tx.query(
          "UPDATE recordings SET current_job_id = $2 WHERE id = $1",
          [recordingId, jobId],
        );
      }
    }
    await tx.query(
      "UPDATE recordings SET status = 'processing' WHERE id = $1",
      [recordingId],
    );
    return result(jobs, false);
  });
}
