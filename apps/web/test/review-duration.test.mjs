import assert from "node:assert/strict";
import { test } from "node:test";
import { FIXTURE_RECORDINGS, fixtureBundle } from "../lib/review/fixture.ts";
import {
  estimateDurationS,
  FALLBACK_DURATION_S,
  reviewDurationS,
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

test("planned review extends the duration beyond the start of the final frame", () => {
  const { annotations } = bundle("baseline");
  const range = {
    kind: "clip",
    start_ordinal: 8,
    end_ordinal: 14,
    first_source_frame_id: "8",
    last_source_frame_id: "13",
    start_ts_ns: "1000000000",
    end_ts_ns: "1166666665",
  };
  const duration = reviewDurationS(annotations, range, "166666665");
  assert.ok(duration > 0.166666665);
  assert.ok(Math.abs(duration - 0.2) < 1e-8);
  assert.equal(reviewDurationS(annotations, null, "1000000000"), 1);
  assert.equal(
    reviewDurationS(
      annotations,
      {
        ...range,
        end_ordinal: range.start_ordinal + 1,
        last_source_frame_id: range.first_source_frame_id,
        end_ts_ns: range.start_ts_ns,
      },
      "0",
    ),
    0,
  );
});
