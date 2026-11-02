import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  requestSha256,
  validateValue,
  type InventoryFile,
} from "@stateaction/contracts";
import {
  checkSourceDeclaration,
  normalizeSeal,
  sealRequestSha256,
  type DeclarationExpectation,
} from "../src/admission/inventory.js";
import { admissionConfigFromEnv } from "../src/admission/recordings.js";

const sha = (v: string | Uint8Array) =>
  createHash("sha256").update(v).digest("hex");

function fixture() {
  const recordingId = randomUUID();
  const files: InventoryFile[] = [
    {
      fileId: randomUUID(),
      role: "source_mcap",
      sizeBytes: "100",
      sha256: sha("mcap"),
      required: true,
    },
    {
      fileId: randomUUID(),
      role: "recorder_metadata",
      sizeBytes: "20",
      sha256: sha("meta"),
      required: true,
    },
    {
      fileId: randomUUID(),
      role: "calibration",
      sizeBytes: "30",
      sha256: sha("cal"),
      required: false,
    },
  ];
  const doc = {
    schema: "stateaction.recording_source.v1",
    recording_id: recordingId,
    client_recording_id: randomUUID(),
    owner_user_id: "ba_owner:1",
    capture_format: "stateaction.capture.v1",
    rgb_profile: "h264_mcap_v1",
    capture_config_sha256: sha("config"),
    close_status: "closed_after_recovery",
    files: files.map((f) => ({
      file_id: f.fileId,
      role: f.role,
      required: f.required,
      size_bytes: f.sizeBytes,
      sha256: f.sha256,
    })),
    clock_domains: ["android.elapsed_realtime"],
    channels: [
      {
        topic: "/camera/rgb",
        message_encoding: "protobuf",
        schema_name: "foxglove.CompressedVideo",
        clock_domain: "android.elapsed_realtime",
        message_count: "3",
      },
    ],
    counts: {
      video_frames: "3",
      dropped_video_frames: "1",
      motion_events: "0",
    },
    collection_permission_ref: "pilot-2026-11",
    source_verification: "pending",
  };
  const bytes = Buffer.from(JSON.stringify(doc));
  const manifest: InventoryFile = {
    fileId: randomUUID(),
    role: "source_manifest",
    sizeBytes: String(bytes.byteLength),
    sha256: sha(bytes),
    required: true,
  };
  const expect: DeclarationExpectation = {
    recordingId,
    clientRecordingId: doc.client_recording_id,
    ownerUserId: doc.owner_user_id,
    captureFormat: doc.capture_format,
    rgbProfile: doc.rgb_profile,
    sourceManifestSha256: manifest.sha256,
    sizeBytes: manifest.sizeBytes,
    permissionRef: doc.collection_permission_ref,
    seal: [manifest, ...files],
    supportedRgbProfiles: ["h264_mcap_v1"],
  };
  return { doc, bytes, expect, files, manifest };
}

test("seal digest is canonical and independent of inventory order and key order", () => {
  const { files, manifest } = fixture();
  const a = [manifest, ...files];
  const b = [...a].reverse().map((f) => ({
    required: f.required,
    sha256: f.sha256,
    sizeBytes: f.sizeBytes,
    role: f.role,
    fileId: f.fileId,
  }));
  assert.equal(sealRequestSha256(a), sealRequestSha256(b));
  assert.deepEqual(
    normalizeSeal(b).map((f) => f.fileId),
    [...a.map((f) => f.fileId)].sort(),
  );
  assert.equal(
    sealRequestSha256(a),
    requestSha256({ files: normalizeSeal(a) }),
  );
  const changed = a.map((f) =>
    f.role === "calibration" ? { ...f, required: true } : f,
  );
  assert.notEqual(sealRequestSha256(a), sealRequestSha256(changed));
});

test("a valid declaration yields admission evidence", () => {
  const { bytes, expect, files } = fixture();
  const out = checkSourceDeclaration(bytes, expect);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.evidence.closeStatus, "closed_after_recovery");
  assert.deepEqual(out.evidence.calibrationFileIds, [files[2]!.fileId]);
  assert.equal(out.evidence.channelCount, 1);
});

test("declared counts are independent: more dropped than written frames is valid", () => {
  // Producer semantics (native capture snapshot): written + dropped +
  // unresolved <= acquired, so dropped may exceed written.
  const f = fixture();
  f.doc.counts = {
    video_frames: "2",
    dropped_video_frames: "40",
    motion_events: "9",
  };
  const bytes = Buffer.from(JSON.stringify(f.doc));
  const out = checkSourceDeclaration(bytes, {
    ...f.expect,
    sourceManifestSha256: sha(bytes),
    sizeBytes: String(bytes.byteLength),
  });
  assert.equal(out.ok, true);
});

test("a declaration whose profile differs from the registered recording is a mismatch", () => {
  const f = fixture();
  assert.deepEqual(
    checkSourceDeclaration(f.bytes, {
      ...f.expect,
      rgbProfile: "other_profile",
    }),
    { ok: false, code: "profile_mismatch" },
  );
});

test("declaration defects map to stable codes", () => {
  const cases: [
    string,
    (d: ReturnType<typeof fixture>["doc"]) => void,
    string,
  ][] = [
    [
      "identity",
      (d) => (d.owner_user_id = "someone-else"),
      "identity_mismatch",
    ],
    [
      "permission",
      (d) => (d.collection_permission_ref = "client-ref"),
      "permission_ref_mismatch",
    ],
    ["unclosed", (d) => (d.close_status = "unclosed"), "source_not_closed"],
    [
      "inventory",
      (d) => (d.files[0]!.size_bytes = "101"),
      "seal_reference_mismatch",
    ],
    ["missing", (d) => d.files.pop(), "seal_inventory_incomplete"],
    [
      "schema",
      (d) => Object.assign(d, { unexpected: 1 }),
      "manifest_schema_violation",
    ],
  ];
  for (const [name, mutate, code] of cases) {
    const f = fixture();
    mutate(f.doc);
    const bytes = Buffer.from(JSON.stringify(f.doc));
    const out = checkSourceDeclaration(bytes, {
      ...f.expect,
      sourceManifestSha256: sha(bytes),
      sizeBytes: String(bytes.byteLength),
    });
    assert.deepEqual(out, { ok: false, code }, name);
  }
  const f = fixture();
  assert.deepEqual(
    checkSourceDeclaration(f.bytes, { ...f.expect, supportedRgbProfiles: [] }),
    { ok: false, code: "profile_unsupported" },
  );
  // Re-serialization with the same value is a different stored document.
  const pretty = Buffer.from(JSON.stringify(f.doc, null, 2));
  assert.deepEqual(
    checkSourceDeclaration(pretty, {
      ...f.expect,
      sizeBytes: String(pretty.byteLength),
    }),
    { ok: false, code: "manifest_digest_mismatch" },
  );
  assert.deepEqual(
    checkSourceDeclaration(f.bytes, { ...f.expect, sizeBytes: "1" }),
    { ok: false, code: "manifest_size_mismatch" },
  );
  assert.deepEqual(checkSourceDeclaration(new Uint8Array(1048577), f.expect), {
    ok: false,
    code: "manifest_too_large",
  });
});

test("admission settings are explicit configuration", () => {
  assert.deepEqual(
    admissionConfigFromEnv({
      PROCESSING_PROFILE_REVISION: "p1",
      SUPPORTED_RGB_PROFILES: "h264_mcap_v1",
    }),
    {
      processingProfileRevision: "p1",
      supportedRgbProfiles: ["h264_mcap_v1"],
    },
  );
  assert.throws(
    () => admissionConfigFromEnv({}),
    /PROCESSING_PROFILE_REVISION/,
  );
  assert.throws(
    () => admissionConfigFromEnv({ PROCESSING_PROFILE_REVISION: "p1" }),
    /SUPPORTED_RGB_PROFILES/,
  );
  assert.throws(
    () =>
      admissionConfigFromEnv({
        PROCESSING_PROFILE_REVISION: "p1",
        SUPPORTED_RGB_PROFILES: "mp4",
      }),
    /SUPPORTED_RGB_PROFILES/,
  );
});

test("the proposed registration response schema wraps the unchanged recording.v1 shape", () => {
  const schema = JSON.parse(
    readFileSync(
      new URL(
        "../contracts-proposed/http/recording-registration.v1.schema.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(
    schema.properties.recording.$ref,
    "https://stateaction.ai/schemas/http/recording.v1.json",
  );
  assert.deepEqual(schema.required, ["recording", "collectionPermissionRef"]);
  assert.equal(schema.additionalProperties, false);
  const recording = {
    recordingId: randomUUID(),
    clientRecordingId: randomUUID(),
    ownerUserId: "ba_owner",
    status: "registered",
    createdAt: "2026-11-01T12:00:00.000000Z",
    files: [],
    missingRequiredRoles: [
      "source_manifest",
      "source_mcap",
      "recorder_metadata",
    ],
  };
  assert.equal(validateValue("http.recording.v1", recording).valid, true);
});
