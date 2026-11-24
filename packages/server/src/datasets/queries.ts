import {
  decodeCursor,
  encodeCursor,
  pageSize,
  requireRole,
  TS,
  uuid,
  type Queryable,
} from "../catalog/catalog.js";
import { CatalogError, toCatalogError } from "../catalog/errors.js";
import type {
  ClipSimulation,
  DatasetClipView,
  DatasetView,
  Page,
  StaffClipView,
} from "./types.js";

/**
 * Bounded dataset/clip reads (SA-35). One definition of "visible member" is
 * shared by the dataset counts, the member grid, clip detail and the read
 * broker, so a count can never disagree with the grid it summarizes and a
 * stale snapshot is impossible (every read is one statement).
 *
 * A clip is externally visible in dataset D to viewer V only when ALL hold at
 * the time of the statement:
 *   - V holds an enabled role (staff, or customer) read from `access`;
 *   - the clip is a member of D (dataset_clips);
 *   - the clip's LATEST review is approved;
 *   - the clip belongs to the recording's current, succeeded job (a retry or
 *     a deleted recording hides stale outputs);
 *   - customer only: an enabled dataset_access grant for (D, V) resting on
 *     ACTIVE recipient-sharing evidence that has cleared this clip.
 * Customers have no catalog read other than through these predicates, so
 * "All clips" and recording-wide browsing do not exist for them.
 * Parameter $1 is always the viewer's opaque auth user id.
 */
const ts = (column: string) => TS.replace("%s", column);

function filterText(value: string | undefined): string {
  if (value === undefined) return "";
  if (
    typeof value !== "string" ||
    value.length > 160 ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new CatalogError(
      "invalid_request",
      "Search must be at most 160 characters",
    );
  return value.trim();
}
function searchPattern(value: string | undefined): string {
  const text = filterText(value);
  return text ? `%${text.replace(/[\\%_]/g, "\\$&")}%` : "";
}

/**
 * Job/recording/latest-review facts for the clip alias `c`. The selected-job
 * gate and the latest review are LATERAL primary-key probes per candidate row
 * (never flattened into a join the planner may reorder ahead of the ordered
 * membership/clip index scan). Rejected or non-selected candidates may still
 * require additional index reads before a page fills.
 */
const CORE = `
  JOIN LATERAL (
    SELECT rec.simulation, rec.imported_from_cache FROM recordings rec
    JOIN jobs j ON j.id = c.job_id AND j.recording_id = rec.id AND j.state = 'succeeded'
    WHERE rec.id = c.recording_id AND coalesce(recording_selected_job(rec.id), rec.current_job_id) = c.job_id
      AND rec.deleted_at IS NULL LIMIT 1
  ) rec ON true
  LEFT JOIN LATERAL (
    SELECT r.decision, r.task_label, r.revision FROM reviews r
    WHERE r.clip_id = c.id ORDER BY r.revision DESC LIMIT 1
  ) lr ON true`;

/** Availability of the two derived read targets (accepted-job outputs only). */
const MEDIA = `
  LEFT JOIN files th ON th.id = c.thumbnail_file_id AND th.job_id = c.job_id
    AND th.purpose = 'output' AND th.role = 'thumbnail_jpeg'
    AND th.state IN ('completed', 'verified')
  LEFT JOIN files vw ON vw.id = c.viewer_rrd_file_id AND vw.job_id = c.job_id
    AND vw.purpose = 'output' AND vw.role = 'viewer_rrd'
    AND vw.state IN ('completed', 'verified')`;

/** Customer grant resting on active evidence, for dataset expression `ds`. */
export const grantedTo = (ds: string) => `
  SELECT 1 FROM dataset_access da
  JOIN dataset_sharing_permissions sp ON sp.id = da.sharing_permission_id
    AND sp.dataset_id = da.dataset_id AND sp.recipient_user_id = da.user_id
    AND sp.status = 'active'
  WHERE da.dataset_id = ${ds} AND da.user_id = $1 AND da.enabled`;

/** Member gate for clip alias `c` in dataset expression `ds` (latest approved). */
export const memberGate = (ds: string) => `
  lr.decision = 'approved' AND (
    catalog_has_role($1, 'staff') OR (
      catalog_has_role($1, 'customer') AND EXISTS (
        SELECT 1 FROM dataset_access da
        JOIN dataset_sharing_permissions sp ON sp.id = da.sharing_permission_id
          AND sp.dataset_id = da.dataset_id AND sp.recipient_user_id = da.user_id
          AND sp.status = 'active'
        JOIN dataset_sharing_clearances sc ON sc.permission_id = sp.id AND sc.clip_id = c.id
        WHERE da.dataset_id = ${ds} AND da.user_id = $1 AND da.enabled)))`;

/** Dataset visibility for dataset alias `d`. */
const DATASET_GATE = `(
  catalog_has_role($1, 'staff') OR (
    catalog_has_role($1, 'customer') AND EXISTS (${grantedTo("d.id")})))`;

const SIM_SAFE: ClipSimulation = {
  simulated: true,
  qualification: "simulation_only",
  productionQualified: false,
};
function simulationOf(value: unknown): ClipSimulation | null {
  return value === null || value === undefined ? null : { ...SIM_SAFE };
}

type DatasetRow = {
  id: string;
  name: string;
  revision: number;
  clip_count: string;
  duration_ns: string;
  contains_imported: boolean | null;
  is_staff: boolean;
  created_at: string;
  ts: string;
};
const DATASET_SELECT = `SELECT d.id, d.name, d.revision, s.clip_count::text, s.duration_ns::text, s.contains_imported,
       catalog_has_role($1, 'staff') AS is_staff, ${ts("d.created_at")} AS created_at,
       ${ts("d.created_at")} AS ts
     FROM datasets d
     CROSS JOIN LATERAL (
       SELECT count(*) AS clip_count, coalesce(sum(c.duration_ns), 0) AS duration_ns,
              bool_or(rec.imported_from_cache) AS contains_imported
       FROM dataset_clips dc JOIN clips c ON c.id = dc.clip_id ${CORE}
       WHERE dc.dataset_id = d.id AND ${memberGate("d.id")}
     ) s`;
/** Params: viewer, after-timestamp, after-id, limit + 1. */
export const LIST_DATASETS_SQL = `${DATASET_SELECT}
       WHERE ${DATASET_GATE}
         AND ($5::text = '' OR d.name ILIKE $5 ESCAPE '\\')
         AND ($2::timestamptz IS NULL OR (d.created_at, d.id) < ($2::timestamptz, $3::uuid))
       ORDER BY d.created_at DESC, d.id DESC LIMIT $4`;
function datasetView(row: DatasetRow): DatasetView {
  return {
    datasetId: row.id,
    name: row.name,
    clipCount: Number(row.clip_count),
    durationNs: row.duration_ns,
    ...(row.contains_imported ? { containsImported: true as const } : {}),
    ...(row.is_staff
      ? {
          revision: row.revision,
          createdAt: row.created_at,
        }
      : {}),
  };
}

/** Datasets visible to the viewer; counts use the member gate above. */
export async function listDatasets(
  pool: Queryable,
  input: { viewerUserId: string; cursor?: string; limit?: number; q?: string },
): Promise<Page<DatasetView>> {
  const limit = pageSize(input.limit);
  const [afterTs, afterId] = decodeCursor(input.cursor);
  try {
    const { rows } = await pool.query<DatasetRow>(LIST_DATASETS_SQL, [
      input.viewerUserId,
      afterTs,
      afterId,
      limit + 1,
      searchPattern(input.q),
    ]);
    const page = rows.slice(0, limit);
    return {
      items: page.map(datasetView),
      nextCursor:
        rows.length > limit
          ? encodeCursor(page.at(-1)!.ts, page.at(-1)!.id)
          : null,
    };
  } catch (error) {
    throw toCatalogError(error);
  }
}

/** Not-found for an invisible dataset: no signal whether it exists. */
export async function getDataset(
  pool: Queryable,
  input: { viewerUserId: string; datasetId: string },
): Promise<DatasetView> {
  try {
    const { rows } = await pool.query<DatasetRow>(
      `${DATASET_SELECT} WHERE d.id = $2 AND ${DATASET_GATE}`,
      [input.viewerUserId, uuid(input.datasetId, "datasetId")],
    );
    if (!rows[0]) throw new CatalogError("not_found", "Dataset not found");
    return datasetView(rows[0]);
  } catch (error) {
    throw toCatalogError(error);
  }
}

type ClipRow = {
  id: string;
  title: string;
  duration_ns: string;
  raster_width: number;
  raster_height: number;
  frame_count: number;
  task_label: string | null;
  review_revision: number | null;
  review_decision: string | null;
  simulation: unknown;
  imported_from_cache: boolean;
  recording_id: string;
  job_id: string;
  is_staff: boolean;
  has_thumbnail: boolean;
  has_viewer: boolean;
  dataset_count: number | null;
  dataset_id: string | null;
  ts: string;
};
const CLIP_COLUMNS = `c.id, c.title, c.duration_ns::text, c.raster_width, c.raster_height,
  c.frame_count, lr.task_label, lr.revision AS review_revision, lr.decision AS review_decision,
  rec.simulation, rec.imported_from_cache, c.recording_id, c.job_id, catalog_has_role($1, 'staff') AS is_staff,
  (th.id IS NOT NULL) AS has_thumbnail, (vw.id IS NOT NULL) AS has_viewer`;

/**
 * Whitelisted DTO. Customers get presentation metadata only: no recording,
 * job, collector, notes, QC, hashes or object keys. Staff additionally see
 * internal identifiers and review status.
 */
function clipView(row: ClipRow, datasetId: string | null): DatasetClipView {
  const base: DatasetClipView = {
    clipId: row.id,
    ...(datasetId ? { datasetId } : {}),
    title: row.title,
    ...(row.imported_from_cache ? { source: "imported" as const } : {}),
    taskLabel: row.task_label,
    durationNs: row.duration_ns,
    raster: { width: row.raster_width, height: row.raster_height },
    frameCount: row.frame_count,
    simulation: simulationOf(row.simulation),
    media: { thumbnail: row.has_thumbnail, viewer: row.has_viewer },
  };
  return row.is_staff
    ? {
        ...base,
        recordingId: row.recording_id,
        jobId: row.job_id,
        reviewRevision: row.review_revision ?? 0,
      }
    : base;
}

/** Params: viewer, dataset, after-timestamp, after-id, limit + 1. */
export const DATASET_CLIPS_SQL = `SELECT ${CLIP_COLUMNS}, ${ts("dc.added_at")} AS ts
       FROM dataset_clips dc JOIN clips c ON c.id = dc.clip_id ${CORE} ${MEDIA}
       WHERE dc.dataset_id = $2 AND ${memberGate("dc.dataset_id")}
         AND ($6::text = '' OR c.title ILIKE $6 ESCAPE '\\' OR lr.task_label ILIKE $6 ESCAPE '\\')
         AND ($7::text = '' OR lower(lr.task_label) = lower($7))
         AND ($3::timestamptz IS NULL OR (dc.added_at, dc.clip_id) < ($3::timestamptz, $4::uuid))
       ORDER BY dc.added_at DESC, dc.clip_id DESC LIMIT $5`;

/** Approved members of one dataset, newest membership first. */
export async function listDatasetClips(
  pool: Queryable,
  input: {
    viewerUserId: string;
    datasetId: string;
    cursor?: string;
    limit?: number;
    q?: string;
    label?: string;
  },
): Promise<Page<DatasetClipView>> {
  const limit = pageSize(input.limit);
  const [afterTs, afterId] = decodeCursor(input.cursor);
  const datasetId = uuid(input.datasetId, "datasetId");
  try {
    const { rows } = await pool.query<ClipRow>(DATASET_CLIPS_SQL, [
      input.viewerUserId,
      datasetId,
      afterTs,
      afterId,
      limit + 1,
      searchPattern(input.q),
      filterText(input.label),
    ]);
    if (!rows.length && !input.cursor)
      await getDataset(pool, { viewerUserId: input.viewerUserId, datasetId });
    const page = rows.slice(0, limit);
    return {
      items: page.map((row) => clipView(row, datasetId)),
      nextCursor:
        rows.length > limit
          ? encodeCursor(page.at(-1)!.ts, page.at(-1)!.id)
          : null,
    };
  } catch (error) {
    throw toCatalogError(error);
  }
}

/**
 * One clip. With `datasetId` the exact dataset context is required. Without
 * it a customer is authorized through ANY dataset they are currently granted
 * that holds this approved, cleared clip (direct clip links); staff may open
 * any accepted clip. A clip with no current authority is "not found".
 */
export async function getClip(
  pool: Queryable,
  input: { viewerUserId: string; clipId: string; datasetId?: string },
): Promise<DatasetClipView> {
  const clipId = uuid(input.clipId, "clipId");
  const datasetId = input.datasetId ? uuid(input.datasetId, "datasetId") : null;
  try {
    const { rows } = await pool.query<ClipRow>(
      `SELECT ${CLIP_COLUMNS}, '' AS ts
       FROM clips c ${CORE} ${MEDIA}
       WHERE c.id = $2 AND (
         ($3::uuid IS NULL AND catalog_has_role($1, 'staff'))
         OR EXISTS (
           SELECT 1 FROM dataset_clips dc
           WHERE dc.clip_id = c.id AND ($3::uuid IS NULL OR dc.dataset_id = $3)
             AND ${memberGate("dc.dataset_id")}))`,
      [input.viewerUserId, clipId, datasetId],
    );
    if (!rows[0]) throw new CatalogError("not_found", "Clip not found");
    return clipView(rows[0], datasetId);
  } catch (error) {
    throw toCatalogError(error);
  }
}

/** Staff catalog (All clips): includes pending and rejected, never customers. */
export async function listStaffClips(
  pool: Queryable,
  input: {
    viewerUserId: string;
    recordingId?: string;
    reviewStatus?: "pending" | "approved" | "rejected";
    cursor?: string;
    limit?: number;
    q?: string;
    label?: string;
  },
): Promise<Page<StaffClipView>> {
  const limit = pageSize(input.limit);
  const [afterTs, afterId] = decodeCursor(input.cursor);
  try {
    await requireRole(pool, input.viewerUserId, "staff");
    const { rows } = await pool.query<ClipRow>(
      `SELECT ${CLIP_COLUMNS}, ${ts("c.created_at")} AS ts,
              (SELECT count(*) FROM dataset_clips x WHERE x.clip_id = c.id)::int AS dataset_count
       FROM clips c ${CORE} ${MEDIA}
       WHERE catalog_has_role($1, 'staff')
         AND ($7::text = '' OR c.title ILIKE $7 ESCAPE '\\' OR lr.task_label ILIKE $7 ESCAPE '\\')
         AND ($8::text = '' OR lower(lr.task_label) = lower($8))
         AND ($2::uuid IS NULL OR c.recording_id = $2)
         AND ($3::text IS NULL OR coalesce(lr.decision, 'pending') = $3)
         AND ($4::timestamptz IS NULL OR (c.created_at, c.id) < ($4::timestamptz, $5::uuid))
       ORDER BY c.created_at DESC, c.id DESC LIMIT $6`,
      [
        input.viewerUserId,
        input.recordingId ? uuid(input.recordingId, "recordingId") : null,
        input.reviewStatus ?? null,
        afterTs,
        afterId,
        limit + 1,
        searchPattern(input.q),
        filterText(input.label),
      ],
    );
    const page = rows.slice(0, limit);
    return {
      items: page.map((row) => ({
        ...clipView(row, null),
        recordingId: row.recording_id,
        jobId: row.job_id,
        reviewRevision: row.review_revision ?? 0,
        reviewStatus: (row.review_decision ?? "pending") as
          | "pending"
          | "approved"
          | "rejected",
        datasetCount: row.dataset_count ?? 0,
      })),
      nextCursor:
        rows.length > limit
          ? encodeCursor(page.at(-1)!.ts, page.at(-1)!.id)
          : null,
    };
  } catch (error) {
    throw toCatalogError(error);
  }
}
