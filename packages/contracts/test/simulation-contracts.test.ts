import assert from "node:assert/strict";
import test from "node:test";
import {
  HARDWARE_RGB_PROFILE,
  SIMULATION_RGB_PROFILE,
  recordingCreateContractFor,
  recordingSourceContractFor,
  simulationFromArtifact,
  simulationToArtifact,
  validateValue,
  type SimulationProvenance,
} from "../src/index.js";

// SA-71 additive contracts (catalog.v6). The shared fixture cases run in
// conformance.test.ts (and the Python/Dart runners); this file pins the
// selection helpers and the "frozen v1 cannot carry it" guarantees.
const simulation: SimulationProvenance = {
  schema: "stateaction.simulation_provenance.v1",
  qualification: "simulation_only",
  mappedTimelineSemantics: "simulation_transport_only",
  productionQualified: false,
  provenance: {
    camera: { status: "known", label: "android-emulator-virtualscene" },
    encoder: { status: "unknown" },
    clock: { status: "unknown" },
  },
};
const create = {
  clientRecordingId: "0d9e8f7a-1b2c-4d3e-8f4a-5b6c7d8e9f00",
  captureFormat: "stateaction.capture.v1",
  startedAt: "2026-11-02T08:00:00Z",
  device: { model: "sdk", osVersion: "15", appVersion: "0.1.0" },
};

test("profile constants name the frozen hardware profile and the emulator profile", () => {
  assert.equal(HARDWARE_RGB_PROFILE, "h264_mcap_v1");
  assert.equal(SIMULATION_RGB_PROFILE, "h264_mcap_simulation_v1");
});

test("frozen v1 create rejects the simulation profile; v2 requires its marker", () => {
  assert.equal(
    validateValue("http.recording-create.v1", {
      ...create,
      rgbProfile: SIMULATION_RGB_PROFILE,
    }).valid,
    false,
  );
  const v2 = { schema: "stateaction.recording_create.v2", ...create };
  assert.equal(
    validateValue("http.recording-create.v2", {
      ...v2,
      rgbProfile: SIMULATION_RGB_PROFILE,
    }).valid,
    false,
    "no marker",
  );
  assert.equal(
    validateValue("http.recording-create.v2", {
      ...v2,
      rgbProfile: SIMULATION_RGB_PROFILE,
      simulation,
    }).valid,
    true,
  );
  assert.equal(
    validateValue("http.recording-create.v2", {
      ...v2,
      rgbProfile: HARDWARE_RGB_PROFILE,
      simulation,
    }).valid,
    false,
    "hardware never carries a marker",
  );
});

test("contract selection follows the document discriminator", () => {
  assert.equal(
    recordingSourceContractFor("stateaction.recording_source.v2"),
    "artifacts.recording-source.v2",
  );
  for (const other of ["stateaction.recording_source.v1", "x", undefined, 2])
    assert.equal(
      recordingSourceContractFor(other),
      "artifacts.recording-source.v1",
    );
  assert.equal(
    recordingCreateContractFor({ ...create }),
    "http.recording-create.v1",
  );
  assert.equal(
    recordingCreateContractFor({ schema: "stateaction.recording_create.v2" }),
    "http.recording-create.v2",
  );
});

test("manifest and HTTP marker forms convert losslessly and both validate", () => {
  const artifact = simulationToArtifact(simulation);
  assert.equal(artifact.production_qualified, false);
  assert.deepEqual(simulationFromArtifact(artifact), simulation);
  assert.equal(
    validateValue("http.simulation-provenance.v1", simulation).valid,
    true,
  );
  assert.equal(
    validateValue("artifacts.simulation-provenance.v1", artifact).valid,
    true,
  );
  // Each form is rejected by the other's casing: no silent cross-reading.
  assert.equal(
    validateValue("http.simulation-provenance.v1", artifact).valid,
    false,
  );
  assert.equal(
    validateValue("artifacts.simulation-provenance.v1", simulation).valid,
    false,
  );
  // The converter copies provenance; callers cannot alias the stored object.
  assert.notEqual(artifact.provenance.camera, simulation.provenance.camera);
});
