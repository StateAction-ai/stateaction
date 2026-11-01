import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Render } from "@renderinc/sdk";
import { parseWorkerHealth } from "@stateaction/contracts";
if (
  process.env.APP_ENV !== "local" ||
  process.env.RENDER_USE_LOCAL_DEV !== "true"
)
  throw new Error("Smoke must use the local runner");
const target = new URL(
  process.env.RENDER_LOCAL_DEV_URL ?? "http://127.0.0.1:8120",
);
if (
  !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
  target.protocol !== "http:"
)
  throw new Error("Refusing a cloud workflow endpoint");
const base = "http://127.0.0.1:3000";
const health = await fetch(`${base}/api/v1/health`, {
  signal: AbortSignal.timeout(10000),
});
assert.equal(health.status, 200);
assert.deepEqual(await health.json(), {
  status: "ok",
  checks: { database: true, storage: true },
});
const requestId = randomUUID();
const path = `${base}/api/v1/development/workflows/verify`;
const unauthorized = await fetch(path, {
  method: "POST",
  body: JSON.stringify({ requestId }),
  signal: AbortSignal.timeout(10000),
});
assert.equal(unauthorized.status, 401);
const invalid = await fetch(path, {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.LOCAL_SMOKE_TOKEN}` },
  body: "{}",
  signal: AbortSignal.timeout(10000),
});
assert.equal(invalid.status, 400);
const response = await fetch(path, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${process.env.LOCAL_SMOKE_TOKEN}`,
  },
  body: JSON.stringify({ requestId }),
  signal: AbortSignal.timeout(10000),
});
assert.equal(response.status, 202);
const accepted = (await response.json()) as {
  requestId: string;
  taskRunId: string;
};
assert.equal(accepted.requestId, requestId);
assert.ok(accepted.taskRunId);
const render = new Render();
const deadline = Date.now() + 60000;
for (;;) {
  const run = await render.workflows.getTaskRun(accepted.taskRunId);
  if (run.status === "completed") {
    const result = run.results?.[0] as {
      requestId: string;
      renderRunId: string;
      worker: unknown;
    };
    assert.equal(result.requestId, requestId);
    assert.equal(result.renderRunId, accepted.taskRunId);
    const worker = parseWorkerHealth(result.worker);
    assert.equal(worker.requestId, requestId);
    console.log(
      JSON.stringify(
        {
          status: "passed",
          database: true,
          storage: true,
          officialRenderTaskRunId: accepted.taskRunId,
          requestId,
          worker,
        },
        null,
        2,
      ),
    );
    break;
  }
  if (
    ["failed", "canceled"].includes(run.status ?? "") ||
    Date.now() >= deadline
  )
    throw new Error(`Local task did not complete: ${run.status}`);
  await new Promise((resolve) => setTimeout(resolve, 250));
}
