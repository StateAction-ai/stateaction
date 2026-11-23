import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import test from "node:test";
import { assertLocalDispatch } from "../src/config.js";
import {
  requestPlatformVerification,
  START_TASK_DEADLINE_MS,
} from "../src/dispatch.js";
const env = {
  APP_ENV: "local",
  RENDER_USE_LOCAL_DEV: "true",
  RENDER_LOCAL_DEV_URL: "http://127.0.0.1:8120",
  LOCAL_SMOKE_TOKEN: "12345678901234567890123456789012",
};
test("development route refuses production and remote targets", () => {
  assert.doesNotThrow(() => assertLocalDispatch(env));
  for (const overrides of [
    { APP_ENV: "production" },
    { NODE_ENV: "production" },
    { RENDER_USE_LOCAL_DEV: "false" },
    { RENDER_LOCAL_DEV_URL: "https://api.render.com" },
    { LOCAL_SMOKE_TOKEN: "short" },
  ])
    assert.throws(() => assertLocalDispatch({ ...env, ...overrides }));
});
test("real handler rejects unauthenticated, malformed and oversized bodies before dispatch", async () => {
  const old = { ...process.env };
  Object.assign(process.env, env);
  try {
    const invoke = (body: string, token?: string) =>
      requestPlatformVerification(
        new Request("http://localhost/api", {
          method: "POST",
          body,
          ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
        }),
      );
    assert.equal((await invoke("{}")).status, 401);
    assert.equal((await invoke("{}", env.LOCAL_SMOKE_TOKEN)).status, 400);
    assert.equal(
      (await invoke("x".repeat(4097), env.LOCAL_SMOKE_TOKEN)).status,
      413,
    );
    process.env.APP_ENV = "production";
    assert.equal((await invoke("{}", env.LOCAL_SMOKE_TOKEN)).status, 404);
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
  }
});

// Stub local runner (SA-117): POST /v1/task-runs answers after `ackMs` (never when null), the
// way the real runner acks only after it has started the task.
async function withStubRunner(
  ackMs: number | null,
  run: (url: string, seen: string[]) => Promise<void>,
) {
  const seen: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    req.resume();
    if (ackMs === null) return; // hung runner: accepted the connection, never answers
    setTimeout(() => {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "trn-stub-run", status: "pending" }));
    }, ackMs).unref();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`, seen);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function dispatchTo(
  url: string,
  options?: { startDeadlineMs?: number },
): Promise<Response> {
  const old = { ...process.env };
  Object.assign(process.env, env, { RENDER_LOCAL_DEV_URL: url });
  try {
    return await requestPlatformVerification(
      new Request("http://localhost/api", {
        method: "POST",
        headers: { authorization: `Bearer ${env.LOCAL_SMOKE_TOKEN}` },
        body: JSON.stringify({ requestId: randomUUID() }),
      }),
      options,
    );
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in old)) delete process.env[key];
    Object.assign(process.env, old);
  }
}

test("a runner that acks after the old 2 s deadline still gets 202 with the real taskRunId", async () => {
  await withStubRunner(3000, async (url, seen) => {
    const response = await dispatchTo(url);
    assert.equal(response.status, 202);
    const body = (await response.json()) as { taskRunId: string };
    assert.equal(body.taskRunId, "trn-stub-run");
    assert.deepEqual(seen, ["POST /v1/task-runs"]);
  });
});

test("a hung runner is cut off by the guard with 503 within the deadline", async () => {
  await withStubRunner(null, async (url, seen) => {
    const started = Date.now();
    const response = await dispatchTo(url, { startDeadlineMs: 400 });
    const elapsed = Date.now() - started;
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "local_workflow_unavailable",
    });
    assert.ok(elapsed >= 350 && elapsed < 3000, `elapsed ${elapsed} ms`);
    // Residual: the request reached the runner and no task run id was ever returned, so
    // the SDK offers nothing to cancel; a runner that starts a task later is not reported.
    assert.equal(seen.length, 1);
  });
});

test("the production guard exceeds the measured loaded acknowledgement maximum", () => {
  assert.ok(START_TASK_DEADLINE_MS >= 3 * 4900);
});
