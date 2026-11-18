import assert from "node:assert/strict";
import test from "node:test";
import { createClipViewer } from "../lib/rerun/clip-viewer.ts";

globalThis.location = { href: "http://127.0.0.1:3000/x" };
const ORIGIN = "http://127.0.0.1:9";
const rrd = (tag = "") =>
  new Uint8Array([
    ...new TextEncoder().encode("RRF2"),
    ...new TextEncoder().encode(tag),
  ]);

// Track object URLs: every created URL must be revoked unless it is the one
// still adopted by a live viewer.
const live = new Set();
let n = 0;
URL.createObjectURL = () => {
  const u = `blob:test/${(n += 1)}`;
  live.add(u);
  return u;
};
URL.revokeObjectURL = (u) => live.delete(u);

function harness({ moduleGate, startGate } = {}) {
  const log = [];
  class FakeViewer {
    async start(url) {
      log.push(["start", url]);
      await startGate?.promise;
      this.loaded = url;
    }
    async close() {
      log.push(["close"]);
      this.loaded = null;
    }
    async open(url) {
      log.push(["open", url]);
      this.loaded = url;
    }
    async get_state() {
      return {
        loading: [],
        recordings: this.loaded ? [{ store_id: `store-${this.loaded}` }] : [],
      };
    }
    stop() {
      log.push(["stop"]);
    }
  }
  const fetchImpl = async (url) =>
    new Response(rrd(new URL(url).searchParams.get("t") ?? ""), {
      headers: { "content-type": "application/octet-stream" },
    });
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const states = [];
  const c = createClipViewer(
    {},
    {
      allowedOrigins: [ORIGIN],
      onState: (s) => states.push(s),
      loadViewerModule: async () => {
        await moduleGate?.promise;
        return { WebViewer: FakeViewer };
      },
    },
  );
  return { c, log, states, restore: () => (globalThis.fetch = realFetch) };
}
const gate = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
const resolver = (t) => async () => `${ORIGIN}/c.rrd?t=${t}`;
const tick = () => new Promise((r) => setTimeout(r, 20));

test("sequential loads close the previous clip and keep exactly one adopted URL", async () => {
  live.clear();
  const h = harness();
  const a = await h.c.load(resolver("a"));
  const b = await h.c.load(resolver("b"));
  assert.equal(a.phase, "ready");
  assert.equal(b.phase, "ready");
  assert.deepEqual(
    h.log.map((e) => e[0]),
    ["start", "close", "open"],
  );
  assert.equal(live.size, 1);
  h.c.stop();
  await tick();
  assert.equal(live.size, 0);
  assert.deepEqual(h.log.at(-1), ["stop"]);
  h.restore();
});

test("a failed switch clears the previous recording and permits retry", async () => {
  live.clear();
  const h = harness();
  try {
    assert.equal((await h.c.load(resolver("a"))).phase, "ready");
    const failed = await h.c.load(async () => {
      throw new Error("Access denied");
    });
    assert.equal(failed.phase, "error");
    assert.equal(h.c.viewer, null);
    assert.equal(live.size, 0);
    assert.deepEqual(h.log.at(-1), ["stop"]);
    assert.equal((await h.c.load(resolver("b"))).phase, "ready");
    assert.equal(live.size, 1);
  } finally {
    h.c.stop();
    await tick();
    h.restore();
  }
});

test("rapid superseding loads show only the latest and leak no object URL", async () => {
  live.clear();
  const startGate = gate();
  const h = harness({ startGate });
  const p1 = h.c.load(resolver("1"));
  const p2 = h.c.load(resolver("2"));
  const p3 = h.c.load(resolver("3"));
  await tick();
  startGate.resolve();
  await Promise.all([p1, p2, p3]);
  const last = h.states.filter((s) => s.phase === "ready").at(-1);
  assert.ok(last);
  assert.equal(
    h.log.filter((e) => e[0] === "start").length,
    1,
    "one viewer start",
  );
  assert.ok(
    h.log.every((e, i) => e[0] !== "open" || h.log[i - 1]?.[0] === "close"),
  );
  assert.equal(live.size, 1);
  h.c.stop();
  await tick();
  assert.equal(live.size, 0);
  h.restore();
});

test("stop while the viewer module is still loading never starts a viewer", async () => {
  live.clear();
  const moduleGate = gate();
  const h = harness({ moduleGate });
  const p = h.c.load(resolver("a"));
  await tick();
  h.c.stop();
  moduleGate.resolve();
  await p;
  await tick();
  assert.equal(h.log.filter((e) => e[0] === "start").length, 0);
  assert.equal(live.size, 0);
  h.restore();
});

test("stop during a pending start stops that viewer once it settles", async () => {
  live.clear();
  const startGate = gate();
  const h = harness({ startGate });
  const p = h.c.load(resolver("a"));
  await tick();
  h.c.stop();
  assert.ok(!h.log.some((e) => e[0] === "stop"), "not stopped mid-start");
  startGate.resolve();
  await p;
  await tick();
  assert.deepEqual(
    h.log.map((e) => e[0]),
    ["start", "stop"],
  );
  assert.equal(live.size, 0);
  assert.notEqual(h.states.at(-1).phase, "ready");
  h.restore();
});
