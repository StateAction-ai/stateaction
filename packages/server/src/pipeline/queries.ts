import type { Queryable } from "../catalog/catalog.js";
import type { AnnotationCounts, ListCounts } from "./run-view.js";
import {
  PIPELINE_PAGE_SIZE,
  PIPELINE_STATUSES,
  STAGE_FAILURE_COUNTS,
  failedStageNote,
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
  type RecipeStage,
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
/** The digest of the job's newest completed segments.json (the one marks are pinned to). */
const LATEST_SEGMENTS_SHA = `(SELECT x.sha256 FROM files x
  WHERE x.job_id = j.id AND x.role = 'segments_json' AND x.purpose = 'output'
    AND x.state IN ('completed', 'verified')
  ORDER BY x.created_at DESC, x.id DESC LIMIT 1)`;
const STATUS_SQL = `CASE
  WHEN b.rec_status = 'cancelled' OR b.job_state = 'cancelled' THEN 'cancelled'
  WHEN b.job_state IN ('submit_unknown', 'needs_attention') THEN 'needs_attention'
  WHEN cardinality(b.failed_stages) > 0 THEN 'needs_attention'
  WHEN b.rec_status = 'failed' OR b.job_state = 'failed'
    OR b.admission_outcome = 'rejected' THEN 'failed'
  WHEN b.job_state = 'succeeded' THEN 'completed'
  WHEN b.job_state IN ('running', 'result_pending', 'cancel_requested') THEN 'processing'
  WHEN b.job_state IN ('queued', 'submitting')
    OR b.rec_status IN ('sealed', 'uploaded') THEN 'queued'
  WHEN b.rec_status IN ('processing', 'reviewable') THEN 'needs_attention'
  ELSE 'uploading' END`;

const STAGE_OUTPUT_FAILED_SQL = Object.entries(STAGE_FAILURE_COUNTS)
  .flatMap(([stage, keys]) =>
    keys.map(
      (
        key,
      ) => `(s.stage = '${stage}' AND jsonb_typeof(s.counts -> '${key}') = 'number'
      AND s.counts -> '${key}' > '0'::jsonb)`,
    ),
  )
  .join(" OR ");

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
    a.outcome AS admission_outcome, a.rejection_code,
    (j.recipe IS NOT NULL) AS has_recipe,
    j.segment_count, j.failed_window_count, j.caption_count, j.caption_failed_count,
    ARRAY(
      SELECT stage FROM (
        SELECT s.stage FROM job_stage_runs s
        WHERE s.job_id = j.id AND (s.state = 'failed' OR ${STAGE_OUTPUT_FAILED_SQL})
        UNION SELECT 'segment' WHERE j.failed_window_count > 0
        UNION SELECT 'caption' WHERE j.caption_failed_count > 0
      ) failed
      ORDER BY CASE stage WHEN 'segment' THEN 1 WHEN 'caption' THEN 2 ELSE 3 END
    ) AS failed_stages,
    EXISTS (
      SELECT 1 FROM job_output_slots o
      JOIN files f ON f.id = o.file_id AND f.job_id = o.job_id
        AND f.purpose = 'output' AND f.state IN ('completed', 'verified')
      WHERE o.job_id = j.id
        AND o.slot IN ('segments.json', 'captions.json', 'hand-presence.json')
    ) AS has_review_output,
    (SELECT count(DISTINCT m.segment_id)::int FROM segment_marks m
      WHERE m.job_id = j.id AND m.segments_sha256 = ${LATEST_SEGMENTS_SHA}) AS checked_count,
    (SELECT count(*)::int FROM (
       SELECT DISTINCT ON (m.segment_id) m.verdict FROM segment_marks m
       WHERE m.job_id = j.id AND m.segments_sha256 = ${LATEST_SEGMENTS_SHA}
       ORDER BY m.segment_id, m.revision DESC) latest
      WHERE latest.verdict = 'issue') AS issue_count
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
  has_recipe: boolean | null;
  segment_count: number | null;
  failed_window_count: number | null;
  caption_count: number | null;
  caption_failed_count: number | null;
  failed_stages: RecipeStage[];
  has_review_output: boolean;
  checked_count: number | null;
  issue_count: number | null;
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
  /** Accepted annotation counts; null fields = not accepted (unknown). */
  counts: ListCounts;
  /** The accepted job has output or a recorded failure that Review can explain. */
  reviewable: boolean;
  failedStages: RecipeStage[];
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
  const stages = failedStageNote(row.failed_stages);
  if (stages) return stages;
  const summary = pipelineErrorSummary(row.error_code);
  if (row.status === "needs_attention")
    return row.job_state === "submit_unknown"
      ? "Submission acknowledgement unknown"
      : (summary ?? "Needs staff attention");
  if (row.status === "failed")
    return summary ?? "Failure details are unavailable";
  return null;
}

function annotationCounts(row: Row): AnnotationCounts {
  return row.segment_count === null
    ? null
    : {
        segments: row.segment_count,
        failedWindows: row.failed_window_count,
        captions: row.caption_count,
        captionsFailed: row.caption_failed_count,
      };
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
    counts: {
      segments: row.segment_count,
      failedWindows: row.failed_window_count,
      captions: row.caption_count,
      captionsFailed: row.caption_failed_count,
      // Segments with a team mark, and those whose newest mark is an issue.
      teamChecks: row.checked_count ?? 0,
      teamIssues: row.issue_count ?? 0,
    },
    failedStages: row.failed_stages,
    reviewable:
      row.job_state === "succeeded" &&
      (row.has_review_output || row.failed_stages.length > 0),
  };
}

export async function listPipelineRecordings(
  pool: Queryable,
  staffUserId: string,
  query: PipelineQuery,
): Promise<PipelineList> {
  const offset = (query.page - 1) * PIPELINE_PAGE_SIZE;
  const filter = `WHERE ($2::text = '' OR collector_name ILIKE $2 ESCAPE '\\'
      OR id::text ILIKE $2 ESCAPE '\\'
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
  failedStages: RecipeStage[];
  reviewable: boolean;
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
  /** True when the job was admitted with a recipe (stage runs apply). */
  hasRecipe: boolean;
  /** Accepted annotation counts, or null when not accepted. */
  annotations: AnnotationCounts;
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
    failedStages: row.failed_stages,
    reviewable: item.reviewable,
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
    hasRecipe: row.has_recipe === true,
    annotations: annotationCounts(row),
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
      (detail.status === "completed" || detail.status === "needs_attention") &&
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
