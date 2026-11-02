import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  recordingCreateContractFor,
  validateBytes,
  validateValue,
  type InventoryFile,
} from "@stateaction/contracts";
import {
  checkSourceDeclaration,
  type DeclarationExpectation,
} from "../src/admission/inventory.js";
import { admissionConfigFromEnv } from "../src/admission/recordings.js";
import {
  registerRecording,
  type CollectorPrincipal,
} from "../src/admission/recordings.js";
import {
  renderHostedMarker,
  simulatedCaptureInputsEnabled,
} from "../src/admission/simulation.js";

const sha = (v: string | Uint8Array) =>
  createHash("sha256").update(v).digest("hex");
const SIM = "h264_mcap_simulation_v1";
const marker = {
  schema: "stateaction.simulation_provenance.v1",
  qualification: "simulation_only",
  mapped_timeline_semantics: "simulation_transport_only",
  production_qualified: false,
  provenance: {
    camera: { status: "known", label: "android-emulator-virtualscene" },
    encoder: { status: "unknown" },
    clock: { status: "known", label: "host-receipt-transport-only" },
  },
};
const httpMarker = {
  schema: "stateaction.simulation_provenance.v1",
  qualification: "simulation_only",
  mappedTimelineSemantics: "simulation_transport_only",
  productionQualified: false,
  provenance: marker.provenance,
};

function fixture(overrides: Record<string, unknown> = {}, simulated = false) {
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
  ];
  const doc: Record<string, unknown> = {
    schema: "stateaction.recording_source.v2",
    recording_id: randomUUID(),
    client_recording_id: randomUUID(),
    owner_user_id: "ba_owner:1",
    capture_format: "stateaction.capture.v1",
    rgb_profile: simulated ? SIM : "h264_mcap_v1",
    ...(simulated ? { simulation: marker } : {}),
    capture_config_sha256: sha("config"),
    close_status: "closed_clean",
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
      {
        topic: "/pose",
        message_encoding: "cdr",
        schema_name: "geometry_msgs/msg/PoseStamped",
        clock_domain: "android.elapsed_realtime",
        message_count: "3",
      },
    ],
    counts: {
      video_frames: "3",
      dropped_video_frames: "0",
      motion_events: "3",
    },
    collection_permission_ref: "pilot-2026-11",
    source_verification: "pending",
    ...overrides,
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
    recordingId: doc.recording_id as string,
    clientRecordingId: doc.client_recording_id as string,
    ownerUserId: "ba_owner:1",
    captureFormat: "stateaction.capture.v1",
    rgbProfile: doc.rgb_profile as string,
    sourceManifestSha256: manifest.sha256,
    sizeBytes: manifest.sizeBytes,
    permissionRef: "pilot-2026-11",
    seal: [manifest, ...files],
    supportedRgbProfiles: simulated ? ["h264_mcap_v1", SIM] : ["h264_mcap_v1"],
  };
  return { doc, bytes, expect };
}

// ---------------------------------------------------------------- policy
const LOCAL = { APP_ENV: "local" };
test("simulated inputs are off by default and in every environment without the flag", () => {
  for (const env of [
    {},
    LOCAL,
    { APP_ENV: "development" },
    { APP_ENV: "production" },
  ])
    assert.equal(simulatedCaptureInputsEnabled(env), false);
});

test("the explicit flag enables simulation only in local/development", () => {
  assert.equal(
    simulatedCaptureInputsEnabled({
      ...LOCAL,
      ALLOW_SIMULATED_CAPTURE_INPUTS: "true",
    }),
    true,
  );
  assert.equal(
    simulatedCaptureInputsEnabled({
      APP_ENV: "development",
      ALLOW_SIMULATED_CAPTURE_INPUTS: "true",
    }),
    true,
  );
  assert.equal(
    simulatedCaptureInputsEnabled({
      ...LOCAL,
      ALLOW_SIMULATED_CAPTURE_INPUTS: "false",
    }),
    false,
  );
  for (const bad of ["1", "yes", "TRUE", " true"])
    assert.throws(
      () =>
        simulatedCaptureInputsEnabled({
          ...LOCAL,
          ALLOW_SIMULATED_CAPTURE_INPUTS: bad,
        }),
      /exactly/,
      bad,
    );
});

test("the flag is refused (even false) in staging, production, unset or spoofed APP_ENV", () => {
  for (const appEnv of [
    "production",
    "staging",
    "Production",
    "",
    undefined,
    "local ",
  ])
    for (const value of ["true", "false"])
      assert.throws(
        () =>
          simulatedCaptureInputsEnabled({
            APP_ENV: appEnv,
            ALLOW_SIMULATED_CAPTURE_INPUTS: value,
          }),
        /refused/,
        `${String(appEnv)}:${value}`,
      );
});

test("a Render-hosted deployment refuses the flag even when APP_ENV claims local", () => {
  for (const marker of [
    "RENDER",
    "RENDER_SERVICE_ID",
    "RENDER_INSTANCE_ID",
    "RENDER_EXTERNAL_URL",
    "RENDER_GIT_COMMIT",
    "IS_PULL_REQUEST",
  ]) {
    const env = {
      APP_ENV: "development",
      ALLOW_SIMULATED_CAPTURE_INPUTS: "true",
      [marker]: "x",
    };
    assert.equal(renderHostedMarker(env), marker);
    assert.throws(() => simulatedCaptureInputsEnabled(env), /refused/, marker);
  }
  // Local dispatch settings are not Render markers.
  assert.equal(
    renderHostedMarker({
      RENDER_USE_LOCAL_DEV: "true",
      RENDER_LOCAL_DEV_URL: "http://127.0.0.1:8120",
    }),
    undefined,
  );
});

test("admission config: hardware list unchanged, simulation only via the flag", () => {
  const base = {
    PROCESSING_PROFILE_REVISION: "p1",
    SUPPORTED_RGB_PROFILES: "h264_mcap_v1",
  };
  assert.deepEqual(admissionConfigFromEnv({ ...LOCAL, ...base }), {
    processingProfileRevision: "p1",
    supportedRgbProfiles: ["h264_mcap_v1"],
  });
  assert.deepEqual(
    admissionConfigFromEnv({
      ...LOCAL,
      ...base,
      ALLOW_SIMULATED_CAPTURE_INPUTS: "true",
    }),
    {
      processingProfileRevision: "p1",
      supportedRgbProfiles: ["h264_mcap_v1", SIM],
      simulatedCaptureInputs: true,
    },
  );
  // Listing the simulation profile directly is not a way around the flag.
  assert.throws(
    () =>
      admissionConfigFromEnv({
        ...LOCAL,
        ...base,
        SUPPORTED_RGB_PROFILES: `h264_mcap_v1,${SIM}`,
      }),
    /SUPPORTED_RGB_PROFILES/,
  );
  assert.throws(
    () =>
      admissionConfigFromEnv({
        APP_ENV: "production",
        ...base,
        ALLOW_SIMULATED_CAPTURE_INPUTS: "true",
      }),
    /refused/,
  );
  assert.throws(
    () =>
      admissionConfigFromEnv({
        ...LOCAL,
        ...base,
        RENDER: "true",
        ALLOW_SIMULATED_CAPTURE_INPUTS: "true",
      }),
    /refused/,
  );
});

// ----------------------------------------------------------- registration
test("v2 create is selected by its schema discriminator; v1 bodies stay frozen", () => {
  assert.equal(
    recordingCreateContractFor({ rgbProfile: "h264_mcap_v1" }),
    "http.recording-create.v1",
  );
  assert.equal(
    recordingCreateContractFor({ schema: "x" }),
    "http.recording-create.v2",
  );
  assert.equal(
    recordingCreateContractFor(undefined),
    "http.recording-create.v1",
  );
  assert.equal(recordingCreateContractFor(null), "http.recording-create.v1");
});

test("registration rejects the simulation profile before any database access unless enabled", async () => {
  const body = {
    schema: "stateaction.recording_create.v2",
    clientRecordingId: randomUUID(),
    captureFormat: "stateaction.capture.v1",
    rgbProfile: SIM,
    simulation: httpMarker,
    startedAt: "2026-11-02T08:00:00.000000Z",
    device: {
      model: "sdk_gphone64_x86_64",
      osVersion: "Android 15",
      appVersion: "0.1.0+1",
    },
  };
  const principal: CollectorPrincipal = { userId: "ba_owner:1" };
  const pool = {
    query: () => assert.fail("no database access before the gate"),
    connect: () => assert.fail("no database access before the gate"),
  } as never;
  for (const config of [undefined, {}, { simulatedCaptureInputs: false }])
    await assert.rejects(
      () => registerRecording({ pool, config }, principal, body),
      (error: { code?: string; message?: string }) =>
        error.code === "forbidden" && /not enabled/.test(error.message ?? ""),
    );
  // v1 contract cannot name the simulation profile at all.
  const { schema: _schema, ...v1Body } = body;
  await assert.rejects(
    () =>
      registerRecording(
        { pool, config: { simulatedCaptureInputs: true } },
        principal,
        v1Body,
      ),
    (error: { code?: string }) => error.code === "invalid_request",
  );
});

// --------------------------------------------------------- source manifest
test("hardware v2 manifest with a ROS slash schema name is admitted without a marker", () => {
  const f = fixture();
  const check = checkSourceDeclaration(f.bytes, f.expect);
  assert.equal(check.ok, true);
  if (check.ok) assert.equal(check.evidence.simulation, null);
});

test("frozen v1 cannot carry the slash schema name or the simulation profile", () => {
  const v1 = fixture({ schema: "stateaction.recording_source.v1" });
  assert.equal(
    validateBytes("artifacts.recording-source.v1", v1.bytes).valid,
    false,
  );
  const v1sim = fixture({ schema: "stateaction.recording_source.v1" }, true);
  assert.deepEqual(checkSourceDeclaration(v1sim.bytes, v1sim.expect), {
    ok: false,
    code: "manifest_schema_violation",
  });
});

test("simulated v2 manifest carries the explicit marker into evidence; unknown stays explicit", () => {
  const f = fixture({}, true);
  const check = checkSourceDeclaration(f.bytes, f.expect);
  assert.equal(check.ok, true);
  if (!check.ok) return;
  assert.equal(check.evidence.rgbProfile, SIM);
  assert.deepEqual(check.evidence.simulation, httpMarker);
  assert.deepEqual(check.evidence.simulation?.provenance.encoder, {
    status: "unknown",
  });
});

test("a simulated manifest is deferred, never admitted, when the server does not enable simulation", () => {
  const f = fixture({}, true);
  assert.deepEqual(
    checkSourceDeclaration(f.bytes, {
      ...f.expect,
      supportedRgbProfiles: ["h264_mcap_v1"],
    }),
    { ok: false, code: "profile_unsupported" },
  );
});

test("simulation marker and profile cannot disagree in the manifest", () => {
  const noMarker = fixture({ simulation: undefined }, true);
  assert.deepEqual(checkSourceDeclaration(noMarker.bytes, noMarker.expect), {
    ok: false,
    code: "manifest_schema_violation",
  });
  const hardwareWithMarker = fixture({ simulation: marker });
  assert.deepEqual(
    checkSourceDeclaration(hardwareWithMarker.bytes, hardwareWithMarker.expect),
    {
      ok: false,
      code: "manifest_schema_violation",
    },
  );
  // Registered as hardware but the manifest claims simulation (relabel attempt).
  const relabel = fixture({}, true);
  assert.deepEqual(
    checkSourceDeclaration(relabel.bytes, {
      ...relabel.expect,
      rgbProfile: "h264_mcap_v1",
    }),
    { ok: false, code: "profile_mismatch" },
  );
  for (const bad of [
    { ...marker, production_qualified: true },
    { ...marker, qualification: "unqualified" },
    { ...marker, mapped_timeline_semantics: "device_clock" },
    {
      ...marker,
      provenance: { ...marker.provenance, camera: { status: "known" } },
    },
    {
      ...marker,
      provenance: {
        ...marker.provenance,
        clock: { status: "unknown", label: "x" },
      },
    },
    {
      ...marker,
      provenance: {
        camera: marker.provenance.camera,
        encoder: marker.provenance.encoder,
      },
    },
    { ...marker, extra: 1 },
  ]) {
    const f = fixture({ simulation: bad }, true);
    assert.equal(
      validateValue("artifacts.recording-source.v2", f.doc).valid,
      false,
      JSON.stringify(bad),
    );
  }
});
