import type { Queryable } from "../catalog/catalog.js";
import {
  PIPELINE_PAGE_SIZE,
  PIPELINE_STATUSES,
  deriveStages,
  formatBytes,
  formatStart,
  noJobControl,
  pipelineErrorSummary,
  recordingTitle,
  reviewClipsHref,
  type JobControlCapabilities,
  type JobState,
  type PipelineActions,
  type PipelineQuery,
  type PipelineStatus,
  type Stage,
} from "./model.js";

/**
 * Read-only staff Pipeline queries over the real catalog rows (recordings,
 * jobs, files, clips, recording_admissions) through the restricted application
 * role. Every statement re-checks the enabled `staff` access row in SQL, so a
 * caller that skipped the page guard still cannot read another role's view.
 * Output is deliberately narrow: no owner id or email, device metadata, object
 * keys, hashes or raw storage paths.
 */

// The one place a recording is classified (list filter and detail share it).
const STATUS_SQL = `CASE
  WHEN b.rec_status = 'cancelled' OR b.job_state = 'cancelled' THEN 'cancelled'
  WHEN b.job_state IN ('submit_unknown', 'needs_attention') THEN 'needs_attention'
  WHEN b.rec_status = 'failed' OR b.job_state = 'failed'
    OR b.admission_outcome = 'rejected' THEN 'failed'
  WHEN b.job_state = 'succeeded' THEN 'completed'
  WHEN b.job_state IN ('running', 'result_pending', 'cancel_requested') THEN 'processing'
  WHEN b.job_state IN ('queued', 'submitting')
    OR b.rec_status IN ('sealed', 'uploaded') THEN 'queued'
  WHEN b.rec_status IN ('processing', 'reviewable') THEN 'needs_attention'
  ELSE 'uploading' END`;

const BASE_SQL = `WITH staff AS (
  SELECT EXISTS (
    SELECT 1 FROM access WHERE user_id = $1 AND role = 'staff' AND enabled
  ) AS ok
), base AS (
  SELECT r.id, r.status AS rec_status, r.started_at, r.updated_at,
    r.source_manifest_file_id IS NOT NULL AS sealed,
    u.name AS collector_name,
    j.id AS job_id, j.state AS job_state, j.error_code,
    (j.submission_intent_at IS NOT NULL OR j.execution_call_id IS NOT NULL
      OR j.workflow_run_ref IS NOT NULL) AS job_submitted,
    a.outcome AS admission_outcome, a.rejection_code
  FROM recordings r
  JOIN "user" u ON u.id = r.owner_user_id
  LEFT JOIN jobs j ON j.id = r.current_job_id AND j.recording_id = r.id
  LEFT JOIN recording_admissions a ON a.recording_id = r.id
  WHERE r.deleted_at IS NULL AND (SELECT ok FROM staff)
), classified AS (
  SELECT b.*, ${STATUS_SQL} AS status FROM base b
)`;

const SOURCE_LATERAL = `LEFT JOIN LATERAL (
  SELECT count(*)::int AS file_count,
    sum(f.size_bytes)::text AS total_bytes,
    (sum(f.size_bytes) FILTER (WHERE f.state IN ('completed', 'verified')))::text AS confirmed_bytes,
    (sum(f.size_bytes) FILTER (WHERE f.role = 'source_mcap'))::text AS mcap_bytes
  FROM files f
  WHERE f.recording_id = c.id AND f.purpose = 'source'
    AND f.state NOT IN ('cancelled', 'failed', 'expired')
) s ON true
LEFT JOIN LATERAL (
  SELECT count(*)::int AS clip_count FROM clips k WHERE k.job_id = c.job_id
) k ON c.job_state = 'succeeded'`;

const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, "\\$&")}%`;
const num = (value: string | null | undefined) =>
  value === null || value === undefined ? null : Number(value);

type Row = {
  id: string;
  status: PipelineStatus;
  rec_status: string;
  started_at: Date;
  updated_at: Date;
  sealed: boolean;
  collector_name: string;
  job_id: string | null;
  job_state: JobState | null;
  error_code: string | null;
  job_submitted: boolean | null;
  admission_outcome: string | null;
  rejection_code: string | null;
  file_count: number | null;
  total_bytes: string | null;
  confirmed_bytes: string | null;
  mcap_bytes: string | null;
  clip_count: number | null;
};

export type PipelineListItem = {
  id: string;
  title: string;
  collector: string;
  /** e.g. `482 MB · MCAP`; null when no source file is recorded yet. */
  source: string | null;
  status: PipelineStatus;
  /** One truthful line under the status badge, or null. */
  note: string | null;
  /** Upload percentage only while uploading and only from confirmed bytes. */
  uploadPercent: number | null;
};
export type PipelineList = {
  items: PipelineListItem[];
  hasNext: boolean;
  counts: Record<PipelineStatus, number>;
};

function sourceText(row: Row): string | null {
  const bytes = num(row.mcap_bytes) ?? num(row.total_bytes);
  if (bytes === null) return null;
  const size = formatBytes(bytes) ?? "Unknown size";
  return row.mcap_bytes !== null ? `${size} · MCAP` : size;
}
function failureNote(row: Row): string | null {
  if (row.admission_outcome === "rejected")
    return (
      pipelineErrorSummary(row.rejection_code) ??
      "Source was rejected during admission"
    );
  const summary = pipelineErrorSummary(row.error_code);
  if (row.status === "needs_attention")
    return row.job_state === "submit_unknown"
      ? "Submission acknowledgement unknown"
      : (summary ?? "Needs staff attention");
  if (row.status === "failed")
    return summary ?? "Failure details are unavailable";
  return null;
}

function toListItem(row: Row): PipelineListItem {
  const total = num(row.total_bytes);
  const confirmed = num(row.confirmed_bytes);
  const uploadPercent =
    row.status === "uploading" && total && confirmed !== null
      ? Math.min(100, Math.floor((confirmed / total) * 100))
      : null;
  let note: string | null = failureNote(row);
  if (row.status === "completed")
    note =
      row.clip_count === null
        ? null
        : `${row.clip_count} ${row.clip_count === 1 ? "clip" : "clips"}`;
  else if (row.status === "queued")
    note = row.job_id
      ? "Waiting for a processing slot"
      : "Waiting for a processing job";
  else if (row.status === "processing")
    note =
      row.job_state === "cancel_requested"
        ? "Cancellation requested"
        : "Processing";
  else if (row.status === "uploading")
    note =
      uploadPercent === null
        ? "Upload progress not reported"
        : `${uploadPercent}% uploaded`;
  else if (row.status === "cancelled") note = "Cancelled";
  return {
    id: row.id,
    title: recordingTitle(row.started_at),
    collector: row.collector_name,
    source: sourceText(row),
    status: row.status,
    note,
    uploadPercent,
  };
}

export async function listPipelineRecordings(
  pool: Queryable,
  staffUserId: string,
  query: PipelineQuery,
): Promise<PipelineList> {
  const offset = (query.page - 1) * PIPELINE_PAGE_SIZE;
  const filter = `WHERE ($2::text = '' OR collector_name ILIKE $2 ESCAPE '\\'
      OR to_char(started_at AT TIME ZONE 'UTC', 'FMDD FMMon YYYY, HH24:MI') ILIKE $2 ESCAPE '\\')
    AND ($3::text IS NULL OR status = $3)`;
  const params = [
    staffUserId,
    query.q ? likePattern(query.q) : "",
    query.status,
  ];
  const [page, counts] = await Promise.all([
    pool.query<Row>(
      `${BASE_SQL}, page AS (
         SELECT * FROM classified ${filter}
         ORDER BY started_at DESC, id DESC LIMIT $4 OFFSET $5
       )
       SELECT c.*, s.file_count, s.total_bytes, s.confirmed_bytes, s.mcap_bytes, k.clip_count
       FROM page c ${SOURCE_LATERAL}
       ORDER BY c.started_at DESC, c.id DESC`,
      [...params, PIPELINE_PAGE_SIZE + 1, offset],
    ),
    pool.query<{ status: PipelineStatus; n: number }>(
      `${BASE_SQL} SELECT status, count(*)::int AS n FROM classified GROUP BY status`,
      [staffUserId],
    ),
  ]);
  const countMap = Object.fromEntries(
    PIPELINE_STATUSES.map((s) => [s, 0]),
  ) as Record<PipelineStatus, number>;
  for (const row of counts.rows) countMap[row.status] = row.n;
  return {
    items: page.rows.slice(0, PIPELINE_PAGE_SIZE).map(toListItem),
    hasNext: page.rows.length > PIPELINE_PAGE_SIZE,
    counts: countMap,
  };
}

export type PipelineDetail = {
  id: string;
  title: string;
  startedAt: string;
  startedLabel: string;
  collector: string;
  status: PipelineStatus;
  statusNote: string | null;
  /** Staff-readable, curated error summary. */
  error: { summary: string } | null;
  stages: Stage[];
  source: {
    format: string | null;
    size: string | null;
    /** Not stored by the catalog; always unknown here. */
    duration: null;
    /** Reported by worker telemetry only; none exists yet. */
    hash: null;
  };
  jobId: string | null;
  jobState: JobState | null;
  clipCount: number | null;
};

export async function getPipelineDetail(
  pool: Queryable,
  staffUserId: string,
  recordingId: string,
): Promise<PipelineDetail | null> {
  const result = await pool.query<Row>(
    `${BASE_SQL}
     SELECT c.*, s.file_count, s.total_bytes, s.confirmed_bytes, s.mcap_bytes, k.clip_count
     FROM classified c ${SOURCE_LATERAL} WHERE c.id = $2`,
    [staffUserId, recordingId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const item = toListItem(row);
  const errorSummary = failureNote(row);
  const stages = deriveStages({
    sealed: row.sealed,
    recordingStatus: row.rec_status,
    admissionRejected: row.admission_outcome === "rejected",
    jobState: row.job_state,
    jobSubmitted: row.job_submitted === true,
    uploadedBytes: num(row.confirmed_bytes),
    totalBytes: num(row.total_bytes),
    clipCount: row.job_state === "succeeded" ? row.clip_count : null,
  });
  return {
    id: row.id,
    title: item.title,
    startedAt: row.started_at.toISOString(),
    startedLabel: formatStart(row.started_at),
    collector: row.collector_name,
    status: row.status,
    statusNote: item.note,
    error: errorSummary ? { summary: errorSummary } : null,
    stages,
    source: {
      format: row.mcap_bytes !== null ? "MCAP" : null,
      size: formatBytes(num(row.mcap_bytes) ?? num(row.total_bytes)),
      duration: null,
      hash: null,
    },
    jobId: row.job_id,
    jobState: row.job_state,
    clipCount: row.clip_count,
  };
}

/**
 * Applicable actions from authoritative current state. Review clips needs the
 * current job to be succeeded with accepted clips; lifecycle controls come
 * only from an injected backend capability provider (none exists yet).
 */
export async function pipelineActionsFor(
  detail: PipelineDetail,
  controls: JobControlCapabilities = noJobControl,
): Promise<PipelineActions> {
  const control =
    detail.jobId && detail.jobState
      ? await controls.forJob({
          recordingId: detail.id,
          jobId: detail.jobId,
          state: detail.jobState,
        })
      : [];
  return {
    reviewClipsHref:
      detail.status === "completed" &&
      detail.jobId !== null &&
      detail.jobState === "succeeded" &&
      (detail.clipCount ?? 0) > 0
        ? reviewClipsHref(detail.id)
        : null,
    control: control.filter(
      (a) => a.jobId === detail.jobId && a.expectedState === detail.jobState,
    ),
  };
}
