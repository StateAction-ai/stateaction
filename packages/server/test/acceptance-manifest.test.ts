import assert from "node:assert/strict";
import test from "node:test";
import { acceptanceConfigFromEnv } from "../src/acceptance/config.js";
import {
  checkManifest,
  type ManifestFacts,
} from "../src/acceptance/manifest.js";

const JOB = "7e0b7a58-0f3b-4b0f-9d1a-2f6a1b0c1d2e";
const REC = "9a1f3c52-7d84-4e6b-8f21-0c5d6e7f8a90";
const NONCE = "N".repeat(43);
const MCAP = "11111111-1111-4111-8111-111111111111";
const SIM = {
  schema: "stateaction.simulation_provenance.v1",
  qualification: "simulation_only",
  mapped_timeline_semantics: "simulation_transport_only",
  production_qualified: false,
  provenance: {
    camera: { status: "known", label: "android-emulator-virtualscene" },
    encoder: { status: "unknown" },
    clock: { status: "unknown" },
  },
};
const SIM_JOB = {
  schema: SIM.schema,
  qualification: SIM.qualification,
  mappedTimelineSemantics: SIM.mapped_timeline_semantics,
  productionQualified: false,
  provenance: SIM.provenance,
};
const FILES = [
  ["rgb_mp4", "clip_mp4", "rgb.mp4"],
  ["hand_arrays_npz", "hand_arrays_npz", "hand-arrays.npz"],
  [
    "hand_observations_json",
    "hand_observations_json",
    "hand-observations.json",
  ],
  ["frame_map_json", "frame_map_json", "frame-map.json"],
  ["thumbnail_jpeg", "thumbnail_jpeg", "thumbnail.jpg"],
  ["viewer_rrd", "viewer_rrd", "viewer.rrd"],
] as const;

function fixture(simulated = false) {
  const outputs = FILES.map(([, role, name], i) => ({
    fileId: `00000000-0000-4000-8000-00000000000${i + 1}`,
    role,
    slot: `clips/000/${name}`,
    sizeBytes: String(10 + i),
    sha256: String(i).repeat(64),
  }));
  const taskInput = simulated
    ? { rgbProfile: "h264_mcap_simulation_v1", simulation: SIM_JOB }
    : { rgbProfile: "h264_mcap_v1" };
  const facts: ManifestFacts = {
    jobId: JOB,
    recordingId: REC,
    nonce: NONCE,
    outcome: "succeeded",
    summary: {
      clipCount: 1,
      checks: { pass: 1, warn: 0, fail: 0, measured: 0, notEvaluated: 0 },
      errorCode: null,
    },
    inputs: {
      sourceManifestSha256: "a".repeat(64),
      profileRevision: "h264_mcap_v1",
      codeRevision: "rev1",
      imageSpecSha256: "b".repeat(64),
      modelSha256: "c".repeat(64),
      configSha256: "d".repeat(64),
      taskInput,
    },
    outputs,
    sources: [
      {
        fileId: MCAP,
        role: "source_mcap",
        sizeBytes: "99",
        sha256: "e".repeat(64),
      },
    ],
  };
  const manifest: Record<string, any> = {
    job_id: JOB,
    recording_id: REC,
    source_manifest_sha256: "a".repeat(64),
    provenance: {
      code_revision: "rev1",
      image_spec_sha256: "b".repeat(64),
      config_sha256: "d".repeat(64),
      profile_revision: "h264_mcap_v1",
      model: { asset_sha256: "c".repeat(64) },
    },
    attestation: {
      invocation_nonce: NONCE,
      rgb_profile: taskInput.rgbProfile,
      source_file_id: MCAP,
      source_eof_verified: true,
    },
    verified_sources: [
      { file_id: MCAP, size_bytes: "99", sha256: "e".repeat(64) },
    ],
    checks: [{ status: "pass" }],
    outputs: outputs.map((o) => ({
      file_id: o.fileId,
      role: o.role,
      relative_path: o.slot,
      size_bytes: o.sizeBytes,
      sha256: o.sha256,
    })),
    clips: [
      {
        clip_id: "33333333-3333-4333-8333-333333333333",
        title: "Clip 1",
        source_start_ns: "1",
        source_end_ns: "3",
        duration_ns: "2",
        clock_domain: "d",
        raster: { width: 4, height: 3 },
        frame_count: 2,
        files: Object.fromEntries(
          FILES.map(([key], i) => [key, outputs[i]!.fileId]),
        ),
      },
    ],
  };
  if (simulated) manifest.simulation = structuredClone(SIM);
  return { facts, manifest };
}

const reason = (v: ReturnType<typeof checkManifest>) => (v.ok ? "ok" : v.code);

test("a consistent hardware manifest yields the clip plan", () => {
  const { facts, manifest } = fixture();
  const v = checkManifest(manifest, facts);
  assert.equal(v.ok, true);
  if (v.ok) {
    assert.equal(v.clipPlan.length, 1);
    assert.equal(v.clipPlan[0]!.viewerRrdFileId, facts.outputs[5]!.fileId);
  }
});

test("simulation provenance must match the admitted marker; unknown stays unknown", () => {
  const sim = fixture(true);
  assert.equal(checkManifest(sim.manifest, sim.facts).ok, true);
  sim.manifest.simulation.provenance.encoder = {
    status: "known",
    label: "invented",
  };
  assert.equal(
    reason(checkManifest(sim.manifest, sim.facts)),
    "manifest_simulation_mismatch",
  );
  const hw = fixture();
  hw.manifest.simulation = structuredClone(SIM);
  assert.equal(
    reason(checkManifest(hw.manifest, hw.facts)),
    "manifest_simulation_mismatch",
  );
  const dropped = fixture(true);
  delete dropped.manifest.simulation;
  assert.equal(
    reason(checkManifest(dropped.manifest, dropped.facts)),
    "manifest_simulation_mismatch",
  );
});

test("each binding mismatch has its own actionable code", () => {
  const cases: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
    ["manifest_job_mismatch", (f) => (f.manifest.job_id = REC)],
    [
      "manifest_source_mismatch",
      (f) => (f.manifest.source_manifest_sha256 = "0".repeat(64)),
    ],
    [
      "manifest_provenance_mismatch",
      (f) => (f.manifest.provenance.model.asset_sha256 = "0".repeat(64)),
    ],
    [
      "manifest_nonce_mismatch",
      (f) => (f.manifest.attestation.invocation_nonce = "Z".repeat(43)),
    ],
    [
      "manifest_profile_mismatch",
      (f) => (f.manifest.attestation.rgb_profile = "h264_mcap_simulation_v1"),
    ],
    [
      "source_identity_mismatch",
      (f) => (f.manifest.verified_sources[0].sha256 = "0".repeat(64)),
    ],
    [
      "source_not_eof_verified",
      (f) => (f.manifest.attestation.source_eof_verified = false),
    ],
    ["summary_mismatch", (f) => (f.facts.summary.clipCount = 2)],
    ["inventory_mismatch", (f) => f.manifest.outputs.pop()],
    [
      "inventory_mismatch",
      (f) => (f.manifest.outputs[0].sha256 = "f".repeat(64)),
    ],
    [
      "inventory_mismatch",
      (f) => (f.manifest.outputs[0].relative_path = "clips/000/other.mp4"),
    ],
    [
      "clip_slot_mismatch",
      (f) => (f.manifest.clips[0].files.rgb_mp4 = f.facts.outputs[1]!.fileId),
    ],
  ];
  for (const [code, mutate] of cases) {
    const f = fixture();
    mutate(f);
    assert.equal(
      reason(checkManifest(f.manifest, f.facts)),
      code,
      `${code}: ${mutate}`,
    );
  }
});

test("a failure report carries diagnostics only and never outputs", () => {
  const f = fixture();
  f.facts.outcome = "failed";
  f.facts.summary = {
    clipCount: 0,
    checks: { pass: 0, warn: 0, fail: 1, measured: 0, notEvaluated: 0 },
    errorCode: "worker_failed",
  };
  f.manifest.checks = [{ status: "fail" }];
  f.manifest.clips = [];
  f.manifest.outputs = [];
  f.manifest.verified_sources = [];
  f.manifest.attestation.source_eof_verified = false;
  assert.deepEqual(checkManifest(f.manifest, f.facts), {
    ok: true,
    clipPlan: [],
  });
  f.manifest.outputs = [{ file_id: MCAP }];
  assert.equal(
    reason(checkManifest(f.manifest, f.facts)),
    "failed_manifest_has_outputs",
  );
});

test("acceptance budgets are finite and validated", () => {
  const defaults = acceptanceConfigFromEnv({});
  assert.equal(defaults.verifyMaxFiles, 600);
  assert.equal(
    acceptanceConfigFromEnv({ ACCEPTANCE_VERIFY_MAX_FILES: "1800" })
      .verifyMaxFiles,
    1800,
  );
  for (const value of ["0", "2001", "1.5", "NaN"])
    assert.throws(
      () => acceptanceConfigFromEnv({ ACCEPTANCE_VERIFY_MAX_FILES: value }),
      /ACCEPTANCE_VERIFY_MAX_FILES/,
    );
  assert.ok(defaults.verifyMaxBytes > 0 && defaults.graceSeconds > 0);
  assert.throws(() =>
    acceptanceConfigFromEnv({ ACCEPTANCE_VERIFY_MAX_BYTES: "0" }),
  );
  assert.throws(() =>
    acceptanceConfigFromEnv({ ACCEPTANCE_RESULT_GRACE_SECONDS: "x" }),
  );
  assert.throws(() =>
    acceptanceConfigFromEnv({ ACCEPTANCE_VERIFY_OBJECT_TIMEOUT_MS: "5" }),
  );
});
