import assert from "node:assert/strict";
import { test } from "node:test";
import { isCurrentImport } from "../lib/clip-pipeline.ts";

test("only the current execution can supply an imported pipeline label", () => {
  const selectedResult = { jobId: "imported-job", source: "imported" };
  assert.equal(
    isCurrentImport({ liveJobId: "imported-job", selectedResult }),
    true,
  );
  assert.equal(
    isCurrentImport({ liveJobId: "failed-job", selectedResult }),
    false,
  );
  assert.equal(isCurrentImport({ liveJobId: null, selectedResult }), true);
  assert.equal(
    isCurrentImport({ liveJobId: null, selectedResult: null }),
    false,
  );
});
