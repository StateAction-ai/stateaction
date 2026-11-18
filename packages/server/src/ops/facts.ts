import type pg from "pg";
import { MAX_JOBS } from "./alerts.js";
import { readJobFacts, type JobFacts } from "./receipt.js";
import { OpsInputError } from "./redact.js";

/**
 * Finite, read-only durable fact loader for the operator report (SA-45).
 *
 * It runs with the RESTRICTED APP role that the server already uses (SELECT on
 * the catalog and acceptance tables; no new grant, no migration). Everything
 * happens in one `READ ONLY`, `REPEATABLE READ` transaction with a statement
 * and lock timeout, so the three queries describe one snapshot and a hung
 * database cannot hold the operator tool. It refuses a privileged role
 * (superuser, bypass-RLS, table-level DELETE on jobs, write-all-data member). Selected columns are named
 * explicitly: nonces, capability hashes, object keys, signed URLs and error
 * messages are never read. The result is rebuilt through `readJobFacts` (closed
 * validators) and carries `provenance: "restricted_db_read"`.
 *
 * Byte semantics (each basis is all-or-nothing per role, never a partial sum):
 *   declared  = sum of `files.size_bytes` for the role's live files
 *   uploaded  = sum of `files.observed_size_bytes` when EVERY file is completed/verified
 *   verified  = source: every file in state `verified`;
 *               outputs: every file has a `job_output_verifications` row
 * Roles: `source` = the recording's live source files; `rrd` = output role
 * `viewer_rrd`; `failedOutput` = other outputs of a closure whose worker outcome
 * is `failed`; `output` = the remaining outputs. QC counts exist only for an
 * `accepted` result candidate (its hash-verified summary); anything else is
 * unknown, never zero.
 */
export const DEFAULT_QUERY_TIMEOUT_MS = 10_000;
export const MAX_SINCE_SECONDS = 90 * 86_400;
export const MAX_BYTE_ROWS = MAX_JOBS * 4;

export type LoadOptions = {
  /** Terminal jobs created within this window are included; open jobs always are. */
  sinceSeconds: number;
  /** At most this many jobs (<= MAX_JOBS). More matching jobs is an error, not a silent cut. */
  limit?: number;
  timeoutMs?: number;
};

export type LoadedFacts = {
  jobs: JobFacts[];
  /** Database clock for the snapshot: alert ages use the same clock as the stored timestamps. */
  databaseNow: number;
  /** Count of rows the loader rejected as not valid job facts (never silently dropped). */
  unreadable: number;
};

const JOBS_SQL = `
  SELECT j.id, j.state, j.error_code, j.execution_backend, j.execution_call_id,
         j.created_at, j.admitted_at, j.claimed_at, j.last_heartbeat_at,
         j.unknown_at, j.finished_at, j.execution_deadline
  FROM jobs j
  WHERE j.state NOT IN ('succeeded', 'failed', 'cancelled')
     OR j.created_at >= clock_timestamp() - make_interval(secs => $1::double precision)
  ORDER BY j.created_at DESC, j.id DESC
  LIMIT $2`;

const BYTES_SQL = `
  SELECT s.id AS job_id, b.bucket, count(*)::int AS n,
         sum(b.size_bytes)::text AS declared,
         CASE WHEN bool_and(b.state IN ('completed', 'verified'))
              THEN sum(b.observed_size_bytes)::text END AS uploaded,
         CASE WHEN bool_and(b.vsize IS NOT NULL) THEN sum(b.vsize)::text END AS verified
  FROM jobs s
  JOIN LATERAL (
    SELECT 'source'::text AS bucket, f.size_bytes, f.observed_size_bytes, f.state,
           CASE WHEN f.state = 'verified' THEN f.size_bytes END AS vsize
    FROM files f
    WHERE f.purpose = 'source' AND f.recording_id = s.recording_id
      AND f.state NOT IN ('cancelled', 'failed', 'expired')
    UNION ALL
    SELECT CASE WHEN f.role = 'viewer_rrd' THEN 'rrd'
                WHEN c.outcome = 'failed' THEN 'failedOutput'
                ELSE 'output' END,
           f.size_bytes, f.observed_size_bytes, f.state, v.size_bytes
    FROM files f
    LEFT JOIN job_output_verifications v ON v.file_id = f.id
    LEFT JOIN job_output_closures c ON c.job_id = f.job_id
    WHERE f.purpose = 'output' AND f.job_id = s.id
      AND f.state NOT IN ('cancelled', 'failed', 'expired')
  ) b ON true
  WHERE s.id = ANY($1::uuid[])
  GROUP BY s.id, b.bucket`;

const QC_SQL = `
  SELECT job_id, summary -> 'checks' AS checks
  FROM job_result_candidates
  WHERE job_id = ANY($1::uuid[]) AND status = 'accepted'`;

type JobRow = {
  id: string;
  state: string;
  error_code: string | null;
  execution_backend: string | null;
  execution_call_id: string | null;
  created_at: Date;
  admitted_at: Date | null;
  claimed_at: Date | null;
  last_heartbeat_at: Date | null;
  unknown_at: Date | null;
  finished_at: Date | null;
  execution_deadline: Date | null;
};
type ByteRow = {
  job_id: string;
  bucket: string;
  declared: string | null;
  uploaded: string | null;
  verified: string | null;
};
type QcRow = { job_id: string; checks: unknown };

const iso = (d: Date | null): string | undefined =>
  d instanceof Date && Number.isFinite(d.getTime())
    ? d.toISOString()
    : undefined;

const count = (v: string | null): number | undefined =>
  typeof v === "string" && /^\d{1,15}$/.test(v) ? Number(v) : undefined;

export async function loadJobFacts(
  pool: Pick<pg.Pool, "connect">,
  options: LoadOptions,
): Promise<LoadedFacts> {
  const limit = options.limit ?? MAX_JOBS;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_JOBS)
    throw new OpsInputError(`limit must be 1..${MAX_JOBS}`);
  if (
    !Number.isFinite(options.sinceSeconds) ||
    options.sinceSeconds <= 0 ||
    options.sinceSeconds > MAX_SINCE_SECONDS
  )
    throw new OpsInputError("since window out of range");
  const timeoutMs = options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000)
    throw new OpsInputError("timeout out of range");
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
    await client.query(`SET LOCAL lock_timeout = ${Math.min(timeoutMs, 2000)}`);
    // Refuse a privileged role: this tool is for the restricted application
    // role only (no superuser, no table-level DELETE on jobs, no write-all).
    const who = await client.query<{ privileged: boolean }>(
      `SELECT (r.rolsuper OR r.rolbypassrls
              OR has_table_privilege(current_user, 'public.jobs', 'DELETE')
              OR pg_has_role(current_user, 'pg_write_all_data', 'member')) AS privileged
       FROM pg_roles r WHERE r.rolname = current_user`,
    );
    if (who.rows[0]?.privileged !== false)
      throw new OpsInputError(
        "refusing a privileged database role; use the restricted application role",
      );
    const clock = await client.query<{ now: Date }>(
      "SELECT clock_timestamp() AS now",
    );
    const databaseNow = clock.rows[0]?.now?.getTime();
    if (databaseNow === undefined || !Number.isFinite(databaseNow))
      throw new OpsInputError("database clock unreadable");
    const jobs = await client.query<JobRow>(JOBS_SQL, [
      options.sinceSeconds,
      limit + 1,
    ]);
    if (jobs.rows.length > limit)
      throw new OpsInputError(
        "more jobs match than the limit; narrow --since-hours (nothing was truncated silently)",
      );
    const ids = jobs.rows.map((r) => r.id);
    const bytes = ids.length
      ? await client.query<ByteRow>(BYTES_SQL, [ids])
      : { rows: [] as ByteRow[] };
    const qc = ids.length
      ? await client.query<QcRow>(QC_SQL, [ids])
      : { rows: [] as QcRow[] };
    await client.query("COMMIT");
    if (bytes.rows.length > MAX_BYTE_ROWS)
      throw new OpsInputError("unexpected row count");
    const byJob = new Map<string, Record<string, Record<string, number>>>();
    for (const row of bytes.rows) {
      const roles = byJob.get(row.job_id) ?? {};
      const bases: Record<string, number> = {};
      for (const basis of ["declared", "uploaded", "verified"] as const) {
        const n = count(row[basis]);
        if (n !== undefined) bases[basis] = n;
      }
      roles[row.bucket] = bases;
      byJob.set(row.job_id, roles);
    }
    const qcBy = new Map(qc.rows.map((r) => [r.job_id, r.checks]));
    let unreadable = 0;
    const out: JobFacts[] = [];
    for (const r of jobs.rows) {
      const facts = readJobFacts(
        {
          jobId: r.id,
          state: r.state,
          errorCode: r.error_code ?? undefined,
          backend: r.execution_backend ?? undefined,
          executionRef: r.execution_call_id ?? undefined,
          createdAt: iso(r.created_at),
          admittedAt: iso(r.admitted_at),
          claimedAt: iso(r.claimed_at),
          lastHeartbeatAt: iso(r.last_heartbeat_at),
          unknownAt: iso(r.unknown_at),
          finishedAt: iso(r.finished_at),
          executionDeadline: iso(r.execution_deadline),
          bytes: byJob.get(r.id) ?? {},
          qc: checkCounts(qcBy.get(r.id)),
        },
        "restricted_db_read",
      );
      if (facts) out.push(facts);
      else unreadable += 1;
    }
    return { jobs: out, databaseNow, unreadable };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Accepted candidates carry the verified check counts under `summary.checks`. */
function checkCounts(v: unknown): unknown {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  return v;
}
