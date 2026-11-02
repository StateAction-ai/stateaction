import {
  appendReview,
  MAX_BATCH,
  requireRole,
  TS,
  uuid,
  type Queryable,
} from "../catalog/catalog.js";
import type {
  ClipQualityCheck,
  ClipReview,
  ClipReviewCommand,
  ClipReviewState,
} from "@stateaction/contracts";
import { CatalogError, toCatalogError } from "../catalog/errors.js";

/**
 * Staff review command and read model (SA-36). The command is a thin wrapper
 * over catalog.appendReview, the single transaction implementation; the read
 * model is one REPEATABLE READ snapshot so decision, memberships and dataset
 * revisions can never disagree. Customers have no route to either.
 */
export const REVIEW_HISTORY_LIMIT = 20;
export const AVAILABLE_DATASET_LIMIT = MAX_BATCH;

export async function commitClipReview(
  pool: Queryable,
  input: { clipId: string; reviewerUserId: string; command: ClipReviewCommand },
): Promise<{ review: ClipReview; replayed: boolean }> {
  const c = input.command;
  const out = await appendReview(pool, {
    reviewId: c.reviewId,
    clipId: input.clipId,
    jobId: c.jobId,
    resultManifestSha256: c.resultManifestSha256,
    reviewerUserId: input.reviewerUserId,
    expectedRevision: c.expectedReviewRevision,
    decision: c.decision,
    ...(c.taskLabel !== undefined ? { taskLabel: c.taskLabel } : {}),
    ...(c.notes !== undefined ? { notes: c.notes } : {}),
    ...(c.datasetSelection ? { datasetSelection: c.datasetSelection } : {}),
  });
  return { review: out.review, replayed: out.replayed };
}

const ts = (column: string) => TS.replace("%s", column);

type QualityCheck = ClipQualityCheck;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const STATUSES = ["pass", "warn", "fail", "measured", "not_evaluated"];
/**
 * Allowlist projection of the verified manifest `checks` persisted by SA-28
 * (job_result_candidates.verified_checks). The exporter `message` and any
 * unknown field are dropped; unknown codes/statuses/values are skipped.
 */
export function projectQualityChecks(raw: unknown): QualityChecks {
  if (!Array.isArray(raw) || raw.length === 0)
    return { status: "not_evaluated", checks: [] };
  const checks: QualityCheck[] = [];
  for (const entry of raw.slice(0, 64)) {
    const e = entry as Record<string, unknown> | null;
    if (!e || typeof e.code !== "string" || !CODE.test(e.code)) continue;
    const check: QualityCheck = {
      id: e.code,
      status: STATUSES.includes(e.status as string)
        ? (e.status as QualityCheck["status"])
        : "unknown",
    };
    if (Number.isInteger(e.rule_revision) && (e.rule_revision as number) >= 0)
      check.ruleRevision = e.rule_revision as number;
    if (e.measurements && typeof e.measurements === "object") {
      const m: Record<string, string> = {};
      for (const [k, v] of Object.entries(e.measurements).slice(0, 16))
        if (CODE.test(k) && typeof v === "string" && /^-?[0-9]{1,19}$/.test(v))
          m[k] = v;
      if (Object.keys(m).length) check.measurements = m;
    }
    checks.push(check);
  }
  return checks.length
    ? { status: "evaluated", checks }
    : { status: "not_evaluated", checks: [] };
}

type QualityChecks = ClipReviewState["qualityChecks"];

export async function getClipReviewState(
  pool: Queryable,
  input: { viewerUserId: string; clipId: string },
): Promise<ClipReviewState> {
  const clipId = uuid(input.clipId, "clipId");
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await requireRole(tx, input.viewerUserId, "staff");
    const clip = (
      await tx.query<{
        recording_id: string;
        job_id: string;
        sha: string;
        current: boolean;
        checks: unknown;
      }>(
        `SELECT c.recording_id, c.job_id, j.result_manifest_sha256 AS sha,
                (SELECT jc.verified_checks FROM job_result_candidates jc
                  WHERE jc.job_id = c.job_id AND jc.status IN ('verified', 'accepted')
                    AND jc.manifest_sha256 = j.result_manifest_sha256) AS checks,
                (j.state = 'succeeded' AND rec.current_job_id = c.job_id
                 AND rec.deleted_at IS NULL) AS current
         FROM clips c
         JOIN jobs j ON j.id = c.job_id
         JOIN recordings rec ON rec.id = c.recording_id
         WHERE c.id = $1`,
        [clipId],
      )
    ).rows[0];
    if (!clip) throw new CatalogError("not_found", "Clip not found");
    const history = (
      await tx.query<{
        revision: number;
        decision: "approved" | "rejected";
        task_label: string | null;
        notes: string | null;
        at: string;
      }>(
        `SELECT revision, decision, task_label, notes, ${ts("created_at")} AS at
         FROM reviews WHERE clip_id = $1 ORDER BY revision DESC LIMIT $2`,
        [clipId, REVIEW_HISTORY_LIMIT],
      )
    ).rows;
    const memberships = (
      await tx.query<{
        id: string;
        name: string;
        revision: number;
        at: string;
      }>(
        `SELECT d.id, d.name, d.revision, ${ts("dc.added_at")} AS at
         FROM dataset_clips dc JOIN datasets d ON d.id = dc.dataset_id
         WHERE dc.clip_id = $1 ORDER BY d.id LIMIT $2`,
        [clipId, MAX_BATCH + 1],
      )
    ).rows;
    const datasets = (
      await tx.query<{
        id: string;
        name: string;
        revision: number;
        member: boolean;
        shared: boolean;
      }>(
        `SELECT d.id, d.name, d.revision,
                EXISTS (SELECT 1 FROM dataset_clips dc
                        WHERE dc.dataset_id = d.id AND dc.clip_id = $1) AS member,
                EXISTS (SELECT 1 FROM dataset_access da
                        WHERE da.dataset_id = d.id AND da.enabled) AS shared
         FROM datasets d ORDER BY d.updated_at DESC, d.id DESC LIMIT $2`,
        [clipId, AVAILABLE_DATASET_LIMIT + 1],
      )
    ).rows;
    await tx.query("COMMIT");
    const latest = history[0];
    return {
      qualityChecks: projectQualityChecks(clip.checks),
      clipId,
      recordingId: clip.recording_id,
      jobId: clip.job_id,
      resultManifestSha256: clip.sha,
      current: clip.current,
      capabilities: { canReview: clip.current },
      review: {
        revision: latest?.revision ?? 0,
        decision: latest?.decision ?? null,
        taskLabel: latest?.task_label ?? null,
        notes: latest?.notes ?? null,
        reviewedAt: latest?.at ?? null,
      },
      history: history.map((r) => ({
        revision: r.revision,
        decision: r.decision,
        taskLabel: r.task_label,
        notes: r.notes,
        reviewedAt: r.at,
      })),
      membershipsTruncated: memberships.length > MAX_BATCH,
      memberships: memberships.slice(0, MAX_BATCH).map((m) => ({
        datasetId: m.id,
        name: m.name,
        revision: m.revision,
        addedAt: m.at,
      })),
      availableDatasets: datasets
        .slice(0, AVAILABLE_DATASET_LIMIT)
        .map((d) => ({
          datasetId: d.id,
          name: d.name,
          revision: d.revision,
          member: d.member,
          shared: d.shared,
        })),
      availableDatasetsTruncated: datasets.length > AVAILABLE_DATASET_LIMIT,
    };
  } catch (error) {
    await tx.query("ROLLBACK").catch(() => undefined);
    throw toCatalogError(error);
  } finally {
    tx.release();
  }
}

export type { ClipReview, ClipReviewCommand, ClipReviewState };
