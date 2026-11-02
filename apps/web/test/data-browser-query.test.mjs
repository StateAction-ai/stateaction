import assert from "node:assert/strict";
import { test } from "node:test";
import {
  browserApiPath,
  browserHref,
  parseBrowserQuery,
} from "../lib/data-browser-query.ts";

const datasetId = "00000000-0000-4000-8000-000000000001";
const recordingId = "00000000-0000-4000-8000-000000000002";
const parse = (value, role = "staff") =>
  parseBrowserQuery(new URLSearchParams(value), role);

test("default, dataset and fixed recording views round trip through encoded URLs", () => {
  assert.deepEqual(parse(""), { mode: "datasets" });
  for (const query of [
    { mode: "datasets", q: "Table & grasp" },
    {
      mode: "clips",
      datasetId,
      q: "100%_box",
      label: "grasp / release",
      cursor: "eyJ0IjoiQSJ9",
    },
    { mode: "clips", recordingId, reviewStatus: "pending" },
    { mode: "clips", reviewStatus: "approved", label: "pick" },
  ]) {
    const href = browserHref(query);
    assert.deepEqual(parse(href.split("?")[1] ?? ""), query);
    assert.equal(href.includes("100%_box"), false, "query content is encoded");
  }
  assert.match(
    browserApiPath(parse(`recordingId=${recordingId}`)),
    /^\/api\/v1\/clips\?/,
  );
  assert.ok(
    browserApiPath(parse(`datasetId=${datasetId}`)).startsWith(
      `/api/v1/datasets/${datasetId}/clips?`,
    ),
  );
});

test("customer context checks happen before any private fetch", () => {
  assert.deepEqual(parse(`datasetId=${datasetId}&q=grasp`, "customer"), {
    mode: "clips",
    datasetId,
    q: "grasp",
  });
  for (const value of [
    "view=clips",
    `recordingId=${recordingId}`,
    `datasetId=${datasetId}&reviewStatus=approved`,
  ])
    assert.throws(() => parse(value, "customer"));
});

test("malformed, duplicate and incompatible filters never become a global view", () => {
  for (const value of [
    "datasetId=invalid",
    `datasetId=${datasetId}&recordingId=${recordingId}`,
    `datasetId=${datasetId}&view=clips`,
    "view=unknown",
    "q=a&q=b",
    "role=staff",
    "reviewStatus=unknown&view=clips",
    "label=grasp",
    "cursor=",
    `q=${"x".repeat(161)}`,
    "q=hidden%00text",
  ])
    assert.throws(() => parse(value), value);
});
