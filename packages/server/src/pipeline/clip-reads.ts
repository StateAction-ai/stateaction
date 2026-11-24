import type pg from "pg";
import type {
  ClipListItem,
  ClipListQuery,
  ClipPipelineState,
  ClipPlanV1,
  ClipQueueStatus,
  ClipReadModel,
  ClipSelectedResultRef,
  ClipViewerChunk,
  DagRunV1,
  JobState,
  SourceFrameRange,
} from "@stateaction/contracts";
import {
  loadRecordingAnnotations,
  type AnnotationDeps,
} from "../annotations/annotations.js";
import { uuid } from "../catalog/catalog.js";
import { CatalogError } from "../catalog/errors.js";
import { issueRecordingRead, type ReadSigner } from "../datasets/broker.js";
import {
  effectiveSegmentMarksSql,
  getSegmentMarks,
} from "../datasets/marks.js";
import { getDagRunWithLineage } from "../jobs/stages.js";
import { TransportError } from "../transport/errors.js";
import { recordingTitle } from "./model.js";

type ClipRow = {
  id: string;
  recording_id: string;
  plan_version: number;
  ordinal: number;
  range: SourceFrameRange | null;
  live_job_id: string | null;
  selected_job_id: string | null;
  started_at: Date;
  created_at: Date;
  cursor_created_at: string;
  owner_user_id: string;
  collector_name: string;
  import_title: string | null;
  source_offset_ns: string | null;
  duration_ns: string | null;
  job_state: JobState | null;
  pipeline_state: ClipPipelineState;
  error_code: string | null;
  has_recipe: boolean;
  selected_has_recipe: boolean;
  manifest_sha256: string | null;
  selection_revision: number | null;
  selected_kind: string | null;
  failed_window_count: number | null;
  caption_failed_count: number | null;
  marks: ClipListItem["marks"];
  review_status: ClipQueueStatus;
  can_read_original: boolean;
};

// Filter and page over stored facts before rendering a DAG or reading an object.
const selectClips = `
  SELECT c.id, c.recording_id, c.plan_version, c.ordinal, c.live_job_id, c.selected_job_id,
    c.created_at, c.created_at::text AS cursor_created_at, r.started_at, r.owner_user_id,
    u.name AS collector_name,
    i.evidence -> 'attribution' ->> 'title' AS import_title,
    CASE WHEN c.start_ordinal IS NOT NULL THEN jsonb_build_object(
      'kind', 'clip', 'start_ordinal', c.start_ordinal, 'end_ordinal', c.end_ordinal,
      'first_source_frame_id', c.first_source_frame_id::text, 'last_source_frame_id', c.last_source_frame_id::text,
      'start_ts_ns', c.start_ts_ns::text, 'end_ts_ns', c.end_ts_ns::text
    ) END AS range,
    CASE WHEN p.plan_job_id IS NULL THEN '0'
      ELSE (c.start_ts_ns - (p.plan ->> 'origin_ts_ns')::bigint)::text END AS source_offset_ns,
    CASE WHEN c.end_ts_ns IS NOT NULL THEN (c.end_ts_ns - c.start_ts_ns)::text
      WHEN jsonb_typeof(i.evidence -> 'durationSeconds') = 'number'
        THEN round((i.evidence ->> 'durationSeconds')::numeric * 1000000000)::text
    END AS duration_ns,
    live.state AS job_state, live.error_code, live.recipe IS NOT NULL AS has_recipe,
    chosen.recipe IS NOT NULL AS selected_has_recipe,
    chosen.result_manifest_sha256 AS manifest_sha256, selection.seq AS selection_revision,
    chosen.kind AS selected_kind, live.failed_window_count, live.caption_failed_count,
    CASE WHEN live.state = 'succeeded' THEN
      CASE WHEN coalesce(live.failed_window_count, 0) > 0 OR coalesce(live.caption_failed_count, 0) > 0
        OR EXISTS (SELECT 1 FROM job_effective_stage_runs sr WHERE sr.job_id = live.id
                   AND sr.state IN ('failed', 'cancelled')) THEN 'partially_failed' ELSE 'succeeded' END
      WHEN live.state IN ('failed','cancelled') THEN 'failed'
      WHEN live.state IS NULL OR live.state = 'queued' THEN 'queued'
      ELSE 'processing'
    END AS pipeline_state,
    CASE WHEN chosen.segment_count IS NOT NULL THEN jsonb_build_object(
      'segmentCount', chosen.segment_count,
      'checkedCount', marks.checked_count, 'issueCount', marks.issue_count
    ) END AS marks,
    CASE WHEN chosen.result_manifest_sha256 IS NULL OR selection.seq IS NULL THEN 'not_ready'
      ELSE coalesce(review.decision, 'pending') END AS review_status,
    (p.original_mp4_file_id IS NOT NULL OR EXISTS (
      SELECT 1 FROM job_output_slots s
      JOIN files f ON f.id = s.file_id AND f.job_id = s.job_id AND f.role = 'recording_mp4'
      WHERE s.job_id = chosen.id AND s.slot = 'recording.mp4' AND f.state IN ('completed','verified')
    )) AS can_read_original
  FROM review_clips c
  JOIN recordings r ON r.id = c.recording_id AND r.deleted_at IS NULL
  JOIN "user" u ON u.id = r.owner_user_id
  JOIN clip_plans p ON p.recording_id = c.recording_id AND p.version = c.plan_version
  LEFT JOIN jobs live ON live.id = c.live_job_id
  LEFT JOIN jobs chosen ON chosen.id = c.selected_job_id AND chosen.state = 'succeeded'
  LEFT JOIN cached_processing_imports i ON i.job_id = chosen.id
  LEFT JOIN LATERAL (
    SELECT seq, job_id FROM clip_result_selections WHERE clip_id = c.id ORDER BY seq DESC LIMIT 1
  ) selection ON selection.job_id = chosen.id
  LEFT JOIN LATERAL (
    SELECT f.sha256 FROM files f
    WHERE f.job_id = chosen.id AND f.role = 'segments_json' AND f.purpose = 'output'
      AND f.state IN ('completed', 'verified')
    ORDER BY f.created_at DESC, f.id DESC LIMIT 1
  ) segments ON chosen.segment_count IS NOT NULL
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS checked_count,
      count(*) FILTER (WHERE m.verdict = 'issue')::int AS issue_count
    FROM (${effectiveSegmentMarksSql("chosen.id", "segments.sha256", "verdict")}) m
  ) marks ON chosen.segment_count IS NOT NULL
  LEFT JOIN LATERAL (
    SELECT decision FROM review_clip_decisions
    WHERE clip_id = c.id AND job_id = chosen.id
      AND result_manifest_sha256 = chosen.result_manifest_sha256
      AND selection_revision = selection.seq
    ORDER BY revision DESC LIMIT 1
  ) review ON chosen.id IS NOT NULL
  WHERE catalog_has_role($1, 'staff')`;

async function effectiveDag(
  pool: pg.Pool,
  jobId: string | null,
  hasRecipe: boolean,
) {
  if (!jobId || !hasRecipe) return null;
  try {
    const {
      derivedFromJobId: _parent,
      execute: _execute,
      reuse: _reuse,
      ...run
    } = await getDagRunWithLineage({ pool }, jobId);
    return { ...run, schemaVersion: 1 } satisfies DagRunV1;
  } catch (error) {
    if (error instanceof TransportError && error.code === "not_found")
      return null;
    throw error;
  }
}

function resultRef(row: ClipRow): ClipSelectedResultRef | null {
  return row.selected_job_id &&
    row.manifest_sha256 &&
    row.selection_revision !== null
    ? {
        jobId: row.selected_job_id,
        resultManifestSha256: row.manifest_sha256,
        selectionRevision: row.selection_revision,
        source:
          row.selected_kind === "cached_import" ? "imported" : "processed",
      }
    : null;
}

function item(row: ClipRow, dag: DagRunV1 | null): ClipListItem {
  return {
    id: row.id,
    recordingId: row.recording_id,
    planVersion: row.plan_version,
    ordinal: row.ordinal,
    sourceRange: row.range,
    liveJobId: row.live_job_id,
    selectedJobId: row.selected_job_id,
    recordingTitle: row.import_title ?? recordingTitle(row.started_at),
    collectorId: row.owner_user_id,
    collectorName: row.collector_name,
    createdAt: row.created_at.toISOString(),
    sourceOffsetNs: row.source_offset_ns,
    durationNs: row.duration_ns,
    pipeline: {
      state: row.pipeline_state,
      jobState: row.job_state,
      errorCode: row.error_code,
      estimatedCostUsd: dag?.estimatedCostUsd ?? null,
      stages: dag?.stages ?? [],
      failureCounts: {
        failedWindows: row.failed_window_count,
        failedCaptions: row.caption_failed_count,
      },
    },
    reviewStatus: row.review_status,
    selectedResult: resultRef(row),
    marks: row.marks,
  };
}

function cursorOf(value: string | undefined) {
  if (value === undefined) return [null, null] as const;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value))
    throw new CatalogError("invalid_request", "Invalid clip cursor");
  const [time, id, extra] = Buffer.from(value, "base64url")
    .toString()
    .split("|");
  if (
    extra !== undefined ||
    !id ||
    !time ||
    !/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d{1,6})?[+-]\d\d(?::\d\d)?$/.test(
      time,
    ) ||
    !Number.isFinite(Date.parse(time))
  )
    throw new CatalogError("invalid_request", "Invalid clip cursor");
  return [time, uuid(id, "cursor")] as const;
}

function aggregateState(
  states: ClipPipelineState[],
  planState: JobState | null,
): ClipPipelineState {
  if (!states.length)
    return planState === "failed" || planState === "cancelled"
      ? "failed"
      : planState && planState !== "queued"
        ? "processing"
        : "queued";
  if (states.some((state) => state === "queued" || state === "processing"))
    return "processing";
  if (states.every((state) => state === "succeeded")) return "succeeded";
  if (states.every((state) => state === "failed")) return "failed";
  return "partially_failed";
}

export function persistedClipReads(
  deps: AnnotationDeps & { signer: ReadSigner },
): ClipReadModel {
  const { pool } = deps;
  const withDag = async (row: ClipRow) =>
    item(row, await effectiveDag(pool, row.live_job_id, row.has_recipe));
  const find = async (staff: string, clipId: string) =>
    (
      await pool.query<ClipRow>(`${selectClips} AND c.id = $2`, [
        staff,
        uuid(clipId, "clipId"),
      ])
    ).rows[0];
  return {
    async listClips(staff, query: ClipListQuery) {
      const limit = query.limit ?? 25;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw new CatalogError("invalid_request", "Clip limit must be 1–100");
      const [cursorTime, cursorId] = cursorOf(query.cursor);
      const { rows } = await pool.query<ClipRow>(
        `WITH candidates AS (
           ${selectClips}
           AND ($2::uuid IS NULL OR c.recording_id = $2)
           AND ($3::text IS NULL OR r.owner_user_id = $3)
           AND ($4::timestamptz IS NULL OR (c.created_at, c.id) > ($4, $5::uuid))
         )
         SELECT * FROM candidates WHERE ($6::text IS NULL OR pipeline_state = $6)
           AND ($7::text IS NULL OR review_status = $7)
         ORDER BY created_at, id LIMIT $8`,
        [
          staff,
          query.recordingId ? uuid(query.recordingId, "recordingId") : null,
          query.collectorId ?? null,
          cursorTime,
          cursorId,
          query.pipelineState ?? null,
          query.reviewStatus ?? null,
          limit + 1,
        ],
      );
      const clips = [];
      for (const row of rows.slice(0, limit)) clips.push(await withDag(row));
      const last = rows[limit - 1];
      const nextCursor =
        last && rows.length > limit
          ? Buffer.from(`${last.cursor_created_at}|${last.id}`).toString(
              "base64url",
            )
          : null;
      return { clips, nextCursor };
    },
    async getClip(staff, clipId) {
      const row = await find(staff, clipId);
      if (!row) return null;
      const currentDag = await effectiveDag(
        pool,
        row.live_job_id,
        row.has_recipe,
      );
      const selectedDag =
        row.selected_job_id === row.live_job_id
          ? currentDag
          : await effectiveDag(
              pool,
              row.selected_job_id,
              row.selected_has_recipe,
            );
      return {
        ...item(row, currentDag),
        currentDag,
        selectedDag,
        canReadOriginal: row.can_read_original,
      };
    },
    async getSelectedResult(staff, clipId, selected) {
      const row = await find(staff, clipId);
      const ref = row && resultRef(row);
      if (
        !row ||
        !ref ||
        ref.jobId !== selected.jobId ||
        ref.resultManifestSha256 !== selected.resultManifestSha256 ||
        ref.selectionRevision !== selected.selectionRevision ||
        ref.source !== selected.source
      )
        return null;
      const { rows: viewerChunks } = await pool.query<ClipViewerChunk>(
        `SELECT c.id AS "chunkId", c.source_start_ns::text AS "startNs", c.source_end_ns::text AS "endNs"
         FROM clips c JOIN jobs j ON j.id = c.job_id
         WHERE c.job_id = $1 AND j.result_manifest_sha256 = $2 AND j.state = 'succeeded'
         ORDER BY c.ordinal`,
        [ref.jobId, ref.resultManifestSha256],
      );
      const annotations = await loadRecordingAnnotations(
        deps,
        staff,
        row.recording_id,
        ref.jobId,
      );
      const segmentMarks = row.marks
        ? await getSegmentMarks(pool, {
            viewerUserId: staff,
            recordingId: row.recording_id,
            viewJobId: ref.jobId,
            includeOrigins: true,
          })
        : null;
      // Do not return annotations or marks after the selection changed during I/O.
      const latest = await find(staff, clipId);
      if (
        !latest ||
        latest.selected_job_id !== ref.jobId ||
        latest.selection_revision !== ref.selectionRevision
      )
        return null;
      return {
        ...ref,
        annotations,
        segmentMarks,
        viewerChunks,
        viewerChunkIds: viewerChunks.map((c) => c.chunkId),
      };
    },
    async getRecording(staff, recordingId) {
      const {
        rows: [rec],
      } = await pool.query<{
        started_at: Date;
        state: JobState | null;
        plan: ClipPlanV1 | null;
        plan_version: number | null;
        status: string;
      }>(
        `SELECT r.started_at, r.status, j.state, p.plan, p.version AS plan_version
         FROM recordings r LEFT JOIN jobs j ON j.id = r.current_job_id
         LEFT JOIN LATERAL (
           SELECT version, plan FROM clip_plans WHERE recording_id = r.id ORDER BY version DESC LIMIT 1
         ) p ON true WHERE r.id = $2 AND r.deleted_at IS NULL AND catalog_has_role($1, 'staff')`,
        [staff, uuid(recordingId, "recordingId")],
      );
      if (!rec) return null;
      const { rows } = await pool.query<ClipRow>(
        `${selectClips} AND c.recording_id = $2 AND c.plan_version = $3 ORDER BY c.ordinal`,
        [staff, recordingId, rec.plan_version],
      );
      const clips = [];
      for (const row of rows) clips.push(await withDag(row));
      return {
        id: recordingId,
        title: clips[0]?.recordingTitle ?? recordingTitle(rec.started_at),
        state:
          rec.status === "failed"
            ? "failed"
            : aggregateState(
                clips.map((c) => c.pipeline.state),
                rec.state,
              ),
        plan: rec.plan,
        canReadOriginal: rows.some((r) => r.can_read_original),
        clips,
      };
    },
    async readSource(staff, recordingId) {
      try {
        return await issueRecordingRead(deps, {
          viewerUserId: staff,
          recordingId,
          role: "recording_mp4",
        });
      } catch (error) {
        if (error instanceof CatalogError && error.code === "not_found")
          return null;
        throw error;
      }
    },
  };
}
