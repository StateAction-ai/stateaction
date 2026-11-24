import {
  bumpDataset,
  inTransaction,
  lockClips,
  lockDatasets,
  MAX_BATCH,
  requireRole,
  sortedUnique,
  uuid,
  type Queryable,
} from "../catalog/catalog.js";
import { CatalogError } from "../catalog/errors.js";

/**
 * Staff dataset operations (SA-35). Every mutation runs in one READ COMMITTED
 * transaction that follows the documented lock order (clip locks sorted by
 * UUID, then dataset rows FOR UPDATE) and rechecks the staff role from the
 * database. The database triggers independently refuse a non-latest-approved
 * clip and an addition to a shared dataset without current per-recipient
 * clearance, so these checks are conveniences with precise error messages,
 * never the only barrier.
 */

export async function createDatasetRecord(
  pool: Queryable,
  input: { datasetId: string; name: string; actorUserId: string },
): Promise<{ datasetId: string; revision: number; created: boolean }> {
  const datasetId = uuid(input.datasetId, "datasetId");
  const name = input.name.trim();
  return inTransaction(pool, async (tx) => {
    await requireRole(tx, input.actorUserId, "staff");
    const inserted = await tx.query(
      `INSERT INTO datasets (id, name, created_by, updated_by) VALUES ($1, $2, $3, $3)
       ON CONFLICT (id) DO NOTHING`,
      [datasetId, name, input.actorUserId],
    );
    if (inserted.rowCount) return { datasetId, revision: 1, created: true };
    // Replay: the same creator and name is the same request.
    const { rows } = await tx.query<{ revision: number }>(
      "SELECT revision FROM datasets WHERE id = $1 AND created_by = $2 AND name = $3",
      [datasetId, input.actorUserId, name],
    );
    if (!rows[0])
      throw new CatalogError("conflict", "Dataset ID already in use");
    return { datasetId, revision: rows[0].revision, created: false };
  });
}

export async function renameDatasetRecord(
  pool: Queryable,
  input: {
    datasetId: string;
    name: string;
    expectedRevision: number;
    actorUserId: string;
  },
): Promise<{ revision: number }> {
  const datasetId = uuid(input.datasetId, "datasetId");
  return inTransaction(pool, async (tx) => {
    await requireRole(tx, input.actorUserId, "staff");
    const revisions = await lockDatasets(tx, [datasetId]);
    if (revisions.get(datasetId) !== input.expectedRevision)
      throw new CatalogError("conflict", "Stale dataset revision");
    await tx.query(
      "UPDATE datasets SET name = $2, revision = revision + 1, updated_by = $3 WHERE id = $1",
      [datasetId, input.name.trim(), input.actorUserId],
    );
    return { revision: input.expectedRevision + 1 };
  });
}

/**
 * Adds approved clips from the recording's selected accepted job. The batch is
 * all-or-nothing and bounded. In a shared dataset the sharing guard (SAC05)
 * additionally requires every enabled recipient's active evidence to have
 * cleared each clip first.
 */
export async function addDatasetMembers(
  pool: Queryable,
  input: {
    datasetId: string;
    clipIds: string[];
    expectedRevision: number;
    actorUserId: string;
  },
): Promise<{ added: number; revision: number }> {
  const datasetId = uuid(input.datasetId, "datasetId");
  const clipIds = sortedUnique(input.clipIds, "clipIds", MAX_BATCH);
  if (!clipIds.length)
    throw new CatalogError("invalid_request", "clipIds must not be empty");
  return inTransaction(pool, async (tx) => {
    await requireRole(tx, input.actorUserId, "staff");
    await lockClips(tx, clipIds);
    const revisions = await lockDatasets(tx, [datasetId]);
    if (revisions.get(datasetId) !== input.expectedRevision)
      throw new CatalogError("conflict", "Stale dataset revision");
    const { rows } = await tx.query<{ id: string }>(
      `SELECT u.id FROM unnest($1::uuid[]) AS u(id)
       WHERE NOT EXISTS (
         SELECT 1 FROM clips c
         JOIN jobs j ON j.id = c.job_id AND j.state = 'succeeded'
         JOIN recordings rec ON rec.id = c.recording_id
           AND coalesce(recording_selected_job(rec.id), rec.current_job_id) = c.job_id AND rec.deleted_at IS NULL
         WHERE c.id = u.id AND catalog_latest_decision(c.id) = 'approved')`,
      [clipIds],
    );
    if (rows.length)
      throw new CatalogError(
        "conflict",
        "Only approved clips from the selected accepted result can join a dataset",
      );
    const inserted = await tx.query(
      `INSERT INTO dataset_clips (dataset_id, clip_id, added_by)
       SELECT $1, u.id, $3 FROM unnest($2::uuid[]) AS u(id) ORDER BY u.id
       ON CONFLICT DO NOTHING`,
      [datasetId, clipIds, input.actorUserId],
    );
    if (inserted.rowCount) await bumpDataset(tx, datasetId, input.actorUserId);
    return {
      added: inserted.rowCount ?? 0,
      revision: input.expectedRevision + (inserted.rowCount ? 1 : 0),
    };
  });
}

export async function removeDatasetMember(
  pool: Queryable,
  input: {
    datasetId: string;
    clipId: string;
    expectedRevision: number;
    actorUserId: string;
  },
): Promise<{ removed: boolean; revision: number }> {
  const datasetId = uuid(input.datasetId, "datasetId");
  const clipId = uuid(input.clipId, "clipId");
  return inTransaction(pool, async (tx) => {
    await requireRole(tx, input.actorUserId, "staff");
    await lockClips(tx, [clipId]);
    const revisions = await lockDatasets(tx, [datasetId]);
    if (revisions.get(datasetId) !== input.expectedRevision)
      throw new CatalogError("conflict", "Stale dataset revision");
    const { rowCount } = await tx.query(
      "DELETE FROM dataset_clips WHERE dataset_id = $1 AND clip_id = $2",
      [datasetId, clipId],
    );
    if (rowCount) await bumpDataset(tx, datasetId, input.actorUserId);
    return {
      removed: rowCount === 1,
      revision: input.expectedRevision + (rowCount ? 1 : 0),
    };
  });
}
