import type pg from "pg";
import { inTransaction, uuid } from "../catalog/catalog.js";
import { CatalogError } from "../catalog/errors.js";
import { randomUUID } from "node:crypto";
import {
  requireSelectedResult,
  resultParams,
  validateReviewResult,
  type ReviewResult,
} from "./review-result.js";

/**
 * Operator-only dataset sharing setup (SA-35). These functions are called with
 * the migration-owner credential by the operator CLI and by test fixtures,
 * never from a request path: the restricted web role has SELECT only on the
 * evidence tables and no EXECUTE on the grant routine.
 *
 * Order of an operator setup for one recipient and dataset:
 *   1. recordSharingPermission  external-inspection cover for that recipient;
 *   2. clearClips or clearReviewClips  confirm each approved clip for that recipient;
 *   3. grantDatasetAccess       enable the view grant (needs every current
 *                               approved member cleared by that evidence).
 * Later additions to the shared dataset need staff to add only clips already
 * cleared (step 2 again). Revoking evidence disables the grant immediately.
 */
const REF = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const text = (value: string, field: string, max: number) => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed || trimmed.length > max)
    throw new CatalogError(
      "invalid_request",
      `${field} must be 1..${max} characters`,
    );
  return trimmed;
};
const ref = (value: string) => {
  if (!REF.test(value))
    throw new CatalogError(
      "invalid_request",
      "permissionRef must match ^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$",
    );
  return value;
};

export type SharingPermission = {
  permissionRef: string;
  datasetId: string;
  recipientUserId: string;
  status: "active" | "revoked";
  evidenceRef: string;
  recordedBy: string;
  clearedClips: number;
};

export async function recordSharingPermission(
  owner: pg.Pool,
  input: {
    permissionRef: string;
    datasetId: string;
    recipientUserId: string;
    evidenceRef: string;
    recordedBy: string;
  },
): Promise<{ permissionId: string }> {
  const permissionId = randomUUID();
  await inTransaction(owner, async (tx) => {
    await tx.query(
      `INSERT INTO dataset_sharing_permissions
         (id, permission_ref, dataset_id, recipient_user_id, covers_external_inspection,
          evidence_ref, recorded_by)
       VALUES ($1, $2, $3, $4, true, $5, $6)`,
      [
        permissionId,
        ref(input.permissionRef),
        uuid(input.datasetId, "datasetId"),
        input.recipientUserId,
        text(input.evidenceRef, "evidenceRef", 500),
        text(input.recordedBy, "recordedBy", 200),
      ],
    );
  });
  return { permissionId };
}

/** Clears clips for one evidence row: explicit IDs or all approved members. */
export async function clearClips(
  owner: pg.Pool,
  input: {
    permissionRef: string;
    clipIds?: string[];
    allCurrentMembers?: boolean;
    clearedBy: string;
  },
): Promise<{ cleared: number }> {
  if (!input.clipIds?.length === !input.allCurrentMembers)
    throw new CatalogError(
      "invalid_request",
      "Pass either clipIds or allCurrentMembers",
    );
  const clipIds = (input.clipIds ?? []).map((id) => uuid(id, "clipId"));
  if (clipIds.length > 500)
    throw new CatalogError("invalid_request", "At most 500 clips per call");
  return inTransaction(owner, async (tx) => {
    const { rows } = await tx.query<{ id: string; dataset_id: string }>(
      "SELECT id, dataset_id FROM dataset_sharing_permissions WHERE permission_ref = $1",
      [ref(input.permissionRef)],
    );
    const permission = rows[0];
    if (!permission)
      throw new CatalogError("not_found", "Sharing permission not found");
    const target = await tx.query<{ id: string }>(
      input.allCurrentMembers
        ? `SELECT dc.clip_id AS id FROM dataset_clips dc
           WHERE dc.dataset_id = $1 AND catalog_latest_decision(dc.clip_id) = 'approved'
           ORDER BY dc.clip_id LIMIT 501`
        : "SELECT u AS id FROM unnest($1::uuid[]) AS t(u) ORDER BY u",
      input.allCurrentMembers ? [permission.dataset_id] : [clipIds],
    );
    if (target.rows.length > 500)
      throw new CatalogError(
        "invalid_request",
        "Dataset has more than 500 approved members; clear explicit batches",
      );
    // The guard takes each clip lock and the evidence lock (lock order 1 -> 3).
    let cleared = 0;
    for (const { id } of target.rows) {
      const result = await tx.query(
        `INSERT INTO dataset_sharing_clearances (permission_id, clip_id, cleared_by)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [permission.id, id, text(input.clearedBy, "clearedBy", 200)],
      );
      cleared += result.rowCount ?? 0;
    }
    return { cleared };
  });
}

/** Clears the approved result of each review clip for one recipient permission. */
export async function clearReviewClips(
  owner: pg.Pool,
  input: {
    permissionRef: string;
    clearedBy: string;
  } & (
    | {
        results: (ReviewResult & { clipId: string })[];
        allCurrentMembers?: never;
      }
    | { allCurrentMembers: true; results?: never }
  ),
): Promise<{ cleared: number }> {
  const results = input.results;
  if (Boolean(results?.length) === Boolean(input.allCurrentMembers))
    throw new CatalogError(
      "invalid_request",
      "Pass either results or allCurrentMembers",
    );
  if (results && results.length > 500)
    throw new CatalogError("invalid_request", "At most 500 results per call");
  for (const result of results ?? []) {
    uuid(result.clipId, "clipId");
    validateReviewResult(result);
  }
  const permissionRef = ref(input.permissionRef);
  const clearedBy = text(input.clearedBy, "clearedBy", 200);
  return inTransaction(owner, async (tx) => {
    await tx.query("SET LOCAL lock_timeout = '5s'");
    const {
      rows: [permission],
    } = await tx.query<{ id: string; dataset_id: string }>(
      "SELECT id, dataset_id FROM dataset_sharing_permissions WHERE permission_ref = $1 AND status = 'active'",
      [permissionRef],
    );
    if (!permission)
      throw new CatalogError(
        "forbidden",
        "Active sharing permission is required",
      );
    const { rows: targets } = results
      ? await tx.query<ReviewResult & { clipId: string }>(
          `SELECT pins.* FROM jsonb_to_recordset($1::jsonb) AS pins(
              "clipId" uuid, "jobId" uuid, "resultManifestSha256" text, "selectionRevision" integer)
            LEFT JOIN review_clips c ON c.id = pins."clipId"
            ORDER BY c.recording_id, pins."clipId"`,
          [JSON.stringify(results)],
        )
      : await tx.query<ReviewResult & { clipId: string }>(
          `SELECT m.clip_id AS "clipId", m.job_id AS "jobId",
              m.result_manifest_sha256 AS "resultManifestSha256", m.selection_revision AS "selectionRevision"
            FROM dataset_review_clips m
            JOIN selected_dataset_review_clips s USING (dataset_id, clip_id)
            JOIN review_clips c ON c.id = m.clip_id AND c.selected_job_id = m.job_id
            WHERE m.dataset_id = $1 AND m.selection_revision = (
              SELECT max(seq) FROM clip_result_selections WHERE clip_id = m.clip_id
            )
            ORDER BY c.recording_id, m.clip_id LIMIT 501`,
          [permission.dataset_id],
        );
    if (targets.length > 500)
      throw new CatalogError(
        "invalid_request",
        "Dataset has more than 500 approved members; clear explicit batches",
      );
    // Lock all result pins in recording order before the first evidence lock.
    for (const target of targets)
      await requireSelectedResult(tx, target.clipId, target);
    let cleared = 0;
    for (const target of targets) {
      const result = await tx.query(
        `INSERT INTO dataset_review_clip_clearances
           (clip_id, job_id, result_manifest_sha256, selection_revision, permission_id, cleared_by)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
        [...resultParams(target.clipId, target), permission.id, clearedBy],
      );
      cleared += result.rowCount ?? 0;
    }
    return { cleared };
  });
}

/**
 * Enables the recipient's view grant on the named evidence. `actorUserId` is
 * the enabled staff member the operator acts for (recorded as granted_by).
 */
export async function grantDatasetAccess(
  owner: pg.Pool,
  input: { permissionRef: string; actorUserId: string },
): Promise<{ datasetId: string; recipientUserId: string }> {
  return inTransaction(owner, async (tx) => {
    const { rows } = await tx.query<{
      dataset_id: string;
      recipient_user_id: string;
    }>(
      `SELECT dataset_id, recipient_user_id FROM dataset_sharing_permissions
       WHERE permission_ref = $1`,
      [ref(input.permissionRef)],
    );
    const permission = rows[0];
    if (!permission)
      throw new CatalogError("not_found", "Sharing permission not found");
    await tx.query("SELECT catalog_set_dataset_access($1, $2, true, $3, $4)", [
      permission.dataset_id,
      permission.recipient_user_id,
      input.actorUserId,
      input.permissionRef,
    ]);
    return {
      datasetId: permission.dataset_id,
      recipientUserId: permission.recipient_user_id,
    };
  });
}

export async function disableDatasetAccess(
  owner: pg.Pool,
  input: { datasetId: string; userId: string; actorUserId: string },
): Promise<void> {
  await inTransaction(owner, async (tx) => {
    await tx.query(
      "SELECT catalog_set_dataset_access($1, $2, false, $3, 'disabled')",
      [uuid(input.datasetId, "datasetId"), input.userId, input.actorUserId],
    );
  });
}

/** Revokes evidence; the trigger disables every grant that rests on it. */
export async function revokeSharingPermission(
  owner: pg.Pool,
  input: { permissionRef: string; revokedBy: string; reason: string },
): Promise<{ revoked: boolean }> {
  return inTransaction(owner, async (tx) => {
    const { rowCount } = await tx.query(
      `UPDATE dataset_sharing_permissions
       SET status = 'revoked', revoked_by = $2, revocation_reason = $3, revoked_at = now()
       WHERE permission_ref = $1 AND status = 'active'`,
      [
        ref(input.permissionRef),
        text(input.revokedBy, "revokedBy", 200),
        text(input.reason, "reason", 1000),
      ],
    );
    return { revoked: rowCount === 1 };
  });
}

export async function listSharingPermissions(
  owner: pg.Pool,
  datasetId: string,
): Promise<SharingPermission[]> {
  const { rows } = await owner.query<{
    permission_ref: string;
    dataset_id: string;
    recipient_user_id: string;
    status: "active" | "revoked";
    evidence_ref: string;
    recorded_by: string;
    cleared: string;
  }>(
    `SELECT p.permission_ref, p.dataset_id, p.recipient_user_id, p.status, p.evidence_ref,
            p.recorded_by,
            (SELECT count(*) FROM dataset_sharing_clearances c WHERE c.permission_id = p.id)::text AS cleared
     FROM dataset_sharing_permissions p WHERE p.dataset_id = $1
     ORDER BY p.created_at DESC, p.id DESC LIMIT 200`,
    [uuid(datasetId, "datasetId")],
  );
  return rows.map((r) => ({
    permissionRef: r.permission_ref,
    datasetId: r.dataset_id,
    recipientUserId: r.recipient_user_id,
    status: r.status,
    evidenceRef: r.evidence_ref,
    recordedBy: r.recorded_by,
    clearedClips: Number(r.cleared),
  }));
}
