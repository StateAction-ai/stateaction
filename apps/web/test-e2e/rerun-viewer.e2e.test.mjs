// Real production Next build + real self-hosted @rerun-io/web-viewer 0.41.0 in
// headless Chrome, loading real worker RRDs from a loopback storage stand-in.
// Run ENTIRELY inside one resource-guard job (the browser daemon included):
//   agent-resource run -- node --test test-e2e/rerun-viewer.e2e.test.mjs
// Needs a prior `pnpm --filter @stateaction/web build`. No Docker, database or
// external network. SA38_RRD_DIR (optional) points at extra real clips
// (a.rrd/b.rrd) such as the ignored SA-61 artifacts for the larger qualification.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

const web = new URL("../", import.meta.url);
const golden = readFileSync(new URL("test-e2e/fixtures/golden-clip.rrd", web));
const extra = process.env.SA38_RRD_DIR;
const clips = {
  a:
    extra && existsSync(`${extra}/a.rrd`)
      ? readFileSync(`${extra}/a.rrd`)
      : golden,
  b:
    extra && existsSync(`${extra}/b.rrd`)
      ? readFileSync(`${extra}/b.rrd`)
      : golden,
};
const session = `sa38-${randomBytes(4).toString("hex")}`;
const chrome = process.env.CHROME ?? "/usr/bin/google-chrome";
let storage, app, appOrigin, storageOrigin;
const stats = { issued: 0, served: 0, forbidden: 0 };
const tokens = new Map(); // token -> { clip, valid }
const control = { expireNext: 0, hostile: null };

function browser(...args) {
  return execFileSync(
    "agent-browser",
    [
      "--session",
      session,
      "--executable-path",
      chrome,
      "--args",
      "--no-sandbox,--enable-unsafe-swiftshader",
      ...args,
    ],
    { encoding: "utf8", timeout: 120_000 },
  ).trim();
}
const ev = (expr) => {
  const out = browser(
    "eval",
    `(async()=>{const v=await(${expr});return JSON.stringify(v,(_,x)=>typeof x==="bigint"?x.toString():x)})()`,
  );
  const once = JSON.parse(out);
  return typeof once === "string" ? JSON.parse(once) : once;
};
async function until(pred, what, ms = 90_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await pred();
    if (v) return v;
    assert.ok(Date.now() < end, `timeout: ${what}`);
    await sleep(150);
  }
}
const phase = () =>
  browser(
    "eval",
    `document.querySelector('[data-testid=phase]').textContent`,
  ).replace(/"/g, "");
const detail = () =>
  JSON.parse(
    JSON.parse(
      browser(
        "eval",
        `document.querySelector('[data-testid=detail]').textContent`,
      ),
    ),
  );
const click = (label) =>
  browser(
    "eval",
    `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==${JSON.stringify(label)}).click()`,
  );

before(async () => {
  storage = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const cors = {
      "access-control-allow-origin": appOrigin ?? "*",
      vary: "origin",
    };
    if (req.method === "OPTIONS") {
      res
        .writeHead(204, { ...cors, "access-control-allow-methods": "GET" })
        .end();
      return;
    }
    if (url.pathname === "/issue") {
      stats.issued += 1;
      const token = randomBytes(8).toString("hex");
      tokens.set(token, { clip: url.searchParams.get("clip") });
      res
        .writeHead(200, { ...cors, "content-type": "application/json" })
        .end(JSON.stringify({ url: `${storageOrigin}/clips/${token}.rrd` }));
      return;
    }
    const token = /^\/clips\/(\w+)\.rrd$/.exec(url.pathname)?.[1];
    const entry = token && tokens.get(token);
    if (!entry || control.expireNext > 0) {
      if (control.expireNext > 0) control.expireNext -= 1;
      stats.forbidden += 1;
      res
        .writeHead(403, { ...cors, "content-type": "application/xml" })
        .end("<Error>ExpiredToken</Error>");
      return;
    }
    stats.served += 1;
    const body = clips[entry.clip];
    res
      .writeHead(200, {
        ...cors,
        "content-type": "application/octet-stream",
        "content-length": body.length,
      })
      .end(body);
  });
  await new Promise((r) => storage.listen(0, "127.0.0.1", r));
  storageOrigin = `http://127.0.0.1:${storage.address().port}`;
  const port = 20000 + Math.floor(Math.random() * 20000);
  appOrigin = `http://127.0.0.1:${port}`;
  app = spawn(
    process.execPath,
    [new URL("../../scripts/platform/web.mjs", web).pathname, "start"],
    {
      cwd: new URL(".", web).pathname,
      env: {
        ...process.env,
        APP_ENV: "local",
        PORT: String(port),
        STATEACTION_VIEWER_HARNESS_ORIGIN: storageOrigin,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let log = "";
  app.stdout.on("data", (d) => (log += d));
  app.stderr.on("data", (d) => (log += d));
  await until(
    async () => {
      try {
        return (await fetch(`${appOrigin}/api/v1/live`)).ok;
      } catch {
        return false;
      }
    },
    `next start\n${log}`,
    60_000,
  );
});

after(async () => {
  try {
    browser("close");
  } catch {}
  app?.kill("SIGTERM");
  storage?.close();
});

test("self-hosts the viewer and refuses hosted/unconfigured harness", async () => {
  const wasm = await fetch(`${appOrigin}/rerun/0.41.0/re_viewer_bg.wasm`);
  assert.equal(wasm.status, 200);
  assert.match(wasm.headers.get("cache-control"), /immutable/);
  assert.equal(wasm.headers.get("content-type"), "application/wasm");
  const bytes = Buffer.from(await wasm.arrayBuffer());
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    "f2831500e6ca8645fbfc94f4ffff78e62a4eb8d864afd84299f9188b9b577cb2",
  );
  const page = await fetch(`${appOrigin}/api/v1/live`);
  assert.match(page.headers.get("cache-control"), /no-store/);
});

test("real RRD loads in the production build, decodes H.264, then clips load sequentially", async () => {
  const t0 = Date.now();
  browser("open", `${appOrigin}/dev/rerun-viewer`);
  await until(() => phase() === "ready" || phase() === "error", "first clip");
  assert.equal(phase(), "ready", JSON.stringify(detail()));
  const startupMs = Date.now() - t0;
  const first = detail();
  assert.equal(first.bytes, clips.a.length);
  const state = ev("window.__clipViewer.viewer.get_state()");
  assert.equal(state.recordings.length, 1);
  assert.match(state.viewer_version, /^0\.41\.0/);
  const schema = ev(
    "window.__clipViewer.viewer.get_recording_schema({max_entities:100})",
  );
  const entities = schema.entities.map((e) => e.entity_path);
  assert.ok(entities.includes("/rgb"), entities.join());
  assert.deepEqual(
    entities.filter(
      (e) =>
        !["/", "/__properties"].includes(e) &&
        !/^\/(rgb|model_relative_3d|notes)/.test(e),
    ),
    [],
  );
  // Seek to the last frame so WebCodecs actually decodes.
  const tl = state.recordings[0].timelines.find((t) => t.name === "clip_time");
  assert.ok(tl?.time_range, "clip_time timeline");
  await until(async () => {
    browser(
      "eval",
      `window.__clipViewer.viewer.set_time({timeline:"clip_time",duration_nanos:BigInt(${JSON.stringify(String(tl.time_range.end))}),play_state:"paused"})`,
    );
    return ev("window.__decoder").decoded.length > 0;
  }, "webcodecs decode");
  const dec = ev("window.__decoder");
  assert.deepEqual(dec.errors, []);
  assert.ok(dec.configs.every((c) => String(c.codec).startsWith("avc1.")));

  // Sequential load of a second clip: previous recording is closed.
  const servedBefore = stats.served;
  click("clip b");
  // The harness remounts per clip (key), so also prove a second fetch+ready.
  // With distinct SA38_RRD_DIR clips the store id differs too.
  await until(
    () =>
      stats.served > servedBefore &&
      detail().phase === "ready" &&
      (clips.a === clips.b || detail().storeId !== first.storeId),
    "second clip",
  );
  assert.equal(
    ev("window.__clipViewer.viewer.get_state()").recordings.length,
    1,
  );

  const resources = ev(
    `performance.getEntriesByType('resource').map(e=>({o:new URL(e.name).origin,p:new URL(e.name).pathname,t:e.transferSize}))`,
  );
  const hosts = new Set(resources.map((r) => r.o));
  assert.deepEqual(
    [...hosts].filter((h) => h !== appOrigin && h !== storageOrigin),
    [],
    "no external hosts",
  );
  assert.ok(resources.some((r) => r.p === "/rerun/0.41.0/re_viewer_bg.wasm"));
  const heap = ev(
    "({used:performance.memory?.usedJSHeapSize,total:performance.memory?.totalJSHeapSize})",
  );
  mkdirSync(new URL("../../artifacts/sa38/", web), { recursive: true });
  writeFileSync(
    new URL(`../../artifacts/sa38/qualification-${Date.now()}.json`, web),
    JSON.stringify(
      {
        startupToReadyMs: startupMs,
        rrdBytes: clips.a.length,
        transferred: resources.map((r) => ({ path: r.p, bytes: r.t })),
        jsHeap: heap,
        decodedFrames: dec.decoded.length,
        configs: dec.configs,
        browser: "headless chrome, SwiftShader WebGL",
        note: "JS heap only; not WASM/GPU memory; not a phone browser",
      },
      null,
      2,
    ),
  );
  assert.equal(stats.issued, 2);
});

test("an expired URL is recovered with one fresh issuance; persistent expiry is an error that Try again clears", async () => {
  const before = stats.issued;
  control.expireNext = 1;
  click("clip a");
  await until(
    () => detail().phase === "ready" || detail().phase === "error",
    "recovered",
  );
  assert.equal(detail().phase, "ready", JSON.stringify(detail()));
  assert.equal(stats.issued - before, 2, "fresh URL issued after expiry");

  control.expireNext = 2;
  click("clip b");
  await until(() => detail().phase === "error", "persistent expiry");
  assert.equal(detail().code, "expired");
  assert.match(
    browser("eval", `document.querySelector('[role=alert]').textContent`),
    /expired/,
  );
  browser(
    "eval",
    `[...document.querySelectorAll('[role=alert] button')][0].click()`,
  );
  await until(() => detail().phase === "ready", "retry after expiry");
});

test("unmounting stops the viewer and removes its canvas", async () => {
  assert.ok(
    Number(browser("eval", "document.querySelectorAll('canvas').length")) > 0,
  );
  click("unmount");
  await until(() => detail().phase === "stopped", "stopped");
  assert.equal(
    Number(browser("eval", "document.querySelectorAll('canvas').length")),
    0,
  );
  assert.equal(
    browser("eval", "String(window.__clipViewer)").replace(/"/g, ""),
    "null",
  );
  click("mount");
  await until(() => detail().phase === "ready", "remount");
});
