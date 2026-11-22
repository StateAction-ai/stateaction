import assert from "node:assert/strict";
import { test } from "node:test";
import { FIXTURE_RECORDINGS, fixtureBundle } from "../lib/review/fixture.ts";
import { buildReviewModel } from "../lib/review/model.ts";

const build = (scenario) => {
  const f = FIXTURE_RECORDINGS.find((r) => r.scenario === scenario);
  const b = fixtureBundle(f.recordingId, f.scenario, f.title);
  return {
    b,
    m: buildReviewModel(b.annotations, b.clips, b.recording.durationS),
  };
};

test("times are seconds from the first decoded frame, not raw timestamps", () => {
  const { m } = build("baseline");
  assert.equal(m.originNs, "5000000000");
  assert.equal(m.cards[0].startS, 0);
  assert.equal(m.cards[1].startS, 9);
  // end-of-stream sentinel resolves to the recording duration.
  assert.equal(m.cards.at(-1).endS, 96);
});

test("a failed window is a failure span and a card, never an empty segment", () => {
  const { m } = build("baseline");
  assert.equal(m.summary.failedWindows, 1);
  const win = m.failures.find((f) => f.kind === "window");
  assert.deepEqual(
    [win.startS, win.endS, win.code],
    [36, 42, "engine_timeout"],
  );
  const card = m.cards[win.cardIndex];
  assert.equal(card.kind, "failed_window");
  assert.equal(card.caption.state, "failed");
  assert.equal(card.caption.message, "window failed: engine_timeout");
  assert.equal(m.summary.segments, 9);
});

test("caption_failed scenario shows exactly 2 failed captions with their codes", () => {
  const { m } = build("caption_failed");
  assert.equal(m.summary.failedCaptions, 2);
  assert.equal(m.summary.failedWindows, 0);
  const msgs = m.cards
    .filter((c) => c.caption.state === "failed")
    .map((c) => c.caption.message);
  assert.deepEqual(msgs, [
    "caption failed: unsupported_target_frames",
    "caption failed: empty_caption",
  ]);
  assert.equal(m.failures.filter((f) => f.kind === "caption").length, 2);
});

test("a failed caption stage marks every segment failed with the stage code", () => {
  const { m } = build("caption_stage_failed");
  const segs = m.cards.filter((c) => c.kind === "segment");
  assert.ok(segs.length > 0);
  for (const c of segs)
    assert.equal(c.caption.message, "caption failed: caption_stage_failed");
  assert.equal(m.summary.failedCaptions, segs.length);
  assert.equal(m.provenance.find((p) => p.stage === "caption").tone, "absent");
});

test("hand legend counts complete captions by derived hand", () => {
  const { m } = build("baseline");
  assert.equal(
    Object.values(m.handCounts).reduce((a, b) => a + b, 0),
    m.cards.filter((c) => c.caption.state === "complete").length,
  );
  assert.deepEqual(m.handCounts, { left: 1, right: 5, both: 1, none: 2 });
});

test("hand percentages come from time-weighted presence; failed frames are not presence", () => {
  const { m } = build("baseline");
  // 0-9 s: left no_hand, right present.
  assert.deepEqual(m.cards[0].handsLR, { left: 0, right: 100, partial: false });
  // Hand-pose failed frames are kept as failed lane spans, not as no_hand.
  assert.ok(m.lanes.left.some((s) => s.state === "failed"));
});

test("provenance is labelled replay and shows module, engine and observed GPU", () => {
  const { m } = build("baseline");
  const seg = m.provenance.find((p) => p.stage === "segment");
  assert.equal(seg.tone, "replay");
  assert.match(seg.text, /^replay · replay_segmenter@1 · replay 1 · no GPU$/);
  assert.match(seg.detail, /weights a{64}/);
});

test("clips map to the same time axis", () => {
  const { m } = build("baseline");
  assert.deepEqual(
    m.clips.map((c) => [c.startS, c.endS]),
    [
      [0, 60],
      [66, 96],
    ],
  );
});

const clone = (o) => structuredClone(o);

test("missing hand-pose data is unknown, never no-hand or 0 %", () => {
  const { b } = build("baseline");
  const a = clone(b.annotations);
  a.hand_presence = null;
  a.dag_run.stages[2].state = "failed";
  a.dag_run.stages[2].errorCode = "hand_pose_failed";
  const m = buildReviewModel(a, b.clips, 96);
  assert.equal(m.presence, "absent");
  assert.equal(m.presenceNote, "failed: hand_pose_failed");
  assert.deepEqual(m.lanes, { left: [], right: [] });
  for (const c of m.cards)
    assert.deepEqual(c.handsLR, { left: null, right: null, partial: false });
  assert.equal(build("baseline").m.presence, "available");
});

test("hand percentages use covered time only; failed time is not 0 %", () => {
  const { m } = build("baseline");
  // 27-36 s: left present 9-30 and 33-60, failed 30-33. 6 s present of 6 s covered.
  assert.deepEqual(m.cards[3].handsLR, { left: 100, right: 56, partial: true });
});

test("a span with no hand-pose coverage is unknown, not 0 %", () => {
  const { b } = build("baseline");
  const a = clone(b.annotations);
  a.hand_presence.lanes.left = a.hand_presence.lanes.left.map((s) => ({
    ...s,
    state: "failed",
  }));
  const m = buildReviewModel(a, b.clips, 96);
  assert.equal(m.cards[0].handsLR.left, null);
  assert.equal(m.cards[0].handsLR.right, 100);
});

test("no invented error codes: a missing caption row is not a coded failure", () => {
  const { b } = build("baseline");
  const a = clone(b.annotations);
  a.captions.rows.splice(1, 1);
  const m = buildReviewModel(a, b.clips, 96);
  assert.equal(m.cards[1].caption.message, "caption missing: no caption row");
  assert.equal(m.cards[1].caption.code, "unknown");
  assert.doesNotMatch(
    JSON.stringify(m),
    /no_caption_row|window_failed|caption_stage_no_output/,
  );
});

test("the derived rule comes from the data; local derivation is flagged", () => {
  const { b } = build("baseline");
  assert.equal(
    buildReviewModel(b.annotations, b.clips, 96).derivedRule,
    "caption_rule@1",
  );
  const a = clone(b.annotations);
  delete a.captions.rows[0].derived;
  const m = buildReviewModel(a, b.clips, 96);
  assert.equal(m.cards[0].derivedLocally, true);
  assert.equal(m.cards[1].derivedLocally, false);
  a.captions = null;
  assert.equal(buildReviewModel(a, b.clips, 96).derivedRule, null);
});

test("without a first-frame reference a clip is left out, never placed at an epoch offset", () => {
  const { b } = build("baseline");
  const bare = {
    ...b.annotations,
    segments: null,
    captions: null,
    hand_presence: null,
  };
  const clip = {
    clipId: "c1",
    startNs: "9223372036000000000",
    endNs: "9223372036100000000",
  };
  assert.deepEqual(buildReviewModel(bare, [clip], 10).clips, []);
  assert.equal(buildReviewModel(b.annotations, [clip], 10).clips.length, 1);
});
