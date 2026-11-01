import assert from "node:assert/strict";
import test from "node:test";
import { parsePlatformVerifyRequest, parseWorkerHealth } from "../src/index.js";
const requestId = "519f19f0-1f9c-49f1-bf88-7343fd2dc358";
test("accept canonical bounded verification request", () =>
  assert.deepEqual(parsePlatformVerifyRequest({ requestId }), { requestId }));
test("reject malformed, extra and noncanonical fields", () => {
  for (const value of [
    null,
    [],
    {},
    { requestId: "bad" },
    { requestId, token: "secret" },
    { requestId: requestId.toUpperCase() },
  ])
    assert.throws(() => parsePlatformVerifyRequest(value));
});
test("worker response must carry exact version and request identity", () => {
  const response = {
    protocolVersion: 1,
    requestId,
    status: "ok",
    python: "3.12.13",
    workerVersion: "0.1.0",
  };
  assert.deepEqual(parseWorkerHealth(response), response);
  assert.throws(() => parseWorkerHealth({ ...response, token: "secret" }));
  assert.throws(() => parseWorkerHealth({ ...response, protocolVersion: 2 }));
});
