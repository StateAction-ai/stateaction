// SA-98 recording review page in a real browser against the production build,
// real Better Auth, the restricted Postgres role and real object storage.
//
// Two recipe jobs (segment, caption, hand_pose seal) are run and ACCEPTED through
// the real services by packages/server/test-auth/review-seed-cli.ts: published
// conformance documents stamped with each job, real multipart uploads, one clip
// on the first recording. The review video and the clip RRD are then replaced by a
// synthetic 24 s testsrc mp4 and the golden worker RRD, so the browser plays and
// the viewer loads real bytes. The SA-96 dev seed (real worker, ~2 min per
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
const golden = await readFile(
  new URL("test-e2e/fixtures/golden-clip.rrd", web),
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
async function until(pred, what, ms = 60_000) {
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
    () => ev(`document.querySelectorAll('[data-testid=rail-card]').length > 0`),
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

before(async () => {
  stack = await startStack({ storage: true, storageProxy });
  origin = stack.origin;
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
  seeded = JSON.parse(seed.stdout);
  s3 = new S3Client({
    endpoint: stack.s3.endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: stack.s3.accessKeyId,
      secretAccessKey: stack.s3.secretAccessKey,
    },
  });
  const put = (Key, Body, ContentType) =>
    s3.send(
      new PutObjectCommand({
        Bucket: stack.env.S3_BUCKET,
        Key,
        Body,
        ContentType,
      }),
    );
  await put(seeded.withClip.mp4Key, video, "video/mp4");
  await put(seeded.withoutClip.mp4Key, video, "video/mp4");
  await put(seeded.withClip.clipViewerKey, golden, "application/octet-stream");
  downloads = await mkdtemp(join(tmpdir(), "review-dl-"));
  const binary = await findChrome();
  assert.ok(binary, "Chrome is required for the review browser test");
  chrome = await launchChrome(binary, { webgl: true });
  const jar = await signIn(stack, "staff");
  const { success } = await chrome.send("Network.setCookie", {
    name: SESSION,
    value: jar.cookies.get(SESSION),
    url: origin,
    httpOnly: true,
  });
  assert.equal(success, true);
  await chrome.send("Page.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloads,
  });
});

after(async () => {
  try {
    await chrome?.close();
  } finally {
    s3?.destroy();
    await stack?.stop();
    if (downloads) await rm(downloads, { recursive: true, force: true });
  }
});

test("segments render on the tiers and the rail, failures as failures", async () => {
  const jar = await signIn(stack, "staff");
  const doc = await apiDoc(jar, seeded.withClip.recordingId);
  await open(`/review/${seeded.withClip.recordingId}`);
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
  await open(`/review/${seeded.withClip.recordingId}`);
  const failed = await ev(
    `[...document.querySelectorAll('[data-testid=rail-failed]')].map(e => ({ text: e.textContent.trim(), code: e.querySelector('[title]')?.title }))`,
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
  await open(`/review/${seeded.withClip.recordingId}`);
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

  // A caption selection starts playing even from pause.
  await ev(
    `document.querySelectorAll('[data-testid=rail-card]')[0].querySelector('button').click()`,
    {
      userGesture: true,
    },
  );
  await until(async () => (await selectedIndex()) === 0, "first card");
  await until(
    () => ev("!" + v + ".paused && " + v + ".currentTime < 1"),
    "caption seeks to the beginning and plays",
  );
  await ev(`document.querySelector('button[aria-label=Pause]').click()`);
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

test("the JSON tab shows the document and Download JSON saves the same valid document", async () => {
  const jar = await signIn(stack, "staff");
  const doc = await apiDoc(jar, seeded.withClip.recordingId);
  await open(`/review/${seeded.withClip.recordingId}`);
  await openTab("json");
  const shown = await until(
    () => ev(`document.querySelector('[data-testid=json-view]')?.innerText`),
    "json view",
  );
  assert.ok(shown.includes(seeded.withClip.jobId));
  await ev(`document.getElementById('dlBtn').click()`);
  const file = await until(async () => {
    const names = (await readdir(downloads)).filter(
      (n) => !n.endsWith(".crdownload"),
    );
    return names[0];
  }, "downloaded file");
  assert.equal(file, `annotations-${seeded.withClip.recordingId}.json`);
  const saved = JSON.parse(await readFile(join(downloads, file), "utf8"));
  const valid = validateValue("http.recording-annotations.v1", saved);
  assert.equal(valid.valid, true, JSON.stringify(valid));
  assert.equal(saved.job_id, seeded.withClip.jobId);
  assert.deepEqual(
    { ...saved, dag_run: null },
    { ...doc, dag_run: null },
    "the download is the API document",
  );
});

test("Hand pose tab loads the golden RRD for the clip under the playhead", async () => {
  await open(`/review/${seeded.withClip.recordingId}`);
  await openTab("hand");
  // Outside the clip (it covers 8-16 s of the axis; the playhead starts at 0).
  await until(
    () => ev(`!!document.querySelector('[data-testid=hand-no-clip]')`),
    "no clip at the start",
  );
  // Segment 3 starts at 12 s on the axis, inside the clip (8-16 s).
  await videoReady();
  await clickUntil(
    `document.querySelector('#lSeg [aria-label="Segment 3"]').click()`,
    `!!document.querySelector('[data-testid=hand-viewer-phase]')`,
    "playhead entered the clip",
  );
  const phase = await until(
    async () => {
      const p = await ev(
        `document.querySelector('[data-testid=hand-viewer-phase]')?.textContent`,
      );
      return p === "ready" || p === "error" ? p : false;
    },
    async () =>
      `the clip viewer settled: ${await ev(`JSON.stringify({ p: document.querySelector('[data-testid=hand-viewer-phase]')?.textContent, alert: document.querySelector('[role=alert]')?.textContent, host: !!document.querySelector('[data-testid=clip-viewer-host]'), t: document.querySelector('[data-testid=review-video]')?.currentTime })`)}`,
    90_000,
  );
  assert.equal(phase, "ready");
  assert.equal(
    await ev(
      `document.querySelector('[data-testid=hand-viewer-phase]').dataset.clipId`,
    ),
    seeded.withClip.clipId,
  );
});

test("a recording without a clip says so; the selector switches recordings", async () => {
  await open(`/review/${seeded.withoutClip.recordingId}`);
  await openTab("hand");
  await until(
    () => ev(`!!document.querySelector('[data-testid=hand-no-clip]')`),
    "no clip message",
  );
  const options = await ev(
    `[...document.querySelectorAll('select[aria-label=Recording] option')].map(o => o.value)`,
  );
  assert.deepEqual(
    options.sort(),
    [seeded.withClip.recordingId, seeded.withoutClip.recordingId].sort(),
  );
  await ev(
    `(() => { const s = document.querySelector('select[aria-label=Recording]'); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(s, ${JSON.stringify(seeded.withClip.recordingId)}); s.dispatchEvent(new Event('change', { bubbles: true })); })()`,
  );
  await until(
    () => ev(`location.pathname === '/review/${seeded.withClip.recordingId}'`),
    "navigated to the other recording",
  );
});

test("no horizontal page scroll at 390 px on every tab", async () => {
  for (const id of [
    seeded.withClip.recordingId,
    seeded.withoutClip.recordingId,
  ]) {
    await open(`/review/${id}`, 390);
    for (const tab of ["segs", "json", "hand"]) {
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
  await open(`/review/${seeded.withClip.recordingId}`, 1280);
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
    const page = await call(stack.origin, `/review/${id}`, {
      jar,
      headers: {
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
      },
    });
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
  const assertCaptionBadge = async (i) => {
    const element = `document.querySelectorAll('[data-testid=rail-card]')[${i}].querySelector('[data-testid=mark-badge]')`;
    // Rail cards use content-visibility:auto. Scroll the badge into view before
    // reading rendered text, which Chrome omits while skipping the card.
    await ev(`${element}.scrollIntoView({ block: 'nearest' })`);
    await until(
      () => ev(`${element}.checkVisibility({ contentVisibilityAuto: true })`),
      "the caption badge is visible",
    );
    assert.equal((await badge(i))?.text, "Caption");
  };
  const chip = (f) =>
    ev(`document.querySelector('[data-filter=${f}]').innerText`);
  const doc = await apiDoc(await signIn(stack, "staff"), rec.recordingId);
  await open(`/review/${rec.recordingId}`);
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
    `(() => { const b = document.querySelector('[data-issue-type=caption]'); b.focus(); b.click(); })()`,
  );
  await until(
    async () => (await badge(1))?.text === "Caption",
    "issue type is Caption",
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
      ["issue", "caption", 2],
    ].sort(),
  );
  // A reload shows the same marks and the Issue and Unchecked chips filter by them.
  await open(`/review/${rec.recordingId}`);
  await until(
    () =>
      ev(
        `document.querySelector('[data-marks-loaded]')?.dataset.marksLoaded === 'true'`,
      ),
    "the marks listing reloaded",
  );
  await until(async () => (await summary()) === "2 checked, 1 issue", "reload");
  assert.equal((await badge(0))?.mark, "good");
  await assertCaptionBadge(1);
  assert.equal((await badge(2))?.mark, "none");
  await clickUntil(
    `document.querySelector('[data-filter=issue]').click()`,
    `document.querySelectorAll('[data-testid=rail-card]').length === 1`,
    "Issue chip applied",
  );
  await assertCaptionBadge(0);
  await clickUntil(
    `document.querySelector('[data-filter=unchecked]').click()`,
    `document.querySelectorAll('[data-testid=rail-card]').length === ${total - 2}`,
    "Unchecked chip applied",
  );
  // The Pipeline list team-check column shows the same counts.
  const pipeline = await call(stack.origin, "/pipeline", {
    jar,
    headers: {
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
    },
  });
  assert.equal(pipeline.status, 200);
  assert.match(
    pipeline.text,
    />\s*2 reviewed<span[^>]*>\s*1(?:<!-- -->)? flagged/,
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
