import { randomUUID } from "node:crypto";
import type pg from "pg";
import { inTransaction } from "../catalog/catalog.js";
import { CatalogError } from "../catalog/errors.js";

/**
 * Operator tooling for pilot ingest permission evidence. These writes need the
 * migration-owner credential: the restricted web role can only read
 * ingest_permissions, so no collector or web request can grant itself
 * permission. This is not a policy engine or admin UI.
 */
export type IngestPermission = {
  id: string;
  permissionRef: string;
  ownerUserId: string;
  pilotScope: string;
  coversCapture: boolean;
  coversProcessing: boolean;
  evidenceRef: string;
  recordedBy: string;
  status: "active" | "revoked";
  revokedAt: string | null;
};

const REF = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

type Row = {
  id: string;
  permission_ref: string;
  owner_user_id: string;
  pilot_scope: string;
  covers_capture: boolean;
  covers_processing: boolean;
  evidence_ref: string;
  recorded_by: string;
  status: "active" | "revoked";
  revoked_at: Date | null;
};
const toPermission = (r: Row): IngestPermission => ({
  id: r.id,
  permissionRef: r.permission_ref,
  ownerUserId: r.owner_user_id,
  pilotScope: r.pilot_scope,
  coversCapture: r.covers_capture,
  coversProcessing: r.covers_processing,
  evidenceRef: r.evidence_ref,
  recordedBy: r.recorded_by,
  status: r.status,
  revokedAt: r.revoked_at ? r.revoked_at.toISOString() : null,
});

/** Records active evidence for one collector (one active record per owner). */
export async function recordIngestPermission(
  ownerPool: pg.Pool,
  input: {
    permissionRef: string;
    ownerUserId: string;
    pilotScope: string;
    coversCapture: boolean;
    coversProcessing: boolean;
    evidenceRef: string;
    recordedBy: string;
  },
): Promise<IngestPermission> {
  if (!REF.test(input.permissionRef))
    throw new CatalogError(
      "invalid_request",
      "permissionRef must be a revision label",
    );
  return inTransaction(ownerPool, async (tx) => {
    const { rows } = await tx.query<Row>(
      `INSERT INTO ingest_permissions (id, permission_ref, owner_user_id, pilot_scope, covers_capture,
         covers_processing, evidence_ref, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        randomUUID(),
        input.permissionRef,
        input.ownerUserId,
        input.pilotScope,
        input.coversCapture,
        input.coversProcessing,
        input.evidenceRef,
        input.recordedBy,
      ],
    );
    return toPermission(rows[0]!);
  });
}

/**
 * One-way revocation. Waits for (and then blocks) registrations/admissions
 * holding the row FOR SHARE, so each one is ordered entirely before or after.
 */
export async function revokeIngestPermission(
  ownerPool: pg.Pool,
  input: { permissionRef: string; revokedBy: string; reason: string },
): Promise<IngestPermission> {
  return inTransaction(ownerPool, async (tx) => {
    const { rows } = await tx.query<Row>(
      `UPDATE ingest_permissions SET status = 'revoked', revoked_at = now(), revoked_by = $2,
         revocation_reason = $3
       WHERE permission_ref = $1 AND status = 'active' RETURNING *`,
      [input.permissionRef, input.revokedBy, input.reason],
    );
    if (!rows[0])
      throw new CatalogError(
        "not_found",
        "No active permission with that reference",
      );
    return toPermission(rows[0]);
  });
}

export async function listIngestPermissions(
  pool: pg.Pool,
  ownerUserId: string,
): Promise<IngestPermission[]> {
  const { rows } = await pool.query<Row>(
    "SELECT * FROM ingest_permissions WHERE owner_user_id = $1 ORDER BY created_at, id",
    [ownerUserId],
  );
  return rows.map(toPermission);
}
