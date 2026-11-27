import { PUBLIC_VIDEO_LABEL } from "../admission/public-video-canary.js";
import { SOURCE_REUPLOAD_ERROR_CODES } from "../jobs/recovery.js";
import {
  pipelineErrorSummary,
  RECIPE_STAGE_LABEL,
  STAGE_FAILURE_COUNTS,
  type JobState,
  type RecipeStage,
} from "./model.js";
import { stageReason } from "./run-view.js";

export type OperationStage = "clip_plan" | RecipeStage;
export type OperationError = {
  stage: OperationStage | null;
  code: string | null;
  summary: string;
};
export type RetryTarget =
  | {
      kind: "clip_plan";
      jobId: string;
      expectedState: JobState;
      available: boolean;
      reason: string | null;
    }
  | {
      kind: "failed_clips";
      clips: {
        clipId: string;
        jobId: string;
        graph: boolean;
        startSeconds: number | null;
        endSeconds: number | null;
      }[];
    };
export type ClipProgress = {
  total: number;
  completed: number;
  retryable: number;
};

const TIMEOUT_CODES = [
  "stage_timeout",
  "budget_exceeded",
  "deadline_exceeded",
  "execution_timeout",
  "timeout",
] as const;
export function timedOut(code: string | null) {
  return code !== null && (TIMEOUT_CODES as readonly string[]).includes(code);
}

const timeoutCodesSql = TIMEOUT_CODES.map((code) => `'${code}'`).join(", ");
const reuploadCodesSql = [...SOURCE_REUPLOAD_ERROR_CODES]
  .map((code) => `'${code}'`)
  .join(", ");

const OPERATION_REASONS = new Map([
  ["native_remux_failed", "The source video could not be prepared for preview"],
  [
    "worker_exited_without_result",
    "The worker exited without returning a result",
  ],
  ["source_sha_mismatch", "Source checksum mismatch"],
  ["source_digest_mismatch", "Source checksum mismatch"],
]);

export function operationError(
  stage: OperationStage | null,
  code: string | null,
  state: string,
): OperationError | null {
  const knownReason =
    pipelineErrorSummary(code) ??
    stageReason(code) ??
    OPERATION_REASONS.get(code ?? "") ??
    (timedOut(code) ? "Processing exceeded its time limit" : null) ??
    (code === "failed_outputs" && stage && stage !== "clip_plan"
      ? `${RECIPE_STAGE_LABEL[stage]} returned incomplete results`
      : null);
  const summary =
    knownReason ??
    (
      {
        failed: "Failure details are unavailable",
        cancelled: "Processing was cancelled",
        timed_out: "Processing exceeded its time limit",
        partially_complete: "Some processing results are unavailable",
        submit_unknown: "Submission acknowledgement is unknown",
        needs_attention: "Processing needs staff attention",
      } as Record<string, string>
    )[state];
  return summary ? { stage, code: knownReason ? code : null, summary } : null;
}

export const STAGE_OUTPUT_FAILED_SQL = Object.entries(STAGE_FAILURE_COUNTS)
  .flatMap(([stage, keys]) =>
    keys.map(
      (
        key,
      ) => `(s.stage = '${stage}' AND jsonb_typeof(s.counts -> '${key}') = 'number'
      AND s.counts -> '${key}' > '0'::jsonb)`,
    ),
  )
  .join(" OR ");

export const CLIP_STATUS_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT s.stage, s.state,
           CASE WHEN s.state IN ('failed', 'cancelled', 'submit_unknown') THEN s.error_code
             ELSE 'failed_outputs' END AS code
    FROM job_effective_stage_runs s
    WHERE s.job_id = live.id
      AND (s.state IN ('failed', 'cancelled', 'submit_unknown') OR ${STAGE_OUTPUT_FAILED_SQL})
    ORDER BY CASE WHEN s.state IN ('failed', 'cancelled') THEN 0 ELSE 1 END,
      job_stage_ord(s.stage)
    LIMIT 1
  ) failure ON true
  CROSS JOIN LATERAL (
    SELECT CASE
      WHEN live.state IN ('failed', 'cancelled', 'succeeded')
        AND coalesce(failure.code, live.error_code) IN (${timeoutCodesSql}) THEN 'timed_out'
      WHEN live.state IN ('failed', 'cancelled') THEN live.state
      WHEN live.state IN ('needs_attention', 'submit_unknown') THEN 'needs_attention'
      WHEN live.state IN ('running', 'result_pending', 'cancel_requested') THEN 'processing'
      WHEN live.state = 'succeeded' AND (failure.stage IS NOT NULL OR live.failed_window_count > 0
        OR live.caption_failed_count > 0) THEN 'partially_complete'
      WHEN live.state = 'succeeded' THEN 'completed'
      WHEN live.state IS NULL AND chosen.id IS NOT NULL THEN 'completed'
      ELSE 'queued'
    END AS status,
    coalesce(failure.stage, CASE WHEN live.failed_window_count > 0 THEN 'segment'
      WHEN live.caption_failed_count > 0 THEN 'caption' END) AS failure_stage,
    coalesce(failure.code, live.error_code, CASE WHEN live.failed_window_count > 0
      OR live.caption_failed_count > 0 THEN 'failed_outputs' END) AS error_code,
    failure.state IN ('failed', 'cancelled') AS terminal_stage
  ) clip_status`;

export const clipCanRetrySql = `(live.state IN ('failed', 'cancelled')
    OR (live.state = 'succeeded' AND (clip_status.terminal_stage
      OR live.failed_window_count > 0 OR live.caption_failed_count > 0)))
  AND (live.recipe IS NOT NULL OR (
    EXISTS (SELECT 1 FROM job_recipe_graph_definitions pinned WHERE pinned.job_id = live.id)
    AND NOT EXISTS (
      SELECT 1 FROM job_recipe_node_read_status node
      WHERE node.job_id = live.id AND node.state IN ('not_run','queued','running')
    )
  ))
  AND coalesce(live.error_code, '') NOT IN (${reuploadCodesSql})
  AND coalesce(clip_status.error_code, '') NOT IN (${reuploadCodesSql})`;

// The read-only console displays planning status without reading dispatch inputs
// or locking ingest permission evidence to decide if a retry can run.
export const recordingOperationsLaterals = (readOnly: boolean) => `
  LEFT JOIN recording_capture_profiles profile ON profile.recording_id = r.id
  LEFT JOIN LATERAL (
    SELECT j.id, j.state, j.error_code${
      readOnly
        ? ""
        : `, job_is_current(j.id) AS is_current,
      j.admitted_at IS NOT NULL AS admitted,
      EXISTS (SELECT 1 FROM job_execution_evidence e WHERE e.job_id = j.id) AS has_evidence,
      EXISTS (SELECT 1 FROM dispatch_admission a WHERE a.job_id = j.id) AS holds_slot,
      EXISTS (SELECT 1 FROM jobs child WHERE child.previous_job_id = j.id) AS has_successor,
      EXISTS (SELECT 1 FROM job_inputs i WHERE i.job_id = j.id
        AND i.task_input #>> '{simulation,provenance,camera,label}' = '${PUBLIC_VIDEO_LABEL}') AS canary`
    }
    FROM jobs j
    WHERE j.recording_id = r.id AND j.kind = 'clip_plan'
    ORDER BY (j.id = r.current_job_id) DESC NULLS LAST, j.created_at DESC, j.id DESC
    LIMIT 1
  ) planning ON true
  LEFT JOIN LATERAL (
    SELECT p.version, p.plan_job_id, p.plan
    FROM clip_plans p WHERE p.recording_id = r.id ORDER BY p.version DESC LIMIT 1
  ) plan ON true
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS total,
      count(*) FILTER (WHERE clip_status.status = 'completed')::int AS completed,
      count(*) FILTER (WHERE clip_status.status = 'processing')::int AS processing,
      count(*) FILTER (WHERE clip_status.status = 'queued')::int AS queued,
      count(*) FILTER (WHERE clip_status.status = 'needs_attention')::int AS attention,
      count(*) FILTER (WHERE clip_status.status = 'cancelled')::int AS cancelled,
      count(*) FILTER (WHERE clip_status.status = 'timed_out')::int AS timed_out,
      count(*) FILTER (WHERE clip_status.status IN ('failed', 'cancelled', 'timed_out', 'partially_complete'))::int AS incomplete,
      count(*) FILTER (WHERE clip_status.status = 'partially_complete' OR chosen.id IS NOT NULL)::int AS available,
      count(*) FILTER (WHERE live.kind = 'clip_pipeline')::int AS clip_scoped,
      jsonb_agg(jsonb_build_object('clipId', c.id, 'jobId', live.id,
        'graph', EXISTS (SELECT 1 FROM job_recipe_graph_definitions pinned WHERE pinned.job_id = live.id),
        'startSeconds', (c.start_ts_ns - (plan.plan ->> 'origin_ts_ns')::bigint) / 1000000000.0,
        'endSeconds', (c.end_ts_ns - (plan.plan ->> 'origin_ts_ns')::bigint) / 1000000000.0) ORDER BY c.ordinal, c.id)
        FILTER (WHERE ${clipCanRetrySql}) AS retry_clips,
      (array_agg(clip_status.failure_stage ORDER BY c.ordinal, c.id)
        FILTER (WHERE clip_status.failure_stage IS NOT NULL
          AND clip_status.status IN ('failed', 'cancelled', 'timed_out', 'partially_complete', 'needs_attention')))[1] AS failure_stage,
      (array_agg(clip_status.error_code ORDER BY c.ordinal, c.id)
        FILTER (WHERE clip_status.failure_stage IS NOT NULL
          AND clip_status.status IN ('failed', 'cancelled', 'timed_out', 'partially_complete', 'needs_attention')))[1] AS stage_error_code,
      (array_agg(clip_status.error_code ORDER BY c.ordinal, c.id)
        FILTER (WHERE clip_status.error_code IS NOT NULL
          AND clip_status.status IN ('failed', 'cancelled', 'timed_out', 'partially_complete', 'needs_attention')))[1] AS error_code
    FROM review_clips c
    LEFT JOIN jobs live ON live.id = c.live_job_id
    LEFT JOIN jobs chosen ON chosen.id = c.selected_job_id AND chosen.state = 'succeeded'
    ${CLIP_STATUS_LATERAL}
    WHERE c.recording_id = r.id AND c.plan_version = plan.version
  ) progress ON true`;

export function recordingStatusSql(fallback: string) {
  return `CASE
    WHEN profile.state = 'held' THEN profile.reason
    WHEN r.status = 'cancelled' THEN 'cancelled'
    WHEN planning.state IN ('failed', 'cancelled')
      AND planning.error_code IN (${timeoutCodesSql}) THEN 'timed_out'
    WHEN planning.state IN ('failed', 'cancelled') THEN planning.state
    WHEN planning.state IN ('needs_attention', 'submit_unknown') THEN 'needs_attention'
    WHEN planning.state IN ('running', 'result_pending', 'cancel_requested') THEN 'processing'
    WHEN planning.state IN ('queued', 'submitting') THEN 'queued'
    WHEN plan.plan_job_id IS NULL AND progress.clip_scoped = 0
      AND (progress.incomplete = 0 OR progress.available = 0) THEN ${fallback}
    WHEN progress.total = 0 THEN 'needs_attention'
    WHEN progress.completed = progress.total THEN 'completed'
    WHEN progress.processing > 0 THEN 'processing'
    WHEN progress.attention > 0 THEN 'needs_attention'
    WHEN progress.available > 0 AND progress.incomplete > 0 THEN 'partially_complete'
    WHEN progress.queued > 0 THEN 'queued'
    WHEN progress.cancelled = progress.total THEN 'cancelled'
    WHEN progress.timed_out = progress.total THEN 'timed_out'
    ELSE 'failed'
  END`;
}

export const recordingOperationColumns = (readOnly: boolean) => `
  planning.id AS planning_job_id,
  planning.state AS planning_state,
  planning.error_code AS planning_error_code,
  profile.code AS capture_profile_code,
  progress.total AS clip_total,
  progress.completed AS clip_completed,
  CASE WHEN planning.state IS NULL OR planning.state = 'succeeded' THEN progress.retry_clips END AS retry_clips,
  ${
    readOnly
      ? "NULL::text"
      : `CASE
    WHEN planning.state NOT IN ('failed', 'cancelled') OR planning.state IS NULL THEN NULL
    WHEN planning.canary THEN 'This public-video canary allows one approved attempt'
    WHEN coalesce(planning.error_code, '') IN (${reuploadCodesSql})
      THEN 'Ask the collector to upload corrected source'
    WHEN NOT planning.is_current OR planning.has_successor THEN 'A newer attempt superseded this job'
    WHEN planning.admitted AND (planning.holds_slot OR NOT planning.has_evidence)
      THEN 'Wait for the controller to record that execution stopped'
    WHEN r.status NOT IN ('uploaded', 'processing')
      THEN 'This recording cannot be processed in its current state'
    WHEN NOT EXISTS (
      SELECT 1 FROM recording_registrations rr WHERE rr.recording_id = r.id
        AND ingest_permission_ok(rr.ingest_permission_id, rr.owner_user_id, true)
    ) THEN 'Active permission to process this source is required'
  END`
  } AS retry_planning_block,
  progress.failure_stage AS clip_failure_stage,
  CASE WHEN progress.failure_stage IS NOT NULL THEN progress.stage_error_code ELSE progress.error_code END
    AS clip_error_code`;

export type RecordingOperationRow = {
  planning_job_id: string | null;
  planning_state: JobState | null;
  planning_error_code: string | null;
  capture_profile_code: string | null;
  clip_total: number;
  clip_completed: number;
  retry_clips: Extract<RetryTarget, { kind: "failed_clips" }>["clips"] | null;
  retry_planning_block: string | null;
  clip_failure_stage: RecipeStage | null;
  clip_error_code: string | null;
};

export function recordingOperationFields(
  row: RecordingOperationRow,
  readOnly = false,
) {
  const planningBlock = readOnly
    ? "This console is read-only"
    : row.retry_planning_block;
  const retryTarget: RetryTarget | null =
    (row.planning_state === "failed" || row.planning_state === "cancelled") &&
    row.planning_job_id
      ? {
          kind: "clip_plan",
          jobId: row.planning_job_id,
          expectedState: row.planning_state,
          available: planningBlock === null,
          reason: planningBlock,
        }
      : row.retry_clips?.length
        ? { kind: "failed_clips", clips: row.retry_clips }
        : null;
  const setupError =
    row.capture_profile_code === "capture_source_unmatched"
      ? {
          stage: null,
          code: row.capture_profile_code,
          summary: "Ask an engineer to configure this capture source",
        }
      : row.capture_profile_code === "recipe_unavailable"
        ? {
            stage: null,
            code: row.capture_profile_code,
            summary:
              "Ask an engineer to make a recipe available for this capture source",
          }
        : null;
  const error =
    setupError ??
    (row.planning_state && row.planning_state !== "succeeded"
      ? operationError("clip_plan", row.planning_error_code, row.planning_state)
      : operationError(
          row.clip_failure_stage,
          row.clip_error_code,
          row.clip_error_code ? "failed" : "",
        ));
  return {
    retryTarget,
    error,
    clipProgress: {
      total: row.clip_total,
      completed: row.clip_completed,
      retryable: row.retry_clips?.length ?? 0,
    } satisfies ClipProgress,
  };
}
