import { randomUUID } from "node:crypto";
import {
  ContractViolation,
  parseContract,
  requestSha256,
  type InventoryFile,
  type Recording,
  type RecordingCreateRequest,
  type RecordingSealRequest,
} from "@stateaction/contracts";
import type pg from "pg";
import { inTransaction, type Queryable } from "../catalog/catalog.js";
import { CatalogError } from "../catalog/errors.js";
import {
  checkSourceDeclaration,
  normalizeSeal,
  sealRequestSha256,
  SOURCE_MANIFEST_MAX_BYTES,
} from "./inventory.js";

type Tx = pg.PoolClient;

/**
 * Authenticated collector identity supplied by the server-side auth boundary
 * (Better Auth session guard, SA-15). Never derived from request fields.
 */
export type CollectorPrincipal = { userId: string };

/** Thrown by an ObjectReader when the stored object exceeds maxBytes. */
export class ObjectTooLargeError extends Error {
  readonly code = "object_too_large";
}

/**
 * Reads one stored object by key, refusing more than maxBytes. Injected:
 * tests use an in-memory store; the storage-backed reader belongs to the
 * upload transport tickets. Used only for the <= 1 MiB source manifest.
 */
export type ObjectReader = {
  read(objectKey: string, maxBytes: number): Promise<Uint8Array>;
};

export type AdmissionConfig = {
  /** Processing profile revision pinned on admitted jobs (explicit config). */
  processingProfileRevision: string;
  /** RGB profiles the server accepts for processing. */
  supportedRgbProfiles: readonly string[];
};

export type AdmissionDeps = {
  pool: Queryable;
  reader: ObjectReader;
  config: AdmissionConfig;
  newId?: () => string;
};

/** Explicit, config-driven admission settings (no implicit defaults). */
export function admissionConfigFromEnv(
  env: Record<string, string | undefined>,
): AdmissionConfig {
  const revision = env.PROCESSING_PROFILE_REVISION;
  if (!revision || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(revision))
    throw new Error(
      "Missing or invalid server setting: PROCESSING_PROFILE_REVISION",
    );
  const profiles = (env.SUPPORTED_RGB_PROFILES ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (!profiles.length || profiles.some((p) => p !== "h264_mcap_v1"))
    throw new Error(
      "Missing or invalid server setting: SUPPORTED_RGB_PROFILES",
    );
  return {
    processingProfileRevision: revision,
    supportedRgbProfiles: profiles,
  };
}

export type AdmissionState =
  | { state: "awaiting_seal" }
  | { state: "awaiting_uploads"; pendingFileIds: string[] }
  | { state: "awaiting_manifest_bytes" }
  | { state: "blocked_permission" }
  /** Bytes read did not match the pinned digest/size: retryable, not durable. */
  | { state: "manifest_unverified"; code: string }
  /** Valid declaration, but the current server configuration does not accept
   * its RGB profile: retryable after a configuration change, not durable. */
  | { state: "deferred"; code: "profile_unsupported" }
  | { state: "rejected"; code: string }
  | { state: "admitted"; jobId: string; sourceManifestSha256: string };

const AUTH_USER = /^[A-Za-z0-9][A-Za-z0-9._~:-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNVERIFIED = new Set([
  "manifest_too_large",
  "manifest_size_mismatch",
  "manifest_digest_mismatch",
]);
const REQUIRED_ROLES = [
  "source_manifest",
  "source_mcap",
  "recorder_metadata",
] as const;

function principalId(principal: CollectorPrincipal): string {
  if (
    !principal ||
    typeof principal.userId !== "string" ||
    !AUTH_USER.test(principal.userId)
  )
    throw new CatalogError("forbidden", "Authenticated collector required");
  return principal.userId;
}
function recordingUuid(value: string): string {
  if (typeof value !== "string" || !UUID.test(value))
    throw new CatalogError("not_found", "Recording not found");
  return value;
}
function contract<T>(id: string, body: unknown): T {
  try {
    return parseContract<T>(id, body);
  } catch (error) {
    if (error instanceof ContractViolation)
      throw new CatalogError("invalid_request", `Request failed ${error.code}`);
    throw error;
  }
}

// ------------------------------------------------------------------ views
const TS = `to_char(%s AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** http.recording.v1 view of an owner's recording (same transaction/snapshot). */
async function recordingView(
  q: Tx | Queryable,
  recordingId: string,
  ownerUserId: string,
): Promise<Recording | undefined> {
  const { rows } = await q.query<{
    id: string;
    client_recording_id: string;
    owner_user_id: string;
    status: Recording["status"];
    created: string;
  }>(
    `SELECT id, client_recording_id, owner_user_id, status, ${TS.replace("%s", "created_at")} AS created
     FROM recordings WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL`,
    [recordingId, ownerUserId],
  );
  const r = rows[0];
  if (!r) return undefined;
  const files = await q.query<{
    id: string;
    role: InventoryFile["role"];
    size_bytes: string;
    sha256: string;
    required: boolean;
    state: Recording["files"][number]["state"];
  }>(
    `SELECT id, role, size_bytes::text, sha256, required, state FROM files
     WHERE recording_id = $1 AND purpose = 'source' ORDER BY created_at, id LIMIT 2000`,
    [recordingId],
  );
  const live = files.rows.filter(
    (f) => !["cancelled", "failed", "expired"].includes(f.state),
  );
  return {
    recordingId: r.id,
    clientRecordingId: r.client_recording_id,
    ownerUserId: r.owner_user_id,
    status: r.status,
    createdAt: r.created,
    files: files.rows.map((f) => ({
      fileId: f.id,
      role: f.role,
      sizeBytes: f.size_bytes,
      sha256: f.sha256,
      required: f.required,
      state: f.state,
    })),
    missingRequiredRoles: REQUIRED_ROLES.filter(
      (role) => !live.some((f) => f.role === role && f.required),
    ),
  };
}

export async function getRecording(
  pool: Queryable,
  principal: CollectorPrincipal,
  recordingId: string,
): Promise<Recording> {
  const owner = principalId(principal);
  const view = await recordingView(pool, recordingUuid(recordingId), owner);
  // Absent and other-owner recordings are indistinguishable.
  if (!view) throw new CatalogError("not_found", "Recording not found");
  return view;
}

// ---------------------------------------------------------- registration
/**
 * POST /api/v1/recordings. Idempotency scope (owner, recordings.create,
 * clientRecordingId) with the sa-cjson-v1 digest of the exact request: an
 * identical replay returns the original recording; any changed field,
 * including a different but equivalent startedAt spelling, is
 * idempotency_conflict. Requires an enabled collector role and the owner's
 * active capture permission evidence, which the registration binds.
 */
export async function registerRecording(
  deps: Pick<AdmissionDeps, "pool" | "newId">,
  principal: CollectorPrincipal,
  body: unknown,
): Promise<{
  created: boolean;
  recording: Recording;
  collectionPermissionRef: string;
}> {
  const owner = principalId(principal);
  const request = contract<RecordingCreateRequest>(
    "http.recording-create.v1",
    body,
  );
  const digest = requestSha256(request);
  const newId = deps.newId ?? randomUUID;
  return inTransaction(deps.pool, async (tx) => {
    const replay = async () => {
      const { rows } = await tx.query<{
        id: string;
        digest: string | null;
        ref: string;
      }>(
        `SELECT r.id, g.request_sha256 AS digest, g.permission_ref AS ref FROM recordings r
         LEFT JOIN recording_registrations g ON g.recording_id = r.id
         WHERE r.owner_user_id = $1 AND r.client_recording_id = $2`,
        [owner, request.clientRecordingId],
      );
      if (!rows[0]) return undefined;
      if (rows[0].digest !== digest)
        throw new CatalogError(
          "idempotency_conflict",
          "clientRecordingId was already used with a different request",
        );
      return {
        created: false,
        recording: (await recordingView(tx, rows[0].id, owner))!,
        collectionPermissionRef: rows[0].ref,
      };
    };
    const existing = await replay();
    if (existing) return existing;
    const role = await tx.query<{ ok: boolean }>(
      "SELECT catalog_has_role($1, 'collector') AS ok",
      [owner],
    );
    if (!role.rows[0]?.ok)
      throw new CatalogError("forbidden", "Requires an enabled collector role");
    const permission = await tx.query<{ id: string; ref: string; ok: boolean }>(
      `SELECT id, permission_ref AS ref, ingest_permission_ok(id, owner_user_id, false) AS ok
       FROM ingest_permissions WHERE owner_user_id = $1 AND status = 'active'`,
      [owner],
    );
    const approval = permission.rows[0];
    if (!approval?.ok)
      throw new CatalogError(
        "forbidden",
        "Collection permission has not been recorded for this collector",
      );
    const recordingId = newId();
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO recordings (id, owner_user_id, client_recording_id, capture_format, rgb_profile, started_at, device)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (owner_user_id, client_recording_id) DO NOTHING RETURNING id`,
      [
        recordingId,
        owner,
        request.clientRecordingId,
        request.captureFormat,
        request.rgbProfile,
        request.startedAt,
        {
          model: request.device.model,
          osVersion: request.device.osVersion,
          appVersion: request.device.appVersion,
        },
      ],
    );
    // A concurrent identical registration committed first: resolve by key.
    if (!inserted.rows[0]) return (await replay())!;
    await tx.query(
      `INSERT INTO recording_registrations (recording_id, owner_user_id, request_sha256, ingest_permission_id, permission_ref)
       VALUES ($1, $2, $3, $4, $5)`,
      [recordingId, owner, digest, approval.id, approval.ref],
    );
    return {
      created: true,
      recording: (await recordingView(tx, recordingId, owner))!,
      collectionPermissionRef: approval.ref,
    };
  });
}

// ------------------------------------------------------------- admission
type ManifestBytes = {
  fileId: string;
  objectKey: string;
  transportEpoch: number;
  bytes?: Uint8Array;
  tooLarge?: boolean;
};

/**
 * Reads the completed manifest bytes OUTSIDE any transaction (no lock held
 * across storage I/O). A completed transport is closed (immutable key/epoch),
 * so the transaction re-checks that the row still names the same object.
 * Transient read failures leave admission pending and recoverable.
 */
async function prereadManifest(
  deps: AdmissionDeps,
  recordingId: string,
  manifestFileId?: string,
  completingFileId?: string,
): Promise<ManifestBytes | undefined> {
  // Only a closed (or now-completing) manifest transport is ever read.
  const { rows } = await deps.pool.query<{
    id: string;
    object_key: string;
    transport_epoch: number;
  }>(
    `SELECT id, object_key, transport_epoch FROM files
     WHERE recording_id = $1 AND purpose = 'source' AND role = 'source_manifest'
       AND ($2::uuid IS NULL OR id = $2)
       AND (state IN ('completed', 'verified') OR id = $3::uuid)`,
    [recordingId, manifestFileId ?? null, completingFileId ?? null],
  );
  const row = rows[0];
  if (!row) return undefined;
  const ref = {
    fileId: row.id,
    objectKey: row.object_key,
    transportEpoch: row.transport_epoch,
  };
  try {
    return {
      ...ref,
      bytes: await deps.reader.read(row.object_key, SOURCE_MANIFEST_MAX_BYTES),
    };
  } catch (error) {
    if (error instanceof ObjectTooLargeError) return { ...ref, tooLarge: true };
    return undefined;
  }
}

/**
 * The common eligibility transaction step, used by seal, final completion and
 * recovery. The caller holds the recording row FOR UPDATE (lock order step
 * 1), so concurrent or reordered callers serialize and at most one creates
 * the queued job. Writes nothing until every required file is completed and
 * the manifest bytes are validated; a durable rejection is recorded for an
 * invalid declaration. Missing/revoked permission leaves the recording
 * pending (no job, no rejection).
 */
export async function admitInTransaction(
  tx: Tx,
  deps: AdmissionDeps,
  recordingId: string,
  manifest: ManifestBytes | undefined,
): Promise<AdmissionState> {
  const { rows } = await tx.query<{
    owner_user_id: string;
    client_recording_id: string;
    capture_format: string;
    rgb_profile: string;
    manifest_file_id: string | null;
    manifest_sha: string | null;
    ingest_permission_id: string;
    permission_ref: string;
    sealed: boolean;
    inventory: InventoryFile[] | null;
    outcome: "admitted" | "rejected" | null;
    rejection_code: string | null;
    job_id: string | null;
  }>(
    `SELECT r.owner_user_id, r.client_recording_id, r.capture_format, r.rgb_profile,
            r.source_manifest_file_id AS manifest_file_id, r.source_manifest_sha256 AS manifest_sha,
            g.ingest_permission_id, g.permission_ref, s.recording_id IS NOT NULL AS sealed, s.inventory,
            a.outcome, a.rejection_code, a.job_id
     FROM recordings r
     JOIN recording_registrations g ON g.recording_id = r.id
     LEFT JOIN recording_seals s ON s.recording_id = r.id
     LEFT JOIN recording_admissions a ON a.recording_id = r.id
     WHERE r.id = $1`,
    [recordingId],
  );
  const r = rows[0];
  if (!r)
    throw new CatalogError(
      "conflict",
      "Recording was not registered for v1 admission",
    );
  if (r.outcome === "admitted")
    return {
      state: "admitted",
      jobId: r.job_id!,
      sourceManifestSha256: r.manifest_sha!,
    };
  if (r.outcome === "rejected")
    return { state: "rejected", code: r.rejection_code! };
  if (!r.sealed || !r.manifest_file_id || !r.manifest_sha || !r.inventory)
    return { state: "awaiting_seal" };
  const pending = await tx.query<{ id: string }>(
    `SELECT id FROM files WHERE recording_id = $1 AND purpose = 'source' AND required
       AND state NOT IN ('cancelled', 'failed', 'expired', 'completed', 'verified') ORDER BY id`,
    [recordingId],
  );
  if (pending.rows.length)
    return {
      state: "awaiting_uploads",
      pendingFileIds: pending.rows.map((p) => p.id),
    };
  const file = await tx.query<{
    object_key: string;
    transport_epoch: number;
    observed: string;
  }>(
    `SELECT object_key, transport_epoch, observed_size_bytes::text AS observed FROM files
     WHERE id = $1 AND state IN ('completed', 'verified')`,
    [r.manifest_file_id],
  );
  const stored = file.rows[0];
  if (
    !stored ||
    !manifest ||
    manifest.fileId !== r.manifest_file_id ||
    manifest.objectKey !== stored.object_key ||
    manifest.transportEpoch !== stored.transport_epoch ||
    (!manifest.bytes && !manifest.tooLarge)
  )
    return { state: "awaiting_manifest_bytes" };
  // Lock order step 3: the approval row FOR SHARE serializes with revocation.
  const permitted = await tx.query<{ ok: boolean }>(
    "SELECT ingest_permission_ok($1, $2, true) AS ok",
    [r.ingest_permission_id, r.owner_user_id],
  );
  if (!permitted.rows[0]?.ok) return { state: "blocked_permission" };
  const check = manifest.tooLarge
    ? ({ ok: false, code: "manifest_too_large" } as const)
    : checkSourceDeclaration(manifest.bytes!, {
        recordingId,
        clientRecordingId: r.client_recording_id,
        ownerUserId: r.owner_user_id,
        captureFormat: r.capture_format,
        rgbProfile: r.rgb_profile,
        sourceManifestSha256: r.manifest_sha,
        sizeBytes: stored.observed,
        permissionRef: r.permission_ref,
        seal: r.inventory,
        supportedRgbProfiles: deps.config.supportedRgbProfiles,
      });
  // Until the bytes hash to the pinned digest nothing is decided durably: a
  // short/corrupt read or wrong object stays retryable.
  if (!check.ok && UNVERIFIED.has(check.code))
    return { state: "manifest_unverified", code: check.code };
  if (!check.ok && check.code === "profile_unsupported")
    return { state: "deferred", code: "profile_unsupported" };
  if (!check.ok) {
    await tx.query(
      `INSERT INTO recording_admissions (recording_id, source_manifest_sha256, outcome, rejection_code)
       VALUES ($1, $2, 'rejected', $3)`,
      [recordingId, r.manifest_sha, check.code],
    );
    await tx.query("UPDATE recordings SET status = 'failed' WHERE id = $1", [
      recordingId,
    ]);
    return { state: "rejected", code: check.code };
  }
  const e = check.evidence;
  const jobId = (deps.newId ?? randomUUID)();
  // Evidence first: the jobs trigger requires the admitted row naming this job.
  await tx.query(
    `INSERT INTO recording_admissions (recording_id, source_manifest_sha256, outcome, job_id,
       ingest_permission_id, permission_ref, capture_format, rgb_profile, capture_config_sha256,
       close_status, clock_domains, declared_files, calibration_file_ids, counts, channel_count)
     VALUES ($1, $2, 'admitted', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      recordingId,
      r.manifest_sha,
      jobId,
      r.ingest_permission_id,
      r.permission_ref,
      e.captureFormat,
      e.rgbProfile,
      e.captureConfigSha256,
      e.closeStatus,
      JSON.stringify(e.clockDomains),
      JSON.stringify(e.declaredFiles),
      e.calibrationFileIds,
      e.counts,
      e.channelCount,
    ],
  );
  await tx.query(
    `INSERT INTO jobs (id, kind, recording_id, source_manifest_sha256, profile_revision)
     VALUES ($1, 'process_recording', $2, $3, $4)`,
    [jobId, recordingId, r.manifest_sha, deps.config.processingProfileRevision],
  );
  await tx.query(
    "UPDATE recordings SET current_job_id = $2, status = 'uploaded' WHERE id = $1",
    [recordingId, jobId],
  );
  return { state: "admitted", jobId, sourceManifestSha256: r.manifest_sha };
}

async function lockOwnedRecording(tx: Tx, recordingId: string, owner: string) {
  const { rows } = await tx.query<{ manifest: string | null }>(
    `SELECT source_manifest_file_id AS manifest FROM recordings
     WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL FOR UPDATE`,
    [recordingId, owner],
  );
  if (!rows[0]) throw new CatalogError("not_found", "Recording not found");
  return rows[0];
}

/**
 * Runs `mutate` and the eligibility step in one transaction. If the manifest
 * object changed or became readable between the pre-read and the lock, the
 * whole transaction is retried once with fresh bytes (mutations are replay-safe).
 */
async function withAdmission<T>(
  deps: AdmissionDeps,
  recordingId: string,
  manifestFileId: string | undefined,
  mutate: (tx: Tx) => Promise<T>,
  completingFileId?: string,
): Promise<{ result: T; admission: AdmissionState }> {
  for (let attempt = 0; ; attempt++) {
    const manifest = await prereadManifest(
      deps,
      recordingId,
      manifestFileId,
      completingFileId,
    );
    const out = await inTransaction(deps.pool, async (tx) => {
      const result = await mutate(tx);
      const admission = await admitInTransaction(
        tx,
        deps,
        recordingId,
        manifest,
      );
      return { result, admission };
    });
    const stale =
      out.admission.state === "awaiting_manifest_bytes" &&
      manifest?.bytes === undefined;
    if (!stale || attempt >= 1) return out;
  }
}

// ------------------------------------------------------------------ seal
/**
 * POST /api/v1/recordings/{recordingId}/seal. Freezes the exact declared live
 * inventory (one required manifest, one required MCAP, >= 1 required
 * recorder_metadata, optional others as declared). Inventory order is not
 * meaningful; an identical (normalized) replay succeeds and re-runs the
 * idempotent eligibility step; a changed seal is idempotency_conflict. Then
 * attempts admission in the same transaction.
 */
export async function sealRecordingInventory(
  deps: AdmissionDeps,
  principal: CollectorPrincipal,
  recordingId: string,
  body: unknown,
): Promise<{
  replayed: boolean;
  recording: Recording;
  admission: AdmissionState;
}> {
  const owner = principalId(principal);
  const id = recordingUuid(recordingId);
  const request = contract<RecordingSealRequest>(
    "http.recording-seal.v1",
    body,
  );
  const seal = normalizeSeal(request.files);
  const digest = sealRequestSha256(seal);
  const manifestFileId = seal.find((f) => f.role === "source_manifest")!.fileId;
  const { result, admission } = await withAdmission(
    deps,
    id,
    manifestFileId,
    async (tx) => {
      const recording = await lockOwnedRecording(tx, id, owner);
      const prior = await tx.query<{ digest: string }>(
        "SELECT request_sha256 AS digest FROM recording_seals WHERE recording_id = $1",
        [id],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].digest !== digest)
          throw new CatalogError(
            "idempotency_conflict",
            "Recording is already sealed with a different inventory",
          );
        return { replayed: true };
      }
      const registered = await tx.query(
        "SELECT 1 FROM recording_registrations WHERE recording_id = $1",
        [id],
      );
      if (!registered.rowCount)
        throw new CatalogError(
          "conflict",
          "Recording was not registered for v1 admission",
        );
      if (recording.manifest !== null)
        throw new CatalogError("conflict", "Recording is already sealed");
      const live = await tx.query<{
        id: string;
        role: string;
        size_bytes: string;
        sha256: string;
        required: boolean;
      }>(
        `SELECT id, role, size_bytes::text, sha256, required FROM files
       WHERE recording_id = $1 AND purpose = 'source' AND state NOT IN ('cancelled', 'failed', 'expired')
       ORDER BY id`,
        [id],
      );
      const matches =
        live.rows.length === seal.length &&
        live.rows.every((f, i) => {
          const s = seal[i]!;
          return (
            f.id === s.fileId &&
            f.role === s.role &&
            f.size_bytes === s.sizeBytes &&
            f.sha256 === s.sha256 &&
            f.required === s.required
          );
        });
      if (!matches)
        throw new CatalogError(
          "conflict",
          "Seal does not match the reserved live source inventory",
        );
      await tx.query(
        `UPDATE recordings r SET status = 'sealed', source_manifest_file_id = f.id, source_manifest_sha256 = f.sha256
       FROM files f WHERE r.id = $1 AND f.id = $2 AND f.recording_id = r.id`,
        [id, manifestFileId],
      );
      await tx.query(
        `INSERT INTO recording_seals (recording_id, request_sha256, source_manifest_sha256, inventory)
       VALUES ($1, $2, (SELECT source_manifest_sha256 FROM recordings WHERE id = $1), $3)`,
        [id, digest, JSON.stringify(seal)],
      );
      return { replayed: false };
    },
  );
  return {
    replayed: result.replayed,
    recording: (await recordingView(deps.pool, id, owner))!,
    admission,
  };
}

// ------------------------------------------------------------ completion
/**
 * Database side of final source-file completion. The upload transport
 * (SA-20/21) calls this only AFTER the provider completed the multipart
 * upload and the API verified the object size; this ticket performs no
 * provider calls. Records the current transport epoch as completed and runs
 * the same eligibility step in the same transaction. An exact replay of an
 * already-completed epoch is accepted; a stale epoch conflicts.
 */
export async function recordSourceCompletion(
  deps: AdmissionDeps,
  principal: CollectorPrincipal,
  input: {
    recordingId: string;
    fileId: string;
    expectedTransportEpoch: number;
    observedSizeBytes: string;
  },
): Promise<{ replayed: boolean; admission: AdmissionState }> {
  const owner = principalId(principal);
  const id = recordingUuid(input.recordingId);
  if (!UUID.test(input.fileId))
    throw new CatalogError("not_found", "File not found");
  if (
    !Number.isSafeInteger(input.expectedTransportEpoch) ||
    input.expectedTransportEpoch < 1
  )
    throw new CatalogError(
      "invalid_request",
      "expectedTransportEpoch must be a positive integer",
    );
  if (!/^(0|[1-9][0-9]{0,11})$/.test(input.observedSizeBytes))
    throw new CatalogError(
      "invalid_request",
      "observedSizeBytes must be a decimal byte count",
    );
  const { result, admission } = await withAdmission(
    deps,
    id,
    undefined,
    async (tx) => {
      await lockOwnedRecording(tx, id, owner);
      const { rows } = await tx.query<{
        state: string;
        epoch: number;
        size: string;
        observed: string | null;
      }>(
        `SELECT state, transport_epoch AS epoch, size_bytes::text AS size, observed_size_bytes::text AS observed
       FROM files WHERE id = $1 AND recording_id = $2 AND purpose = 'source' FOR UPDATE`,
        [input.fileId, id],
      );
      const file = rows[0];
      if (!file) throw new CatalogError("not_found", "File not found");
      if (file.epoch !== input.expectedTransportEpoch)
        throw new CatalogError("conflict", "Stale file transport epoch");
      if (file.size !== input.observedSizeBytes)
        throw new CatalogError(
          "conflict",
          "Observed size does not match the declared size",
        );
      if (file.state === "completed" || file.state === "verified")
        return { replayed: true };
      if (!["reserved", "uploading", "completing"].includes(file.state))
        throw new CatalogError("conflict", "File transport is closed");
      await tx.query(
        `UPDATE files SET state = 'completed', observed_size_bytes = $2, completed_at = now() WHERE id = $1`,
        [input.fileId, input.observedSizeBytes],
      );
      return { replayed: false };
    },
    input.fileId,
  );
  return { replayed: result.replayed, admission };
}

/**
 * Idempotent recovery entry point (e.g. after a manifest read failure or a
 * crash between transactions): re-runs the eligibility step under the lock.
 */
export async function admitRecording(
  deps: AdmissionDeps,
  recordingId: string,
): Promise<AdmissionState> {
  const id = recordingUuid(recordingId);
  const { admission } = await withAdmission(deps, id, undefined, async (tx) => {
    const { rowCount } = await tx.query(
      "SELECT 1 FROM recordings WHERE id = $1 FOR UPDATE",
      [id],
    );
    if (!rowCount) throw new CatalogError("not_found", "Recording not found");
  });
  return admission;
}
