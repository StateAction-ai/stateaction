import type {
  ClipPlanV1,
  CompiledGraph,
  DagRunNode,
  RecipeV1,
} from "@stateaction/contracts";
import { CAPTURE_SOURCES } from "../admission/capture-profiles.js";
import { inTransaction, type Queryable } from "../catalog/catalog.js";
import { recordingMp4MaxBytes } from "../datasets/broker.js";
import { retryStagesForOutputs } from "../jobs/stage-rerun-v2.js";
import { diagnosticSlot } from "../jobs/diagnostics.js";
import {
  parseRecordingId,
  STAGE_FAILURE_COUNTS,
  stageHasFailedOutputs,
  type JobState,
  type PipelineStatus,
  type RecipeStage,
} from "./model.js";
import {
  CLIP_STATUS_LATERAL,
  operationError,
  recordingOperationFields,
  timedOut,
  type OperationError,
  type OperationStage,
  type RecordingOperationRow,
} from "./operations-status.js";
import { RECORDING_IMPORT_LATERAL, staffRecordingsSql } from "./queries.js";
import { recordingDurationSql, recordingNameSql } from "./recording-display.js";
import { nodeDurationSeconds, type DiagnosticLink } from "./run-view.js";

import {
  compiledRecipeGraph,
  v1RecipeGraph,
  withStageStatus,
  type RecipeGraphNode,
} from "./recipe-graph.js";

type ReadDb = Pick<Queryable, "query">;

export type RecipeReference =
  | { kind: "recipe"; id: string; sha256: string; jobId: string | null }
  | { kind: "workflow"; id: string; jobId: string };

type ImportedRecipeReference =
  | { kind: "recipe"; recipeId: string; recipeSha256: string }
  | { kind: "workflow"; workflowId: string };

export function recipeReference(
  jobId: string,
  recipeId: string | null,
  sha256: string | null,
  imported: ImportedRecipeReference | null,
): RecipeReference | null {
  if (recipeId && sha256)
    return { kind: "recipe", id: recipeId, sha256, jobId };
  if (imported?.kind === "recipe")
    return {
      kind: "recipe",
      id: imported.recipeId,
      sha256: imported.recipeSha256,
      jobId: null,
    };
  if (imported?.kind === "workflow")
    return { kind: "workflow", id: imported.workflowId, jobId };
  return null;
}

type Device = {
  model: string | null;
  osVersion: string | null;
  appVersion: string | null;
};

export type CaptureProfileView = {
  state: "held" | "selected";
  reason: "needs_setup" | "choose_recipe" | null;
  code:
    | "capture_source_unmatched"
    | "recipe_unavailable"
    | "manual_selection"
    | null;
  captureSourceId: string | null;
  defaultRecipeId: string | null;
  allowedRecipeIds: string[];
  recipeId: string | null;
  recipeSha256: string | null;
  sourceManifestSha256: string;
  matchedAt: string;
  manuallySelected: boolean;
  evidence: {
    captureFormat: string | null;
    rgbProfile: string | null;
    captureConfigSha256: string | null;
    device: Device;
    channels: {
      topic: string;
      schemaName: string;
      messageEncoding: string;
      clockDomain: string;
    }[];
  };
};

type ProfileRow = {
  state: CaptureProfileView["state"];
  reason: CaptureProfileView["reason"];
  code: CaptureProfileView["code"];
  capture_source_id: string | null;
  allowed_recipe_ids: string[];
  recipe_id: string | null;
  recipe_sha256: string | null;
  matched_at: Date;
  manually_selected: boolean;
  evidence: Record<string, unknown>;
};

const string = (value: unknown) => (typeof value === "string" ? value : null);

function deviceEvidence(raw: unknown): Device {
  const device =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    model: string(device.model),
    osVersion: string(device.osVersion),
    appVersion: string(device.appVersion),
  };
}

function profileView(
  row: ProfileRow,
  sourceManifestSha256: string,
): CaptureProfileView {
  const source = CAPTURE_SOURCES.find(
    (entry) => entry.id === row.capture_source_id,
  );
  const e = row.evidence;
  const channels = Array.isArray(e.channels) ? e.channels : [];
  return {
    state: row.state,
    reason: row.reason,
    code: row.code,
    captureSourceId: row.capture_source_id,
    defaultRecipeId: source?.defaultRecipeId ?? null,
    allowedRecipeIds: row.allowed_recipe_ids,
    recipeId: row.recipe_id,
    recipeSha256: row.recipe_sha256,
    matchedAt: row.matched_at.toISOString(),
    manuallySelected: row.manually_selected,
    sourceManifestSha256,
    evidence: {
      captureFormat: string(e.captureFormat),
      rgbProfile: string(e.rgbProfile),
      captureConfigSha256: string(e.captureConfigSha256),
      device: deviceEvidence(e.device),
      channels: channels.flatMap((entry: unknown) => {
        if (!entry || typeof entry !== "object") return [];
        const channel = entry as Record<string, unknown>;
        const topic = string(channel.topic);
        const schemaName = string(channel.schema_name);
        const messageEncoding = string(channel.message_encoding);
        const clockDomain = string(channel.clock_domain);
        return topic && schemaName && messageEncoding && clockDomain
          ? [{ topic, schemaName, messageEncoding, clockDomain }]
          : [];
      }),
    },
  };
}

export type RecordingMetadata = {
  device: Device;
  captureSourceId: string | null;
  sourceLabel: string | null;
  captureFormat: string;
  rgbProfile: string;
  sourceManifestSha256: string | null;
  clientRecordingId: string;
  sizeBytes: number | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  canReadOriginal: boolean;
};

export type ClipOperationSummary = {
  id: string;
  ordinal: number;
  startSeconds: number | null;
  endSeconds: number | null;
  status: PipelineStatus;
  error: OperationError | null;
  latestJobId: string | null;
  selectedJobId: string | null;
};

export type OperationCost = {
  estimatedUsd: string | null;
  jobCount: number;
  jobsWithEstimate: number;
  jobsMissingEstimate: number;
  complete: boolean;
};

type JobCost = { estimatedUsd: string | null; complete: boolean };

export type OperationJob = {
  id: string;
  state: JobState;
  kind: "full" | "retry" | "stage_rerun" | "cached_import";
  parentJobId: string | null;
  trigger: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: OperationError | null;
  recipe: RecipeReference | null;
  cost: JobCost;
};

export type StageAttempt = {
  stage: OperationStage;
  jobId: string;
  recipeId: string | null;
  kind: OperationJob["kind"];
  parentJobId: string | null;
  trigger: string | null;
  state: JobState | DagRunNode["state"] | "partially_complete" | "timed_out";
  module: string | null;
  error: OperationError | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationSeconds: number | null;
  costUsd: string | null;
  compute: {
    kind: "cpu" | "gpu";
    requestedGpu: string | null;
    observedGpu: string | null;
  } | null;
  counts: Record<string, number>;
  diagnostics: DiagnosticLink[];
};

export type OperationStageHistory = {
  stage: OperationStage;
  latest: StageAttempt | null;
  attempts: StageAttempt[];
  reusedFromJobId: string | null;
  reusableOutput: boolean;
  importedEvidence: {
    jobId: string;
    generator: string | null;
    model: string | null;
    revision: string | null;
    gpu: string | null;
  } | null;
  enabled: boolean | null;
};

type RecordingSummary = {
  id: string;
  title: string;
  startedAt: string;
  canReadOriginal: boolean;
  metadata: RecordingMetadata;
};

export type RecordingOperations = RecordingSummary &
  ReturnType<typeof recordingOperationFields> & {
    status: PipelineStatus;
    captureProfile: CaptureProfileView | null;
    recipe: RecipeReference | null;
    graph: RecipeGraphNode[];
    clipPlanning: OperationStageHistory;
    plan: ClipPlanV1 | null;
    clips: ClipOperationSummary[];
    cost: OperationCost;
  };

export type ClipOperations = {
  recording: RecordingSummary;
  clip: ClipOperationSummary;
  recipe: RecipeReference | null;
  status: PipelineStatus;
  error: OperationError | null;
  stages: OperationStageHistory[];
  graph: RecipeGraphNode[];
  graphRuntime: boolean;
  retryStages: RecipeStage[];
  jobs: OperationJob[];
  selectionRevision: number;
  cost: OperationCost;
};

type ClipRow = {
  id: string;
  ordinal: number;
  start_seconds: number | null;
  end_seconds: number | null;
  status: PipelineStatus;
  failure_stage: RecipeStage | null;
  error_code: string | null;
  live_job_id: string | null;
  selected_job_id: string | null;
};

async function clipRows(
  pool: ReadDb,
  staff: string,
  recordingId: string,
  clipId: string | null,
) {
  const { rows } = await pool.query<ClipRow>(
    `SELECT c.id, c.ordinal, c.live_job_id, chosen.id AS selected_job_id,
       CASE WHEN p.plan_job_id IS NULL AND jsonb_typeof(imported.duration) = 'number' THEN 0
         ELSE (c.start_ts_ns - (p.plan ->> 'origin_ts_ns')::bigint)::float8 / 1000000000 END AS start_seconds,
       CASE WHEN p.plan_job_id IS NULL AND jsonb_typeof(imported.duration) = 'number' THEN imported.duration::float8
         ELSE (c.end_ts_ns - (p.plan ->> 'origin_ts_ns')::bigint)::float8 / 1000000000 END AS end_seconds,
       clip_status.status, clip_status.failure_stage, clip_status.error_code
     FROM review_clips c
     JOIN recordings r ON r.id = c.recording_id
     JOIN clip_plans p ON p.recording_id = c.recording_id AND p.version = c.plan_version
     LEFT JOIN jobs live ON live.id = c.live_job_id
     LEFT JOIN jobs chosen ON chosen.id = c.selected_job_id AND chosen.state = 'succeeded'
     ${RECORDING_IMPORT_LATERAL}
     ${CLIP_STATUS_LATERAL}
     WHERE r.id = $2 AND r.deleted_at IS NULL AND catalog_has_role($1, 'staff')
       AND (($3::uuid IS NOT NULL AND c.id = $3) OR ($3::uuid IS NULL AND p.version = (
         SELECT max(version) FROM clip_plans WHERE recording_id = r.id
       )))
     ORDER BY c.ordinal, c.id`,
    [staff, recordingId, clipId],
  );
  return rows;
}

function clipSummary(row: ClipRow): ClipOperationSummary {
  return {
    id: row.id,
    ordinal: row.ordinal,
    startSeconds: row.start_seconds,
    endSeconds: row.end_seconds,
    status: row.status,
    error: operationError(row.failure_stage, row.error_code, row.status),
    latestJobId: row.live_job_id,
    selectedJobId: row.selected_job_id,
  };
}

type SummaryRow = {
  id: string;
  started_at: Date;
  client_recording_id: string;
  source_manifest_sha256: string | null;
  title: string;
  dataset: string | null;
  size_bytes: string | null;
  duration_seconds: number | null;
  capture_format: string;
  rgb_profile: string;
  device: unknown;
  can_read_original: boolean;
  capture_source_id: string | null;
};

async function recordingSummary(
  pool: ReadDb,
  staff: string,
  recordingId: string,
) {
  const {
    rows: [row],
  } = await pool.query<SummaryRow>(
    `SELECT r.id, r.started_at, r.client_recording_id, r.source_manifest_sha256, r.capture_format,
      r.rgb_profile, r.device, profile.capture_source_id, imported.dataset,
      ${recordingNameSql("r", "imported.title", "imported.dataset", recordingDurationSql("p.plan", "imported.duration"))} AS title,
      (SELECT sum(f.size_bytes)::text FROM files f WHERE f.recording_id = r.id
        AND f.purpose = 'source' AND f.state IN ('completed', 'verified')) AS size_bytes,
      COALESCE(CASE WHEN jsonb_typeof(imported.duration) = 'number' THEN imported.duration::float8 END,
        (SELECT (max(c.end_ts_ns) - (p.plan ->> 'origin_ts_ns')::bigint)::float8 / 1000000000
         FROM review_clips c WHERE c.recording_id = r.id AND c.plan_version = p.version)) AS duration_seconds,
      EXISTS (
        SELECT 1 FROM jobs view_job
        LEFT JOIN review_clips origin_clip ON origin_clip.id = view_job.clip_id
        LEFT JOIN clip_plans origin_plan ON origin_plan.recording_id = r.id
          AND (origin_plan.version = origin_clip.plan_version OR origin_plan.plan_job_id = view_job.id)
        JOIN jobs origin ON origin.id = coalesce(origin_plan.plan_job_id, view_job.id) AND origin.state = 'succeeded'
        JOIN job_output_slots s ON s.job_id = origin.id
          AND (s.slot = 'recording.mp4' OR s.file_id = origin_plan.original_mp4_file_id)
        JOIN files f ON f.id = s.file_id AND f.job_id = s.job_id
          AND f.purpose = 'output' AND f.role = 'recording_mp4' AND f.state IN ('completed', 'verified')
          AND f.size_bytes <= $3
        WHERE view_job.id = coalesce(recording_selected_job(r.id), r.current_job_id)
          AND view_job.recording_id = r.id
          AND (view_job.state = 'succeeded' OR (view_job.kind = 'clip_pipeline' AND job_is_current(view_job.id)))
          AND (origin_plan.plan_job_id IS NULL OR (origin.result_manifest_sha256 = origin_plan.manifest_sha256
            AND f.id = origin_plan.original_mp4_file_id AND f.sha256 = origin_plan.original_mp4_sha256 AND f.state = 'verified'))
      ) AS can_read_original
     FROM recordings r
     LEFT JOIN recording_capture_profiles profile ON profile.recording_id = r.id
     LEFT JOIN LATERAL (
       SELECT version, plan, original_mp4_file_id FROM clip_plans
       WHERE recording_id = r.id ORDER BY version DESC LIMIT 1
     ) p ON true
     ${RECORDING_IMPORT_LATERAL}
     WHERE r.id = $2 AND r.deleted_at IS NULL AND catalog_has_role($1, 'staff')`,
    [staff, recordingId, recordingMp4MaxBytes()],
  );
  if (!row) return null;
  const source = CAPTURE_SOURCES.find(
    (entry) => entry.id === row.capture_source_id,
  );
  return {
    id: row.id,
    title: row.title,
    startedAt: row.started_at.toISOString(),
    canReadOriginal: row.can_read_original,
    metadata: {
      device: deviceEvidence(row.device),
      captureSourceId: row.capture_source_id,
      sourceLabel: row.dataset ?? source?.label ?? null,
      captureFormat: row.capture_format,
      rgbProfile: row.rgb_profile,
      sourceManifestSha256: row.source_manifest_sha256,
      clientRecordingId: row.client_recording_id,
      sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
      durationSeconds: row.duration_seconds,
      width: null,
      height: null,
      frameRate: null,
      canReadOriginal: row.can_read_original,
    },
  } satisfies RecordingSummary;
}

type JobRow = {
  id: string;
  kind: "clip_plan" | "clip_pipeline" | "process_recording" | "cached_import";
  state: JobState;
  previous_job_id: string | null;
  derived_from_job_id: string | null;
  triggered_by: string | null;
  created_at: Date;
  claimed_at: Date | null;
  finished_at: Date | null;
  error_code: string | null;
  recipe: RecipeV1 | null;
  recipe_sha256: string | null;
  compiled_graph: CompiledGraph | null;
  originating_recipe_ref: ImportedRecipeReference | null;
  imported_evidence: Record<string, Record<string, unknown>> | null;
  cost_usd: string | null;
  cost_complete: boolean;
};

export const JOB_COST_LATERAL = `LEFT JOIN LATERAL (
  SELECT sum(s.cost_estimate_usd)::text AS cost_usd,
    bool_and(s.cost_estimate_usd IS NOT NULL OR s.state IS NOT DISTINCT FROM 'not_run' OR reuse.stage IS NOT NULL)
      AND count(*) FILTER (WHERE s.cost_estimate_usd IS NOT NULL) > 0 AS cost_complete
  FROM jsonb_array_elements(j.recipe -> 'stages') spec
  LEFT JOIN job_stage_runs s ON s.job_id = j.id AND s.stage = spec ->> 'stage'
  LEFT JOIN job_stage_reuse reuse ON reuse.job_id = j.id AND reuse.stage = spec ->> 'stage'
  WHERE (spec ->> 'enabled')::boolean
) costs ON true`;

async function jobRows(
  pool: ReadDb,
  staff: string,
  recordingId: string,
  clipId: string | null,
) {
  const { rows } = await pool.query<JobRow>(
    `SELECT j.id, j.kind, j.state, j.previous_job_id, j.derived_from_job_id,
       actor.name AS triggered_by, j.created_at, j.claimed_at, j.finished_at,
       j.error_code, j.recipe, coalesce(g.recipe_sha256,j.recipe_sha256) AS recipe_sha256,
       g.graph AS compiled_graph, i.originating_recipe_ref, i.evidence -> 'evidence' AS imported_evidence,
       costs.cost_usd, coalesce(costs.cost_complete, false) AS cost_complete
     FROM jobs j JOIN recordings r ON r.id = j.recording_id
     LEFT JOIN job_recipe_graph_definitions g ON g.job_id = j.id
     LEFT JOIN cached_processing_imports i ON i.job_id = j.id AND i.manifest_sha256 = j.result_manifest_sha256
     LEFT JOIN job_rerun_plans rerun ON rerun.job_id = j.id
     LEFT JOIN "user" actor ON actor.id = rerun.actor_id
     ${JOB_COST_LATERAL}
     WHERE r.id = $2 AND r.deleted_at IS NULL AND catalog_has_role($1, 'staff')
       AND ($3::uuid IS NULL OR (j.clip_id = $3 AND j.kind <> 'clip_plan'))
     ORDER BY j.created_at DESC, j.id DESC`,
    [staff, recordingId, clipId],
  );
  return rows;
}

function jobView(row: JobRow): OperationJob {
  return {
    id: row.id,
    state: row.state,
    kind: row.derived_from_job_id
      ? "stage_rerun"
      : row.previous_job_id
        ? "retry"
        : row.kind === "cached_import"
          ? "cached_import"
          : "full",
    parentJobId: row.derived_from_job_id ?? row.previous_job_id,
    trigger:
      row.triggered_by ??
      (row.kind === "cached_import"
        ? "Cached import"
        : row.previous_job_id
          ? "Retry"
          : row.kind === "clip_plan" || row.kind === "clip_pipeline"
            ? "Automatic processing"
            : null),
    createdAt: row.created_at.toISOString(),
    startedAt: row.claimed_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
    error: operationError(
      row.kind === "clip_plan" ? "clip_plan" : null,
      row.error_code,
      row.state,
    ),
    recipe: recipeReference(
      row.id,
      row.compiled_graph?.recipe ?? row.recipe?.recipeId ?? null,
      row.recipe_sha256,
      row.originating_recipe_ref,
    ),
    cost: { estimatedUsd: row.cost_usd, complete: row.cost_complete },
  };
}

async function admittedGraph(
  db: ReadDb,
  job: JobRow | undefined,
  scope: "recording" | "clip",
) {
  if (!job?.compiled_graph) return null;
  const { rows } = await db.query<{ node_id: string; state: string }>(
    "SELECT node_id, state FROM job_recipe_node_read_status WHERE job_id = $1",
    [job.id],
  );
  const states = new Map(rows.map((row) => [row.node_id, row.state]));
  const nodes = compiledRecipeGraph(job.compiled_graph).filter(
    (node) => node.scope === scope,
  );
  const scopedIds = new Set(nodes.map((node) => node.id));
  const scoped = nodes.map((node) => ({
    ...node,
    parents: [
      ...new Set(
        node.parents.map((parent) =>
          scopedIds.has(parent) ? parent : "$input",
        ),
      ),
    ],
    status: states.get(node.id) ?? "not_run",
  }));
  if (scope === "clip") {
    const [source] = v1RecipeGraph(null, "clip");
    return [{ ...source!, status: "output_available" }, ...scoped];
  }
  return scoped;
}

function operationCost(jobs: OperationJob[]): OperationCost {
  const estimates = jobs.flatMap((job) =>
    job.cost.estimatedUsd === null
      ? []
      : [Math.round(Number(job.cost.estimatedUsd) * 100)],
  );
  const missing = jobs.filter((job) => !job.cost.complete).length;
  return {
    estimatedUsd: estimates.length
      ? (estimates.reduce((sum, cents) => sum + cents, 0) / 100).toFixed(2)
      : null,
    jobCount: jobs.length,
    jobsWithEstimate: estimates.length,
    jobsMissingEstimate: missing,
    complete: jobs.length > 0 && missing === 0,
  };
}

type StageRow = {
  job_id: string;
  stage: RecipeStage;
  state: DagRunNode["state"];
  module: string | null;
  error_code: string | null;
  counts: Record<string, number>;
  started_at: Date | null;
  finished_at: Date | null;
  requested_gpu: string | null;
  observed_gpu: string | null;
  cost_usd: string | null;
  recorded_execution: boolean;
  origin_job_id: string | null;
  output_available: boolean;
  diagnostics: { id: string; slot: string }[];
};

async function clipStageRows(
  pool: ReadDb,
  staff: string,
  recordingId: string,
  clipId: string,
) {
  const { rows } = await pool.query<StageRow>(
    `SELECT j.id AS job_id, e.stage, e.state, s.module, coalesce(e.error_code, s.unknown_reason) AS error_code,
       e.counts, coalesce(s.started_at, s.running_at) AS started_at,
       coalesce(s.finished_at, s.terminal_at) AS finished_at,
       s.requested_gpu, s.observed_gpu,
       CASE WHEN e.source_job_id IS NULL THEN s.cost_estimate_usd::text END AS cost_usd,
       (e.source_job_id IS NULL AND (s.call_id IS NOT NULL OR s.submitted_at IS NOT NULL
         OR s.started_at IS NOT NULL OR s.running_at IS NOT NULL
         OR s.state IN ('submitting', 'submit_unknown'))) AS recorded_execution,
       coalesce(e.execution_job_id, e.source_job_id) AS origin_job_id,
       (e.state = 'succeeded' AND (e.stage <> 'hand_pose' OR j.state = 'succeeded')
        AND EXISTS (
          SELECT 1 FROM job_output_slots slot JOIN files f ON f.id = slot.file_id AND f.job_id = slot.job_id
          WHERE slot.job_id = j.id AND f.purpose = 'output' AND f.state IN ('completed', 'verified')
            AND slot.slot = CASE e.stage WHEN 'segment' THEN 'segments.json'
              WHEN 'caption' THEN 'captions.json' ELSE 'hand-presence.json' END
        )) AS output_available,
       coalesce(logs.links, '[]'::jsonb) AS diagnostics
     FROM job_effective_stage_runs e JOIN jobs j ON j.id = e.job_id
     JOIN recordings r ON r.id = j.recording_id
     LEFT JOIN job_stage_runs s ON s.job_id = coalesce(e.execution_job_id, e.job_id) AND s.stage = e.stage
     LEFT JOIN LATERAL (
       SELECT jsonb_agg(jsonb_build_object('id', f.id, 'slot', slot.slot) ORDER BY slot.slot) AS links
       FROM job_output_slots slot JOIN files f ON f.id = slot.file_id AND f.job_id = slot.job_id
       WHERE slot.job_id = coalesce(e.execution_job_id, e.source_job_id, j.id)
         AND f.purpose = 'output' AND f.role = 'diagnostic_blob' AND f.state IN ('completed','verified')
         AND split_part(slot.slot, '/', 1) = 'diagnostics' AND split_part(slot.slot, '/', 2) = e.stage
     ) logs ON true
     WHERE r.id = $2 AND j.clip_id = $3 AND j.kind <> 'clip_plan'
       AND r.deleted_at IS NULL AND catalog_has_role($1, 'staff')
       AND NOT EXISTS (
         SELECT 1 FROM job_rerun_copies c JOIN files f ON f.id = c.file_id
         WHERE c.job_id = j.id AND c.stage = e.stage AND f.state NOT IN ('completed','verified')
       )
     ORDER BY j.created_at DESC, j.id DESC`,
    [staff, recordingId, clipId],
  );
  return rows;
}

function stageAttempt(row: StageRow, job: OperationJob): StageAttempt {
  const startedAt = row.started_at?.toISOString() ?? null;
  const finishedAt = row.finished_at?.toISOString() ?? null;
  const errorCode =
    row.error_code ??
    (stageHasFailedOutputs(row.stage, row.counts) ? "failed_outputs" : null);
  const diagnostics = row.diagnostics.flatMap(({ id, slot }) => {
    const diagnostic = diagnosticSlot(slot);
    return diagnostic
      ? [
          {
            name: diagnostic.name,
            href: `/api/v1/jobs/${row.origin_job_id ?? row.job_id}/diagnostics/${id}/read`,
          },
        ]
      : [];
  });
  return {
    stage: row.stage,
    jobId: row.job_id,
    recipeId: job.recipe?.kind === "recipe" ? job.recipe.id : null,
    kind: job.kind,
    parentJobId: job.parentJobId,
    trigger: job.trigger,
    state: timedOut(errorCode)
      ? "timed_out"
      : errorCode === "failed_outputs" && row.state === "succeeded"
        ? "partially_complete"
        : row.state,
    module: row.module,
    error: operationError(row.stage, errorCode, row.state),
    startedAt,
    finishedAt,
    durationSeconds: nodeDurationSeconds({ startedAt, finishedAt }),
    costUsd: row.cost_usd,
    compute: row.requested_gpu
      ? {
          kind: row.requested_gpu === "none" ? "cpu" : "gpu",
          requestedGpu: row.requested_gpu === "none" ? null : row.requested_gpu,
          observedGpu: row.observed_gpu,
        }
      : null,
    counts: row.counts,
    diagnostics,
  };
}

function planningAttempt(
  job: OperationJob,
  plan: ClipPlanV1 | null,
): StageAttempt {
  const error =
    plan?.state === "failed"
      ? operationError("clip_plan", plan.error_code, "failed")
      : job.error;
  return {
    stage: "clip_plan",
    jobId: job.id,
    recipeId: job.recipe?.kind === "recipe" ? job.recipe.id : null,
    kind: job.kind,
    parentJobId: job.parentJobId,
    trigger: job.trigger,
    state: timedOut(error?.code ?? null)
      ? "timed_out"
      : plan?.state === "failed"
        ? "failed"
        : job.state,
    module: plan?.producer.module_id ?? null,
    error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    durationSeconds: nodeDurationSeconds(job),
    costUsd: job.cost.estimatedUsd,
    compute: job.startedAt
      ? { kind: "cpu", requestedGpu: null, observedGpu: null }
      : null,
    counts: plan ? { frames: plan.frame_count } : {},
    diagnostics: [],
  };
}

export async function getRecordingOperations(
  pool: Queryable,
  staff: string,
  recordingId: string,
  readOnly = false,
): Promise<RecordingOperations | null> {
  if (!parseRecordingId(recordingId)) return null;
  return inTransaction(pool, async (db) => {
    // Retry eligibility reads witnessed termination with a row-share lock.
    await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const recording = await recordingSummary(db, staff, recordingId);
    if (!recording) return null;
    const queries = await db.query<
      RecordingOperationRow & {
        operations_status: PipelineStatus;
        rejection_code: string | null;
        error_code: string | null;
        active_recipe_job_id: string | null;
        latest_clip_plan: ClipPlanV1 | null;
        latest_clip_plan_job_id: string | null;
      }
    >(
      `${staffRecordingsSql(readOnly)} SELECT * FROM operations WHERE id = $2`,
      [staff, recordingId],
    );
    const jobs = await jobRows(db, staff, recordingId, null);
    const rows = await clipRows(db, staff, recordingId, null);
    const profile = await db.query<ProfileRow>(
      `SELECT p.state, p.reason, p.code, p.capture_source_id, p.allowed_recipe_ids,
       p.recipe_id, p.recipe_sha256, p.matched_at, p.evidence, p.selected_by IS NOT NULL AS manually_selected
     FROM recording_capture_profiles p JOIN recordings r ON r.id = p.recording_id
     WHERE r.id = $2 AND r.deleted_at IS NULL AND catalog_has_role($1, 'staff')`,
      [staff, recordingId],
    );
    const row = queries.rows[0];
    if (!row) return null;
    const profileRow = profile.rows[0];
    const digest = recording.metadata.sourceManifestSha256;
    const captureProfile =
      profileRow && digest ? profileView(profileRow, digest) : null;
    const allJobs = jobs.map(jobView);
    const planningJobs = jobs.flatMap((job, i) =>
      job.kind === "clip_plan"
        ? [
            planningAttempt(
              allJobs[i]!,
              job.id === row.latest_clip_plan_job_id
                ? row.latest_clip_plan
                : null,
            ),
          ]
        : [],
    );
    const fields = recordingOperationFields(row, readOnly);
    const selectedJob = rows.find(
      (clip) => clip.selected_job_id,
    )?.selected_job_id;
    const recipe =
      allJobs.find((job) => job.id === row.active_recipe_job_id)?.recipe ??
      (captureProfile?.recipeId && captureProfile.recipeSha256
        ? ({
            kind: "recipe",
            id: captureProfile.recipeId,
            sha256: captureProfile.recipeSha256,
            jobId: null,
          } as const)
        : null) ??
      allJobs.find((job) => job.id === selectedJob)?.recipe ??
      allJobs.find((job, i) => jobs[i]?.kind === "cached_import")?.recipe ??
      null;
    const clipPlanning: OperationStageHistory = {
      stage: "clip_plan",
      latest:
        planningJobs.find((job) => job.jobId === row.planning_job_id) ?? null,
      attempts: planningJobs.filter((job) => job.state !== "queued"),
      reusedFromJobId: null,
      reusableOutput: false,
      importedEvidence: null,
      enabled: planningJobs.length ? true : null,
    };
    const clips = rows.map(clipSummary);
    const recordingGraph = await admittedGraph(
      db,
      jobs.find(
        (job) =>
          job.id === (row.planning_job_id ?? row.latest_clip_plan_job_id),
      ),
      "recording",
    );
    return {
      ...recording,
      ...fields,
      error:
        fields.error ??
        operationError(
          null,
          row.rejection_code ?? row.error_code,
          row.operations_status,
        ),
      status: row.operations_status,
      captureProfile,
      recipe,
      clipPlanning,
      graph: (recordingGraph ?? v1RecipeGraph(null, "recording")).map(
        (node) => {
          if (node.id === "$clips") {
            const failed = clips.filter(({ status }) =>
              [
                "failed",
                "partially_complete",
                "timed_out",
                "cancelled",
              ].includes(status),
            ).length;
            const active = clips.filter(
              ({ status }) => status === "processing" || status === "queued",
            ).length;
            return {
              ...node,
              status: !clips.length
                ? "not_run"
                : failed
                  ? "failed"
                  : active
                    ? "processing"
                    : "output_available",
              summary: `${clips.length} total${failed ? ` · ${failed} failed` : active ? ` · ${active} active` : ""}`,
            };
          }
          if (recordingGraph && node.id !== "$source") return node;
          if (node.id === "clip_plan") {
            return clipPlanning.latest
              ? withStageStatus(node, clipPlanning)
              : {
                  ...node,
                  status:
                    row.latest_clip_plan?.state === "failed"
                      ? "failed"
                      : row.latest_clip_plan
                        ? "succeeded"
                        : (captureProfile?.reason ?? "not_run"),
                };
          }
          return {
            ...node,
            status: recording.canReadOriginal ? "output_available" : "not_run",
          };
        },
      ),
      plan: row.latest_clip_plan,
      clips,
      cost: operationCost(allJobs),
    };
  });
}

export async function getClipOperations(
  pool: Queryable,
  staff: string,
  recordingId: string,
  clipId: string,
): Promise<ClipOperations | null> {
  if (!parseRecordingId(recordingId) || !parseRecordingId(clipId)) return null;
  return inTransaction(pool, async (db) => {
    await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const recording = await recordingSummary(db, staff, recordingId);
    if (!recording) return null;
    const [row] = await clipRows(db, staff, recordingId, clipId);
    if (!row) return null;
    const clip = clipSummary(row);
    const {
      rows: [selection],
    } = await db.query<{ seq: number }>(
      "SELECT seq FROM clip_result_selections WHERE clip_id = $1 ORDER BY seq DESC LIMIT 1",
      [clipId],
    );
    const jobs = await jobRows(db, staff, recordingId, clipId);
    const stageRows = await clipStageRows(db, staff, recordingId, clipId);
    const views = jobs.map(jobView);
    const byId = new Map(views.map((job) => [job.id, job]));
    const latestId = clip.latestJobId ?? clip.selectedJobId;
    const currentJob = jobs.find((job) => job.id === latestId);
    const clipGraph = await admittedGraph(db, currentJob, "clip");
    const importJob =
      jobs.find(
        (job) => job.id === clip.selectedJobId && job.kind === "cached_import",
      ) ??
      jobs.find((job) => job.id === latestId && job.kind === "cached_import");
    const stages = (Object.keys(STAGE_FAILURE_COUNTS) as RecipeStage[]).map(
      (stage): OperationStageHistory => {
        const scoped = stageRows.filter((row) => row.stage === stage);
        const current = scoped.find((row) => row.job_id === latestId);
        const currentView = current ? byId.get(current.job_id) : null;
        const imported = importJob?.imported_evidence?.[stage];
        return {
          stage,
          latest:
            current && currentView ? stageAttempt(current, currentView) : null,
          attempts: scoped
            .filter((row) => row.recorded_execution && byId.has(row.job_id))
            .map((row) => stageAttempt(row, byId.get(row.job_id)!)),
          reusedFromJobId: current?.origin_job_id ?? null,
          reusableOutput:
            !!current?.output_available &&
            current.state === "succeeded" &&
            !stageHasFailedOutputs(stage, current.counts),
          importedEvidence:
            imported && importJob
              ? {
                  jobId: importJob.id,
                  generator: string(imported.generator),
                  model: string(imported.model),
                  revision: string(imported.revision),
                  gpu: string(
                    imported.observedGpu ??
                      imported.gpuReport ??
                      imported.requestedGpu,
                  ),
                }
              : null,
          enabled:
            currentJob?.recipe?.stages.find((spec) => spec.stage === stage)
              ?.enabled ?? null,
        };
      },
    );
    return {
      recording,
      clip,
      recipe:
        (latestId ? byId.get(latestId)?.recipe : null) ??
        (clip.selectedJobId ? byId.get(clip.selectedJobId)?.recipe : null) ??
        null,
      status: clip.status,
      error: clip.error,
      stages,
      graphRuntime: clipGraph !== null,
      graph:
        clipGraph ??
        v1RecipeGraph(currentJob?.recipe ?? null, "clip", stages).map((node) =>
          node.id === "$input"
            ? {
                ...node,
                status: recording.canReadOriginal
                  ? "output_available"
                  : "not_run",
              }
            : withStageStatus(
                node,
                stages.find((stage) => stage.stage === node.id),
              ),
        ),
      retryStages:
        currentJob?.recipe &&
        ["succeeded", "failed", "cancelled"].includes(currentJob.state) &&
        [
          "failed",
          "partially_complete",
          "timed_out",
          "cancelled",
          "needs_attention",
        ].includes(clip.status)
          ? retryStagesForOutputs(
              currentJob.recipe,
              stageRows.filter(
                (entry) =>
                  entry.job_id === latestId && entry.state === "succeeded",
              ),
              currentJob.state === "succeeded",
              row.failure_stage,
            )
          : [],
      jobs: views,
      selectionRevision: selection?.seq ?? 0,
      cost: operationCost(views),
    };
  });
}
