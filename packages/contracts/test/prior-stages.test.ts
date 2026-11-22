import assert from "node:assert/strict";
import test from "node:test";
import { validateValue } from "../src/index.js";

const hash = "d3690131c737f212505f230d86ea322e788db598fd0162f5500f7e22ab7005bc";
const file = (slot: string, role: string) => ({
  fileId: "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d",
  role,
  slot,
  sizeBytes: "10",
  sha256: hash,
});
const doc = (stages: unknown[]) => ({
  schemaVersion: 1,
  jobId: "019a4b2c-3d4e-7f50-8a6b-7c8d9e0f1a2b",
  stages,
});
const node = (outputs: unknown[], stage = "segment") => ({
  stage,
  state: "succeeded",
  errorCode: null,
  counts: { segments: 1 },
  outputs,
});

// catalog.v16 (SA-91): schema-only inventory read of the prior stage runs.
test("prior stages accept attributed slots and refuse others", () => {
  const good = doc([
    node([
      file("segments.json", "segments_json"),
      file("diagnostics/segment/log.txt", "diagnostic_blob"),
    ]),
    node([file("captions.json", "captions_json")], "caption"),
  ]);
  assert.equal(validateValue("jobs.prior-stages.v1", good).valid, true);
  for (const slot of [
    "clips/0001/rgb.mp4",
    "diagnostics/hand_pose/x.txt",
    "diagnostics/segment/",
  ])
    assert.equal(
      validateValue(
        "jobs.prior-stages.v1",
        doc([node([file(slot, "diagnostic_blob")])]),
      ).valid,
      false,
      slot,
    );
  assert.equal(
    validateValue("jobs.prior-stages.v1", doc([node([], "hand_pose")])).valid,
    false,
  );
});
