import { createHash } from "node:crypto";
import type pg from "pg";
import { CatalogError, toCatalogError } from "./errors.js";

/**
 * Catalog access layer. Every mutation runs in one READ COMMITTED
 * transaction. Review/membership writes follow the documented lock order:
 * clip locks (sorted by UUID) first, then dataset rows FOR UPDATE (sorted by
 * UUID). Database triggers take the same clip lock and enforce approved-only
 * membership, append-only reviews and immutable identity independently.
 */
export type Queryable = pg.Pool;
export type Tx = pg.PoolClient;

export const MAX_PAGE = 100;
export const DEFAULT_PAGE = 24;
export const MAX_BATCH = 100;
const SHA = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function inTransaction<T>(
  pool: Queryable,
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const result = await work(tx);
    await tx.query("COMMIT");
    return result;
  } catch (error) {
    await tx.query("ROLLBACK").catch(() => undefined);
    throw toCatalogError(error);
  } finally {
    tx.release();
  }
}

export const uuid = (value: string, field: string) => {
  if (!UUID.test(value))
    throw new CatalogError("invalid_request", `${field} must be a UUID`);
  return value;
};
export const sortedUnique = (ids: string[], field: string, max = MAX_BATCH) => {
  const unique = [...new Set(ids.map((id) => uuid(id, field)))].sort();
  if (unique.length !== ids.length || unique.length > max)
    throw new CatalogError(
      "invalid_request",
      `${field} must be at most ${max} unique UUIDs`,
    );
  return unique;
};
/** Lock order step 1. */
export async function lockClips(tx: Tx, clipIds: string[]) {
  for (const clipId of [...clipIds].sort())
    await tx.query("SELECT catalog_lock_clip($1)", [clipId]);
}
/** Lock order step 2; returns current revisions. */
export async function lockDatasets(tx: Tx, datasetIds: string[]) {
  const ids = [...new Set(datasetIds)].sort();
  const revisions = new Map<string, number>();
  for (const id of ids) {
    const { rows } = await tx.query<{ revision: number }>(
      "SELECT revision FROM datasets WHERE id = $1 FOR UPDATE",
      [id],
    );
    if (!rows[0]) throw new CatalogError("not_found", "Dataset not found");
    revisions.set(id, rows[0].revision);
  }
  return revisions;
}
export async function bumpDataset(
  tx: Tx,
  datasetId: string,
  actorUserId: string,
) {
  await tx.query(
    "UPDATE datasets SET revision = revision + 1, updated_by = $2 WHERE id = $1",
    [datasetId, actorUserId],
  );
}
export async function requireRole(
  tx: Tx | Queryable,
  userId: string,
  role: string,
) {
  const { rows } = await tx.query<{ ok: boolean }>(
    "SELECT catalog_has_role($1, $2) AS ok",
    [userId, role],
  );
  if (!rows[0]?.ok)
    throw new CatalogError("forbidden", `Requires an enabled ${role} role`);
}

export function sourceObjectKey(
  recordingId: string,
  fileId: string,
  epoch: number,
  role: string,
) {
  return `recordings/${recordingId}/sources/${fileId}/e${epoch}/${role}`;
}
export function outputObjectKey(
  jobId: string,
  fileId: string,
  epoch: number,
  relativePath: string,
) {
  if (
    !/^[A-Za-z0-9._/-]{1,200}$/.test(relativePath) ||
    relativePath.includes("..")
  )
    throw new CatalogError("invalid_request", "Unsafe output relative path");
  return `jobs/${jobId}/outputs/${fileId}/e${epoch}/${relativePath}`;
}
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

// ------------------------------------------------------------ recordings
export type RecordingInput = {
  recordingId: string;
  ownerUserId: string;
  clientRecordingId: string;
  captureFormat: "stateaction.capture.v1";
  rgbProfile: "h264_mcap_v1";
  startedAt: string;
  device: { model: string; osVersion: string; appVersion: string };
};
/** Idempotent on (owner, clientRecordingId); a different body conflicts. */
export async function registerRecording(
  pool: Queryable,
  input: RecordingInput,
) {
  return inTransaction(pool, async (tx) => {
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO recordings (id, owner_user_id, client_recording_id, capture_format, rgb_profile, started_at, device)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (owner_user_id, client_recording_id) DO NOTHING RETURNING id`,
      [
        uuid(input.recordingId, "recordingId"),
        input.ownerUserId,
        uuid(input.clientRecordingId, "clientRecordingId"),
        input.captureFormat,
        input.rgbProfile,
        input.startedAt,
        {
          model: input.device.model,
          osVersion: input.device.osVersion,
          appVersion: input.device.appVersion,
        },
      ],
    );
    if (inserted.rows[0])
      return { recordingId: inserted.rows[0].id, created: true };
    const { rows } = await tx.query<{
      id: string;
      capture_format: string;
      rgb_profile: string;
      started_at: Date;
      device: unknown;
    }>(
      `SELECT id, capture_format, rgb_profile, started_at, device FROM recordings
       WHERE owner_user_id = $1 AND client_recording_id = $2`,
      [input.ownerUserId, input.clientRecordingId],
    );
    const existing = rows[0];
    const device = existing?.device as Record<string, unknown> | undefined;
    if (
      !existing ||
      existing.capture_format !== input.captureFormat ||
      existing.rgb_profile !== input.rgbProfile ||
      existing.started_at.getTime() !== new Date(input.startedAt).getTime() ||
      Object.keys(device ?? {}).length !== 3 ||
      device?.model !== input.device.model ||
      device?.osVersion !== input.device.osVersion ||
      device?.appVersion !== input.device.appVersion
    )
      throw new CatalogError(
        "idempotency_conflict",
        "clientRecordingId was already used with a different request",
      );
    return { recordingId: existing.id, created: false };
  });
}

export type SourceFileInput = {
  fileId: string;
  recordingId: string;
  ownerUserId: string;
  clientUploadId: string;
  role: "source_manifest" | "source_mcap" | "recorder_metadata" | "calibration";
  sizeBytes: string;
  sha256: string;
  required: boolean;
  partSizeBytes: string;
  partCount: number;
};
/** Idempotent logical source reservation keyed by (recording, clientUploadId). */
export async function reserveSourceFile(
  pool: Queryable,
  input: SourceFileInput,
) {
  if (!SHA.test(input.sha256))
    throw new CatalogError("invalid_request", "sha256 must be lowercase hex");
  const requestDigest = digest([
    input.recordingId,
    input.clientUploadId,
    input.role,
    input.sizeBytes,
    input.sha256,
    input.required,
  ]);
  const existing = async () => {
    const { rows } = await pool.query<{ id: string; request_digest: string }>(
      "SELECT id, request_digest FROM files WHERE recording_id = $1 AND client_upload_id = $2",
      [input.recordingId, input.clientUploadId],
    );
    if (!rows[0]) return undefined;
    if (rows[0].request_digest !== requestDigest)
      throw new CatalogError(
        "idempotency_conflict",
        "clientUploadId was already used with a different request",
      );
    return { fileId: rows[0].id, created: false };
  };
  try {
    return await reserve();
  } catch (error) {
    // A racing insert may trip the one-live-role index before the
    // clientUploadId arbiter; resolve by the logical key afterwards.
    if (error instanceof CatalogError && error.sqlstate === "23505")
      return (await existing()) ?? Promise.reject(error);
    throw error;
  }
  function reserve() {
    return inTransaction(pool, async (tx) => {
      const owner = await tx.query(
        // Lock first: seal and concurrent reservations serialize on the recording.
        "SELECT 1 FROM recordings WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL FOR UPDATE",
        [input.recordingId, input.ownerUserId],
      );
      if (!owner.rowCount)
        throw new CatalogError("not_found", "Recording not found");
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO files (id, recording_id, purpose, role, required, client_upload_id, request_digest,
         size_bytes, sha256, object_key, part_size_bytes, part_count)
       VALUES ($1, $2, 'source', $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (recording_id, client_upload_id) DO NOTHING RETURNING id`,
        [
          uuid(input.fileId, "fileId"),
          input.recordingId,
          input.role,
          input.required,
          uuid(input.clientUploadId, "clientUploadId"),
          requestDigest,
          input.sizeBytes,
          input.sha256,
          sourceObjectKey(input.recordingId, input.fileId, 1, input.role),
          input.partSizeBytes,
          input.partCount,
        ],
      );
      if (inserted.rows[0]) {
        await tx.query(
          "UPDATE recordings SET status = 'uploading' WHERE id = $1 AND status = 'registered'",
          [input.recordingId],
        );
        return { fileId: inserted.rows[0].id, created: true };
      }
      const { rows } = await tx.query<{ id: string; request_digest: string }>(
        "SELECT id, request_digest FROM files WHERE recording_id = $1 AND client_upload_id = $2",
        [input.recordingId, input.clientUploadId],
      );
      if (rows[0]?.request_digest !== requestDigest)
        throw new CatalogError(
          "idempotency_conflict",
          "clientUploadId was already used with a different request",
        );
      return { fileId: rows[0].id, created: false };
    });
  }
}

/** Records API-verified completion of the current transport (bounded checks only). */
export async function recordFileCompleted(
  pool: Queryable,
  input: {
    fileId: string;
    expectedTransportEpoch: number;
    observedSizeBytes: string;
  },
) {
  return inTransaction(pool, async (tx) => {
    const { rowCount } = await tx.query(
      `UPDATE files SET state = 'completed', observed_size_bytes = $3, completed_at = now()
       WHERE id = $1 AND transport_epoch = $2 AND state IN ('reserved', 'uploading', 'completing')`,
      [input.fileId, input.expectedTransportEpoch, input.observedSizeBytes],
    );
    if (!rowCount)
      throw new CatalogError("conflict", "Stale or closed file transport");
  });
}

/**
 * Seal freezes the declared v1 source inventory (one manifest, one required
 * MCAP, >= 1 required recorder_metadata) and pins the manifest's declared
 * SHA-256. Upload completion may arrive before or after seal; job admission
 * requires every required file to be completed. An identical replay returns
 * the existing seal; a different manifest conflicts.
 */
export async function sealRecording(
  pool: Queryable,
  input: { recordingId: string; ownerUserId: string; manifestFileId: string },
) {
  return inTransaction(pool, async (tx) => {
    const { rows } = await tx.query<{
      status: string;
      manifest: string | null;
    }>(
      "SELECT status, source_manifest_file_id AS manifest FROM recordings WHERE id = $1 AND owner_user_id = $2 FOR UPDATE",
      [input.recordingId, input.ownerUserId],
    );
    const recording = rows[0];
    if (!recording) throw new CatalogError("not_found", "Recording not found");
    if (recording.manifest !== null) {
      if (recording.manifest === input.manifestFileId)
        return { replayed: true };
      throw new CatalogError(
        "conflict",
        "Recording is sealed with another manifest",
      );
    }
    const inventory = await tx.query<{ ok: boolean }>(
      "SELECT catalog_source_inventory_ok($1, false) AS ok",
      [input.recordingId],
    );
    if (!inventory.rows[0]?.ok)
      throw new CatalogError(
        "conflict",
        "A v1 seal needs one source manifest, one required MCAP and required recorder metadata",
      );
    const { rowCount } = await tx.query(
      `UPDATE recordings r SET status = 'sealed', source_manifest_file_id = f.id, source_manifest_sha256 = f.sha256
       FROM files f
       WHERE r.id = $1 AND f.id = $2 AND f.recording_id = r.id AND f.role = 'source_manifest'
         AND f.state NOT IN ('cancelled', 'failed', 'expired')
         AND r.status IN ('registered', 'uploading')`,
      [input.recordingId, input.manifestFileId],
    );
    if (!rowCount)
      throw new CatalogError("conflict", "Recording cannot be sealed");
    return { replayed: false };
  });
}

// ------------------------------------------------------------------ jobs
/** Inserts an attempt; the job input is pinned to the sealed manifest digest. */
export async function createProcessingJob(
  pool: Queryable,
  input: {
    jobId: string;
    recordingId: string;
    previousJobId?: string;
    profileRevision: string;
  },
) {
  return inTransaction(pool, async (tx) => {
    const { rows } = await tx.query<{
      sha: string | null;
      current: string | null;
    }>(
      "SELECT source_manifest_sha256 AS sha, current_job_id AS current FROM recordings WHERE id = $1 FOR UPDATE",
      [input.recordingId],
    );
    if (!rows[0]?.sha)
      throw new CatalogError("conflict", "Recording is not sealed");
    const ready = await tx.query<{ ok: boolean }>(
      "SELECT catalog_source_inventory_ok($1, true) AS ok",
      [input.recordingId],
    );
    if (!ready.rows[0]?.ok)
      throw new CatalogError(
        "conflict",
        "Required source files are not all completed",
      );
    if ((input.previousJobId ?? null) !== rows[0].current)
      throw new CatalogError("conflict", "Stale current job reference");
    await tx.query(
      `INSERT INTO jobs (id, kind, recording_id, previous_job_id, source_manifest_sha256, profile_revision)
       VALUES ($1, 'process_recording', $2, $3, $4, $5)`,
      [
        uuid(input.jobId, "jobId"),
        input.recordingId,
        input.previousJobId ?? null,
        rows[0].sha,
        input.profileRevision,
      ],
    );
    await tx.query(
      "UPDATE recordings SET current_job_id = $2, status = 'processing' WHERE id = $1",
      [input.recordingId, input.jobId],
    );
    return { jobId: input.jobId, sourceManifestSha256: rows[0].sha };
  });
}

export type ClipInput = {
  clipId: string;
  ordinal: number;
  title: string;
  sourceStartNs: string;
  sourceEndNs: string;
  durationNs: string;
  clockDomain: string;
  raster: { width: number; height: number };
  frameCount: number;
  files: {
    rgbMp4: string;
    handArraysNpz: string;
    handObservationsJson: string;
    frameMapJson: string;
    thumbnailJpeg: string;
    viewerRrd: string;
  };
};
/**
 * Accepts a validated result: clips and success commit together. Replaying
 * the same manifest returns the same clip IDs; nothing can repoint them.
 */
type AcceptedResult = {
  jobId: string;
  manifestFileId: string;
  manifestSha256: string;
  clips: ClipInput[];
  annotations?: {
    segments: number;
    failedWindows: number;
    captions: number;
    failedCaptions: number;
  };
};

export async function acceptProcessingResult(
  pool: Queryable,
  input: AcceptedResult,
) {
  return inTransaction(pool, (tx) => acceptCatalogResult(tx, input));
}

export async function acceptCatalogResult(tx: Tx, input: AcceptedResult) {
  const { rows } = await tx.query<{
    state: string;
    recording_id: string;
    result_manifest_sha256: string | null;
  }>(
    "SELECT state, recording_id, result_manifest_sha256 FROM jobs WHERE id = $1 FOR UPDATE",
    [input.jobId],
  );
  const job = rows[0];
  if (!job) throw new CatalogError("not_found", "Job not found");
  if (job.state === "succeeded") {
    const existing = await tx.query<{ id: string; ordinal: number }>(
      "SELECT id, ordinal FROM clips WHERE job_id = $1 ORDER BY ordinal",
      [input.jobId],
    );
    const same =
      job.result_manifest_sha256 === input.manifestSha256 &&
      existing.rows.length === input.clips.length &&
      existing.rows.every(
        (row) =>
          input.clips.find((c) => c.ordinal === row.ordinal)?.clipId === row.id,
      );
    if (!same)
      throw new CatalogError(
        "conflict",
        "Job already accepted a different result",
      );
    return { clipIds: existing.rows.map((r) => r.id), replayed: true };
  }
  if (job.state !== "result_pending")
    throw new CatalogError("conflict", "Job is not awaiting result acceptance");
  for (const clip of input.clips)
    await tx.query(
      `INSERT INTO clips (id, job_id, recording_id, ordinal, title, source_start_ns, source_end_ns,
           duration_ns, clock_domain, raster_width, raster_height, frame_count, rgb_mp4_file_id,
           hand_arrays_file_id, hand_observations_file_id, frame_map_file_id, thumbnail_file_id, viewer_rrd_file_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [
        uuid(clip.clipId, "clipId"),
        input.jobId,
        job.recording_id,
        clip.ordinal,
        clip.title,
        clip.sourceStartNs,
        clip.sourceEndNs,
        clip.durationNs,
        clip.clockDomain,
        clip.raster.width,
        clip.raster.height,
        clip.frameCount,
        clip.files.rgbMp4,
        clip.files.handArraysNpz,
        clip.files.handObservationsJson,
        clip.files.frameMapJson,
        clip.files.thumbnailJpeg,
        clip.files.viewerRrd,
      ],
    );
  await tx.query(
    `UPDATE jobs SET state = 'succeeded', result_manifest_file_id = $2, result_manifest_sha256 = $3,
      segment_count = $4, failed_window_count = $5, caption_count = $6, caption_failed_count = $7,
      finished_at = now() WHERE id = $1`,
    [
      input.jobId,
      input.manifestFileId,
      input.manifestSha256,
      input.annotations?.segments ?? null,
      input.annotations?.failedWindows ?? null,
      input.annotations?.captions ?? null,
      input.annotations?.failedCaptions ?? null,
    ],
  );
  await tx.query(
    "UPDATE recordings SET status = 'reviewable' WHERE id = $1 AND current_job_id = $2",
    [job.recording_id, input.jobId],
  );
  return {
    clipIds: [...input.clips]
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((c) => c.clipId),
    replayed: false,
  };
}

// --------------------------------------------------------------- reviews
export type DatasetSelection = {
  datasetIds: string[];
  expectedRevisions: Record<string, number>;
};
export type ReviewInput = {
  reviewId: string;
  clipId: string;
  jobId: string;
  resultManifestSha256: string;
  reviewerUserId: string;
  /** Latest revision the reviewer saw; 0 when unreviewed. */
  expectedRevision: number;
  decision: "approved" | "rejected";
  taskLabel?: string;
  notes?: string;
  datasetSelection?: DatasetSelection;
};
export type ReviewRecord = {
  reviewId: string;
  clipId: string;
  jobId: string;
  resultManifestSha256: string;
  revision: number;
  decision: "approved" | "rejected";
  taskLabel: string | null;
  notes: string | null;
  datasetSelection: DatasetSelection | null;
  createdAt: string;
};
export const MAX_TASK_LABEL = 200;
export const MAX_NOTES = 4000;
const LOCK_TIMEOUT = "5s";

type ReviewRow = {
  id: string;
  clip_id: string;
  job_id: string;
  result_manifest_sha256: string;
  revision: number;
  reviewer_user_id: string;
  decision: "approved" | "rejected";
  task_label: string | null;
  notes: string | null;
  dataset_selection: DatasetSelection | null;
  created_at: string;
};
const canonicalSelection = (s: DatasetSelection | null | undefined) =>
  s
    ? JSON.stringify({
        d: [...s.datasetIds].sort(),
        r: Object.entries(s.expectedRevisions).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        ),
      })
    : null;

/**
 * Appends a review revision atomically with its dataset membership effect.
 * Approval applies an optional complete desired membership set (omitted
 * preserves existing memberships; an explicit empty set clears them all);
 * rejection (also the withdrawal of an approval) removes every working
 * membership. Every affected dataset advances exactly once. All validation
 * and every staleness check precedes any write, and any failure rolls back
 * the review, memberships and revisions together.
 *
 * Lock order: staff role, clip lock, (replay lookup), dataset rows sorted by
 * UUID FOR UPDATE, recipient evidence FOR SHARE (inside dataset_sharing_ok).
 * `reviewId` is the idempotency key: an identical replay by the same reviewer
 * returns the stored review without a new revision; a different body under
 * the same id is an idempotency conflict.
 */
export async function appendReview(
  pool: Queryable,
  input: ReviewInput,
): Promise<{
  revision: number;
  added: string[];
  removed: string[];
  review: ReviewRecord;
  replayed: boolean;
}> {
  const clipId = uuid(input.clipId, "clipId");
  const reviewId = uuid(input.reviewId, "reviewId");
  uuid(input.jobId, "jobId");
  if (!SHA.test(input.resultManifestSha256))
    throw new CatalogError("invalid_request", "resultManifestSha256 invalid");
  if (
    !Number.isInteger(input.expectedRevision) ||
    input.expectedRevision < 0 ||
    input.expectedRevision >= 2147483647
  )
    throw new CatalogError("invalid_request", "expectedRevision invalid");
  const taskLabel = input.taskLabel?.trim() || null;
  const notes = input.notes?.trim() ? input.notes : null;
  if (taskLabel && taskLabel.length > MAX_TASK_LABEL)
    throw new CatalogError("invalid_request", "Task label is too long");
  if (notes && notes.length > MAX_NOTES)
    throw new CatalogError("invalid_request", "Notes are too long");
  if (input.decision === "approved" && !taskLabel)
    throw new CatalogError("invalid_request", "Approval requires a task label");
  if (input.decision === "rejected" && input.datasetSelection)
    throw new CatalogError(
      "invalid_request",
      "A rejection carries no dataset selection",
    );
  const selection = input.datasetSelection
    ? sortedUnique(input.datasetSelection.datasetIds, "datasetIds")
    : undefined;
  const expected = input.datasetSelection?.expectedRevisions ?? {};
  for (const [id, revision] of Object.entries(expected)) {
    uuid(id, "expectedRevisions key");
    if (!Number.isInteger(revision) || revision < 1)
      throw new CatalogError("invalid_request", "expectedRevisions invalid");
  }
  const storedSelection: DatasetSelection | null = selection
    ? {
        datasetIds: selection,
        expectedRevisions: Object.fromEntries(
          Object.entries(expected).sort(([a], [b]) => (a < b ? -1 : 1)),
        ),
      }
    : null;
  const record = (row: ReviewRow): ReviewRecord => ({
    reviewId: row.id,
    clipId: row.clip_id,
    jobId: row.job_id,
    resultManifestSha256: row.result_manifest_sha256,
    revision: row.revision,
    decision: row.decision,
    taskLabel: row.task_label,
    notes: row.notes,
    datasetSelection: row.dataset_selection,
    createdAt: row.created_at,
  });
  const COLUMNS = `id, clip_id, job_id, result_manifest_sha256, revision, reviewer_user_id,
    decision, task_label, notes, dataset_selection,
    to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at`;

  return inTransaction(pool, async (tx) => {
    await tx.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
    await requireRole(tx, input.reviewerUserId, "staff");
    await lockClips(tx, [clipId]);

    // Idempotent replay (append-only rows are stable once visible).
    const prior = (
      await tx.query<ReviewRow>(
        `SELECT ${COLUMNS} FROM reviews WHERE id = $1`,
        [reviewId],
      )
    ).rows[0];
    if (prior) {
      if (
        prior.clip_id !== clipId ||
        prior.reviewer_user_id !== input.reviewerUserId ||
        prior.job_id !== input.jobId ||
        prior.result_manifest_sha256 !== input.resultManifestSha256 ||
        prior.revision !== input.expectedRevision + 1 ||
        prior.decision !== input.decision ||
        prior.task_label !== taskLabel ||
        prior.notes !== notes ||
        canonicalSelection(prior.dataset_selection) !==
          canonicalSelection(storedSelection)
      )
        throw new CatalogError(
          "idempotency_conflict",
          "reviewId was already used with a different request",
        );
      return {
        revision: prior.revision,
        added: [],
        removed: [],
        review: record(prior),
        replayed: true,
      };
    }

    // Keep the recording's selected result stable through the review append.
    const clip = await tx.query(
      `SELECT 1 FROM clips c
       JOIN recordings rec ON rec.id = c.recording_id
       WHERE c.id = $1 AND c.job_id = $2
       FOR UPDATE OF rec`,
      [clipId, input.jobId],
    );
    if (!clip.rowCount) {
      const exists = await tx.query("SELECT 1 FROM clips WHERE id = $1", [
        clipId,
      ]);
      throw exists.rowCount
        ? new CatalogError("conflict", "Clip result identity changed")
        : new CatalogError("not_found", "Clip not found");
    }
    const latest = await tx.query<{ revision: number | null }>(
      "SELECT max(revision) AS revision FROM reviews WHERE clip_id = $1",
      [clipId],
    );
    if ((latest.rows[0]?.revision ?? 0) !== input.expectedRevision)
      throw new CatalogError("conflict", "Stale review revision");
    const selectedResult = await tx.query(
      `SELECT 1 FROM clips c
       JOIN jobs j ON j.id = c.job_id AND j.state = 'succeeded'
         AND j.result_manifest_sha256 = $3
       JOIN recordings rec ON rec.id = c.recording_id
         AND coalesce(recording_selected_job(rec.id), rec.current_job_id) = c.job_id
         AND rec.deleted_at IS NULL
       WHERE c.id = $1 AND c.job_id = $2`,
      [clipId, input.jobId, input.resultManifestSha256],
    );
    if (!selectedResult.rowCount) {
      const identity = await tx.query(
        "SELECT 1 FROM jobs WHERE id = $1 AND result_manifest_sha256 = $2",
        [input.jobId, input.resultManifestSha256],
      );
      if (!identity.rowCount)
        throw new CatalogError(
          "invalid_request",
          "Job and result manifest hash do not identify a result",
        );
      throw new CatalogError(
        "conflict",
        "This is no longer the recording's selected result",
      );
    }

    const current = (
      await tx.query<{ dataset_id: string }>(
        "SELECT dataset_id FROM dataset_clips WHERE clip_id = $1",
        [clipId],
      )
    ).rows.map((r) => r.dataset_id);
    const approved = input.decision === "approved";
    const desired = approved && selection ? selection : undefined;
    const affected = !approved
      ? current
      : desired
        ? [...new Set([...current, ...desired])]
        : [];
    const revisions = await lockDatasets(tx, affected);
    if (desired) {
      const keys = Object.keys(expected);
      if (
        keys.length !== affected.length ||
        affected.some((id) => expected[id] !== revisions.get(id))
      )
        throw new CatalogError("conflict", "Stale dataset revision");
    }
    const removals = !approved
      ? current
      : desired
        ? current.filter((id) => !desired.includes(id))
        : [];
    const additions = desired
      ? desired.filter((id) => !current.includes(id))
      : [];
    // Same predicate the member-add trigger enforces (SAC05), checked first
    // for a precise refusal before any write.
    for (const id of additions) {
      const ok = await tx.query<{ ok: boolean }>(
        "SELECT public.dataset_sharing_ok($1, $2) AS ok",
        [id, clipId],
      );
      if (!ok.rows[0]?.ok)
        throw new CatalogError(
          "forbidden",
          "A dataset is shared: every enabled recipient needs active sharing permission clearing this clip before it is added",
        );
    }
    for (const id of removals)
      await tx.query(
        "DELETE FROM dataset_clips WHERE dataset_id = $1 AND clip_id = $2",
        [id, clipId],
      );
    const inserted = await tx.query<ReviewRow>(
      `INSERT INTO reviews (id, clip_id, job_id, result_manifest_sha256, revision, reviewer_user_id,
         decision, task_label, notes, dataset_selection)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${COLUMNS}`,
      [
        reviewId,
        clipId,
        input.jobId,
        input.resultManifestSha256,
        input.expectedRevision + 1,
        input.reviewerUserId,
        input.decision,
        taskLabel,
        notes,
        approved ? storedSelection : null,
      ],
    );
    for (const id of additions)
      await tx.query(
        "INSERT INTO dataset_clips (dataset_id, clip_id, added_by) VALUES ($1, $2, $3)",
        [id, clipId, input.reviewerUserId],
      );
    for (const id of [...removals, ...additions].sort())
      await bumpDataset(tx, id, input.reviewerUserId);
    return {
      revision: input.expectedRevision + 1,
      added: additions,
      removed: removals,
      review: record(inserted.rows[0] as ReviewRow),
      replayed: false,
    };
  });
}

// -------------------------------------------------------------- datasets
export async function createDataset(
  pool: Queryable,
  input: { datasetId: string; name: string; actorUserId: string },
) {
  return inTransaction(pool, async (tx) => {
    await tx.query(
      "INSERT INTO datasets (id, name, created_by, updated_by) VALUES ($1, $2, $3, $3)",
      [
        uuid(input.datasetId, "datasetId"),
        input.name.trim(),
        input.actorUserId,
      ],
    );
    return { datasetId: input.datasetId, revision: 1 };
  });
}

export async function renameDataset(
  pool: Queryable,
  input: {
    datasetId: string;
    name: string;
    expectedRevision: number;
    actorUserId: string;
  },
) {
  return inTransaction(pool, async (tx) => {
    const { rowCount } = await tx.query(
      "UPDATE datasets SET name = $2, revision = revision + 1, updated_by = $4 WHERE id = $1 AND revision = $3",
      [
        input.datasetId,
        input.name.trim(),
        input.expectedRevision,
        input.actorUserId,
      ],
    );
    if (!rowCount) throw new CatalogError("conflict", "Stale dataset revision");
    return { revision: input.expectedRevision + 1 };
  });
}

/** Bounded add; pending/rejected clips fail the whole batch with no writes. */
export async function addClipsToDataset(
  pool: Queryable,
  input: {
    datasetId: string;
    clipIds: string[];
    expectedRevision: number;
    actorUserId: string;
  },
) {
  const clipIds = sortedUnique(input.clipIds, "clipIds");
  return inTransaction(pool, async (tx) => {
    await requireRole(tx, input.actorUserId, "staff");
    await lockClips(tx, clipIds);
    const revisions = await lockDatasets(tx, [
      uuid(input.datasetId, "datasetId"),
    ]);
    if (revisions.get(input.datasetId) !== input.expectedRevision)
      throw new CatalogError("conflict", "Stale dataset revision");
    const { rows } = await tx.query<{ id: string }>(
      `SELECT c.id FROM unnest($1::uuid[]) AS c(id)
       WHERE catalog_latest_decision(c.id) IS DISTINCT FROM 'approved'`,
      [clipIds],
    );
    if (rows.length)
      throw new CatalogError(
        "conflict",
        "Only approved clips can join a dataset",
      );
    const inserted = await tx.query(
      `INSERT INTO dataset_clips (dataset_id, clip_id, added_by)
       SELECT $1, id, $3 FROM unnest($2::uuid[]) AS c(id) ORDER BY id
       ON CONFLICT DO NOTHING`,
      [input.datasetId, clipIds, input.actorUserId],
    );
    if (inserted.rowCount)
      await bumpDataset(tx, input.datasetId, input.actorUserId);
    return {
      added: inserted.rowCount ?? 0,
      revision: input.expectedRevision + (inserted.rowCount ? 1 : 0),
    };
  });
}

export async function removeClipFromDataset(
  pool: Queryable,
  input: {
    datasetId: string;
    clipId: string;
    expectedRevision: number;
    actorUserId: string;
  },
) {
  return inTransaction(pool, async (tx) => {
    await requireRole(tx, input.actorUserId, "staff");
    await lockClips(tx, [uuid(input.clipId, "clipId")]);
    const revisions = await lockDatasets(tx, [
      uuid(input.datasetId, "datasetId"),
    ]);
    if (revisions.get(input.datasetId) !== input.expectedRevision)
      throw new CatalogError("conflict", "Stale dataset revision");
    const { rowCount } = await tx.query(
      "DELETE FROM dataset_clips WHERE dataset_id = $1 AND clip_id = $2",
      [input.datasetId, input.clipId],
    );
    if (rowCount) await bumpDataset(tx, input.datasetId, input.actorUserId);
    return {
      removed: rowCount === 1,
      revision: input.expectedRevision + (rowCount ? 1 : 0),
    };
  });
}

// ----------------------------------------------------------------- reads
export type ClipSummary = {
  clipId: string;
  title: string;
  durationNs: string;
  jobId: string;
  recordingId: string;
  taskLabel: string | null;
  cursor: string;
};
export const pageSize = (limit?: number) => {
  const size = limit ?? DEFAULT_PAGE;
  if (!Number.isInteger(size) || size < 1 || size > MAX_PAGE)
    throw new CatalogError("invalid_request", `limit must be 1..${MAX_PAGE}`);
  return size;
};
export const decodeCursor = (
  cursor?: string,
): [string, string] | [null, null] => {
  if (!cursor) return [null, null];
  try {
    const [ts, id] = JSON.parse(
      Buffer.from(cursor, "base64url").toString(),
    ) as [string, string];
    if (typeof ts === "string" && typeof id === "string" && UUID.test(id))
      return [ts, id];
  } catch {
    /* fall through */
  }
  throw new CatalogError("invalid_request", "Invalid cursor");
};
export const encodeCursor = (ts: string, id: string) =>
  Buffer.from(JSON.stringify([ts, id])).toString("base64url");
export const TS = `to_char(%s AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Staff All clips with latest review status; pending = no review yet. */
export async function listInternalClips(
  pool: Queryable,
  input: {
    viewerUserId: string;
    recordingId?: string;
    reviewStatus?: "pending" | "approved" | "rejected";
    cursor?: string;
    limit?: number;
  },
) {
  const limit = pageSize(input.limit);
  const [afterTs, afterId] = decodeCursor(input.cursor);
  await requireRole(pool, input.viewerUserId, "staff");
  const { rows } = await pool.query<{
    id: string;
    title: string;
    recording_id: string;
    status: string;
    revision: number;
    ts: string;
  }>(
    `SELECT c.id, c.title, c.recording_id, coalesce(lr.decision, 'pending') AS status,
            coalesce(lr.revision, 0) AS revision, ${TS.replace("%s", "c.created_at")} AS ts
     FROM clips c
     LEFT JOIN LATERAL (
       SELECT decision, revision FROM reviews r WHERE r.clip_id = c.id ORDER BY r.revision DESC LIMIT 1
     ) lr ON true
     WHERE ($1::uuid IS NULL OR c.recording_id = $1)
       AND ($2::text IS NULL OR coalesce(lr.decision, 'pending') = $2)
       AND ($3::timestamptz IS NULL OR (c.created_at, c.id) < ($3::timestamptz, $4::uuid))
     ORDER BY c.created_at DESC, c.id DESC LIMIT $5`,
    [
      input.recordingId ? uuid(input.recordingId, "recordingId") : null,
      input.reviewStatus ?? null,
      afterTs,
      afterId,
      limit + 1,
    ],
  );
  const page = rows.slice(0, limit).map((r) => ({
    clipId: r.id,
    title: r.title,
    recordingId: r.recording_id,
    reviewStatus: r.status,
    reviewRevision: r.revision,
    cursor: encodeCursor(r.ts, r.id),
  }));
  return {
    clips: page,
    nextCursor: rows.length > limit ? (page.at(-1)?.cursor ?? null) : null,
  };
}
