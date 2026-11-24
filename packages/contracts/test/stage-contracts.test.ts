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

test("native overlaps are valid for imported segment projections only", () => {
  const doc = firstValid("artifacts.segments.v1") as SegmentsV1;
  const [first, second] = doc.rows;
  assert.ok(first && second);
  // Begin a second successful segment on a frame covered by the first.
  const overlap = structuredClone(first);
  overlap.end = second.end;
  overlap.ordinal = 1;
  const shifted = doc.rows
    .slice(1)
    .map((row) => ({ ...row, ordinal: row.ordinal + 1 }));
  doc.rows = [first, overlap, ...shifted];
  const id = (segment: SegmentsV1["rows"][number]) =>
    segmentId(
      doc.source_manifest_sha256,
      `${doc.producer.module_id}@${doc.producer.module_version}`,
      doc.producer.params_sha256,
      segment.start.source_frame_id,
      segment.end.source_frame_id,
    );
  overlap.segment_id = id(overlap);
  assert.equal(validateValue("artifacts.segments.v1", doc).valid, false);
  doc.producer.module_id = "imported_segment";
  for (const row of doc.rows) row.segment_id = id(row);
  assert.equal(validateValue("artifacts.segments.v1", doc).valid, false);
  const imported = { ...doc, schema: "stateaction.segments.v2" };
  assert.equal(validateValue("artifacts.segments.v2", imported).valid, true);
  doc.producer.module_version = 2;
  for (const row of doc.rows) row.segment_id = id(row);
  assert.equal(validateValue("artifacts.segments.v2", imported).valid, false);
});
