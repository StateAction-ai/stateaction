import assert from "node:assert/strict";
import { test } from "node:test";
import { FIXTURE_RECORDINGS, fixtureBundle } from "../lib/review/fixture.ts";
import {
  buildMarkCommand,
  isTextEntryTarget,
  markCounts,
  markKey,
  markMap,
  markSummary,
  nextUnchecked,
  passesMarkFilter,
} from "../lib/review/marks.ts";
import { memoryMarksStore } from "../lib/review/marks-store.ts";
import { buildReviewModel } from "../lib/review/model.ts";
import { filterCards } from "../lib/review/timeline.ts";

const f = FIXTURE_RECORDINGS[0];
const b = fixtureBundle(f.recordingId, f.scenario, f.title);
const m = buildReviewModel(b.annotations, b.clips, b.recording.durationS);
const ids = m.cards.map((c) => c.segmentId);
const JOB = b.annotations.job_id;
const SHA = "a".repeat(64);
const row = (segmentId, revision, verdict, issueType = null, note = null) => ({
  segmentId,
  revision,
  verdict,
  issueType,
  note,
  createdAt: "2026-11-22T10:00:00.000000Z",
});

test("G, B and N map to Good, Issue and next unchecked; modifier chords do not", () => {
  assert.equal(markKey({ key: "g" }), "good");
  assert.equal(markKey({ key: "G" }), "good");
  assert.equal(markKey({ key: "b" }), "issue");
  assert.equal(markKey({ key: "n" }), "next");
  assert.equal(markKey({ key: "n", ctrlKey: true }), null);
  assert.equal(markKey({ key: "x" }), null);
});

test("counts cover this recording's segments and read 'n checked, m issue'", () => {
  const marks = markMap([
    row(ids[0], 1, "good"),
    row(ids[1], 2, "issue", "caption"),
    row("ffffffff-ffff-5fff-bfff-ffffffffffff", 1, "issue", "boundary"),
  ]);
  const c = markCounts(ids, marks);
  assert.deepEqual(c, { checked: 2, issue: 1 });
  assert.equal(markSummary(c), "2 checked, 1 issue");
  assert.equal(markSummary({ checked: 0, issue: 0 }), "0 checked, 0 issue");
});

test("Issue and Unchecked chips narrow the rail and compose with the text filter", () => {
  const marks = markMap([
    row(ids[0], 1, "good"),
    row(ids[1], 1, "issue", "boundary"),
  ]);
  const issue = filterCards(m.cards, "", "issue", marks);
  assert.deepEqual(
    issue.map((c) => c.segmentId),
    [ids[1]],
  );
  const unchecked = filterCards(m.cards, "", "unchecked", marks);
  assert.equal(unchecked.length, m.cards.length - 2);
  assert.ok(unchecked.every((c) => !marks.has(c.segmentId)));
  assert.equal(filterCards(m.cards, "", "all", marks).length, m.cards.length);
  assert.equal(passesMarkFilter(ids[0], "unchecked", marks), false);
  assert.deepEqual(
    filterCards(m.cards, "zzz-no-such-text", "issue", marks),
    [],
  );
  // Without marks, nothing is issue and every card is unchecked.
  assert.equal(filterCards(m.cards, "", "issue").length, 0);
  assert.equal(filterCards(m.cards, "", "unchecked").length, m.cards.length);
});

test("next unchecked skips marked and hidden segments and wraps", () => {
  const marks = markMap([row(ids[1], 1, "good"), row(ids[2], 1, "good")]);
  assert.equal(nextUnchecked(ids, marks, 0), 3);
  assert.equal(nextUnchecked(ids, marks, ids.length - 1), 0);
  assert.equal(
    nextUnchecked(ids, marks, 0, (i) => i !== 3),
    4,
  );
  const all = markMap(ids.map((id) => row(id, 1, "good")));
  assert.equal(nextUnchecked(ids, all, 0), null);
  assert.equal(nextUnchecked([], marks, 0), null);
});

test("the command carries the newest revision, requires a type for an issue, and never edits model output", () => {
  const base = { markId: "m", jobId: JOB, segmentsSha256: SHA };
  assert.deepEqual(
    buildMarkCommand({
      ...base,
      current: undefined,
      choice: { verdict: "good" },
    }),
    {
      markId: "m",
      jobId: JOB,
      segmentsSha256: SHA,
      expectedRevision: 0,
      verdict: "good",
    },
  );
  const issue = buildMarkCommand({
    ...base,
    current: row(ids[0], 3, "good"),
    choice: { verdict: "issue" },
  });
  assert.equal(issue.expectedRevision, 3);
  assert.equal(issue.issueType, "boundary");
  assert.equal(
    buildMarkCommand({
      ...base,
      current: row(ids[0], 4, "issue", "hand_pose"),
      choice: { verdict: "issue" },
    }).issueType,
    "hand_pose",
  );
  assert.equal(
    buildMarkCommand({
      ...base,
      current: undefined,
      choice: { verdict: "good", note: "   " },
    }).note,
    undefined,
  );
  assert.equal(
    "issueType" in
      buildMarkCommand({
        ...base,
        current: undefined,
        choice: { verdict: "good" },
      }),
    false,
  );
});

test("browser flow G, B, N against the fixture store: append-only revisions and conflicts", async () => {
  const store = memoryMarksStore(JOB, SHA);
  let marks = markMap([]);
  const apply = async (segmentId, choice) => {
    const r = await store.post(
      segmentId,
      buildMarkCommand({
        markId: `m-${segmentId}`,
        jobId: JOB,
        segmentsSha256: SHA,
        current: marks.get(segmentId),
        choice,
      }),
    );
    if (r.ok) marks = markMap([...marks.values(), r.row]);
    return r;
  };
  // G on the first segment, N to the next unchecked, B there with a type.
  assert.equal((await apply(ids[0], { verdict: "good" })).ok, true);
  const next = nextUnchecked(ids, marks, 0);
  assert.equal(next, 1);
  const issue = await apply(ids[next], {
    verdict: "issue",
    issueType: "caption",
  });
  assert.deepEqual([issue.row.revision, issue.row.issueType], [1, "caption"]);
  // Re-marking appends revision 2; the newest wins and the counts follow.
  const again = await apply(ids[0], {
    verdict: "issue",
    issueType: "hand_pose",
  });
  assert.equal(again.row.revision, 2);
  assert.deepEqual(markCounts(ids, marks), { checked: 2, issue: 2 });
  // A stale revision conflicts and changes nothing.
  const stale = await store.post(ids[0], {
    markId: "x",
    jobId: JOB,
    segmentsSha256: SHA,
    expectedRevision: 1,
    verdict: "good",
  });
  assert.deepEqual([stale.ok, stale.code], [false, "conflict"]);
  const listing = await store.load();
  assert.equal(listing.marks.find((r) => r.segmentId === ids[0]).revision, 2);
});

test("only real text entry blocks G/B/N; buttons and cards do not", () => {
  assert.equal(isTextEntryTarget({ tagName: "INPUT" }), true);
  assert.equal(isTextEntryTarget({ tagName: "TEXTAREA" }), true);
  assert.equal(isTextEntryTarget({ tagName: "SELECT" }), true);
  assert.equal(
    isTextEntryTarget({ tagName: "DIV", isContentEditable: true }),
    true,
  );
  assert.equal(isTextEntryTarget({ tagName: "BUTTON" }), false);
  assert.equal(isTextEntryTarget({ tagName: "DIV" }), false);
  assert.equal(isTextEntryTarget(null), false);
});

test("the previous note carries into a new revision unless cleared", () => {
  const base = { markId: "m", jobId: JOB, segmentsSha256: SHA };
  const cur = row(ids[0], 1, "issue", "caption", "Starts late");
  assert.equal(
    buildMarkCommand({
      ...base,
      current: cur,
      choice: { verdict: "issue", issueType: "boundary" },
    }).note,
    "Starts late",
  );
  assert.equal(
    buildMarkCommand({ ...base, current: cur, choice: { verdict: "good" } })
      .note,
    "Starts late",
  );
  assert.equal(
    buildMarkCommand({
      ...base,
      current: cur,
      choice: { verdict: "good", note: "" },
    }).note,
    undefined,
  );
  assert.equal(
    buildMarkCommand({
      ...base,
      current: cur,
      choice: { verdict: "good", note: "new" },
    }).note,
    "new",
  );
});
