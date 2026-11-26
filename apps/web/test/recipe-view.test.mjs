import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRecipeId, recipeHref } from "../lib/recipe-view.ts";

test("Next route parameters may retain the encoded recipe separator", () => {
  assert.equal(parseRecipeId("stub_local%401"), "stub_local@1");
  assert.equal(parseRecipeId("stub_local@1"), "stub_local@1");
  for (const bad of [
    "stub_local%25",
    "stub_local%4",
    "%2Fstub_local%401",
    "stub_local@0",
  ]) {
    assert.equal(parseRecipeId(bad), null);
  }
});

test("recipe stage links stay pinned to the exact job", () => {
  assert.equal(
    recipeHref("stub_local@1", "job-a", { stage: "segment" }),
    "/recipes/stub_local%401?job=job-a&step=segment",
  );
  assert.notEqual(
    recipeHref("stub_local@1", "job-a"),
    recipeHref("stub_local@1", "job-b"),
  );
});
