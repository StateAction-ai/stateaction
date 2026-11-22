import assert from "node:assert/strict";
import { test } from "node:test";
import { FIXTURE_RECORDINGS, fixtureBundle } from "../lib/review/fixture.ts";
import {
  estimateDurationS,
  FALLBACK_DURATION_S,
} from "../lib/review/duration.ts";
import { originOf } from "../lib/review/model.ts";

const bundle = (scenario) => {
  const f = FIXTURE_RECORDINGS.find((r) => r.scenario === scenario);
  return fixtureBundle(f.recordingId, f.scenario, f.title);
};

test("the length is the latest known time, or frame_count / fps when longer", () => {
  const b = bundle("baseline");
  const a = b.annotations;
  const origin = originOf(a);
  const known = estimateDurationS({ ...a, hand_presence: null }, origin);
  // The last segment runs to end of stream: only its start (84 s) is known.
  assert.equal(known, 84);
  const full = estimateDurationS(a, origin);
  assert.ok(Math.abs(full - b.recording.durationS) < 0.5, `${full}`);
});

test("no timestamps at all is a one second axis, never zero or NaN", () => {
  const empty = {
    schema: "stateaction.recording-annotations.v1",
    recording_id: "r",
    job_id: "j",
    segments: null,
    captions: null,
    hand_presence: null,
    dag_run: null,
  };
  assert.equal(estimateDurationS(empty, 0n), FALLBACK_DURATION_S);
});
