import assert from "node:assert/strict";
import { test } from "node:test";
import { repairOnce } from "../src/repair.js";

test("repair is one bounded reconcile call that returns counts only", async () => {
  let calls = 0;
  const summary = await repairOnce({
    reconcile: async () => {
      calls++;
      return {
        admission: { state: "idle" },
        pendingDispatches: [{ jobId: "a", dispatchKey: "job:a" }],
      } as never;
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(summary, { admission: "idle", pendingDispatches: 1 });
});
test("a failing API call propagates (non-zero exit) with no hidden retry", async () => {
  let calls = 0;
  await assert.rejects(
    repairOnce({
      reconcile: async () => {
        calls++;
        throw new Error("down");
      },
    }),
  );
  assert.equal(calls, 1);
});
