import type pg from "pg";
import { TransportError } from "../transport/errors.js";
import { boundedRun } from "./service.js";

export type RunHistoryRow = {
  jobId: string;
  state: string;
  parentId: string | null;
  retryOf: string | null;
  selected: boolean;
  createdAt: Date;
};

export async function recordingRunHistory(
  pool: pg.Pool,
  actorId: string,
  recordingId: string,
): Promise<{ runs: RunHistoryRow[]; selectionSeq: number }> {
  const rows = (
    await pool.query<RunHistoryRow & { seq: number }>(
      `SELECT j.id AS "jobId", j.state, j.derived_from_job_id AS "parentId",
            j.previous_job_id AS "retryOf", j.created_at AS "createdAt",
            coalesce(j.id = s.job_id, false) AS selected, coalesce(s.seq, 0) AS seq
     FROM recordings r JOIN jobs j ON j.recording_id = r.id
     LEFT JOIN LATERAL (SELECT seq, job_id FROM recording_result_selections
       WHERE recording_id = r.id ORDER BY seq DESC LIMIT 1) s ON TRUE
     WHERE r.id = $2 AND r.deleted_at IS NULL AND catalog_has_role($1, 'staff')
     ORDER BY (j.id = s.job_id) DESC NULLS LAST, j.created_at DESC, j.id LIMIT 100`,
      [actorId, recordingId],
    )
  ).rows;
  return {
    runs: rows.map(({ seq: _seq, ...run }) => run),
    selectionSeq: rows[0]?.seq ?? 0,
  };
}

export async function selectRecordingResult(
  pool: pg.Pool,
  actorId: string,
  recordingId: string,
  input: { jobId: string; expectedSelectionSeq: number; reason: string },
): Promise<{ jobId: string; selectionSeq: number }> {
  return boundedRun(pool, async (tx) => {
    const { rowCount } = await tx.query(
      "SELECT 1 FROM recordings WHERE id = $1 AND deleted_at IS NULL AND catalog_has_role($2, 'staff') FOR UPDATE",
      [recordingId, actorId],
    );
    if (!rowCount) throw new TransportError("not_found", "Recording not found");
    const {
      rows: [current],
    } = await tx.query<{ seq: number }>(
      "SELECT seq FROM recording_result_selections WHERE recording_id = $1 ORDER BY seq DESC LIMIT 1",
      [recordingId],
    );
    if ((current?.seq ?? 0) !== input.expectedSelectionSeq) {
      throw new TransportError("conflict", "selection_changed");
    }
    const seq = input.expectedSelectionSeq + 1;
    await tx.query(
      `INSERT INTO recording_result_selections (recording_id, seq, job_id, selected_by, reason, kind)
       VALUES ($1, $2, $3, $4, $5, 'manual')`,
      [recordingId, seq, input.jobId, actorId, input.reason],
    );
    return { jobId: input.jobId, selectionSeq: seq };
  });
}
