import assert from "node:assert/strict";
import test from "node:test";
import { LocalExecutor } from "../src/local-executor.js";
const requestId = "519f19f0-1f9c-49f1-bf88-7343fd2dc358";
test("real Python worker subprocess returns validated identity", async () => {
  const old = { ...process.env };
  Object.assign(process.env, { APP_ENV: "local", EXECUTION_BACKEND: "local" });
  try {
    const result = await new LocalExecutor().verify({ requestId });
    assert.equal(result.requestId, requestId);
    assert.equal(result.status, "ok");
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
  }
});
test("local child execution refuses implicit environment selection", async () => {
  const previous = process.env.APP_ENV;
  process.env.APP_ENV = "production";
  try {
    await assert.rejects(
      () => new LocalExecutor().verify({ requestId }),
      /explicit local/,
    );
  } finally {
    if (previous === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = previous;
  }
});
