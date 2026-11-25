import type { SourceFrameRange } from "@stateaction/contracts";
import { uuid, type Queryable } from "../catalog/catalog.js";
import { CatalogError } from "../catalog/errors.js";
import {
  recordingDurationSql,
  recordingNameSql,
} from "../pipeline/recording-display.js";
import {
  MAX_READ_TTL_SECONDS,
  READ_LIMITS,
  READ_TTL_SECONDS,
  type BrokerDeps,
} from "./broker.js";
import { grantedTo } from "./queries.js";

export const BUILTIN_REVIEW_DATASETS = [
  { datasetId: "pending-review", name: "Pending Review" },
  { datasetId: "recycle-bin", name: "Recycle Bin" },
] as const;

export function reviewDatasetId(id: string): string {
  return id === "pending-review" || id === "recycle-bin" || id === "all-clips"
    ? id
    : uuid(id, "datasetId");
}

export const REVIEW_DATASET_ACCESS = `
  EXISTS (SELECT 1 FROM datasets d WHERE d.id::text = $2
    AND (catalog_has_role($1, 'staff') OR (
      catalog_has_role($1, 'customer') AND EXISTS (${grantedTo("d.id")}))))
  OR ($2 IN ('pending-review', 'recycle-bin', 'all-clips') AND catalog_has_role($1, 'staff'))`;

export type DatasetShareState = "shared" | "private" | "blocked";

export const shareStateSql = (dataset: string) => `
  CASE WHEN EXISTS (
    SELECT 1 FROM datasets_with_stale_review_clips s WHERE s.dataset_id = ${dataset}
  ) THEN 'blocked' WHEN EXISTS (
    SELECT 1 FROM dataset_access da
    JOIN dataset_sharing_permissions sp ON sp.id = da.sharing_permission_id
      AND sp.dataset_id = da.dataset_id AND sp.recipient_user_id = da.user_id
      AND sp.status = 'active'
    WHERE da.dataset_id = ${dataset} AND da.enabled AND catalog_has_role(da.user_id, 'customer')
  ) THEN 'shared' ELSE 'private' END`;

const resultMembership = `
  m.clip_id = s.clip_id AND m.job_id = s.job_id
  AND m.result_manifest_sha256 = s.manifest AND m.selection_revision = s.selection_revision`;

export const explicitReadGate = () => `
  catalog_has_role($1, 'staff') OR (
    catalog_has_role($1, 'customer') AND EXISTS (${grantedTo("m.dataset_id", "m")}))`;

/** Selected-result data shared by browse and scoped media authorization. */
export const SELECTED_REVIEW_CLIPS = `
  SELECT c.id AS clip_id, r.id AS recording_id, j.id AS job_id, selection.seq AS selection_revision,
    j.result_manifest_sha256 AS manifest, c.ordinal, c.created_at, selection.created_at AS selected_at,
    r.started_at AS captured_at, r.imported_from_cache,
    ${recordingNameSql(
      "r",
      "i.evidence #>> '{attribution,title}'",
      "i.evidence #>> '{attribution,dataset}'",
      recordingDurationSql("p.plan", "i.evidence -> 'durationSeconds'"),
    )} AS recording_title,
    j.failed_window_count, j.caption_failed_count,
    c.start_ts_ns, c.end_ts_ns, c.start_ordinal, c.end_ordinal,
    coalesce(c.start_ts_ns, legacy_origin.source_start_ns) AS clip_origin_ns,
    CASE WHEN c.start_ts_ns IS NOT NULL THEN p.plan ->> 'clock_domain'
      ELSE legacy_origin.clock_domain END AS clip_clock_domain,
    CASE WHEN c.end_ts_ns IS NOT NULL THEN c.end_ts_ns - c.start_ts_ns
      WHEN jsonb_typeof(i.evidence -> 'durationSeconds') = 'number'
        THEN round((i.evidence ->> 'durationSeconds')::numeric * 1000000000)::bigint
    END AS duration_ns,
    coalesce(c.start_ts_ns - (p.plan ->> 'origin_ts_ns')::bigint, 0)::text AS source_offset_ns,
    CASE WHEN c.start_ordinal IS NOT NULL THEN jsonb_build_object(
      'kind', 'clip', 'start_ordinal', c.start_ordinal, 'end_ordinal', c.end_ordinal,
      'first_source_frame_id', c.first_source_frame_id::text,
      'last_source_frame_id', c.last_source_frame_id::text,
      'start_ts_ns', c.start_ts_ns::text, 'end_ts_ns', c.end_ts_ns::text
    ) END AS source_range,
    CASE WHEN review.decision IS NULL OR review.decision = 'reopened' THEN 'pending'
      ELSE review.decision END AS review_status,
    review.task_label, review.notes, review.reviewer_user_id, review.created_at AS reviewed_at,
    poster.object_key AS poster_key, poster.size_bytes::text AS poster_size_bytes
  FROM review_clips c
  JOIN recordings r ON r.id = c.recording_id AND r.deleted_at IS NULL
  JOIN jobs j ON j.id = c.selected_job_id AND j.clip_id = c.id AND j.state = 'succeeded'
    AND j.result_manifest_sha256 IS NOT NULL
  JOIN LATERAL (
    SELECT seq, job_id, created_at FROM clip_result_selections
    WHERE clip_id = c.id ORDER BY seq DESC LIMIT 1
  ) selection ON selection.job_id = j.id
  JOIN clip_plans p ON p.recording_id = c.recording_id AND p.version = c.plan_version
  LEFT JOIN cached_processing_imports i ON i.job_id = j.id
  LEFT JOIN LATERAL (
    SELECT chunk.source_start_ns, chunk.clock_domain
    FROM clips chunk
    JOIN files f ON f.id = chunk.frame_map_file_id AND f.job_id = j.id
      AND f.purpose = 'output' AND f.role = 'frame_map_json' AND f.state = 'verified'
    WHERE chunk.job_id = j.id AND chunk.recording_id = c.recording_id AND chunk.ordinal = 0
  ) legacy_origin ON c.start_ts_ns IS NULL
  LEFT JOIN LATERAL (
    SELECT decision, task_label, notes, reviewer_user_id, created_at
    FROM review_clip_decisions
    WHERE clip_id = c.id AND job_id = j.id AND result_manifest_sha256 = j.result_manifest_sha256
      AND selection_revision = selection.seq
    ORDER BY revision DESC LIMIT 1
  ) review ON true
  LEFT JOIN LATERAL (
    SELECT f.object_key, f.size_bytes
    FROM clips chunk
    JOIN files f ON f.id = chunk.thumbnail_file_id AND f.job_id = j.id
      AND f.purpose = 'output' AND f.role = 'thumbnail_jpeg' AND f.state = 'verified'
      AND f.size_bytes BETWEEN 1 AND ${READ_LIMITS.thumbnail_jpeg}
    WHERE chunk.job_id = j.id AND chunk.recording_id = c.recording_id
      AND (c.start_ts_ns IS NULL OR (
        chunk.source_start_ns >= c.start_ts_ns AND chunk.source_end_ns <= c.end_ts_ns))
    ORDER BY CASE WHEN chunk.source_end_ns < c.start_ts_ns + (c.end_ts_ns - c.start_ts_ns) / 2
      THEN 1 ELSE 0 END, chunk.ordinal
    LIMIT 1
  ) poster ON true
`;

export const REVIEW_MEMBERS = `
  SELECT s.*, m.dataset_id::text AS dataset_id, m.added_at
  FROM selected s JOIN dataset_review_clips m ON ${resultMembership}
  WHERE s.review_status = 'approved' AND m.dataset_id::text = $2
    AND (${explicitReadGate()})
  UNION ALL
  SELECT s.*, $2 AS dataset_id, coalesce(s.reviewed_at, s.selected_at) AS added_at
  FROM selected s
  WHERE catalog_has_role($1, 'staff') AND (
    ($2 = 'pending-review' AND s.review_status = 'pending')
    OR ($2 = 'recycle-bin' AND s.review_status = 'rejected')
    OR $2 = 'all-clips')`;

type BindingRow = {
  clip_id: string;
  recording_id: string;
  job_id: string;
  manifest: string;
  selection_revision: number;
  source_range: SourceFrameRange | null;
  source_offset_ns: string;
  duration_ns: string | null;
  recording_title: string;
  ordinal: number;
  task_label: string | null;
  captured_at: Date;
  poster_key: string | null;
  poster_size_bytes: string | null;
};

async function authorizedRow(
  pool: Queryable,
  input: {
    viewerUserId: string;
    clipId: string;
    datasetId?: string | undefined;
  },
) {
  const { rows } = await pool.query<BindingRow>(
    `WITH selected AS (${SELECTED_REVIEW_CLIPS} WHERE c.id = $3),
     members AS (${REVIEW_MEMBERS})
     SELECT * FROM members
     UNION ALL
     SELECT s.*, NULL::text AS dataset_id, s.selected_at AS added_at FROM selected s
     WHERE $2 IS NULL AND catalog_has_role($1, 'staff')`,
    [
      input.viewerUserId,
      input.datasetId === undefined ? null : reviewDatasetId(input.datasetId),
      uuid(input.clipId, "clipId"),
    ],
  );
  return rows[0] ?? null;
}

/** Internal authorization binding. Never serialize this as customer data. */
export async function getAuthorizedReviewClip(
  pool: Queryable,
  input: {
    viewerUserId: string;
    clipId: string;
    datasetId?: string | undefined;
  },
) {
  const row = await authorizedRow(pool, input);
  return (
    row && {
      clipId: row.clip_id,
      recordingId: row.recording_id,
      jobId: row.job_id,
      resultManifestSha256: row.manifest,
      selectionRevision: row.selection_revision,
      sourceRange: row.source_range,
      sourceOffsetNs: row.source_offset_ns,
      durationNs: row.duration_ns,
    }
  );
}

export async function getDatasetReviewClip(
  pool: Queryable,
  input: { viewerUserId: string; clipId: string; datasetId: string },
) {
  const row = await authorizedRow(pool, input);
  return (
    row && {
      clipId: row.clip_id,
      datasetId: input.datasetId,
      title: row.recording_title,
      ordinal: row.ordinal,
      taskLabel: row.task_label,
      capturedAt: row.captured_at.toISOString(),
      durationNs: row.duration_ns,
      hasPoster: row.poster_key !== null,
    }
  );
}

export async function issueReviewClipPoster(
  deps: BrokerDeps,
  input: {
    viewerUserId: string;
    clipId: string;
    datasetId?: string | undefined;
  },
) {
  const ttl = deps.ttlSeconds ?? READ_TTL_SECONDS;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_READ_TTL_SECONDS)
    throw new CatalogError("invalid_request", "Invalid poster read TTL");
  const row = await authorizedRow(deps.pool, input);
  if (!row?.poster_key || !row.poster_size_bytes)
    throw new CatalogError("not_found", "Clip poster not found");
  const contentType = "image/jpeg";
  const url = await deps.signer.presignRead({
    key: row.poster_key,
    expiresInSeconds: ttl,
    contentType,
  });
  return {
    url,
    role: "thumbnail_jpeg" as const,
    contentType,
    sizeBytes: row.poster_size_bytes,
    ttlSeconds: ttl,
    expiresAt: new Date(
      (deps.now?.() ?? new Date()).getTime() + ttl * 1000,
    ).toISOString(),
  };
}
