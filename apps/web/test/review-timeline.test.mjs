import assert from "node:assert/strict";
import { test } from "node:test";
import { FIXTURE_RECORDINGS, fixtureBundle } from "../lib/review/fixture.ts";
import { formatMediaDuration } from "../lib/media-duration.ts";
import { buildReviewModel } from "../lib/review/model.ts";
import {
  activeCardIndex,
  clampView,
  clipAt,
  filterCards,
  fitView,
  fmtClock,
  followView,
  neighborStart,
  niceStep,
  panView,
  packSegmentRows,
  rulerTicks,
  rowFocusIndex,
  tOf,
  xOf,
  zoomView,
} from "../lib/review/timeline.ts";

const f = FIXTURE_RECORDINGS[0];
const b = fixtureBundle(f.recordingId, f.scenario, f.title);
const m = buildReviewModel(b.annotations, b.clips, b.recording.durationS);

test("fmtClock", () => {
  assert.equal(fmtClock(0), "0:00");
  assert.equal(fmtClock(75.9), "1:15");
  assert.equal(fmtClock(3725), "1:02:05");
});

test("niceStep keeps major ticks readable", () => {
  assert.equal(niceStep(96), 15);
  assert.equal(niceStep(9), 1);
  assert.equal(niceStep(7200), 900);
});

test("zoom keeps the anchor point, clamps to the recording and Fit restores", () => {
  const fit = fitView(96);
  const z = zoomView(fit, 0.5, 48, 96);
  assert.deepEqual(z, [24, 72]);
  assert.deepEqual(zoomView(z, 100, 48, 96), [0, 96]);
  const tight = zoomView(fit, 0.0001, 10, 96);
  assert.equal(tight[1] - tight[0], 2);
  assert.deepEqual(clampView(-5, 20, 96), [0, 25]);
  assert.deepEqual(panView([24, 72], 100, 96), [48, 96]);
});

test("followView scrolls the window to keep the playhead visible", () => {
  assert.deepEqual(followView([0, 30], 10, 96), [0, 30]);
  const v = followView([0, 30], 50, 96);
  assert.ok(50 >= v[0] && 50 <= v[1]);
});

test("x and t round trip", () => {
  const v = [10, 50];
  assert.equal(tOf(xOf(23, v, 800), v, 800), 23);
});

test("the active card follows the playhead; gaps and the failed window", () => {
  assert.equal(activeCardIndex(m.cards, 0), 0);
  assert.equal(activeCardIndex(m.cards, 8.99), 0);
  assert.equal(activeCardIndex(m.cards, 9), 1);
  assert.equal(m.cards[activeCardIndex(m.cards, 38)].kind, "failed_window");
  assert.equal(activeCardIndex(m.cards, 200), -1);
});

test("previous and next segment", () => {
  assert.equal(neighborStart(m.cards, 10, 1), 18);
  assert.equal(neighborStart(m.cards, 10, -1), 9);
  assert.equal(neighborStart(m.cards, 9.2, -1), 0);
  assert.equal(neighborStart(m.cards, 90, 1), null);
  assert.equal(neighborStart(m.cards, 0.2, -1), null);
});

test("text filter and the Failed chip", () => {
  assert.ok(filterCards(m.cards, "faucet", "all").length === 1);
  assert.equal(filterCards(m.cards, "", "failed").length, 1);
  assert.equal(filterCards(m.cards, "ENGINE_TIMEOUT", "failed").length, 1);
  assert.equal(filterCards(m.cards, "no-such-text", "all").length, 0);
  // the filter matches the short label and the hand, not only the caption
  assert.ok(filterCards(m.cards, "pick up knife · right", "all").length === 0);
  assert.ok(filterCards(m.cards, "pick up knife right", "all").length === 1);
});

test("the clip containing the playhead, or none", () => {
  assert.equal(clipAt(m.clips, 10).clipId, b.clips[0].clipId);
  assert.equal(clipAt(m.clips, 63), null);
  assert.equal(clipAt(m.clips, 70).clipId, b.clips[1].clipId);
});

test("fractional minor ticks keep exact major seconds in a panned view", () => {
  const labels = rulerTicks([0.2, 12], 2)
    .filter((tick) => tick.major)
    .map((tick) => fmtClock(tick.s));
  assert.deepEqual(labels, ["0:02", "0:04", "0:06", "0:08", "0:10", "0:12"]);
});

test("timeline rows keep every overlap visible and reuse rows at shared boundaries", () => {
  const spans = [
    [0, 10],
    [1, 3],
    [1, 5],
    [3, 5],
    [5, 7],
    [10, 11],
  ];
  const cards = spans.map(([startS, endS], index) => ({
    ...m.cards[0],
    index,
    startS,
    endS,
  }));
  assert.deepEqual(
    packSegmentRows(cards).map((row) => row.map((card) => card.index)),
    [[0, 5], [1, 3, 4], [2]],
  );
  assert.deepEqual(packSegmentRows([]), []);
});

test("clip and dataset duration use the same rounded clock format", () => {
  assert.equal(formatMediaDuration("11500000000"), "0:12");
  assert.equal(formatMediaDuration("3725000000000"), "1:02:05");
});

test("roving focus moves within a row and stops at its edges", () => {
  assert.equal(rowFocusIndex("Home", 2, 3), 0);
  assert.equal(rowFocusIndex("End", 0, 3), 2);
  assert.equal(rowFocusIndex("ArrowLeft", 0, 3), 0);
  assert.equal(rowFocusIndex("ArrowRight", 1, 3), 2);
  assert.equal(rowFocusIndex("Tab", 1, 3), null);
});
