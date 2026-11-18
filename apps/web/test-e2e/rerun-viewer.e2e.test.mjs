// Production Next, the real dataset read broker, and headless Chrome under
// agent-resource. A loopback proxy supplies test CORS and simulates expiry
// while successful signed requests reach the bounded S3 fixture.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { createRequire } from "node:module";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { findChrome, launchChrome } from "./chrome.mjs";
import { SESSION, signIn, startStack, webDir } from "./harness.mjs";

const web = new URL("../", import.meta.url);
const server = new URL("../../../packages/server/", import.meta.url);
const serverRequire = createRequire(new URL("package.json", server));
const { Pool } = serverRequire("pg");
const { S3Client, CreateBucketCommand, PutObjectCommand } =
  serverRequire("@aws-sdk/client-s3");
const { SEED } = await import(new URL("dist/catalog/seed.js", server));
const { revokeSharingPermission } = await import(
  new URL("dist/datasets/operator.js", server)
);
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
let chrome, stack, owner, s3, appOrigin, storageOrigin;
const stats = { served: 0, waiting: 0, cancelled: 0 };
const control = { expireNext: 0, holdNext: false };
let expireHeld;
const clipIds = [SEED.clips.shared, SEED.clips.both, SEED.clips.private];
const viewerPath = `/dev/rerun-viewer?clips=${clipIds.join(",")}&dataset=${SEED.datasets.shared.id}`;
const directPath = `/dev/rerun-viewer?clips=${SEED.clips.private}`;

async function ev(expression) {
  const { result, exceptionDetails } = await chrome
    .send("Runtime.evaluate", {
      expression: `(async()=>JSON.stringify(await(${expression}),(_,x)=>typeof x==="bigint"?x.toString():x))()`,
      awaitPromise: true,
      returnByValue: true,
    })
    .catch((error) => {
      throw new Error(`Viewer evaluation failed: ${expression}`, {
        cause: error,
      });
    });
  assert.ok(!exceptionDetails, exceptionDetails?.exception?.description);
  return result.value === undefined ? undefined : JSON.parse(result.value);
}
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
  ev("document.querySelector('[data-testid=phase]')?.textContent");
const detail = () =>
  ev("JSON.parse(document.querySelector('[data-testid=detail]').textContent)");
const settled = async () => ["ready", "error"].includes(await phase());
const click = (label) =>
  ev(
    `[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==${JSON.stringify(label)}).click()`,
  );
const canvasCount = () => ev("document.querySelectorAll('canvas').length");

async function storageProxy(endpoint) {
  const proxy = createServer((req, res) => {
    const cors = {
      "access-control-allow-origin": appOrigin,
      "timing-allow-origin": appOrigin,
    };
    if (req.headers.cookie || req.headers.authorization) {
      res.writeHead(400, cors).end();
      return;
    }
    if (control.expireNext > 0) {
      control.expireNext -= 1;
      res.writeHead(403, cors).end();
      return;
    }
    if (control.holdNext) {
      control.holdNext = false;
      stats.waiting += 1;
      expireHeld = () => res.writeHead(403, cors).end();
      res.on("close", () => {
        expireHeld = undefined;
        if (!res.writableEnded) stats.cancelled += 1;
      });
      return;
    }
    const upstream = request(
      endpoint + req.url,
      { method: req.method, headers: req.headers },
      (response) => {
        if (response.statusCode === 200) stats.served += 1;
        res.writeHead(response.statusCode, { ...response.headers, ...cors });
        response.pipe(res);
      },
    );
    upstream.on("error", () => res.destroy());
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  return {
    endpoint: `http://127.0.0.1:${proxy.address().port}`,
    stop: () => {
      proxy.close();
      proxy.closeAllConnections();
    },
  };
}

async function openAs(label, path) {
  const jar = await signIn(stack, label);
  const { success } = await chrome.send("Network.setCookie", {
    name: SESSION,
    value: jar.cookies.get(SESSION),
    url: appOrigin,
    httpOnly: true,
  });
  assert.equal(success, true);
  const start = Date.now();
  const { errorText } = await chrome.send("Page.navigate", {
    url: appOrigin + path,
  });
  assert.equal(errorText, undefined);
  return start;
}
const issued = () =>
  ev(
    "performance.getEntriesByType('resource').filter(e=>new URL(e.name).pathname.endsWith('/reads')).length",
  );

before(async () => {
  stack = await startStack({
    storage: true,
    viewerHarness: true,
    storageProxy,
  });
  appOrigin = stack.origin;
  storageOrigin = stack.outage.endpoint;
  owner = new Pool({ connectionString: stack.db.ownerUrl, max: 2 });
  s3 = new S3Client({
    endpoint: stack.s3.endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: stack.s3.accessKeyId,
      secretAccessKey: stack.s3.secretAccessKey,
    },
  });
  const Bucket = stack.env.S3_BUCKET;
  if (!stack.s3.bucket) await s3.send(new CreateBucketCommand({ Bucket }));
  const { rows } = await owner.query(
    `SELECT c.id, f.object_key FROM clips c
     JOIN files f ON f.id = c.viewer_rrd_file_id WHERE c.id = ANY($1::uuid[])`,
    [clipIds],
  );
  assert.equal(rows.length, clipIds.length);
  for (const row of rows)
    await s3.send(
      new PutObjectCommand({
        Bucket,
        Key: row.object_key,
        Body: row.id === SEED.clips.both ? clips.b : clips.a,
        ContentType: "application/octet-stream",
      }),
    );
});

after(async () => {
  try {
    await chrome?.close();
  } finally {
    await owner?.end();
    s3?.destroy();
    await stack?.stop();
  }
});

test("self-hosts the viewer with immutable assets", async () => {
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

test("the production build denies the harness in a hosted environment", async () => {
  // Bind Next directly to loopback so this negative route check never opens a
  // listener on the workstation network.
  const port = 40000 + Math.floor(Math.random() * 20000);
  const denied = spawn(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: webDir,
      env: {
        ...process.env,
        APP_ENV: "production",
        STATEACTION_VIEWER_HARNESS_ORIGIN: storageOrigin,
      },
      stdio: "ignore",
    },
  );
  try {
    const response = await until(
      async () => {
        try {
          return await fetch(`http://127.0.0.1:${port}${viewerPath}`);
        } catch {
          return false;
        }
      },
      "hosted harness denial",
      60_000,
    );
    assert.equal(response.status, 404);
  } finally {
    if (denied.exitCode === null && denied.signalCode === null) {
      const exited = once(denied, "exit");
      denied.kill("SIGTERM");
      await exited;
    }
  }
});

test("real RRD loads in the production build, decodes H.264, then clips load sequentially", async () => {
  const binary = await findChrome();
  assert.ok(binary, "Chrome is required for the Rerun browser test");
  chrome = await launchChrome(binary, { webgl: true });
  if (process.platform === "linux") {
    const cgroup = (pid) => readFileSync(`/proc/${pid}/cgroup`, "utf8");
    assert.equal(
      cgroup(chrome.pid),
      cgroup("self"),
      "Chrome stays in the test scope",
    );
  }
  const t0 = await openAs("customer", viewerPath);
  await until(settled, "first clip");
  assert.equal(await phase(), "ready", JSON.stringify(await detail()));
  const startupMs = Date.now() - t0;
  const first = await detail();
  assert.equal(first.bytes, clips.a.length);
  const state = await ev("window.__clipViewer.viewer.get_state()");
  assert.equal(state.recordings.length, 1);
  assert.match(state.viewer_version, /^0\.41\.0/);
  const schema = await ev(
    "window.__clipViewer.viewer.get_recording_schema({max_entities:100})",
  );
  const entities = schema.entities.map((e) => e.entity_path);
  assert.ok(entities.includes("/rgb"), entities.join());
  assert.deepEqual(
    entities.filter(
      (e) =>
        !["/", "/__properties"].includes(e) &&
        !/^\/(rgb|model_relative_3d|notes)(?:\/|$)/.test(e),
    ),
    [],
  );
  // Issue one seek and let the decoder finish while observing its output.
  const tl = state.recordings[0].timelines.find((t) => t.name === "clip_time");
  assert.ok(tl?.time_range, "clip_time timeline");
  await ev(
    `window.__clipViewer.viewer.set_time({timeline:"clip_time",duration_nanos:BigInt(${JSON.stringify(String(tl.time_range.end))}),play_state:"paused"})`,
  );
  await until(
    async () => (await ev("window.__decoder")).decoded.length > 0,
    "webcodecs decode",
  );
  const dec = await ev("window.__decoder");
  assert.deepEqual(dec.errors, []);
  assert.ok(dec.configs.every((c) => String(c.codec).startsWith("avc1.")));

  // Sequential load of a second clip: previous recording is closed.
  const servedBefore = stats.served;
  await ev("void (window.__firstViewer = window.__clipViewer.viewer)");
  await click("clip 2");
  // The mounted wrapper must reload when its clip identity changes.
  // With distinct SA38_RRD_DIR clips the store id differs too.
  await until(async () => {
    const second = await detail();
    return (
      stats.served > servedBefore &&
      second.phase === "ready" &&
      (clips.a === clips.b || second.storeId !== first.storeId)
    );
  }, "second clip");
  assert.equal(
    (await ev("window.__clipViewer.viewer.get_state()")).recordings.length,
    1,
  );

  assert.equal(
    await ev("window.__clipViewer.viewer === window.__firstViewer"),
    true,
  );
  await ev("delete window.__firstViewer");

  const resources = await ev(
    `performance.getEntriesByType('resource').map(e=>({o:new URL(e.name).origin,p:new URL(e.name).pathname,t:e.transferSize}))`,
  );
  const hosts = new Set(resources.map((r) => r.o));
  assert.deepEqual(
    [...hosts].filter((h) => h !== appOrigin && h !== storageOrigin),
    [],
    "no external hosts",
  );
  assert.ok(resources.some((r) => r.p === "/rerun/0.41.0/re_viewer_bg.wasm"));
  const heap = await ev(
    "({used:performance.memory?.usedJSHeapSize,total:performance.memory?.totalJSHeapSize})",
  );
  mkdirSync(new URL("../../artifacts/sa38/", web), { recursive: true });
  writeFileSync(
    new URL(`../../artifacts/sa38/qualification-${Date.now()}.json`, web),
    JSON.stringify(
      {
        startupToReadyMs: startupMs,
        rrdBytes: clips.a.length,
        transferred: resources.map((r) => ({
          path: r.o === appOrigin ? r.p : "signed RRD",
          bytes: r.t,
        })),
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
  assert.equal(await issued(), 2);
});

test("an expired URL is recovered with one fresh issuance; persistent expiry is an error that Try again clears", async () => {
  const before = await issued();
  control.expireNext = 1;
  await click("clip 1");
  await until(settled, "recovered");
  assert.equal(await phase(), "ready", JSON.stringify(await detail()));
  assert.equal((await issued()) - before, 2, "fresh URL issued after expiry");

  control.expireNext = 2;
  await click("clip 2");
  await until(async () => (await phase()) === "error", "persistent expiry");
  assert.equal((await detail()).code, "expired");
  assert.equal(await ev("window.__clipViewer.viewer === null"), true);
  assert.equal(await canvasCount(), 0);
  assert.match(
    await ev(`document.querySelector('[role=alert]').textContent`),
    /expired/,
  );
  await click("Try again");
  await until(async () => (await phase()) === "ready", "retry after expiry");
});

test("unmounting stops the viewer and removes its canvas", async () => {
  assert.ok((await canvasCount()) > 0);
  await click("unmount");
  await until(async () => (await phase()) === "stopped", "stopped");
  assert.equal(await canvasCount(), 0);
  assert.equal(await ev("String(window.__clipViewer)"), "null");
  await click("mount");
  await until(async () => (await phase()) === "ready", "remount");
});

test("switching while a signed download is pending cancels it and clears the old recording", async () => {
  const { waiting, cancelled, served } = stats;
  control.holdNext = true;
  await click("clip 1");
  await until(() => stats.waiting === waiting + 1, "pending signed download");
  assert.equal(await phase(), "loading");
  assert.equal(
    (await ev("window.__clipViewer.viewer.get_state()")).recordings.length,
    0,
  );
  assert.equal(
    await ev(
      "getComputedStyle(document.querySelector('[data-testid=clip-viewer-host]')).visibility",
    ),
    "hidden",
  );

  await click("clip 2");
  await until(
    async () =>
      stats.cancelled === cancelled + 1 && (await phase()) === "ready",
    "superseded download cancelled",
  );
  assert.equal(stats.served, served + 1);
});

test("an unauthorized clip switch tears down the old recording, and revocation denies renewal", async () => {
  const served = stats.served;
  await click("clip 3");
  await until(async () => (await phase()) === "error", "ungranted clip denied");
  assert.equal(stats.served, served);
  assert.equal(await ev("window.__clipViewer.viewer === null"), true);
  assert.equal(await canvasCount(), 0);

  await click("clip 1");
  await until(async () => (await phase()) === "ready", "granted clip");
  control.holdNext = true;
  await click("clip 2");
  await until(() => expireHeld, "signed download holding before revocation");
  await revokeSharingPermission(owner, {
    permissionRef: "local-seed-share-1",
    revokedBy: "e2e-operator",
    reason: "viewer test revocation",
  });
  expireHeld();
  await until(
    async () => (await phase()) === "error",
    "renewal denied after revocation",
  );
  assert.equal((await detail()).code, "unavailable");
  assert.equal((await detail()).message, "Clip link was not issued.");
  assert.equal(stats.served, served + 1);
  assert.equal(await canvasCount(), 0);

  await openAs("staff", directPath);
  await until(settled, "staff direct read");
  assert.equal(await phase(), "ready", JSON.stringify(await detail()));
});
