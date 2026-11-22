import type pg from "pg";
import { TransportError } from "../transport/errors.js";

type Db = Pick<pg.Pool, "query">;

/**
 * The one database predicate every worker read or output mutation must pass,
 * evaluated against live rows on every call (nothing is cached):
 *
 * - the job is `running`, claimed (nonce + execution ID recorded) and still
 *   holds the global admission slot;
 * - the immutable absolute execution deadline has not passed (heartbeats and
 *   leases never extend it);
 * - the recording still points at this job (a retry/replacement makes the old
 *   attempt stale), is not deleted and is `processing`;
 * - the recording owner still holds an enabled collector role and the
 *   registration's ingest permission evidence is active and covers
 *   processing. Locking: this read takes NO job or recording row locks (it is
 *   one snapshot per statement); its only lock is the FOR SHARE that the
 *   SECURITY DEFINER `ingest_permission_ok` takes on the permission row, which
 *   serializes the check with revocation. Callers that must not act after a
 *   cancellation, replacement or deadline wins (output allocation) take the job
 *   row FOR UPDATE first and run this check inside the same transaction, so a
 *   transition that already committed is always observed. URLs signed before a
 *   later transition remain valid only for their short lifetime;
 * - when a nonce is supplied it is exactly the claiming physical invocation
 *   (for a recipe job, the claimed hand_pose stage: the seal; SA-88).
 *
 * Callers authenticate the capability scope first; this adds the state checks
 * a capability alone cannot prove.
 */
export const JOB_CURRENT_SQL = `
  SELECT j.id, j.recording_id, j.invocation_nonce, j.execution_deadline
  FROM jobs j JOIN recordings r ON r.id = j.recording_id
  WHERE j.id = $1 AND j.state = 'running' AND j.claimed_at IS NOT NULL
    AND j.execution_deadline > now()
    AND ($2::text IS NULL OR public.job_seal_nonce(j.id) = $2)
    AND r.current_job_id = j.id AND r.deleted_at IS NULL AND r.status = 'processing'
    AND EXISTS (SELECT 1 FROM dispatch_admission a WHERE a.slot = 1 AND a.job_id = j.id)
    AND catalog_has_role(r.owner_user_id, 'collector')
    AND EXISTS (
      SELECT 1 FROM recording_registrations g
      WHERE g.recording_id = r.id AND g.owner_user_id = r.owner_user_id
        AND ingest_permission_ok(g.ingest_permission_id, g.owner_user_id, true))`;

export type CurrentJob = {
  jobId: string;
  recordingId: string;
  invocationNonce: string;
  executionDeadline: Date;
};

export async function assertJobCurrent(
  db: Db,
  jobId: string,
  nonce: string | null = null,
): Promise<CurrentJob> {
  const { rows } = await db.query<{
    id: string;
    recording_id: string;
    invocation_nonce: string;
    execution_deadline: Date;
  }>(JOB_CURRENT_SQL, [jobId, nonce]);
  const row = rows[0];
  // Stale, cancelled, expired, revoked or replaced attempts all look alike.
  if (!row) throw new TransportError("forbidden", "Job is not current");
  return {
    jobId: row.id,
    recordingId: row.recording_id,
    invocationNonce: row.invocation_nonce,
    executionDeadline: row.execution_deadline,
  };
}

/**
 * Output mutations (allocate, sign, receipts, complete, cancel, restart, close)
 * additionally require that the job's output inventory is still OPEN and that
 * no terminal execution evidence exists: after the inventory is closed, or the
 * physical execution is over, no byte may be added or changed. Candidate
 * submission deliberately uses JOB_CURRENT_SQL (an already closed inventory may
 * still be reported by the exact current claim).
 */
export const JOB_OUTPUT_OPEN_SQL = `
  SELECT c.* FROM (${JOB_CURRENT_SQL}) c
  WHERE NOT EXISTS (SELECT 1 FROM job_output_closures x WHERE x.job_id = c.id)
    AND NOT EXISTS (SELECT 1 FROM job_execution_evidence e WHERE e.job_id = c.id)`;

export async function assertJobOutputOpen(
  db: Db,
  jobId: string,
  nonce: string | null = null,
): Promise<CurrentJob> {
  const { rows } = await db.query<{
    id: string;
    recording_id: string;
    invocation_nonce: string;
    execution_deadline: Date;
  }>(JOB_OUTPUT_OPEN_SQL, [jobId, nonce]);
  const row = rows[0];
  if (!row) throw new TransportError("forbidden", "Job outputs are not open");
  return {
    jobId: row.id,
    recordingId: row.recording_id,
    invocationNonce: row.invocation_nonce,
    executionDeadline: row.execution_deadline,
  };
}
