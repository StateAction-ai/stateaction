// Run the ENTIRE driver under agent-resource. Uses real Next/Better Auth,
// restricted Postgres and S3 fixtures, with synthetic seeded clip evidence.
// No physical capture, inference accuracy, hosted provider or GPU qualification.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { resolveFixtures } from "../../../scripts/platform/local-fixtures.mjs";
import { browserHeaders, call, signIn, startStack } from "./harness.mjs";

assert.ok(
  resolveFixtures(),
  "Explicit bounded E2E_EXTERNAL_FIXTURES is required",
);
const serverDir = fileURLToPath(
  new URL("../../../packages/server/", import.meta.url),
);
const require = createRequire(`${serverDir}package.json`);
const { Pool } = require("pg");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { SEED } = await import(
  new URL("dist/catalog/seed.js", `file://${serverDir}`)
);
const out = fileURLToPath(
  new URL("../../../artifacts/sa37/browser/", import.meta.url),
);
mkdirSync(out, { recursive: true });
const session = `sa37-${process.pid}`;
const ab = (...args) =>
  execFileSync("agent-browser", ["--session", session, ...args], {
    encoding: "utf8",
    timeout: 60_000,
  }).trim();
const evaluate = (code) => JSON.parse(ab("eval", code));
const where = () => evaluate("location.pathname + location.search");
const text = () => evaluate("document.body.innerText");
const checks = [];
function check(name, ok) {
  checks.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  assert.ok(ok, name);
}
async function until(predicate) {
  for (let i = 0; i < 60; i++) {
    if (predicate()) return;
    await sleep(250);
  }
  throw new Error("Browser state did not settle");
}
const clickName = (name) =>
  ab("find", "role", "button", "click", "--name", name, "--exact");
const open = async (stack, path) => {
  ab("open", stack.origin + path);
  await until(
    () =>
      /browser-heading/.test(
        evaluate("document.querySelector('main')?.innerHTML ?? ''"),
      ) && !/Loading (datasets|clips)/.test(text()),
  );
};
async function login(stack, role) {
  ab("cookies", "clear");
  ab("open", `${stack.origin}/login`);
  ab("wait", "input[name=email]");
  await sleep(1200);
  ab("fill", "input[name=email]", stack.users[role].email);
  ab("fill", "input[name=password]", stack.password);
  ab("click", "button[type=submit]");
  await until(() => !where().startsWith("/login"));
}

// A forwarding fixture observes cookie presence ONLY, never credentials,
// signed query strings or paths. Requests still reach the real S3 fixture.
const mediaRequests = [];
async function storageProxy(endpoint) {
  const proxy = createServer((incoming, response) => {
    if (incoming.method === "GET" && incoming.headers.origin) {
      mediaRequests.push({
        cookie: Boolean(incoming.headers.cookie),
        method: incoming.method,
      });
    }
    const upstream = request(
      endpoint + incoming.url,
      { method: incoming.method, headers: incoming.headers },
      (res) => {
        response.writeHead(res.statusCode, {
          ...res.headers,
          "access-control-allow-origin": "*",
        });
        res.pipe(response);
      },
    );
    upstream.on("error", () => response.destroy());
    response.on("close", () => upstream.destroy());
    incoming.pipe(upstream);
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  return {
    endpoint: `http://127.0.0.1:${proxy.address().port}`,
    stop() {
      proxy.close();
      proxy.closeAllConnections();
    },
  };
}
let stack, pool, s3;
try {
  stack = await startStack({ storage: true, storageProxy });
  pool = new Pool({ connectionString: stack.db.ownerUrl, max: 2 });
  s3 = new S3Client({
    endpoint: stack.s3.endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: stack.s3.accessKeyId,
      secretAccessKey: stack.s3.secretAccessKey,
    },
  });
  // Valid tiny JPEG with trailing padding to match the synthetic seed's
  // declared 30,000-byte thumbnails. This is UI fixture media, not inference.
  const jpeg = readFileSync(
    new URL(
      "../../../tests/fixtures/android_geometry_v3/thumbnail.jpg",
      import.meta.url,
    ),
  );
  const thumbnails = await pool.query(
    "SELECT f.object_key, f.size_bytes::text FROM clips c JOIN files f ON f.id = c.thumbnail_file_id WHERE c.recording_id = $1",
    [SEED.recordingId],
  );
  for (const row of thumbnails.rows) {
    assert.ok(jpeg.length <= Number(row.size_bytes));
    const body = Buffer.alloc(Number(row.size_bytes));
    jpeg.copy(body);
    await s3.send(
      new PutObjectCommand({
        Bucket: stack.env.S3_BUCKET,
        Key: row.object_key,
        Body: body,
        ContentType: "image/jpeg",
      }),
    );
  }
  const staffJar = await signIn(stack, "staff");

  if (!process.env.SA37_CURSOR_ONLY)
    for (const [label, width, height] of [
      ["desktop", 1280, 900],
      ["phone", 375, 760],
    ]) {
      ab("set", "viewport", String(width), String(height));
      await login(stack, "staff");
      await open(stack, "/data-browser");
      check(
        `${label}: default datasets table`,
        /Dataset[\s\S]*Clips[\s\S]*Total hours/.test(text()) &&
          /Shared pick-and-place/.test(text()) &&
          /Internal holdout/.test(text()),
      );
      check(
        `${label}: dataset list fits width`,
        evaluate("document.documentElement.scrollWidth <= innerWidth"),
      );
      ab("screenshot", `${out}datasets-${label}.png`);
      ab(
        "click",
        `a[href='/data-browser?datasetId=${SEED.datasets.shared.id}']`,
      );
      await until(
        () => /2 approved clips/.test(text()) && !/Loading clips/.test(text()),
      );
      check(
        `${label}: approved cards and parent totals`,
        /Seed clip 3 \(shared\)/.test(text()) &&
          /Seed clip 5 \(both\)/.test(text()) &&
          !/Seed clip 1 \(pending\)/.test(text()),
      );
      await until(() =>
        evaluate(
          "[...document.querySelectorAll('main img')].some(img => img.complete && img.naturalWidth > 0)",
        ),
      );
      check(`${label}: real brokered thumbnail decodes`, true);
      ab("fill", "input[name=q]", "shared");
      ab("click", "form[role=search] button[type=submit]");
      await until(
        () => where().includes("q=shared") && !/Loading clips/.test(text()),
      );
      check(
        `${label}: filter retains dataset and full totals`,
        where().includes(`datasetId=${SEED.datasets.shared.id}`) &&
          /2 approved clips/.test(text()) &&
          !/Seed clip 5 \(both\)/.test(text()),
      );
      const filtered = where();
      ab("reload");
      await until(() => /Seed clip 3 \(shared\)/.test(text()));
      check(
        `${label}: reload preserves filter input`,
        evaluate("document.querySelector('input[name=q]').value") === "shared",
      );
      ab("back");
      await until(
        () => !where().includes("q=") && /Seed clip 5 \(both\)/.test(text()),
      );
      check(
        `${label}: Back restores grid and input`,
        evaluate("document.querySelector('input[name=q]').value") === "",
      );
      ab("forward");
      await until(() => where() === filtered && !/Loading clips/.test(text()));
      check(
        `${label}: Forward restores exact query`,
        evaluate("document.querySelector('input[name=q]').value") === "shared",
      );
      ab("screenshot", `${out}clips-filtered-${label}.png`);

      await open(stack, "/data-browser?view=clips");
      check(
        `${label}: All clips includes pending and rejected`,
        /Seed clip 1 \(pending\)/.test(text()) &&
          /Not reviewed/.test(text()) &&
          /Seed clip 2 \(rejected\)/.test(text()) &&
          /Rejected/.test(text()),
      );
      ab("select", "select[name=reviewStatus]", "rejected");
      ab("click", "form[role=search] button[type=submit]");
      await until(
        () =>
          where().includes("reviewStatus=rejected") &&
          !/Loading clips/.test(text()),
      );
      check(
        `${label}: staff review filter is real`,
        /Seed clip 2 \(rejected\)/.test(text()) &&
          !/Seed clip 1 \(pending\)/.test(text()),
      );

      const recordingPath = `/pipeline/${SEED.recordingId}?status=completed`;
      const clipsPath = `/data-browser?recordingId=${SEED.recordingId}`;
      ab("open", stack.origin + recordingPath);
      const reviewLink = `a[href="${clipsPath}"]`;
      ab("wait", reviewLink);
      ab("scrollintoview", reviewLink);
      ab("click", reviewLink);
      await until(
        () => where() === clipsPath && /Seed clip 1 \(pending\)/.test(text()),
      );
      check(
        `${label}: Pipeline opens recording clips without a review filter`,
        /Seed clip 2 \(rejected\)/.test(text()),
      );
      ab("back");
      await until(() => where() === recordingPath);
      ab("forward");
      await until(
        () => where() === clipsPath && /Seed clip 1 \(pending\)/.test(text()),
      );
      check(
        `${label}: recording has fixed named Pipeline backlink`,
        evaluate(
          `Boolean(document.querySelector('main a[href="/pipeline/${SEED.recordingId}"]')?.textContent?.startsWith('Recording '))`,
        ) && !/clear recording/i.test(text()),
      );
      check(
        `${label}: clip link retains recording context`,
        evaluate(
          `[...document.querySelectorAll('main a[href^="/clips/"]')].every(a => new URL(a.href).searchParams.get('returnTo') === '/data-browser?recordingId=${SEED.recordingId}')`,
        ),
      );
      check(
        `${label}: recording grid fits width`,
        evaluate("document.documentElement.scrollWidth <= innerWidth"),
      );
      ab("screenshot", `${out}recording-${label}.png`);
    }

  // Explicit mutations through the real UI; selecting alone has no effect.
  if (process.env.SA37_CURSOR_ONLY) await login(stack, "staff");
  await open(stack, "/data-browser");
  clickName("New dataset");
  ab("fill", "dialog input[name=name]", "Browser-created dataset");
  clickName("Create dataset");
  await until(
    () => where().includes("datasetId=") && /0 approved clips/.test(text()),
  );
  const newId = new URL(stack.origin + where()).searchParams.get("datasetId");
  clickName("Add clips");
  await until(
    () =>
      evaluate(
        "document.querySelectorAll('dialog input[type=checkbox]').length",
      ) === 3,
  );
  check(
    "picker offers only approved clips",
    !/Seed clip 1 \(pending\)|Seed clip 2 \(rejected\)/.test(
      evaluate("document.querySelector('dialog').innerText"),
    ),
  );
  ab("check", "dialog li:first-child input[type=checkbox]");
  const before = JSON.parse(
    (await call(stack.origin, `/api/v1/datasets/${newId}`, { jar: staffJar }))
      .text,
  ).data;
  check("selection alone writes nothing", before.clipCount === 0);
  clickName("Add selected clips");
  await until(
    () =>
      !evaluate("Boolean(document.querySelector('dialog'))") &&
      /1 approved clips/.test(text()),
  );
  check(
    "explicit Add commits membership",
    JSON.parse(
      (await call(stack.origin, `/api/v1/datasets/${newId}`, { jar: staffJar }))
        .text,
    ).data.clipCount === 1,
  );

  // Real cursor navigation, including a filtered result larger than one page.
  for (let i = 0; i < 24; i++) {
    const result = await call(stack.origin, "/api/v1/datasets", {
      method: "POST",
      jar: staffJar,
      headers: browserHeaders(stack.origin),
      body: JSON.stringify({
        datasetId: crypto.randomUUID(),
        name: `Browser page ${String(i).padStart(2, "0")}`,
      }),
    });
    assert.equal(result.status, 201);
  }
  await open(stack, "/data-browser?q=Browser");
  check(
    "first filtered dataset page is bounded",
    evaluate("document.querySelectorAll('tbody tr').length") === 24,
  );
  console.log(
    "Next link before click",
    evaluate("document.querySelector('a[href*=cursor]')?.getAttribute('href')"),
  );
  ab("scrollintoview", 'a[href*="cursor="]');
  ab("click", 'a[href*="cursor="]');
  console.log("Next location after click", where());
  await until(
    () => where().includes("cursor=") && !/Loading datasets/.test(text()),
  );
  check(
    "Next page keeps search and has remaining dataset",
    where().includes("q=Browser") &&
      evaluate("document.querySelectorAll('tbody tr').length") === 1,
  );
  ab("back");
  await until(
    () => !where().includes("cursor=") && !/Loading datasets/.test(text()),
  );
  check(
    "Back restores first cursor page",
    evaluate("document.querySelectorAll('tbody tr').length") === 24,
  );
  // A real browser offline transition fails only the explicit mutation;
  // restoring connectivity and pressing Create retries the same dataset id.
  clickName("New dataset");
  ab("fill", "dialog input[name=name]", "Network retry dataset");
  ab("set", "offline", "on");
  clickName("Create dataset");
  await until(() =>
    evaluate("Boolean(document.querySelector('dialog [role=alert]'))"),
  );
  check(
    "offline mutation presents an error without losing draft",
    evaluate("document.querySelector('dialog input[name=name]').value") ===
      "Network retry dataset",
  );
  ab("set", "offline", "off");
  clickName("Create dataset");
  await until(
    () =>
      !evaluate("Boolean(document.querySelector('dialog'))") &&
      /Network retry dataset/.test(text()),
  );
  check(
    "explicit Retry succeeds after connectivity returns",
    /0 approved clips/.test(text()),
  );

  await login(stack, "customer");
  await open(stack, "/data-browser");
  check(
    "customer sees only granted datasets",
    /Shared pick-and-place/.test(text()) &&
      !/Internal holdout|Browser-created dataset|New dataset|All clips/.test(
        text(),
      ),
  );
  await open(stack, `/data-browser?datasetId=${SEED.datasets.shared.id}`);
  check(
    "customer sees only approved safe cards",
    /Seed clip 3 \(shared\)/.test(text()) &&
      !/Add clips|Not reviewed|Rejected|jobId|object_key/.test(text()),
  );
  for (const context of [
    "view=clips",
    `recordingId=${SEED.recordingId}`,
    `datasetId=${SEED.datasets.shared.id}&datasetId=${SEED.datasets.internal.id}`,
  ]) {
    ab("open", `${stack.origin}/data-browser?${context}`);
    await until(() => /This view is unavailable/.test(text()));
    check(
      `customer malformed/staff context denied: ${context.split("=")[0]}`,
      !/Seed clip/.test(text()),
    );
  }
  check(
    "media GETs carry no session cookie",
    mediaRequests.length > 0 &&
      mediaRequests.every((r) => r.method === "GET" && !r.cookie),
  );
  ab("screenshot", `${out}customer-denied.png`);
} catch (error) {
  try {
    console.error("Browser failure context", where(), text());
    ab("screenshot", `${out}failure.png`);
  } catch {}
  throw error;
} finally {
  try {
    ab("close");
  } catch {}
  await pool?.end();
  s3?.destroy();
  await stack?.stop();
  writeFileSync(
    `${out}receipt.json`,
    JSON.stringify({ checks, mediaRequests }, null, 2),
  );
}
console.log(`${checks.length} browser checks passed`);
