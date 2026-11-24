import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clipForFrame,
  frameAtPts,
  handsAtFrame,
} from "../lib/review/hand-frames.ts";

const clips = [0, 2, 4, 6].map((startS) => ({ startS, endS: startS + 2 }));
const left = { side: "left", points: [[35, 16]] };
const right = { side: "right", points: [[20, 35]] };
const frame = {
  ptsUs: 105_000,
  timestampNs: "1700000009100000000",
  sourceFrameId: "090",
  hands: [left, right],
};

test("uses exact video PTS without borrowing a pose from the previous frame", () => {
  const chunk = { frames: [{ ...frame, ptsUs: 40_000 }, frame] };
  assert.equal(frameAtPts(chunk, 105_000), frame);
  assert.equal(frameAtPts(chunk, 104_999), null);
  assert.equal(frameAtPts(chunk, 110_000), null);
});

test("settles clip selection on measured PTS rather than its native-clock hint", () => {
  const ranges = new Map([[1, { first: 3_000_000, last: 4_800_000 }]]);
  assert.equal(clipForFrame(clips, ranges, 4_030_000), 1);
  assert.equal(clipForFrame(clips, ranges, 2_990_000), 0);
  assert.equal(clipForFrame(clips, ranges, 4_900_000), 2);
  ranges.set(2, { first: 5_010_000, last: 6_400_000 });
  assert.equal(clipForFrame(clips, ranges, 4_900_000), null);
});

test("uses the exact native frame timestamp for failed-span masking", () => {
  const model = {
    originNs: "1700000009000000000",
    lanes: {
      left: [{ startS: 0.1, endS: 0.2, state: "failed" }],
      right: [],
    },
  };
  assert.deepEqual(handsAtFrame(frame, model), {
    failed: true,
    hands: [right],
  });
  const noHand = { ...frame, timestampNs: "1700000009200000000", hands: [] };
  assert.deepEqual(handsAtFrame(noHand, model), { failed: false, hands: [] });
});
