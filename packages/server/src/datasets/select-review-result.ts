import { inTransaction, type Queryable } from "../catalog/catalog.js";
import { CatalogError } from "../catalog/errors.js";
import { lockStaffReview } from "./review-result.js";

export async function selectReviewClipResult(
  pool: Queryable,
  input: {
    viewerUserId: string;
    clipId: string;
    jobId: string;
    expectedSelectionSeq: number;
    reason: string;
  },
) {
  const reason = input.reason.trim();
  if (!reason)
    throw new CatalogError("invalid_request", "A reason is required");

  return inTransaction(pool, async (tx) => {
    await lockStaffReview(tx, input.viewerUserId, input.clipId);
    const {
      rows: [current],
    } = await tx.query<{ job_id: string; seq: number }>(
      "SELECT job_id, seq FROM clip_result_selections WHERE clip_id = $1 ORDER BY seq DESC LIMIT 1",
      [input.clipId],
    );
    const currentSeq = current?.seq ?? 0;
    if (currentSeq !== input.expectedSelectionSeq)
      throw new CatalogError("conflict", "The selected clip result changed");
    if (current?.job_id === input.jobId)
      return { jobId: input.jobId, selectionRevision: currentSeq };
    const {
      rows: [target],
    } = await tx.query<{ recording_id: string; legacy: boolean }>(
      `SELECT j.recording_id, p.plan_job_id IS NULL AND j.kind IN ('process_recording', 'cached_import') AS legacy
       FROM jobs j JOIN review_clips c ON c.id = j.clip_id
       JOIN clip_plans p ON p.recording_id = c.recording_id AND p.version = c.plan_version
       JOIN recordings r ON r.id = j.recording_id AND r.deleted_at IS NULL
       WHERE j.clip_id = $1 AND j.id = $2 AND j.state = 'succeeded'
         AND j.result_manifest_sha256 IS NOT NULL`,
      [input.clipId, input.jobId],
    );
    if (!target)
      throw new CatalogError(
        "not_found",
        "An accepted result was not found for this clip",
      );
    if (target.legacy) {
      await tx.query(
        `INSERT INTO recording_result_selections (recording_id, seq, job_id, selected_by, reason, kind)
         SELECT $1, coalesce(max(seq), 0) + 1, $2, $3, $4, 'manual'
         FROM recording_result_selections WHERE recording_id = $1`,
        [target.recording_id, input.jobId, input.viewerUserId, reason],
      );
    } else {
      await tx.query(
        `INSERT INTO clip_result_selections (clip_id, seq, job_id, selected_by, reason, kind)
         VALUES ($1, $2, $3, $4, $5, 'manual')`,
        [input.clipId, currentSeq + 1, input.jobId, input.viewerUserId, reason],
      );
    }
    return { jobId: input.jobId, selectionRevision: currentSeq + 1 };
  });
}
