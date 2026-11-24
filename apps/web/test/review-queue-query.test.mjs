import assert from "node:assert/strict";
import test from "node:test";
import { parseReviewQueueQuery, reviewQueueHref } from "../lib/review/queue.ts";

const recording = "00000000-0000-4000-8000-000000000001";
const clip = "00000000-0000-4000-8000-000000000002";

test("the queue defaults to pending and ignores malformed or repeated parameters", () => {
  for (const state of [undefined, "unknown", "__proto__", ["all", "pending"]]) {
    assert.deepEqual(
      parseReviewQueueQuery({
        state,
        recording: [recording, clip],
        collector: "collector\0other",
        after: ["opaque1", "opaque2"],
      }),
      { state: "pending" },
    );
  }
  assert.deepEqual(parseReviewQueueQuery({ collector: "c".repeat(129) }), {
    state: "pending",
  });
});

test("pagination keeps filters including non-UUID collector IDs", () => {
  const query = parseReviewQueueQuery({
    state: "not-ready",
    recording,
    collector: "seed collector & other",
    after: "opaque-cursor.Az_1=",
  });
  assert.deepEqual(query, {
    state: "not-ready",
    recordingId: recording,
    collectorId: "seed collector & other",
    after: "opaque-cursor.Az_1=",
  });
  const href = new URL(reviewQueueHref(query), "http://localhost");
  assert.equal(href.pathname, "/review");
  assert.deepEqual(
    parseReviewQueueQuery(Object.fromEntries(href.searchParams)),
    query,
  );
});

test("the canonical pending queue link omits the default state", () => {
  assert.equal(reviewQueueHref({ state: "pending" }), "/review");
});

test("option search retains separate recording and collector queries across pages", () => {
  const query = parseReviewQueueQuery({
    recordingSearch: "  camera % A  ",
    collectorSearch: "b".repeat(200),
    after: "opaque",
  });
  assert.equal(query.recordingSearch, "camera % A");
  assert.equal(query.collectorSearch.length, 160);
  const url = new URL(reviewQueueHref(query), "http://localhost");
  assert.deepEqual(
    parseReviewQueueQuery(Object.fromEntries(url.searchParams)),
    query,
  );
});
