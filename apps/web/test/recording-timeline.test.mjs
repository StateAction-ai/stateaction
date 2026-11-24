import assert from "node:assert/strict";
import { test } from "node:test";
import { planTimeline, sourceTime } from "../lib/recording-timeline.ts";

test("source links accept elapsed seconds and reject ambiguous query values", () => {
  assert.equal(sourceTime("12.345"), 12.345);
  for (const invalid of [
    undefined,
    ["1", "2"],
    "-3",
    "1e2",
    "0xFF",
    "NaN",
    "Infinity",
    " 9",
  ]) {
    assert.equal(sourceTime(invalid), 0);
  }
});

test("the timeline uses offset timestamps and the next included frame at each boundary", () => {
  const plan = {
    origin_ts_ns: "6000000000000000000",
    spans: [
      { kind: "clip", start_ts_ns: "6000000000000000000" },
      { kind: "excluded", reason: "idle", start_ts_ns: "6000000001500000000" },
      { kind: "clip", start_ts_ns: "6000000002000000000" },
    ],
  };
  assert.deepEqual(planTimeline(plan), [
    { kind: "clip", label: "Clip 1", start: 0, end: 1.5 },
    { kind: "excluded", label: "Excluded · Idle", start: 1.5, end: 2 },
    { kind: "clip", label: "Clip 2", start: 2, end: null },
  ]);
  assert.deepEqual(planTimeline(null), []);
});
