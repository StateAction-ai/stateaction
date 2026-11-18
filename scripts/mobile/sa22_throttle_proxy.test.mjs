import assert from "node:assert/strict";
import { connect, createServer } from "node:net";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { startProxy } from "./sa22_throttle_proxy.mjs";

const TEST_TIMEOUT_MS = 20_000;
const STEP_TIMEOUT_MS = 5_000;

/** Rejects if [promise] does not settle within [ms]. */
function bounded(promise, label, ms = STEP_TIMEOUT_MS) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function sink() {
  let received = 0;
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", (c) => (received += c.length));
    socket.on("error", () => {});
  });
  await bounded(
    new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    }),
    "sink listen",
  );
  return {
    port: server.address().port,
    received: () => received,
    close: async () => {
      for (const s of sockets) s.destroy();
      await bounded(new Promise((r) => server.close(() => r())), "sink close");
    },
  };
}

/**
 * Runs [body] with a sink and proxy. Every client, the proxy and the sink are
 * released in `finally`, so a failing assertion cannot leave a handle open.
 */
async function withRig(options, body) {
  const clients = new Set();
  const s = await sink();
  let proxy;
  try {
    proxy = await startProxy({ targetPort: s.port, ...options });
    const client = async () => {
      const c = connect(proxy.port, "127.0.0.1");
      clients.add(c);
      c.on("error", () => {});
      await bounded(
        new Promise((resolve, reject) => {
          c.once("connect", resolve);
          c.once("error", reject);
        }),
        "client connect",
      );
      return c;
    };
    await body({ s, proxy, client });
  } finally {
    for (const c of clients) c.destroy();
    if (proxy) await proxy.close();
    await s.close();
  }
}

test(
  "forwards bytes unchanged and counts them",
  { timeout: TEST_TIMEOUT_MS },
  () =>
    withRig({ rate: 10 * 1024 * 1024 }, async ({ s, proxy, client }) => {
      const c = await client();
      c.write(Buffer.alloc(100_000, 7));
      await sleep(400);
      assert.equal(s.received(), 100_000);
      assert.equal(proxy.stats().upBytes, 100_000);
      assert.equal(proxy.stats().readBytes, 100_000);
      assert.equal(proxy.stats().forwardedBytes, 100_000);
    }),
);

test(
  "stall holds bytes and flow releases them; reset drops sockets",
  { timeout: TEST_TIMEOUT_MS },
  () =>
    withRig({ rate: 10 * 1024 * 1024 }, async ({ s, proxy, client }) => {
      const c = await client();
      proxy.setMode("stall");
      c.write(Buffer.alloc(50_000, 1));
      await sleep(300);
      assert.equal(s.received(), 0, "nothing is forwarded while stalled");
      proxy.setMode("flow");
      await sleep(400);
      assert.equal(s.received(), 50_000);
      proxy.setMode("reset");
      await sleep(200);
      assert.equal(proxy.stats().active, 0);
    }),
);

test("the rate limit slows a large write", { timeout: TEST_TIMEOUT_MS }, () =>
  withRig({ rate: 100 * 1024 }, async ({ s, client }) => {
    const c = await client();
    c.write(Buffer.alloc(400 * 1024, 2));
    await sleep(1000);
    const after1s = s.received();
    assert.ok(
      after1s > 40 * 1024 && after1s < 250 * 1024,
      `rate-limited, got ${after1s}`,
    );
  }),
);

test(
  "a fence mark separates draining buffered bytes from new device connections",
  { timeout: TEST_TIMEOUT_MS },
  () =>
    withRig({ rate: 100 * 1024 }, async ({ proxy, client }) => {
      const c = await client();
      c.write(Buffer.alloc(300 * 1024, 3));
      await sleep(300);
      proxy.mark("fence");
      await sleep(500);
      const d = proxy.since("fence");
      // Bytes the device wrote before the fence can still sit in kernel socket
      // buffers and be read/forwarded afterwards; only NEW connections (or bytes
      // after the buffers drained) indicate new device activity.
      assert.ok(d.forwardedBytes > 0, "pre-fence data was still draining");
      assert.equal(d.newConnections, 0, "the device opened no new connection");
      await client();
      assert.equal(
        proxy.since("fence").newConnections,
        1,
        "a new request is visible",
      );
    }),
);
