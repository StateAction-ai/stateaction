// Entire driver, Next and Chrome must run inside agent-resource.
// Real auth, restricted Postgres, API writes, private S3 and Rerun rendering.
// Catalog rows are explicitly synthetic seed evidence, NOT a worker acceptance
// or physical-camera qualification. RRD bytes are the real golden Rerun file;
// seeded declared sizes/hashes are metadata fixtures, not a hash qualification.
// Headless Chrome explicitly uses software WebGL; Android runs remain GPU-host.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { externalFixtures } from "./fixtures.mjs";
import { browserHeaders, call, signIn, startStack } from "./harness.mjs";

assert.ok(
  readFileSync("/proc/self/cgroup", "utf8").includes("agent-work.slice"),
  "Guard required",
);
const ext = externalFixtures();
assert.ok(ext, "Bounded external fixtures required");
const serverDir = fileURLToPath(
  new URL("../../../packages/server/", import.meta.url),
);
const require = createRequire(serverDir + "package.json");
const { Pool } = require("pg");
const {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
} = require("@aws-sdk/client-s3");
const { SEED } = await import(
  new URL("dist/catalog/seed.js", `file://${serverDir}`)
);
const out = fileURLToPath(
  new URL("../../../artifacts/sa39/browser/", import.meta.url),
);
mkdirSync(out, { recursive: true });
const session = `sa39-${process.pid}`;
let firstBrowserCall = true;
const ab = (...args) => {
  const launch = firstBrowserCall
    ? [
        "--executable-path",
        "/usr/bin/google-chrome",
        "--args",
        "--no-sandbox,--enable-unsafe-swiftshader",
      ]
    : [];
  firstBrowserCall = false;
  return execFileSync(
    "agent-browser",
    ["--session", session, ...launch, ...args],
    { encoding: "utf8", timeout: 60000 },
  ).trim();
};
const ev = (code) => JSON.parse(ab("eval", code));
const body = () => ev("document.body.innerText");
const click = (name, role = "button") => {
  const line = ab("snapshot", "-i")
    .split("\n")
    .find((line) => line.includes(`${role} ${JSON.stringify(name)} [`));
  const ref = line?.match(/ref=(e[0-9]+)/)?.[1];
  assert.ok(ref, `Visible button ${name}`);
  ab("scrollintoview", `@${ref}`);
  ab("click", `@${ref}`);
};
const checks = [];
const check = (name, ok) => {
  checks.push({ name, ok: Boolean(ok) });
  assert.ok(ok, name);
  console.log(`PASS ${name}`);
};
async function until(predicate, name, seconds = 45) {
  const deadline = Date.now() + seconds * 1000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, name);
    await sleep(250);
  }
}
async function login(stack, role) {
  ab("cookies", "clear");
  ab("open", stack.origin + "/login");
  ab("wait", "input[name=email]");
  await sleep(800);
  ab("fill", "input[name=email]", stack.users[role].email);
  ab("fill", "input[name=password]", stack.password);
  ab("click", "button[type=submit]");
  await until(() => !ev("location.pathname").startsWith("/login"), "sign in");
}
async function openClip(stack, clipId, staff = true) {
  ab(
    "open",
    `${stack.origin}/clips/${clipId}?returnTo=${encodeURIComponent("/data-browser?view=clips&q=cup")}`,
  );
  await until(
    () =>
      /clip-heading/.test(
        ev("document.querySelector('main')?.innerHTML ?? ''"),
      ),
    "clip page",
  );
  if (staff)
    await until(
      () => ev("Boolean(document.querySelector('#task-label'))"),
      "review editor",
    );
}
const media = [];
const proxy = createServer((incoming, response) => {
  media.push({
    cookie: Boolean(incoming.headers.cookie),
    method: incoming.method,
  });
  if (incoming.method !== "GET") return response.writeHead(405).end();
  const target = new URL(ext.STORAGE_TEST_ENDPOINT);
  const upstream = request(
    {
      hostname: target.hostname,
      port: target.port,
      path: incoming.url,
      method: "GET",
      headers: incoming.headers,
    },
    (res) => {
      response.writeHead(res.statusCode, {
        ...res.headers,
        "access-control-allow-origin": "*",
      });
      res.pipe(response);
    },
  );
  upstream.setTimeout(15000, () => upstream.destroy());
  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(502);
    response.end();
  });
  incoming.on("aborted", () => upstream.destroy());
  upstream.end();
});
await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
let stack, pool, s3;
try {
  stack = await startStack({
    storage: true,
    extraEnv: {
      S3_PUBLIC_ENDPOINT: `http://127.0.0.1:${proxy.address().port}`,
    },
  });
  pool = new Pool({ connectionString: stack.db.ownerUrl, max: 2 });
  s3 = new S3Client({
    endpoint: ext.STORAGE_TEST_ENDPOINT,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: ext.STORAGE_TEST_ACCESS_KEY_ID,
      secretAccessKey: ext.STORAGE_TEST_SECRET_ACCESS_KEY,
    },
  });
  await s3.send(new CreateBucketCommand({ Bucket: stack.env.S3_BUCKET }));
  const golden = readFileSync(
    new URL("fixtures/golden-clip.rrd", import.meta.url),
  );
  const rows = await pool.query(
    "SELECT f.object_key FROM clips c JOIN files f ON f.id=c.viewer_rrd_file_id WHERE c.recording_id=$1",
    [SEED.recordingId],
  );
  for (const row of rows.rows)
    await s3.send(
      new PutObjectCommand({
        Bucket: stack.env.S3_BUCKET,
        Key: row.object_key,
        Body: golden,
        ContentType: "application/octet-stream",
      }),
    );
  const staffJar = await signIn(stack, "staff");
  const customerJar = await signIn(stack, "customer");
  const state = async (clipId) => {
    const response = await call(
      stack.origin,
      `/api/v1/clips/${clipId}/review`,
      { jar: staffJar },
    );
    assert.equal(response.status, 200);
    return JSON.parse(response.text).data;
  };
  const pending = SEED.clips.pending;
  await login(stack, "staff");
  ab("set", "viewport", "1280", "900");
  await openClip(stack, pending);
  await until(
    () =>
      ev(
        "document.querySelectorAll('[data-testid=clip-viewer-host] canvas').length",
      ) > 0 &&
      ev(
        "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Approve'&&!b.disabled)",
      ),
    "real Rerun ready",
    90,
  );
  check("real Rerun renders beside staff review", /Review clip/.test(body()));
  check(
    "synthetic missing QC remains not evaluated",
    /have not been evaluated/.test(body()) &&
      !/Automatic quality checks[\s\S]*Passed/.test(body()),
  );
  const before = await state(pending);
  ab("fill", "#task-label", "Pick up a cup");
  ab("fill", "#review-notes", "Keep this unsaved draft through reload.");
  const datasetName = "Internal holdout";
  ab("find", "label", datasetName, "check", "--exact");
  check(
    "editing and dataset selection do not write a review",
    (await state(pending)).review.revision === before.review.revision,
  );
  ab("reload");
  await until(
    () =>
      ev("document.querySelector('#review-notes')?.value") ===
      "Keep this unsaved draft through reload.",
    "draft restored",
  );
  check(
    "reload preserves label, notes and dataset choice",
    ev("document.querySelector('#task-label').value") === "Pick up a cup" &&
      ev(
        `[...document.querySelectorAll('fieldset label')].some(l=>l.textContent.includes(${JSON.stringify(datasetName)})&&l.querySelector('input[type=checkbox]')?.checked)`,
      ),
  );
  await until(
    () =>
      ev(
        "[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Approve'&&!b.disabled)",
      ),
    "preview reloaded",
    90,
  );
  ab("set", "offline", "on");
  click("Approve");
  await until(
    () =>
      /save could not be confirmed/.test(body()) && /Retry save/.test(body()),
    "uncertain save retained",
  );
  const pendingRequest = ev(
    "JSON.parse(sessionStorage.getItem(Object.keys(sessionStorage).find(k=>k.startsWith('sa:review:')))).pending",
  );
  check(
    "network failure retains one exact save request",
    Boolean(pendingRequest.reviewId) && pendingRequest.decision === "approved",
  );
  ab("set", "offline", "off");
  click("Retry save");
  await until(() => /Review saved/.test(body()), "saved after retry");
  const approved = await state(pending);
  check(
    "explicit approval saves notes and membership atomically",
    approved.review.revision === before.review.revision + 1 &&
      approved.review.decision === "approved" &&
      approved.review.taskLabel === "Pick up a cup" &&
      approved.memberships.some(
        (d) => d.datasetId === SEED.datasets.internal.id,
      ),
  );
  check(
    "customer cannot read internally approved clip",
    (await call(stack.origin, `/api/v1/clips/${pending}`, { jar: customerJar }))
      .status === 404,
  );
  const competing = await call(
    stack.origin,
    `/api/v1/clips/${pending}/review`,
    {
      method: "POST",
      jar: staffJar,
      headers: browserHeaders(stack.origin),
      body: JSON.stringify({
        reviewId: crypto.randomUUID(),
        jobId: approved.jobId,
        resultManifestSha256: approved.resultManifestSha256,
        expectedReviewRevision: approved.review.revision,
        decision: "approved",
        taskLabel: "Saved elsewhere",
        notes: "A second staff request.",
      }),
    },
  );
  assert.equal(competing.status, 201);
  ab("fill", "#task-label", "Conflict draft label");
  ab("fill", "#review-notes", "Keep these edits after a concurrent save.");
  click("Reject");
  await until(
    () => /review or dataset changed/.test(body()),
    "concurrent review conflict",
  );
  check(
    "a stale review is not overwritten",
    (await state(pending)).review.revision === approved.review.revision + 1,
  );
  click("Reload saved review");
  await until(() => /Saved review reloaded/.test(body()), "conflict refresh");
  check(
    "conflict refresh retains label and notes",
    ev("document.querySelector('#task-label').value") ===
      "Conflict draft label" &&
      ev("document.querySelector('#review-notes').value") ===
        "Keep these edits after a concurrent save.",
  );
  ab("scroll", "up", "10000");
  ab("screenshot", out + "staff-desktop.png");
  ab("set", "viewport", "375", "780");
  check(
    "review fits a phone viewport",
    ev("document.documentElement.scrollWidth<=innerWidth"),
  );
  ab("screenshot", out + "staff-phone.png", "--full");
  click("Reject");
  await until(
    async () =>
      /Review saved/.test(body()) &&
      (await state(pending)).review.decision === "rejected",
    "rejection saved",
  );
  const rejected = await state(pending);
  check(
    "explicit rejection removes every dataset assignment",
    rejected.review.decision === "rejected" &&
      rejected.memberships.length === 0 &&
      rejected.review.revision === approved.review.revision + 2,
  );
  click("Account menu for Seed Staff");
  await until(
    () => ev("Boolean(document.querySelector('[role=menuitem]'))"),
    "account menu opened",
  );
  click("Sign out", "menuitem");
  await until(() => ev("location.pathname").startsWith("/login"), "sign out");
  check(
    "sign out clears private draft storage",
    ev("!Object.keys(sessionStorage).some(k=>k.startsWith('sa:'))"),
  );
  await login(stack, "customer");
  await openClip(stack, SEED.clips.shared, false);
  await until(
    () =>
      /Approved/.test(body()) &&
      ev(
        "document.querySelectorAll('[data-testid=clip-viewer-host] canvas').length",
      ) > 0,
    "customer viewer",
    90,
  );
  check(
    "customer preview has no review, QC or staff notes",
    !/Review clip|Automatic quality checks|Keep this unsaved draft|Review notes/.test(
      body(),
    ) && !ev("Boolean(document.querySelector('#task-label'))"),
  );
  const denied = await call(
    stack.origin,
    `/api/v1/clips/${SEED.clips.shared}/review`,
    { jar: customerJar },
  );
  check("review API denies a real customer session", denied.status === 403);
  ab("screenshot", out + "customer-phone.png", "--full");
  check(
    "all storage media reads omit session cookies",
    media.length > 0 && media.every((r) => r.method === "GET" && !r.cookie),
  );
} catch (error) {
  try {
    ab("screenshot", out + "failure.png");
    writeFileSync(out + "failure-snapshot.txt", ab("snapshot", "-i"));
    console.error("Page failure", ev("location.pathname"), body());
  } catch {}
  throw error;
} finally {
  try {
    ab("set", "offline", "off");
    ab("close");
  } catch {}
  await pool?.end();
  s3?.destroy();
  await stack?.stop();
  proxy.closeAllConnections();
  await new Promise((resolve) => proxy.close(resolve));
  writeFileSync(
    out + "receipt.json",
    JSON.stringify(
      {
        qualification:
          "synthetic catalog UI test; real RRD; software WebGL; no worker acceptance, R2 or physical qualification",
        checks,
        media,
      },
      null,
      2,
    ),
  );
}
