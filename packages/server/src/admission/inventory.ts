import {
  checkSealedInventory,
  recordingSourceContractFor,
  requestSha256,
  sha256Hex,
  simulationFromArtifact,
  validateBytes,
  type InventoryFile,
  type SimulationProvenance,
  type SimulationProvenanceArtifact,
} from "@stateaction/contracts";

/** Bound for the source manifest control document (contract maxBytes). */
export const SOURCE_MANIFEST_MAX_BYTES = 1048576;

/**
 * Seal inventory in its normalized form: files sorted by fileId, exactly the
 * five contract fields. Inventory order carries no meaning (checkSealedInventory
 * matches by fileId), so the idempotency digest is taken over this form.
 */
export function normalizeSeal(
  files: readonly InventoryFile[],
): InventoryFile[] {
  return files
    .map((f) => ({
      fileId: f.fileId,
      role: f.role,
      sizeBytes: f.sizeBytes,
      sha256: f.sha256,
      required: f.required,
    }))
    .sort((a, b) => (a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : 0));
}

/** sa-cjson-v1 request digest of the normalized seal request. */
export function sealRequestSha256(files: readonly InventoryFile[]): string {
  return requestSha256({ files: normalizeSeal(files) });
}

export type DeclarationExpectation = {
  recordingId: string;
  clientRecordingId: string;
  ownerUserId: string;
  captureFormat: string;
  rgbProfile: string;
  /** Pinned digest of the sealed source_manifest file. */
  sourceManifestSha256: string;
  /** Completed (observed) size of the manifest file. */
  sizeBytes: string;
  /** Approval bound at registration (server state, never client input). */
  permissionRef: string;
  seal: readonly InventoryFile[];
  supportedRgbProfiles: readonly string[];
};

export type DeclarationEvidence = {
  captureFormat: string;
  rgbProfile: string;
  /** Simulation marker declared by the manifest (null for hardware). */
  simulation: SimulationProvenance | null;
  captureConfigSha256: string;
  closeStatus: "closed_clean" | "closed_after_recovery";
  clockDomains: string[];
  declaredFiles: {
    fileId: string;
    role: string;
    required: boolean;
    sizeBytes: string;
    sha256: string;
  }[];
  calibrationFileIds: string[];
  counts: {
    video_frames: string;
    dropped_video_frames: string;
    motion_events: string;
  };
  channelCount: number;
};

export type DeclarationCheck =
  | { ok: true; evidence: DeclarationEvidence }
  | { ok: false; code: string };

const CLOSED = new Set(["closed_clean", "closed_after_recovery"]);

type Declaration = {
  recording_id: string;
  client_recording_id: string;
  owner_user_id: string;
  capture_format: string;
  rgb_profile: string;
  simulation?: SimulationProvenanceArtifact;
  capture_config_sha256: string;
  close_status: "closed_clean" | "closed_after_recovery";
  files: {
    file_id: string;
    role: string;
    required: boolean;
    size_bytes: string;
    sha256: string;
  }[];
  clock_domains: string[];
  channels: { clock_domain: string }[];
  counts: DeclarationEvidence["counts"];
  collection_permission_ref: string;
};

/**
 * Validates the exact stored recording-source/v1 bytes before admission. Only
 * this bounded control document is read; media/MCAP bytes are never fetched.
 * The worker independently re-verifies the source bytes and evidence later.
 * Failure codes are stable, persisted rejection codes.
 */
export function checkSourceDeclaration(
  bytes: Uint8Array,
  expect: DeclarationExpectation,
): DeclarationCheck {
  const fail = (code: string): DeclarationCheck => ({ ok: false, code });
  if (bytes.byteLength > SOURCE_MANIFEST_MAX_BYTES)
    return fail("manifest_too_large");
  if (String(bytes.byteLength) !== expect.sizeBytes)
    return fail("manifest_size_mismatch");
  if (sha256Hex(bytes) !== expect.sourceManifestSha256)
    return fail("manifest_digest_mismatch");
  const result = validateBytes(
    recordingSourceContractFor(peekSchema(bytes)),
    bytes,
  );
  if (!result.valid) {
    if (result.code === "schema_violation" && unclosed(bytes))
      return fail("source_not_closed");
    return fail(`manifest_${result.code}`);
  }
  const doc = result.value as Declaration;
  if (
    doc.recording_id !== expect.recordingId ||
    doc.client_recording_id !== expect.clientRecordingId ||
    doc.owner_user_id !== expect.ownerUserId
  )
    return fail("identity_mismatch");
  if (
    doc.capture_format !== expect.captureFormat ||
    doc.rgb_profile !== expect.rgbProfile
  )
    return fail("profile_mismatch");
  if (!CLOSED.has(doc.close_status)) return fail("source_not_closed");
  if (doc.collection_permission_ref !== expect.permissionRef)
    return fail("permission_ref_mismatch");
  const inventory = checkSealedInventory(
    { files: expect.seal } as never,
    doc as never,
  );
  if (inventory) return fail(`seal_${inventory.code}`);
  const domains = new Set(doc.clock_domains);
  if (doc.channels.some((c) => !domains.has(c.clock_domain)))
    return fail("clock_mismatch");
  // counts are independent declared totals (written vs dropped frames may be
  // in any ratio); the worker re-derives them from the MCAP. Not checked here.
  // Configuration-dependent last: an RGB profile outside the current server
  // allowlist defers admission (retryable), it never rejects durably.
  if (!expect.supportedRgbProfiles.includes(doc.rgb_profile))
    return fail("profile_unsupported");
  const declaredFiles = [...doc.files]
    .map((f) => ({
      fileId: f.file_id,
      role: f.role,
      required: f.required,
      sizeBytes: f.size_bytes,
      sha256: f.sha256,
    }))
    .sort((a, b) => (a.fileId < b.fileId ? -1 : 1));
  return {
    ok: true,
    evidence: {
      captureFormat: doc.capture_format,
      rgbProfile: doc.rgb_profile,
      simulation: doc.simulation
        ? simulationFromArtifact(doc.simulation)
        : null,
      captureConfigSha256: doc.capture_config_sha256,
      closeStatus: doc.close_status,
      clockDomains: [...doc.clock_domains],
      declaredFiles,
      calibrationFileIds: declaredFiles
        .filter((f) => f.role === "calibration")
        .map((f) => f.fileId),
      counts: { ...doc.counts },
      channelCount: doc.channels.length,
    },
  };
}

/** The document's `schema` value (v1 vs v2 selection); undefined if unreadable. */
function peekSchema(bytes: Uint8Array): unknown {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as {
      schema?: unknown;
    };
    return typeof value === "object" && value !== null
      ? value.schema
      : undefined;
  } catch {
    return undefined;
  }
}

function unclosed(bytes: Uint8Array): boolean {
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as {
      close_status?: unknown;
    };
    return "close_status" in value && !CLOSED.has(value.close_status as string);
  } catch {
    return false;
  }
}
