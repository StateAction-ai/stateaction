import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  captionSteps,
  parseContract,
  requestSha256,
  segmentId,
  validateValue,
  type SegmentsV1,
  type TaskInputV3,
} from "../src/index.js";

const fixtures = new URL("../conformance/fixtures/contracts/", import.meta.url);
const firstValid = (contract: string) =>
  JSON.parse(
    readFileSync(new URL(`${contract}.json`, fixtures), "utf8"),
  ).cases.find((c: any) => c.expect.valid).input.document;

test("segment ids recompute from the header and frames", () => {
  const doc = parseContract<SegmentsV1>(
    "artifacts.segments.v1",
    firstValid("artifacts.segments.v1"),
  );
  const ref = `${doc.producer.module_id}@${doc.producer.module_version}`;
  for (const row of doc.rows)
    assert.equal(
      row.segment_id,
      segmentId(
        doc.source_manifest_sha256,
        ref,
        doc.producer.params_sha256,
        row.start.source_frame_id,
        row.end.source_frame_id,
      ),
    );
});

test("caption steps split on commas and trim spaces and tabs", () => {
  assert.deepEqual(captionSteps(" hold cup with left hand,,\tpour water ,"), [
    "hold cup with left hand",
    "pour water",
  ]);
});

test("a task input pins its inline recipe by sa-cjson-v1 digest", () => {
  const task = parseContract<TaskInputV3>(
    "jobs.task-input.v3",
    firstValid("jobs.task-input.v3"),
  );
  assert.equal(task.kind, "process_recording");
  if (task.kind !== "process_recording") return;
  assert.equal(task.recipeSha256, requestSha256(task.recipe));
  assert.equal(validateValue("jobs.recipe.v1", task.recipe).valid, true);
});
