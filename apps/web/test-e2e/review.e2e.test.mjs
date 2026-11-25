// SA-98 recording review page in a real browser against the production build,
// real Better Auth, the restricted Postgres role and real object storage.
//
// Two recipe jobs (segment, caption, hand_pose seal) are run and ACCEPTED through
// the real services by packages/server/test-auth/review-seed-cli.ts: published
// conformance documents stamped with each job, real multipart uploads, one clip
// on the first recording. The review video is replaced with a synthetic
// 24-second testsrc MP4 so Chromium can exercise playback. The SA-96 dev seed (real worker, ~2 min per
// scenario) is exercised separately by review-seeded-browser.mjs. SA-99 adds the
// Good, Issue and Next unchecked flow (G, B, N) and its persistence on the second recording.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer, request } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { findChrome, launchChrome } from "./chrome.mjs";
import {
  SESSION,
  browserHeaders,
  call,
  signIn,
  startStack,
} from "./harness.mjs";

const web = new URL("../", import.meta.url);
const serverDir = fileURLToPath(
  new URL("../../../packages/server/", import.meta.url),
);
const requireServer = createRequire(join(serverDir, "package.json"));
const { S3Client, PutObjectCommand } = requireServer("@aws-sdk/client-s3");
const { validateValue } = await import(
  new URL("../../../packages/contracts/dist/index.js", import.meta.url)
);
const video = await readFile(new URL("test-e2e/fixtures/review-24s.mp4", web));

let stack;
let chrome;
let s3;
let seeded;
let downloads;
let origin;

/** Loopback storage proxy: adds the test CORS the credential-free RRD fetch needs. */
async function storageProxy(endpoint) {
  const server = createServer((req, res) => {
    const cors = {
      "access-control-allow-origin": origin,
      "timing-allow-origin": origin,
    };
    // Browser reads are credential-free; the server's own signed reads (no Origin) pass.
    if (
      req.headers.origin &&
      (req.headers.cookie || req.headers.authorization)
    ) {
      res.writeHead(400, cors).end();
      return;
    }
    const upstream = request(
      endpoint + req.url,
      { method: req.method, headers: req.headers },
      (response) => {
        res.writeHead(response.statusCode, { ...response.headers, ...cors });
        response.pipe(res);
      },
    );
    upstream.on("error", () => res.destroy());
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    stop: () => {
      server.close();
      server.closeAllConnections();
    },
  };
}

async function ev(expression, { userGesture = false } = {}) {
  const { result, exceptionDetails } = await chrome.send("Runtime.evaluate", {
    expression: `(async()=>JSON.stringify(await(${expression})))()`,
    awaitPromise: true,
    returnByValue: true,
    userGesture,
  });
  assert.ok(
    !exceptionDetails,
    `${expression}: ${exceptionDetails?.exception?.description}`,
  );
  return result.value === undefined ? undefined : JSON.parse(result.value);
}
async function until(pred, what, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() >= end)
      assert.fail(
        `timeout: ${typeof what === "function" ? await what() : what}`,
      );
    await sleep(100);
  }
}
async function open(path, width = 1280) {
  await chrome.send("Emulation.setDeviceMetricsOverride", {
    width,
    height: 900,
    deviceScaleFactor: 1,
    mobile: width < 600,
  });
  const { errorText } = await chrome.send("Page.navigate", {
    url: origin + path,
  });
  assert.equal(errorText, undefined);
  await until(
    () =>
      ev(
        `location.pathname === ${JSON.stringify(path.split("?")[0])} && document.querySelectorAll('[data-testid=rail-card]').length > 0`,
      ),
    `${path} rendered its cards`,
  );
  // The video element mounts and loads only after hydration: every click below needs it.
  await videoReady();
}

/** Clicks until the predicate holds: the first clicks can land before React hydrates. */
async function clickUntil(clickExpr, doneExpr, what) {
  await until(async () => {
    await ev(`(() => { ${clickExpr} })()`);
    return ev(doneExpr);
  }, what);
}
const openTab = (id) =>
  clickUntil(
    `document.getElementById('tab-${id}').click()`,
    `document.getElementById('tab-${id}').getAttribute('aria-selected') === 'true'`,
    `tab ${id} selected`,
  );
const videoReady = () =>
  until(
    () =>
      ev(
        `(() => { const v = document.querySelector('[data-testid=review-video]'); return !!v && v.readyState >= 1; })()`,
      ),
    "the review video loaded",
  );
const cards = () =>
  ev(`[...document.querySelectorAll('[data-testid=rail-card]')].map(c => ({
    index: Number(c.dataset.index), active: c.dataset.active === 'true',
    selected: c.dataset.selected === 'true', failed: c.dataset.failed === 'true', text: c.innerText }))`);
const selectedIndex = async () =>
  (await cards()).find((c) => c.selected)?.index ?? null;
const apiDoc = async (jar, id) => {
  const res = await call(stack.origin, `/api/v1/recordings/${id}/annotations`, {
    jar,
  });
  assert.equal(res.status, 200, res.text);
  return JSON.parse(res.text).data;
};

async function startReviewBrowser() {
  stack = await startStack({
    storage: true,
    storageProxy,
    extraEnv: {
      PROCESSING_EXECUTION_BACKEND: "local",
      PROCESSING_CODE_REVISION: "1".repeat(40),
      PROCESSING_IMAGE_SPEC_SHA256: "2".repeat(64),
      PROCESSING_MODEL_SHA256: "3".repeat(64),
      PROCESSING_CONFIG_SHA256: "4".repeat(64),
    },
  });
  origin = stack.origin;
  s3 = new S3Client({
    endpoint: stack.s3.endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: stack.s3.accessKeyId,
      secretAccessKey: stack.s3.secretAccessKey,
    },
  });
  seeded = await seedReviewPair();
  downloads = await mkdtemp(join(tmpdir(), "review-dl-"));
  const binary = await findChrome();
  assert.ok(binary, "Chrome is required for the review browser test");
  chrome = await launchChrome(binary);
  await browserSession(await signIn(stack, "staff"));
  await chrome.send("Page.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloads,
  });
}

before(startReviewBrowser);

async function seedReviewPair() {
  const seed = spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "test-auth/review-seed-cli.ts",
    ],
    {
      cwd: serverDir,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        CATALOG_TEST_OWNER_URL: stack.db.ownerUrl,
        CATALOG_APP_URL: stack.db.appUrl,
        SEED_USERS: JSON.stringify(stack.users),
        S3_ENDPOINT: stack.s3.endpoint,
        S3_BUCKET: stack.env.S3_BUCKET,
        S3_ACCESS_KEY_ID: stack.s3.accessKeyId,
        S3_SECRET_ACCESS_KEY: stack.s3.secretAccessKey,
      },
      encoding: "utf8",
    },
  );
  assert.equal(seed.status, 0, seed.stderr);
  const pair = JSON.parse(seed.stdout);
  const put = (Key, Body, ContentType) =>
    s3.send(
      new PutObjectCommand({
        Bucket: stack.env.S3_BUCKET,
        Key,
        Body,
        ContentType,
      }),
    );
  await put(pair.withClip.mp4Key, video, "video/mp4");
  await put(pair.withoutClip.mp4Key, video, "video/mp4");
  return pair;
}

async function stopReviewBrowser() {
  try {
    await chrome?.close();
  } finally {
    s3?.destroy();
    await stack?.stop();
    if (downloads) await rm(downloads, { recursive: true, force: true });
  }
}

after(stopReviewBrowser);

test("segments render on the tiers and the rail, failures as failures", async () => {
  const jar = await signIn(stack, "staff");
  const doc = await apiDoc(jar, seeded.withClip.recordingId);
  await open(`/clips/${seeded.withClip.recordingId}`);
  const rows = doc.segments.rows;
  assert.ok(rows.length >= 3);
  assert.equal((await cards()).length, rows.length);
  const blocks = await ev(`({
    segments: document.querySelectorAll('#lSeg [data-testid=block-segment]').length,
    gaps: document.querySelectorAll('#lSeg [data-testid=block-failed-window]').length,
    failureLane: document.querySelectorAll('#lFail [data-testid^=failure-]').length,
    lanes: ['lHL', 'lHR', 'lFail'].every((id) => document.getElementById(id)),
  })`);
  assert.equal(blocks.segments, rows.filter((r) => r.status === "ok").length);
  assert.equal(
    blocks.gaps,
    rows.filter((r) => r.status === "failed_window").length,
  );
  assert.ok(blocks.failureLane >= 1, "the Failures lane shows the failures");
  assert.equal(blocks.lanes, true);
  const summary = await ev(
    `document.querySelector('[data-testid=review-summary]').innerText`,
  );
  assert.match(
    summary,
    new RegExp(`${rows.filter((r) => r.status === "ok").length} segments`),
  );
  // The video is the accepted job's recording.mp4 through the broker.
  await until(
    () =>
      ev(
        `(() => { const v = document.querySelector('[data-testid=review-video]'); return !!v && v.readyState >= 1 && Math.abs(v.duration - 24) < 0.5 })()`,
      ),
    "the review video loaded from a broker URL",
  );
});

test("caption_failed: failed captions are shown with their codes, never blank", async () => {
  const jar = await signIn(stack, "staff");
  const doc = await apiDoc(jar, seeded.withClip.recordingId);
  const failedRows = doc.captions.rows.filter((r) => r.status === "failed");
  assert.equal(failedRows.length, 2, "the seed has two failed captions");
  await open(`/clips/${seeded.withClip.recordingId}`);
  const failed = await ev(
    `[...document.querySelectorAll('[data-testid=rail-failed]')].map(e => ({ text: e.textContent.trim(), code: e.title }))`,
  );
  assert.equal(
    failed.filter((t) => t.text === "No caption is available for this segment.")
      .length,
    2,
    JSON.stringify(failed),
  );
  for (const row of failedRows)
    assert.ok(
      failed.some((t) => t.code === row.error_code),
      `${row.error_code} shown`,
    );
  assert.ok(failed.every((t) => t.text.length > 0));
  // The Failed chip keeps only failed rows; All restores them.
  await clickUntil(
    `[...document.querySelectorAll('button')].find(b => /^Failed/.test(b.innerText.trim())).click()`,
    `document.querySelectorAll('[data-testid=rail-card]').length < ${doc.segments.rows.length}`,
    "Failed filter applied",
  );
  const only = await cards();
  assert.ok(only.length > 0 && only.length < doc.segments.rows.length);
  await clickUntil(
    `[...document.querySelectorAll('button')].find(b => /^All/.test(b.innerText.trim())).click()`,
    `document.querySelectorAll('[data-testid=rail-card]').length === ${doc.segments.rows.length}`,
    "All filter applied",
  );
});

test("seeking by a tier block selects the matching card and moves the video", async () => {
  const jar = await signIn(stack, "staff");
  const doc = await apiDoc(jar, seeded.withClip.recordingId);
  await open(`/clips/${seeded.withClip.recordingId}`);
  await videoReady();
  const rows = doc.segments.rows;
  const origin0 = BigInt(rows[0].start.timestamp_ns);
  for (const index of [1, 3]) {
    await ev(
      `document.querySelector('#lSeg [aria-label="Segment ${index + 1}"]').click()`,
    );
    const expected =
      Number(BigInt(rows[index].start.timestamp_ns) - origin0) / 1e9;
    await until(async () => (await selectedIndex()) === index, `card ${index}`);
    await until(
      () =>
        ev(
          `Math.abs(document.querySelector('[data-testid=review-video]').currentTime - ${expected}) < 0.5`,
        ),
      `video seeked near ${expected}s`,
    );
  }
  // Simulate an expired grant without waiting for the broker's 60-second TTL.
  await ev(`(() => {
    window.originalVideo = document.querySelector('[data-testid=review-video]');
    const now = Date.now;
    Date.now = () => now() + 61_000;
    document.querySelector('#lSeg [aria-label="Segment 2"]').click();
    Date.now = now;
  })()`);
  await until(
    () =>
      ev(`(() => {
      const v = document.querySelector('[data-testid=review-video]');
      return v && v !== window.originalVideo && v.readyState >= 1 && !v.seeking;
    })()`),
    "expired video source was renewed at the seek target",
  );
  assert.equal(
    await ev("document.querySelectorAll('[data-testid=review-video]').length"),
    1,
  );
  const v = "document.querySelector('[data-testid=review-video]')";
  const clickPlay = `document.querySelector('button[aria-label=Play]').click()`;
  await ev(clickPlay, { userGesture: true });
  await until(() => ev("!" + v + ".paused"), "Play after a timestamp seek");
  await ev(`document.querySelector('button[aria-label=Pause]').click()`);
  await until(() => ev(v + ".paused"), "Pause after the renewed seek");

  // A rail selection seeks to the start of its segment.
  await ev(
    `document.querySelectorAll('[data-testid=rail-card]')[0].querySelector('button').click()`,
    {
      userGesture: true,
    },
  );
  await until(async () => (await selectedIndex()) === 0, "first card");
  await until(
    () => ev(v + ".paused && " + v + ".currentTime < 1"),
    "caption seeks to the beginning while paused",
  );
  assert.ok(
    await ev(`(() => {
    const bounds = (name) => document.querySelector('[data-testid=' + name + ']').getBoundingClientRect();
    return bounds('review-video').bottom <= bounds('review-caption').top &&
      bounds('review-caption').bottom <= bounds('review-controls').top;
  })()`),
  );
  // The overview window shrinks on zoom and Fit restores it.
  const width = () =>
    ev(
      `document.querySelector('[data-testid=overview-window]').getBoundingClientRect().width`,
    );
  const fit = await width();
  await ev(`document.querySelector('[aria-label="Zoom in"]').click()`);
  await until(async () => Math.abs((await width()) - fit / 2) < 1, "zoomed in");
  await ev(`document.querySelector('[aria-label="Fit"]').click()`);
  await until(async () => Math.abs((await width()) - fit) < 1, "fit again");
});

test("Download captions exports the accepted caption text and clip times", async () => {
  const jar = await signIn(stack, "staff");
  const doc = await apiDoc(jar, seeded.withClip.recordingId);
  await open(`/clips/${seeded.withClip.recordingId}`);
  await ev(`document.querySelector('[data-testid=download-json]').click()`);
  const file = await until(async () => {
    const names = (await readdir(downloads)).filter(
      (n) => !n.endsWith(".crdownload"),
    );
    return names[0];
  }, "downloaded file");
  assert.equal(file, "clip-captions.json");
  const saved = JSON.parse(await readFile(join(downloads, file), "utf8"));
  const first = doc.segments.rows.find((row) => row.status === "ok");
  const caption = doc.captions.rows.find(
    (row) => row.segment_id === first.segment_id,
  );
  assert.ok(caption?.text);
  assert.equal(
    saved.captions.length,
    doc.segments.rows.filter((row) => row.status === "ok").length,
  );
  assert.deepEqual(
    saved.captions.find((row) => row.segmentId === first.segment_id)?.caption,
    caption.text,
  );
  assert.ok(
    saved.captions.every(
      (row) => row.startSeconds >= 0 && row.endSeconds > row.startSeconds,
    ),
  );
});

test("no horizontal page scroll at 390 px on every tab", async () => {
  for (const id of [
    seeded.withClip.recordingId,
    seeded.withoutClip.recordingId,
  ]) {
    await open(`/clips/${id}`, 390);
    for (const tab of ["segs", "decision"]) {
      await openTab(tab);
      await sleep(300);
      const widths = await ev(
        `({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth })`,
      );
      assert.ok(
        widths.scroll <= widths.inner,
        `${tab}: ${JSON.stringify(widths)}`,
      );
    }
  }
});

test("a media error renews the broker URL and resumes at the same time", async () => {
  await open(`/clips/${seeded.withClip.recordingId}`, 1280);
  await clickUntil(
    `document.querySelector('#lSeg [aria-label="Segment 2"]').click()`,
    `Math.abs(document.querySelector('[data-testid=review-video]').currentTime - 3.67) < 0.5`,
    "playhead at segment 2",
  );
  // Mark the element: a renewal mounts a fresh one even when the signed URL is
  // byte-identical (same second), so an element stuck in its error state is dropped.
  await ev(
    `(() => { document.querySelector('[data-testid=review-video]').dataset.old = '1'; })()`,
  );
  // Break the element's source (as an expired signature would): storage answers 404/403.
  await ev(
    `(() => { const v = document.querySelector('[data-testid=review-video]'); v.src = ${JSON.stringify(stack.outage.endpoint + "/expired/recording.mp4")}; })()`,
  );
  await until(
    () =>
      ev(
        `(() => { const v = document.querySelector('[data-testid=review-video]'); return v.currentSrc !== ${JSON.stringify(stack.outage.endpoint + "/expired/recording.mp4")} && v.currentSrc !== '' && v.readyState >= 1 && Math.abs(v.currentTime - 3.67) < 0.5 })()`,
      ),
    async () =>
      `a fresh broker URL was fetched and playback resumed at 3.67 s: ${await ev(`(() => { const v = document.querySelector('[data-testid=review-video]'); return JSON.stringify({ src: v.currentSrc.slice(0, 60), ready: v.readyState, t: v.currentTime, err: v.error && v.error.code }); })()`)}`,
  );
  assert.equal(
    await ev(
      `document.querySelector('[data-testid=review-video]').dataset.old ?? null`,
    ),
    null,
    "a fresh <video> was mounted by the renewal",
  );
});

test("the clip video grant is scoped to the selected job", async () => {
  const jar = await signIn(stack, "staff");
  const clip = seeded.withClip;
  const readPath = "/api/v1/recordings/" + clip.recordingId + "/reads";
  const request = {
    method: "POST",
    jar,
    headers: browserHeaders(stack.origin),
    body: JSON.stringify({ role: "recording_mp4" }),
  };
  assert.equal(
    (await call(stack.origin, readPath + "?job=" + clip.jobId, request)).status,
    200,
  );
  assert.equal(
    (
      await call(
        stack.origin,
        readPath + "?job=" + seeded.withoutClip.jobId,
        request,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await call(
        stack.origin,
        readPath + "?job=" + clip.jobId + "&job=" + clip.jobId,
        request,
      )
    ).status,
    400,
  );
});

test("staff only: customer, collector and anonymous are denied", async () => {
  const { recordingId: id, clipId, jobId } = seeded.withClip;
  const apiPath = "/api/v1/recordings/" + id;
  const handPath = apiPath + "/hand-frames?job=" + jobId + "&clip=" + clipId;
  const staleJob = randomUUID();
  for (const label of ["customer", "collector"]) {
    const jar = await signIn(stack, label);
    const api = await call(
      stack.origin,
      `/api/v1/recordings/${id}/annotations`,
      { jar },
    );
    assert.equal(api.status, 403, label);
    assert.equal(
      (await call(stack.origin, handPath, { jar })).status,
      403,
      label,
    );
    const page = await call(stack.origin, `/clips/${id}`, {
      jar,
      headers: {
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
      },
    });
    if (label === "customer") assert.equal(page.status, 404);
    assert.ok(
      !page.text.includes("review-summary") &&
        !page.text.includes(seeded.withClip.jobId),
      `${label} page ${page.status} must not carry the review`,
    );
  }
  const anon = await call(stack.origin, `/api/v1/recordings/${id}/annotations`);
  assert.equal(anon.status, 401);
  assert.equal((await call(stack.origin, handPath)).status, 401);

  const staff = await signIn(stack, "staff");
  assert.equal(
    (
      await call(stack.origin, handPath.replace(jobId, staleJob), {
        jar: staff,
      })
    ).status,
    404,
  );
  const staleGrant = await call(
    stack.origin,
    apiPath + "/reads?job=" + staleJob,
    {
      method: "POST",
      jar: staff,
      headers: browserHeaders(stack.origin),
      body: JSON.stringify({ role: "recording_mp4" }),
    },
  );
  assert.equal(staleGrant.status, 404);
});

test("G, B and N mark segments, survive a reload and feed the counts; customers cannot mark", async () => {
  const rec = seeded.withoutClip;
  const press = async (key) => {
    const base = { key, code: `Key${key.toUpperCase()}`, text: key };
    await chrome.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
    await chrome.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  };
  const summary = () =>
    ev(`document.querySelector('[data-testid=mark-summary]').innerText`);
  const badge = (i) =>
    ev(
      `(() => { const b = document.querySelectorAll('[data-testid=rail-card]')[${i}]?.querySelector('[data-testid=mark-badge]'); return b ? { mark: b.dataset.mark, text: b.innerText.trim() } : null })()`,
    );
  const assertHandPoseBadge = async (i) => {
    const element = `document.querySelectorAll('[data-testid=rail-card]')[${i}].querySelector('[data-testid=mark-badge]')`;
    // Rail cards use content-visibility:auto. Scroll the badge into view before
    // reading rendered text, which Chrome omits while skipping the card.
    await ev(`${element}.scrollIntoView({ block: 'nearest' })`);
    await until(
      () => ev(`${element}.checkVisibility({ contentVisibilityAuto: true })`),
      "the caption badge is visible",
    );
    assert.equal((await badge(i))?.text, "Hand pose");
  };
  const chip = (f) =>
    ev(`document.querySelector('[data-filter=${f}]').innerText`);
  const doc = await apiDoc(await signIn(stack, "staff"), rec.recordingId);
  await open(`/clips/${rec.recordingId}`);
  const total = (await cards()).length;
  assert.equal(total, doc.segments.rows.length);
  assert.ok(total >= 3, "the seed has at least three segments");
  // Marks are append-only and this test runs on a fresh stack: nothing is marked yet.
  await until(
    () =>
      ev(
        `document.querySelector('[data-marks-loaded]')?.dataset.marksLoaded === 'true'`,
      ),
    "the marks listing loaded",
  );
  assert.equal(await summary(), "0 checked, 0 issue");
  assert.equal(await chip("unchecked"), `Unreviewed ${total}`);
  // G marks the selected segment Good.
  await clickUntil(
    `document.querySelectorAll('[data-testid=rail-card]')[0].querySelector('button').click()`,
    `document.querySelectorAll('[data-testid=rail-card]')[0].dataset.selected === 'true'`,
    "card 0 selected",
  );
  await press("g");
  await until(async () => (await badge(0))?.mark === "good", "card 0 is Good");
  assert.equal(await summary(), "1 checked, 0 issue");
  // N moves to the next unchecked segment, B marks it Issue (boundary by default).
  await press("n");
  await until(async () => (await selectedIndex()) === 1, "N selected card 1");
  await press("b");
  await until(async () => (await badge(1))?.mark === "issue", "card 1 Issue");
  assert.deepEqual(await badge(1), { mark: "issue", text: "Boundary" });
  assert.equal(await summary(), "2 checked, 1 issue");
  // The issue-type picker appends a new revision with the chosen type.
  // Keys keep working after a real click focused a mark button (no stopPropagation).
  await ev(
    `(() => { const b = document.querySelector('[data-issue-type=hand_pose]'); b.focus(); b.click(); })()`,
  );
  await until(
    async () => (await badge(1))?.text === "Hand pose",
    "issue type is Hand pose",
  );
  assert.equal(await summary(), "2 checked, 1 issue");
  // N skips the checked segments: the next unchecked one is card 2.
  await press("n");
  await until(async () => (await selectedIndex()) === 2, "N selected card 2");
  assert.equal(await chip("issue"), "Flagged 1");
  assert.equal(await chip("unchecked"), `Unreviewed ${total - 2}`);
  // The server holds the newest revision per segment, pinned to the accepted result.
  const jar = await signIn(stack, "staff");
  const listed = await call(
    stack.origin,
    `/api/v1/recordings/${rec.recordingId}/segment-marks`,
    { jar },
  );
  assert.equal(listed.status, 200, listed.text);
  const data = JSON.parse(listed.text).data;
  assert.equal(validateValue("http.segment-marks.v1", data).valid, true);
  assert.equal(data.jobId, rec.jobId);
  assert.deepEqual(
    [data.segmentCount, data.checkedCount, data.issueCount],
    // segmentCount counts the accepted segments; the rail also lists failed windows.
    [doc.segments.rows.filter((r) => r.status === "ok").length, 2, 1],
  );
  assert.deepEqual(
    data.marks.map((m) => [m.verdict, m.issueType, m.revision]).sort(),
    [
      ["good", null, 1],
      ["issue", "hand_pose", 2],
    ].sort(),
  );
  // A reload shows the same marks and the Issue and Unchecked chips filter by them.
  await open(`/clips/${rec.recordingId}`);
  await until(
    () =>
      ev(
        `document.querySelector('[data-marks-loaded]')?.dataset.marksLoaded === 'true'`,
      ),
    "the marks listing reloaded",
  );
  await until(async () => (await summary()) === "2 checked, 1 issue", "reload");
  assert.equal((await badge(0))?.mark, "good");
  await assertHandPoseBadge(1);
  assert.equal((await badge(2))?.mark, "none");
  await clickUntil(
    `document.querySelector('[data-filter=issue]').click()`,
    `document.querySelectorAll('[data-testid=rail-card]').length === 1`,
    "Issue chip applied",
  );
  await assertHandPoseBadge(0);
  await clickUntil(
    `document.querySelector('[data-filter=unchecked]').click()`,
    `document.querySelectorAll('[data-testid=rail-card]').length === ${total - 2}`,
    "Unchecked chip applied",
  );
  // Customers and collectors can neither read nor append marks.
  const first = data.marks[0].segmentId;
  for (const label of ["customer", "collector"]) {
    const other = await signIn(stack, label);
    const read = await call(
      stack.origin,
      `/api/v1/recordings/${rec.recordingId}/segment-marks`,
      { jar: other },
    );
    assert.equal(read.status, 403, label);
    const write = await call(
      stack.origin,
      `/api/v1/recordings/${rec.recordingId}/segments/${first}/marks`,
      {
        method: "POST",
        jar: other,
        headers: browserHeaders(stack.origin),
        body: JSON.stringify({
          markId: randomUUID(),
          jobId: rec.jobId,
          segmentsSha256: data.segmentsSha256,
          expectedRevision: 2,
          verdict: "good",
        }),
      },
    );
    assert.equal(write.status, 403, label);
  }
});

test("a review clip saves its own decision and dataset assignment under the selection revision", async () => {
  const staff = await signIn(stack, "staff");
  const customer = await signIn(stack, "customer");
  const { recordingId, jobId, clipId: viewerChunkId } = seeded.withClip;
  const reviewPage = "/clips/" + recordingId;
  const recordingBase = "/api/v1/recordings/" + recordingId;
  const decisionBase = "/api/v1/review-clips/" + recordingId + "/decision";
  const get = (path, jar = staff) => call(origin, path, { jar });
  const post = (path, body) =>
    call(origin, path, {
      method: "POST",
      jar: staff,
      headers: browserHeaders(origin),
      body: JSON.stringify(body),
    });
  const data = async (path) => {
    const res = await get(path);
    assert.equal(res.status, 200, res.text);
    return JSON.parse(res.text).data;
  };
  const { selectionSeq } = await data(recordingBase + "/runs");
  const oldDecision = decisionBase + "?selection=" + selectionSeq;
  const initial = await data(oldDecision);
  assert.equal(initial.clipId, recordingId);
  assert.equal(initial.jobId, jobId);
  assert.equal(initial.review.decision, null);
  assert.ok(viewerChunkId);
  assert.equal((await get(oldDecision, customer)).status, 403);

  const datasetId = randomUUID();
  const datasetPath = "/api/v1/datasets/" + datasetId;
  const datasetName = "Clip review regression";
  const created = await post("/api/v1/datasets", {
    datasetId,
    name: datasetName,
  });
  assert.equal(created.status, 201, created.text);

  const reselect = await post(recordingBase + "/result-selection", {
    jobId,
    expectedSelectionSeq: selectionSeq,
    reason: "Verify that an earlier open review cannot write after reselection",
  });
  assert.equal(reselect.status, 201, reselect.text);
  const decisionPath = decisionBase + "?selection=" + (selectionSeq + 1);
  const command = {
    reviewId: randomUUID(),
    expectedReviewRevision: initial.review.revision,
    jobId,
    resultManifestSha256: initial.resultManifestSha256,
    decision: "approved",
    taskLabel: "Verify task",
    datasetSelection: {
      datasetIds: [datasetId],
      expectedRevisions: { [datasetId]: 1 },
    },
  };
  const stale = await post(oldDecision, command);
  assert.equal(stale.status, 409, stale.text);
  assert.equal((await get(oldDecision)).status, 409);
  assert.equal((await data(datasetPath)).revision, 1);
  const staleVideo = await post(
    recordingBase +
      "/reads?" +
      new URLSearchParams({
        job: jobId,
        clip: recordingId,
        revision: String(selectionSeq),
      }),
    { role: "recording_mp4" },
  );
  assert.equal(staleVideo.status, 404);
  const wrongClip = await post(
    "/api/v1/review-clips/" +
      viewerChunkId +
      "/decision?selection=" +
      (selectionSeq + 1),
    command,
  );
  assert.equal(wrongClip.status, 409, wrongClip.text);
  assert.deepEqual((await data(decisionPath)).memberships, []);

  const saved = await post(decisionPath, command);
  assert.equal(saved.status, 201, saved.text);

  const approved = await data(decisionPath);
  assert.equal(approved.review.decision, "approved");
  assert.equal(approved.review.taskLabel, "Verify task");
  assert.deepEqual(
    approved.memberships.map((member) => member.datasetId),
    [datasetId],
  );
  assert.equal((await data(datasetPath)).clipCount, 1);
  assert.equal((await data(datasetPath)).revision, 2);
  const datasetPage = await get("/data-browser?datasetId=" + datasetId);
  assert.equal(datasetPage.status, 200);
  assert.ok(datasetPage.text.includes(reviewPage));
  assert.equal((await get(datasetPath, customer)).status, 404);

  const revised = {
    ...command,
    reviewId: randomUUID(),
    expectedReviewRevision: approved.review.revision,
    taskLabel: "Verified task",
    datasetSelection: {
      datasetIds: [datasetId],
      expectedRevisions: { [datasetId]: 2 },
    },
  };
  assert.equal((await post(decisionPath, revised)).status, 201);
  assert.equal((await post(decisionPath, revised)).status, 200);
  assert.equal(
    (await post(decisionPath, { ...revised, notes: "Different payload" }))
      .status,
    409,
  );
  assert.equal((await data(datasetPath)).revision, 2);

  const { Pool } = requireServer("pg");
  const {
    clearReviewClips,
    recordSharingPermission,
    grantDatasetAccess,
    disableDatasetAccess,
  } = await import(
    new URL(
      "../../../packages/server/dist/datasets/operator.js",
      import.meta.url,
    )
  );
  const owner = new Pool({ connectionString: stack.db.ownerUrl, max: 1 });
  try {
    const permissionRef = "review-clip-" + randomUUID();
    const addPermission = (id, ref) =>
      recordSharingPermission(owner, {
        permissionRef: ref,
        datasetId: id,
        recipientUserId: stack.users.customer.id,
        evidenceRef: "local test fixture",
        recordedBy: stack.users.staff.id,
      });
    const grant = (ref) =>
      grantDatasetAccess(owner, {
        permissionRef: ref,
        actorUserId: stack.users.staff.id,
      });
    await addPermission(datasetId, permissionRef);
    assert.deepEqual(
      await clearReviewClips(owner, {
        permissionRef,
        allCurrentMembers: true,
        clearedBy: stack.users.staff.id,
      }),
      { cleared: 1 },
    );
    await grant(permissionRef);
    assert.equal((await get(datasetPath, customer)).status, 200);
    await disableDatasetAccess(owner, {
      datasetId,
      userId: stack.users.customer.id,
      actorUserId: stack.users.staff.id,
    });

    const sharedId = randomUUID();
    assert.equal(
      (
        await post("/api/v1/datasets", {
          datasetId: sharedId,
          name: "Shared fixture dataset",
        })
      ).status,
      201,
    );
    const sharedRef = "review-clip-" + randomUUID();
    await addPermission(sharedId, sharedRef);
    await grant(sharedRef);
    const addShared = await post(decisionPath, {
      ...revised,
      reviewId: randomUUID(),
      expectedReviewRevision: approved.review.revision + 1,
      datasetSelection: {
        datasetIds: [datasetId, sharedId],
        expectedRevisions: { [datasetId]: 2, [sharedId]: 1 },
      },
    });
    assert.equal(addShared.status, 403, addShared.text);

    const laterSelection = selectionSeq + 2;
    assert.equal(
      (
        await post(recordingBase + "/result-selection", {
          jobId,
          expectedSelectionSeq: laterSelection - 1,
          reason:
            "Reselect the same result without carrying its prior decision",
        })
      ).status,
      201,
    );
    const laterDecision = decisionBase + "?selection=" + laterSelection;
    const later = await data(laterDecision);
    assert.equal(later.review.decision, null);
    assert.deepEqual(later.memberships, []);
    assert.equal((await data(datasetPath)).clipCount, 0);
    assert.equal((await data(datasetPath)).revision, 2);
    assert.equal((await post(decisionPath, revised)).status, 200);
    assert.equal((await data(datasetPath)).clipCount, 0);
    assert.equal(
      (
        await post(laterDecision, {
          ...revised,
          reviewId: randomUUID(),
          expectedReviewRevision: later.review.revision,
        })
      ).status,
      201,
    );
    assert.equal((await data(datasetPath)).clipCount, 1);

    const reject = {
      reviewId: randomUUID(),
      expectedReviewRevision: later.review.revision + 1,
      jobId,
      resultManifestSha256: initial.resultManifestSha256,
      decision: "rejected",
    };
    assert.equal((await post(laterDecision, reject)).status, 201);
    const rejected = await data(laterDecision);
    assert.equal(rejected.review.decision, "rejected");
    assert.deepEqual(rejected.memberships, []);
    assert.equal((await data(datasetPath)).clipCount, 0);
    assert.equal((await data(datasetPath)).revision, 4);

    await owner.query(
      "UPDATE recordings SET deleted_at = now() WHERE id = $1",
      [recordingId],
    );
    assert.equal((await post(laterDecision, reject)).status, 200);
    assert.equal(
      (await post(laterDecision, { ...reject, reviewId: randomUUID() })).status,
      409,
    );
  } finally {
    await owner.end();
  }
});

const recyclePath = "/data-browser?datasetId=recycle-bin";

function namedButton(name, scope = "main") {
  return `[...document.querySelectorAll(${JSON.stringify(scope + " button")})].find(b => b.textContent.trim() === ${JSON.stringify(name)} && b.checkVisibility() && !b.disabled)`;
}

async function clickButton(name, scope) {
  const button = namedButton(name, scope);
  await until(() => ev(`!!(${button})`), name);
  await ev(`(${button}).click()`);
}

async function fill(selector, value) {
  await until(
    () => ev(`!!document.querySelector(${JSON.stringify(selector)})`),
    selector,
  );
  await ev(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    input.scrollIntoView({ block: 'center' });
    input.focus();
    input.select();
  })()`);
  await chrome.send("Input.insertText", { text: value });
}

async function enter(modifiers = 0) {
  const key = {
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    modifiers,
  };
  await chrome.send("Input.dispatchKeyEvent", { ...key, type: "keyDown" });
  await chrome.send("Input.dispatchKeyEvent", { ...key, type: "keyUp" });
}

async function go(path, ready) {
  await ev("window.__previousTestDocument = true");
  const { errorText } = await chrome.send("Page.navigate", {
    url: origin + path,
  });
  assert.equal(errorText, undefined);
  await until(
    () =>
      ev(
        `!window.__previousTestDocument && location.pathname + location.search === ${JSON.stringify(path)} && (${ready})`,
      ),
    path,
  );
}

async function browserSession(jar) {
  const { success } = await chrome.send("Network.setCookie", {
    name: SESSION,
    value: jar.cookies.get(SESSION),
    url: origin,
    httpOnly: true,
  });
  assert.ok(success);
}

const navigationHeaders = {
  "sec-fetch-site": "same-origin",
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
};

const clipLinks = `[...new Set([...document.querySelectorAll('article a[href^="/clips/"]')].map(a => new URL(a.href).pathname))]`;
const catalogReady = '!!document.getElementById("browser-heading")';

test("SA-150 pending review, caption correction and customer isolation at 1280 and 390 CSS pixels", async () => {
  // The compatibility tests mutate the preceding stack's approvals and selections.
  await stopReviewBrowser();
  await startReviewBrowser();
  const staff = await signIn(stack, "staff");
  const customer = await signIn(stack, "customer");
  const get = (path, jar = staff) => call(origin, path, { jar });
  const post = (path, data) =>
    call(origin, path, {
      method: "POST",
      headers: browserHeaders(origin),
      jar: staff,
      body: JSON.stringify(data),
    });
  const read = async (path, jar) => {
    const res = await get(path, jar);
    assert.equal(res.status, 200, path);
    return JSON.parse(res.text).data;
  };
  const datasets = [
    { datasetId: randomUUID(), name: "Browser training" },
    { datasetId: randomUUID(), name: "Browser validation" },
  ];
  for (const dataset of datasets) {
    assert.equal((await post("/api/v1/datasets", dataset)).status, 201);
  }
  const reviewClips = [seeded.withClip, seeded.withoutClip];
  const pendingPath =
    "/data-browser?" +
    new URLSearchParams([
      ["datasetId", "pending-review"],
      ...reviewClips.map(({ recordingId }) => ["recording", recordingId]),
    ]);
  const shared = datasets[0];
  const datasetPath = "/data-browser?datasetId=" + shared.datasetId;
  const privateNote = "SA150 staff notebook syrup lantern";
  const rejectionReason = "SA150 rejected by browser test";
  const correction = "Tightens the cobalt wingnut by hand.";
  const selectionByClip = new Map(
    await Promise.all(
      reviewClips.map(async ({ recordingId }) => {
        const { selectionSeq } = await read(
          "/api/v1/recordings/" + recordingId + "/runs",
        );
        assert.ok(selectionSeq > 0);
        return [recordingId, selectionSeq];
      }),
    ),
  );
  const decisionPath = (clipId) =>
    "/api/v2/review-clips/" +
    clipId +
    "/decision?selection=" +
    selectionByClip.get(clipId);
  const state = (clipId) => read(decisionPath(clipId));
  async function membership(clipId, expected) {
    const row = await state(clipId);
    assert.deepEqual(
      row.memberships.map(({ datasetId }) => datasetId).sort(),
      expected.map(({ datasetId }) => datasetId).sort(),
    );
    return row;
  }
  async function chooseDatasets() {
    for (const dataset of datasets) {
      await fill('#pane-decision input[role="combobox"]', dataset.name);
      await until(
        () =>
          ev(
            `[...document.querySelectorAll('[role=option]')].some(option => option.textContent.includes(${JSON.stringify(dataset.name)}))`,
          ),
        dataset.name,
      );
      await enter();
      await until(
        () =>
          ev(
            `document.querySelector('[aria-label="Selected datasets"]')?.textContent.includes(${JSON.stringify(dataset.name)})`,
          ),
        dataset.name + " selected",
      );
    }
    await fill("#pane-decision input[list]", "Tighten fixture");
    await fill("#pane-decision textarea", privateNote);
    await clickButton("Save", "#pane-decision");
  }
  async function reject(reason) {
    await clickButton("Reject", "#pane-decision");
    await until(
      () =>
        ev(
          `document.querySelector('#pane-decision textarea[required]')?.checkVisibility()`,
        ),
      "reject form",
    );
    assert.equal(
      await ev(`!!(${namedButton("Reject clip", "#pane-decision")})`),
      false,
    );
    await fill("#pane-decision textarea[required]", reason);
    await clickButton("Reject clip", "#pane-decision");
  }
  let clipId;
  let clipUrl;
  for (const width of [1280, 390]) {
    await chrome.send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: width < 600,
    });
    await go(pendingPath, catalogReady);
    const next = `[...document.querySelectorAll("main a")].find(a => a.textContent.trim() === "Review next")`;
    await until(() => ev(`!!(${next})`), "Review next");
    clipUrl = await ev(`(${next}).getAttribute("href")`);
    clipId = new URL(clipUrl, origin).pathname.split("/").at(-1);
    assert.ok(reviewClips.some(({ recordingId }) => recordingId === clipId));
    await ev(`(${next}).click()`);
    await until(
      () =>
        ev(
          `location.pathname === "/clips/${clipId}" && !!document.querySelector('[data-testid=review-summary]')`,
        ),
      "canonical clip from Review next",
    );
    await openTab("decision");
    const start = await membership(clipId, []);
    await chooseDatasets();
    await until(
      async () => (await state(clipId)).review.revision > start.review.revision,
      "add persisted",
    );
    assert.equal(
      (await membership(clipId, datasets)).review.taskLabel,
      "Tighten fixture",
    );
    await until(
      () =>
        ev(
          `location.pathname.startsWith("/clips/") && location.pathname !== "/clips/${clipId}"`,
        ),
      "advance to another pending clip",
    );
    await openTab("decision");
    await clickButton("Undo", "#pane-decision");
    await until(
      () => ev(`location.pathname === "/clips/${clipId}"`),
      "undo returns to the reviewed clip",
    );
    await until(
      async () => (await state(clipId)).memberships.length === 0,
      "undo removed both memberships",
    );
    await openTab("decision");
    await chooseDatasets();
    await until(
      async () => (await state(clipId)).memberships.length === 2,
      "both memberships were saved again",
    );

    const clipPath = "/clips/" + clipId;
    await go(
      clipPath + "?panel=review",
      '!!document.querySelector("#pane-decision input[list]")',
    );
    await reject(rejectionReason);
    await until(
      async () => (await state(clipId)).review.decision === "rejected",
      "rejection persisted",
    );
    await membership(clipId, []);
    await clickButton("Undo", "#pane-decision");
    await until(
      async () => (await state(clipId)).memberships.length === 2,
      "undo restores both memberships",
    );
    // Reload the restored decision so the next command uses its persisted revision.
    await go(
      clipPath + "?panel=review",
      '!!document.querySelector("#pane-decision input[list]")',
    );
    await openTab("decision");
    await reject(rejectionReason);
    await until(
      async () => (await state(clipId)).review.decision === "rejected",
      "second rejection persisted",
    );
    await go(recyclePath, catalogReady);
    assert.ok((await ev(clipLinks)).includes(clipPath));
    assert.match(
      await ev("document.querySelector('main').innerText"),
      /SA150 rejected by browser test/,
    );
    const recycleClip = `document.querySelector('article a[href^="${clipPath}?"]')`;
    assert.ok(await ev(`!!${recycleClip}`));
    await ev(recycleClip + ".click()");
    await until(
      () =>
        ev(
          `location.pathname === "${clipPath}" && !!document.getElementById("tab-decision")`,
        ),
      "rejected clip",
    );
    await openTab("decision");
    await clickButton("Restore", "#pane-decision");
    await until(
      async () => (await state(clipId)).review.decision === "reopened",
      "restored to pending",
    );
    await membership(clipId, []);
    await go(pendingPath, catalogReady);
    assert.ok((await ev(clipLinks)).includes(clipPath));
    assert.equal(await ev("innerWidth"), width);
    assert.ok(await ev("document.documentElement.scrollWidth <= innerWidth"));
  }
  await go(clipUrl, '!!document.getElementById("tab-decision")');
  await openTab("decision");
  await chooseDatasets();
  await until(
    async () => (await state(clipId)).memberships.length === 2,
    "membership for customer sharing",
  );

  const clipPath = "/clips/" + clipId;
  const binding = await membership(clipId, datasets);
  assert.equal(binding.review.notes, privateNote);
  const doc = await apiDoc(staff, clipId);
  const original = doc.captions.rows.find((row) => row.status === "complete");
  assert.ok(original?.text);
  await go(
    clipPath + "?segment=" + original.segment_id,
    '!!document.getElementById("tab-segs")',
  );
  await clickButton("Incorrect");
  await fill("[data-testid=rail-card] textarea", correction);
  await enter(2);
  await until(
    () =>
      ev(
        `document.querySelector('[data-testid=rail-card][data-selected=true]')?.textContent.includes(${JSON.stringify(correction)}) && document.body.innerText.includes("Caption saved")`,
      ),
    "caption save from Ctrl+Enter",
  );

  const captionPath =
    `/api/v2/review-clips/${clipId}/segments/${original.segment_id}/caption?` +
    new URLSearchParams({
      job: binding.jobId,
      manifest: binding.resultManifestSha256,
      selection: String(binding.selectionRevision),
    });
  const [update] = await read(captionPath);
  assert.equal(update.text, correction);
  assert.equal(update.reviewerName, "Seed Staff");
  assert.equal(
    (await apiDoc(staff, clipId)).captions.rows.find(
      (row) => row.segment_id === original.segment_id,
    ).text,
    original.text,
  );
  const { Pool } = requireServer("pg");
  const { clearReviewClips, recordSharingPermission, grantDatasetAccess } =
    await import(
      new URL(
        "../../../packages/server/dist/datasets/operator.js",
        import.meta.url,
      )
    );
  const owner = new Pool({ connectionString: stack.db.ownerUrl, max: 1 });
  try {
    const permissionRef = "sa150-browser-" + randomUUID();
    await recordSharingPermission(owner, {
      permissionRef,
      datasetId: shared.datasetId,
      recipientUserId: stack.users.customer.id,
      evidenceRef: "local browser fixture",
      recordedBy: stack.users.staff.id,
    });
    assert.deepEqual(
      await clearReviewClips(owner, {
        permissionRef,
        allCurrentMembers: true,
        clearedBy: stack.users.staff.id,
      }),
      { cleared: 1 },
    );
    await grantDatasetAccess(owner, {
      permissionRef,
      actorUserId: stack.users.staff.id,
    });
  } finally {
    await owner.end();
  }
  const sharedClip = clipPath + "?datasetId=" + shared.datasetId;
  const privateValues = [
    original.text,
    privateNote,
    rejectionReason,
    binding.jobId,
    binding.resultManifestSha256,
    stack.users.staff.id,
    "Seed Staff",
  ];
  function assertNoStaffData(res, path) {
    for (const value of privateValues)
      assert.ok(
        !res.text.includes(value),
        path + " leaked private fixture data",
      );
    assert.doesNotMatch(
      res.text,
      /expectedReviewRevision|reviewerUserId|resultManifestSha256|Original model caption|Show original \/ history|stub_captioner@1|Total estimated cost|Retry (?:clip planning|failed clips|captions|hand pose|segmentation|from here)|Runs \(\d+\)/,
      path + " leaked staff-only fields or controls",
    );
  }
  const assertCustomerPayload = (
    res,
    { expected = correction, search = false } = {},
  ) => {
    assert.equal(res.status, 200);
    if (search) {
      const result = res.text.match(/<article[\s\S]+?<\/article>/)?.[0];
      assert.ok(
        result?.includes("cobalt") && result.includes("wingnut"),
        "corrected caption appears in the result card",
      );
    } else assert.ok(res.text.includes(expected));
    assertNoStaffData(res, "customer payload");
  };
  assertCustomerPayload(
    await call(origin, sharedClip, {
      jar: customer,
      headers: navigationHeaders,
    }),
  );
  const metadata = await get("/api/v1/datasets/" + shared.datasetId, customer);
  assertCustomerPayload(metadata, { expected: shared.name });
  assert.equal(JSON.parse(metadata.text).data.datasetId, shared.datasetId);
  const privateDataset = datasets[1];
  const recordingPath = "/recordings/" + clipId;
  for (const path of [
    "/data-browser?datasetId=pending-review",
    "/data-browser?datasetId=recycle-bin",
    "/data-browser?datasetId=" + privateDataset.datasetId,
    "/data-browser?datasetId=" + randomUUID(),
    datasetPath + "&recordingId=" + clipId,
    clipPath,
    clipPath + "?datasetId=" + privateDataset.datasetId,
    "/recordings",
    recordingPath,
    recordingPath + "/clips/" + clipId + "/processing",
    "/recipes",
  ]) {
    const res = await call(origin, path, {
      jar: customer,
      headers: navigationHeaders,
    });
    assert.equal(res.status, 404, path);
    assert.match(res.text, /Page unavailable/, path);
    assert.ok(!res.text.includes(privateDataset.name), path);
    assertNoStaffData(res, path);
  }

  const reviewApi = "/api/v2/review-clips/" + clipId;
  const mediaApi = (datasetId) =>
    "/api/v2/datasets/" + datasetId + "/review-clips/" + clipId;
  const viewerChunk = reviewClips.find(
    ({ recordingId }) => recordingId === clipId,
  ).clipId;
  const selection = "selection=" + binding.selectionRevision;
  const handQuery = selection + "&clip=" + (viewerChunk ?? randomUUID());
  const captionDownload = "/api/v2/review-datasets/captions?datasetId=";
  const sharedDownload = await get(
    captionDownload + shared.datasetId,
    customer,
  );
  assertCustomerPayload(sharedDownload);
  for (const path of [
    captionPath,
    decisionPath(clipId),
    reviewApi + "/hand-frames?" + handQuery,
    reviewApi + "/dataset-picker",
    captionDownload + "pending-review",
    captionDownload + "recycle-bin",
    captionDownload + privateDataset.datasetId,
    captionDownload + randomUUID(),
    captionDownload + shared.datasetId + "&recordingId=" + clipId,
    reviewApi + "/poster?role=source_mcap",
    reviewApi + "/poster?dataset=" + privateDataset.datasetId,
    mediaApi(privateDataset.datasetId) +
      "/video?" +
      selection +
      "&role=recording_mp4",
    mediaApi(privateDataset.datasetId) + "/hand-frames?" + handQuery,
    mediaApi(shared.datasetId) +
      "/video?selection=" +
      (binding.selectionRevision + 1),
    mediaApi(shared.datasetId) +
      "/hand-frames?" +
      selection +
      "&clip=" +
      randomUUID(),
  ]) {
    const res = await get(path, customer);
    assert.equal(res.status, 404, path);
    assert.deepEqual(
      JSON.parse(res.text).error,
      {
        code: "not_found",
        message: "Not found",
        retryable: false,
      },
      path,
    );
    assertNoStaffData(res, path);
  }
  // The legacy broker must reject raw roles even when a recipient may view a dataset.
  const legacyReads =
    "/api/v1/datasets/" +
    shared.datasetId +
    "/clips/" +
    (viewerChunk ?? clipId) +
    "/reads";
  for (const [role, status] of [
    ["source_mcap", 422],
    ["recording_mp4", 422],
    ["viewer_rrd", 404],
  ]) {
    const res = await call(origin, legacyReads, {
      method: "POST",
      jar: customer,
      headers: browserHeaders(origin),
      body: JSON.stringify({ role }),
    });
    assert.equal(res.status, status, role);
    assert.equal(JSON.parse(res.text).data, undefined, role);
    assertNoStaffData(res, role);
  }
  for (const width of [1280, 390]) {
    await chrome.send("Emulation.setDeviceMetricsOverride", {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: width < 600,
    });
    await browserSession(staff);
    await go(datasetPath, catalogReady);
    await fill(
      'form[role="search"] input[name="q"]',
      '"cobalt wingnut" -screwdriver',
    );
    await clickButton("Search", 'form[role="search"]');
    await until(
      () =>
        ev(
          'new URLSearchParams(location.search).get("q") === \'"cobalt wingnut" -screwdriver\'',
        ),
      "search URL",
    );
    assert.deepEqual(await ev(clipLinks), [clipPath]);
    const searchPath = await ev("location.pathname + location.search");
    await ev(`(() => {
      const select = [...document.querySelectorAll("main label select")].find(el => el.parentElement.textContent.startsWith("Sort"));
      select.value = "oldest";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await until(
      () => ev('new URLSearchParams(location.search).get("sort") === "oldest"'),
      "sort control applied",
    );
    assert.deepEqual(await ev(clipLinks), [clipPath]);

    if (width === 390)
      await clickButton("Filters", 'aside[aria-label="Clip filters"]');
    await ev(
      `[...document.querySelectorAll("aside summary")].find(el => el.textContent.trim() === "Task label").click()`,
    );
    const taskCheckbox = `[...document.querySelectorAll('aside label input[type="checkbox"]')].find(el => el.parentElement.textContent.includes("Tighten fixture"))`;
    await until(
      () =>
        ev(`(() => {
        const checkbox = ${taskCheckbox};
        return checkbox?.checkVisibility() && !checkbox.matches(":disabled") && !checkbox.checked;
      })()`),
      "task label filter visible and enabled",
    );
    await ev(`(${taskCheckbox}).focus()`);
    for (const type of ["keyDown", "keyUp"]) {
      await chrome.send("Input.dispatchKeyEvent", {
        type,
        key: " ",
        code: "Space",
        windowsVirtualKeyCode: 32,
      });
    }
    await until(
      () =>
        ev(
          'new URLSearchParams(location.search).get("task") === "tighten fixture"',
        ),
      "task label filter applied",
    );
    assert.deepEqual(await ev(clipLinks), [clipPath]);
    const filteredPath = await ev("location.pathname + location.search");
    await go(filteredPath + "&page=2&size=12", catalogReady);
    assert.deepEqual(await ev(clipLinks), []);
    assert.match(
      await ev("document.querySelector('main').innerText"),
      /This page has no clips/,
    );

    await browserSession(customer);
    try {
      await go(
        sharedClip,
        '!!document.querySelector("[data-testid=rail-list]")',
      );
      assert.match(
        await ev("document.querySelector('main').textContent"),
        /Tightens the cobalt wingnut by hand/,
      );
      assert.doesNotMatch(
        await ev("document.querySelector('main').textContent"),
        /Caption edited|Review actions|Add to dataset|Clip processing/,
      );
      assert.equal(await ev("innerWidth"), width);
      assert.ok(await ev("document.documentElement.scrollWidth <= innerWidth"));
      assertCustomerPayload(
        await call(origin, searchPath, {
          jar: customer,
          headers: navigationHeaders,
        }),
        { search: true },
      );
    } finally {
      await browserSession(staff);
    }
  }
});

test("SA-150 Previous and Next follow a populated result page boundary", async () => {
  const recordingIds = [];
  while (recordingIds.length < 13) {
    const pair = await seedReviewPair();
    recordingIds.push(pair.withClip.recordingId);
    if (recordingIds.length < 13)
      recordingIds.push(pair.withoutClip.recordingId);
  }
  await browserSession(await signIn(stack, "staff"));
  const browse = new URLSearchParams([
    ["datasetId", "pending-review"],
    ...recordingIds.map((id) => ["recording", id]),
  ]);
  const firstPage = "/data-browser?" + browse;
  const secondPage = firstPage + "&page=2";
  await go(firstPage, catalogReady);
  const first = await ev(clipLinks);
  assert.equal(first.length, 12);
  const last = first.at(-1);
  await go(secondPage, catalogReady);
  const second = await ev(clipLinks);
  assert.equal(second.length, 1);
  assert.deepEqual(
    [...first, ...second].sort(),
    recordingIds.map((id) => "/clips/" + id).sort(),
  );
  await go(firstPage, catalogReady);
  const lastLink =
    "document.querySelector(" +
    JSON.stringify('article a[href^="' + last + '?"]') +
    ")";
  const lastHref = await ev(lastLink + '?.getAttribute("href")');
  const clipReady = '!!document.querySelector("[data-testid=review-summary]")';
  await go(lastHref, clipReady);

  const clipLink = (name) =>
    '[...document.querySelectorAll("main header a")].find(a => a.textContent.trim() === ' +
    JSON.stringify(name) +
    ")";
  const next = await ev(clipLink("Next clip") + '?.getAttribute("href")');
  const nextUrl = new URL(next, origin);
  assert.equal(nextUrl.pathname, second[0]);
  const nextReturnTo = new URL(nextUrl.searchParams.get("returnTo"), origin);
  assert.equal(nextReturnTo.searchParams.get("page"), "2");
  assert.deepEqual(nextReturnTo.searchParams.getAll("recording"), recordingIds);
  await go(next, clipReady);
  assert.equal(await ev("Boolean(" + clipLink("Next clip") + ")"), false);
  const previous = await ev(
    clipLink("Previous clip") + '?.getAttribute("href")',
  );
  assert.equal(new URL(previous, origin).pathname, last);
  await go(previous, clipReady);
  assert.equal(
    new URL(await ev(clipLink("Next clip") + ".href")).pathname,
    second[0],
  );
});
