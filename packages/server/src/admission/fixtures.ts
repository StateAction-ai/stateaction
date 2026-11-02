import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { inTransaction } from "../catalog/catalog.js";

/**
 * EXPLICIT local-seed/test fixture step, owner credential only. It establishes
 * synthetic ingest evidence for a recording that was created through the
 * SA-13 catalog helpers (no registration/manifest validation) so the
 * fail-closed jobs trigger admits exactly `firstJobId`. It records a clearly
 * labelled fixture permission (when the owner has none active), a fixture
 * registration digest, the live sealed inventory and an admitted row naming
 * the job. It never adopts a recording under another account (the recording's
 * own owner is used) and the restricted web role cannot run it, because it
 * cannot write ingest_permissions. Production admission is admitInTransaction.
 */
export async function establishFixtureAdmission(
  ownerPool: pg.Pool,
  input: { recordingId: string; firstJobId: string; recordedBy?: string },
): Promise<{ permissionRef: string }> {
  return inTransaction(ownerPool, async (tx) => {
    const { rows } = await tx.query<{ owner: string; sha: string | null }>(
      "SELECT owner_user_id AS owner, source_manifest_sha256 AS sha FROM recordings WHERE id = $1 FOR UPDATE",
      [input.recordingId],
    );
    const rec = rows[0];
    if (!rec?.sha)
      throw new Error("Fixture admission needs a sealed recording");
    let permission = (
      await tx.query<{ id: string; ref: string }>(
        "SELECT id, permission_ref AS ref FROM ingest_permissions WHERE owner_user_id = $1 AND status = 'active'",
        [rec.owner],
      )
    ).rows[0];
    if (!permission) {
      const ref = `fixture-${createHash("sha256").update(rec.owner).digest("hex").slice(0, 16)}`;
      const id = randomUUID();
      await tx.query(
        `INSERT INTO ingest_permissions (id, permission_ref, owner_user_id, pilot_scope, covers_capture,
           covers_processing, evidence_ref, recorded_by)
         VALUES ($1, $2, $3, 'local-fixture', true, true, 'fixture:local-only synthetic evidence', $4)`,
        [id, ref, rec.owner, input.recordedBy ?? "fixture"],
      );
      permission = { id, ref };
    }
    await tx.query(
      `INSERT INTO recording_registrations (recording_id, owner_user_id, request_sha256, ingest_permission_id, permission_ref)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (recording_id) DO NOTHING`,
      [
        input.recordingId,
        rec.owner,
        createHash("sha256")
          .update(`fixture-registration:${input.recordingId}`)
          .digest("hex"),
        permission.id,
        permission.ref,
      ],
    );
    const files = await tx.query<{ inventory: unknown }>(
      `SELECT coalesce(jsonb_agg(jsonb_build_object('fileId', id, 'role', role, 'sizeBytes', size_bytes::text,
                'sha256', sha256, 'required', required) ORDER BY id), '[]') AS inventory
       FROM files WHERE recording_id = $1 AND purpose = 'source' AND state NOT IN ('cancelled', 'failed', 'expired')`,
      [input.recordingId],
    );
    await tx.query(
      `INSERT INTO recording_seals (recording_id, request_sha256, source_manifest_sha256, inventory)
       VALUES ($1, $2, $3, $4) ON CONFLICT (recording_id) DO NOTHING`,
      [
        input.recordingId,
        createHash("sha256")
          .update(`fixture-seal:${input.recordingId}`)
          .digest("hex"),
        rec.sha,
        JSON.stringify(files.rows[0]!.inventory),
      ],
    );
    await tx.query(
      `INSERT INTO recording_admissions (recording_id, source_manifest_sha256, outcome, job_id,
         ingest_permission_id, permission_ref, capture_format, rgb_profile, capture_config_sha256,
         close_status, clock_domains, declared_files, calibration_file_ids, counts, channel_count)
       SELECT r.id, r.source_manifest_sha256, 'admitted', $2, $3, $4, r.capture_format, r.rgb_profile,
              $5, 'closed_clean', '["fixture"]', s.inventory, '{}', '{"fixture": true}', 1
       FROM recordings r JOIN recording_seals s ON s.recording_id = r.id WHERE r.id = $1`,
      [
        input.recordingId,
        input.firstJobId,
        permission.id,
        permission.ref,
        createHash("sha256").update("fixture-capture-config").digest("hex"),
      ],
    );
    return { permissionRef: permission.ref };
  });
}
