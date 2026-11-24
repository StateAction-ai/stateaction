import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clipReturnTo,
  draftKey,
  rebaseDraft,
  restoreDraft,
  reviewCommand,
  savedDraft,
} from "../lib/review-draft.ts";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const state = () => ({
  clipId: id(1),
  recordingId: id(2),
  jobId: id(3),
  resultManifestSha256: "a".repeat(64),
  current: true,
  capabilities: { canReview: true },
  review: {
    revision: 2,
    decision: "approved",
    taskLabel: "Pick up cup",
    notes: "Original note",
    reviewedAt: null,
  },
  memberships: [
    {
      datasetId: id(4),
      name: "Cups",
      revision: 7,
      addedAt: "2026-11-02T00:00:00Z",
    },
  ],
  membershipsTruncated: false,
  availableDatasets: [
    {
      datasetId: id(5),
      name: "Hands",
      revision: 3,
      member: false,
      shared: false,
    },
  ],
  availableDatasetsTruncated: false,
  history: [],
  qualityChecks: { status: "not_evaluated", checks: [] },
});
const encoded = (draft) => JSON.stringify(draft);

test("draft storage and return links preserve the user and allowed browser context", () => {
  const s = state();
  assert.notEqual(
    draftKey("owner-a", s.clipId, s.resultManifestSha256),
    draftKey("owner-b", s.clipId, s.resultManifestSha256),
  );
  assert.notEqual(
    draftKey("owner-a", s.clipId, s.resultManifestSha256),
    draftKey("owner-a", s.clipId, "b".repeat(64)),
  );
  assert.notEqual(
    draftKey("owner-a", s.clipId, s.resultManifestSha256, 2),
    draftKey("owner-a", s.clipId, s.resultManifestSha256, 3),
  );
  const href = `/data-browser?datasetId=${id(4)}&q=cup&cursor=abc`;
  assert.equal(clipReturnTo(href, "staff"), href);
  const unicode = `/data-browser?view=clips&q=${encodeURIComponent("杯".repeat(160))}&label=${encodeURIComponent("手".repeat(160))}`;
  assert.equal(clipReturnTo(unicode, "staff"), unicode);
  for (const raw of [
    "https://example.com",
    "//example.com",
    "/data-browser#secret",
    "/data-browser?role=staff",
    "/data-browser/../pipeline",
    "/data-browser?view=clips",
  ]) {
    assert.equal(clipReturnTo(raw, "customer"), "/data-browser");
  }
});

test("draft reload retains edits only for the exact clip, job and manifest", () => {
  const s = state();
  const draft = {
    ...savedDraft(s),
    taskLabel: "Changed label",
    notes: "Unsaved note",
  };
  assert.deepEqual(restoreDraft(encoded(draft), s), draft);
  for (const changed of [
    { ...s, clipId: id(8) },
    { ...s, jobId: id(8) },
    { ...s, resultManifestSha256: "b".repeat(64) },
  ])
    assert.equal(restoreDraft(encoded(draft), changed), null);
  for (const changed of [
    { ...draft, extra: true },
    { ...draft, baseRevision: -1 },
    { ...draft, notes: "x".repeat(4001) },
    { ...draft, datasetIds: [id(4), id(4)] },
    { ...draft, expectedRevisions: { [id(4)]: 0 } },
  ])
    assert.equal(restoreDraft(encoded(changed), s), null);
  assert.equal(restoreDraft("null", s), null);
  assert.equal(restoreDraft("{", s), null);
});

test("omitted dataset selection preserves assignments and an explicit empty selection clears them", () => {
  const s = state();
  const draft = savedDraft(s);
  assert.equal(
    Object.hasOwn(
      reviewCommand(draft, "approved", id(6), s),
      "datasetSelection",
    ),
    false,
  );
  const cleared = reviewCommand(
    { ...draft, datasetIds: [], selectionTouched: true },
    "approved",
    id(6),
    s,
  );
  assert.deepEqual(cleared.datasetSelection, {
    datasetIds: [],
    expectedRevisions: { [id(4)]: 7 },
  });
  const added = reviewCommand(
    {
      ...draft,
      datasetIds: [id(5)],
      expectedRevisions: { [id(4)]: 7, [id(5)]: 3 },
      selectionTouched: true,
    },
    "approved",
    id(6),
    s,
  );
  assert.deepEqual(added.datasetSelection, {
    datasetIds: [id(5)],
    expectedRevisions: { [id(4)]: 7, [id(5)]: 3 },
  });
  assert.equal(
    Object.hasOwn(
      reviewCommand({ ...draft, selectionTouched: true }, "rejected", id(6), s),
      "datasetSelection",
    ),
    false,
  );
});

test("uncertain saves replay the exact persisted request even after the saved review advances", () => {
  const s = state();
  const draft = savedDraft(s);
  const command = reviewCommand(draft, "approved", id(6), s);
  const pending = { ...draft, pending: command };
  const advanced = { ...s, review: { ...s.review, revision: 3 } };
  const restored = restoreDraft(encoded(pending), advanced);
  assert.ok(restored);
  assert.deepEqual(
    reviewCommand(restored, "rejected", id(9), advanced),
    command,
  );
  for (const changed of [
    { ...command, reviewId: "bad" },
    { ...command, notes: "Different request" },
    { ...command, jobId: id(9) },
    { ...command, expectedReviewRevision: 3 },
    { ...command, unknown: true },
    { ...command, datasetSelection: { datasetIds: [], expectedRevisions: {} } },
  ])
    assert.equal(
      restoreDraft(encoded({ ...draft, pending: changed }), s),
      null,
    );
});

test("restored dataset commands must retain bounded exact selection and revision bindings", () => {
  const s = state();
  const draft = {
    ...savedDraft(s),
    datasetIds: [id(5)],
    expectedRevisions: { [id(4)]: 7, [id(5)]: 3 },
    selectionTouched: true,
  };
  const command = reviewCommand(draft, "approved", id(6), s);
  assert.ok(restoreDraft(encoded({ ...draft, pending: command }), s));
  for (const selection of [
    undefined,
    null,
    { datasetIds: [id(4)], expectedRevisions: {} },
    { datasetIds: [id(5)], expectedRevisions: { [id(5)]: 8 } },
    { datasetIds: [id(5)], expectedRevisions: {}, extra: true },
  ]) {
    const changed = { ...command };
    if (selection === undefined) delete changed.datasetSelection;
    else changed.datasetSelection = selection;
    assert.equal(
      restoreDraft(encoded({ ...draft, pending: changed }), s),
      null,
    );
  }
});

test("refresh keeps unsaved edits and updates known dataset revisions without inventing unseen ones", () => {
  const s = state();
  const draft = {
    ...savedDraft(s),
    taskLabel: "Unsaved label",
    notes: "Unsaved note",
    datasetIds: [id(5), id(8)],
    expectedRevisions: { [id(4)]: 7, [id(5)]: 3, [id(8)]: 4 },
    selectionTouched: true,
  };
  const next = {
    ...s,
    review: { ...s.review, revision: 3 },
    memberships: [{ ...s.memberships[0], revision: 8 }],
    availableDatasets: [{ ...s.availableDatasets[0], revision: 9 }],
  };
  const refreshed = rebaseDraft(draft, next);
  assert.equal(refreshed.baseRevision, 3);
  assert.equal(refreshed.taskLabel, draft.taskLabel);
  assert.equal(refreshed.notes, draft.notes);
  assert.deepEqual(refreshed.datasetIds, draft.datasetIds);
  assert.deepEqual(refreshed.expectedRevisions, {
    [id(4)]: 8,
    [id(5)]: 9,
    [id(8)]: 4,
  });
  assert.throws(
    () => rebaseDraft(draft, { ...next, jobId: id(9) }),
    /result changed/,
  );
});

test("review commands require a current reviewable result, a label for approval and complete revision coverage", () => {
  const s = state();
  const draft = savedDraft(s);
  assert.throws(
    () => reviewCommand(draft, "approved", id(6), { ...s, current: false }),
    /no longer/,
  );
  assert.throws(
    () =>
      reviewCommand(draft, "approved", id(6), {
        ...s,
        capabilities: { canReview: false },
      }),
    /no longer/,
  );
  assert.throws(
    () => reviewCommand({ ...draft, taskLabel: " " }, "approved", id(6), s),
    /task label/,
  );
  assert.equal(
    reviewCommand({ ...draft, taskLabel: "" }, "rejected", id(6), s).decision,
    "rejected",
  );
  assert.throws(
    () =>
      reviewCommand({ ...draft, selectionTouched: true }, "approved", id(6), {
        ...s,
        membershipsTruncated: true,
      }),
    /assignments/,
  );
  assert.throws(
    () =>
      reviewCommand(
        { ...draft, datasetIds: [id(5)], selectionTouched: true },
        "approved",
        id(6),
        s,
      ),
    /Reload the dataset/,
  );
});
