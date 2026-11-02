import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { validateValue } from "../src/validate.ts";

// Published in catalog.v5 (SA-20): the worker output reservation request and
// plan. The fixture cases run in conformance.test.ts; this file pins the
// closed-request shape and the relationship to the source upload plan.
const schema = (file: string) =>
  JSON.parse(
    readFileSync(new URL(`../api/http/${file}`, import.meta.url), "utf8"),
  );

test("the request is closed and carries no job, owner, recording or key", () => {
  const s = schema("output-create.v1.schema.json");
  assert.deepEqual(s.required, ["slot", "role", "sizeBytes", "sha256"]);
  assert.deepEqual(Object.keys(s.properties).sort(), [
    "role",
    "sha256",
    "sizeBytes",
    "slot",
  ]);
  assert.equal(s.additionalProperties, false);
});

test("the plan has the source plan fields, output roles and no source-manifest rule", () => {
  const out = schema("output-plan.v1.schema.json");
  const src = schema("upload-plan.v1.schema.json");
  assert.deepEqual(out.required, src.required);
  assert.deepEqual(Object.keys(out.properties), Object.keys(src.properties));
  assert.equal(out.additionalProperties, false);
  assert.equal(out.if, undefined);
  assert.ok(String(out.properties.role.$ref).endsWith("/outputFileRole"));
});

test("output and source roles are disjoint across the two plan contracts", () => {
  const plan = {
    fileId: "7c2d3e4f-5061-4728-9bac-1d2e3f4a5b6c",
    recordingId: "3f1b8c2e-6a4d-4e7b-9c1a-2b5d8e9f0a11",
    role: "clip_mp4",
    sizeBytes: "10",
    sha256: "d3690131c737f212505f230d86ea322e788db598fd0162f5500f7e22ab7005bc",
    transportEpoch: 1,
    partSizeBytes: "67108864",
    partCount: 1,
    state: "reserved",
    transportExpiresAt: "2026-11-08T18:04:05Z",
  };
  assert.equal(validateValue("http.output-plan.v1", plan).valid, true);
  assert.equal(validateValue("http.upload-plan.v1", plan).valid, false);
  const source = { ...plan, role: "source_mcap" };
  assert.equal(validateValue("http.upload-plan.v1", source).valid, true);
  assert.equal(validateValue("http.output-plan.v1", source).valid, false);
});
