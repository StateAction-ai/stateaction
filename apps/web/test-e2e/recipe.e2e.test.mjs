// SA-100: the stub recipe end to end on every gate run, zero model cost.
//
// The committed SA-50 golden MCAP (packages/contracts/capture/golden/valid.mcap, re-framed as an
// indexed MCAP by workers/processing/tools/golden_indexed_mcap.py) is uploaded as a capture
// through the real create/seal path of the production Next build (real Better Auth, restricted
// Postgres role, real object storage). Admission attaches a recipe, the official Render loopback
// runner runs process-recording, and the real stub segment/caption children plus the real CPU
// hand_pose seal produce the accepted result. The Review and Pipeline pages are then read in Chrome.
// Scenarios live in seed-scenarios.mjs (RECIPE_E2E_SCENARIOS); the seed asserts each ends in its
// expected states on the first attempt. Needs the built web/server/jobs apps, the processing venv,
// the Render CLI and Chrome (the same inputs as the SA-96 dev seed).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { validateValue } from "@stateaction/contracts";
import { findChrome, launchChrome } from "./chrome.mjs";
import { SESSION, call, signIn, startStack } from "./harness.mjs";
import { newSeedDirs, jobsEnv, seedAnnotations } from "./seed-annotations.mjs";
import { RECIPE_E2E_SCENARIOS } from "./seed-scenarios.mjs";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const serverRequire = createRequire(
  join(repoRoot, "packages/server/package.json"),
);
const { S3Client, GetObjectCommand } = serverRequire("@aws-sdk/client-s3");
const pg = serverRequire("pg");
const python =
  process.env.PYTHON_EXECUTABLE ??
  join(repoRoot, "workers/processing/.venv/bin/python");
const renderCli =
  process.env.RENDER_CLI ??
  join(repoRoot, "artifacts/platform-tools/render/render");
const GOLDEN_FLAT = join(
  repoRoot,
  "packages/contracts/capture/golden/valid.mcap",
);
const STAGES = ["segment", "caption", "hand_pose"];

let stack;
let owner;
let s3;
let chrome;
let dirs;
let scratch;
let stopRunner = () => {};
let by; // scenario name -> seeded recording

const q = async (sql, params = []) => (await owner.query(sql, params)).rows;
const rec = (name) => {
  assert.ok(by[name], `scenario ${name} was seeded`);
  return by[name];
};

async function objectJson(key) {
  const out = await s3.send(
    new GetObjectCommand({ Bucket: stack.env.S3_BUCKET, Key: key }),
  );
  return JSON.parse(
    Buffer.from(await out.Body.transformToByteArray()).toString("utf8"),
  );
}

/** Everything the server recorded for one job: stage rows, claims, files, candidate, manifest. */
async function facts(name) {
  const { jobId, recordingId } = rec(name);
  const stages = Object.fromEntries(
    (
      await q(
        "SELECT stage, state, module, error_code, counts, call_id FROM job_stage_runs WHERE job_id = $1",
        [jobId],
      )
    ).map((r) => [r.stage, r]),
  );
  const claims = await q(
    "SELECT stage FROM job_stage_claims WHERE job_id = $1 ORDER BY job_stage_ord(stage)",
    [jobId],
  );
  const files = await q(
    `SELECT f.id, f.role, f.state, f.object_key, s.slot
     FROM files f LEFT JOIN job_output_slots s ON s.file_id = f.id AND s.job_id = f.job_id
     WHERE f.job_id = $1 AND f.purpose = 'output' ORDER BY s.slot`,
    [jobId],
  );
  const [cand] = await q(
    `SELECT status, outcome, clip_count, error_code
     FROM job_result_candidates WHERE job_id = $1`,
    [jobId],
  );
  const [job] = await q(
    `SELECT j.state, rec.current_job_id
     FROM jobs j JOIN recordings rec ON rec.id = j.recording_id WHERE j.id = $1`,
    [jobId],
  );
  // A slotless output would be an unaccounted file: the inventory must give every one a slot.
  for (const file of files)
    assert.ok(
      file.slot,
      `${name}: output ${file.id} (${file.role}) has no slot`,
    );
  const manifestFile = files.find((f) => f.role === "result_manifest");
  assert.ok(manifestFile, `${name}: a result manifest was uploaded`);
  const manifest = await objectJson(manifestFile.object_key);
  return {
    jobId,
    recordingId,
    stages,
    claims: claims.map((c) => c.stage),
    files,
    cand,
    job,
    manifest,
    manifestFile,
  };
}

let staffJar;
async function annotations(name) {
  const { recordingId } = rec(name);
  return call(stack.origin, `/api/v1/recordings/${recordingId}/annotations`, {
    jar: staffJar,
  });
}
async function annotationsDoc(name) {
  const res = await annotations(name);
  assert.equal(res.status, 200, res.text);
  return JSON.parse(res.text).data;
}

/**
 * What every accepted recipe job must satisfy, whatever the stage outcomes: the job and its
 * result candidate are accepted, the manifest is a valid processing-result.v3 whose three nodes
 * mirror the recorded stage rows and the admitted recipe, and every uploaded output file is
 * accounted for (the manifest itself, or named by exactly one stage node).
 */
function assertAcceptedRecipeResult(name, f) {
  const recipe = RECIPE_E2E_SCENARIOS[name].recipe;
  assert.equal(f.job.state, "succeeded", name);
  assert.equal(
    f.job.current_job_id,
    f.jobId,
    "the accepted job is the recording's current job",
  );
  assert.deepEqual(
    {
      status: f.cand.status,
      outcome: f.cand.outcome,
      error_code: f.cand.error_code,
    },
    { status: "accepted", outcome: "succeeded", error_code: null },
    name,
  );
  assert.equal(f.cand.clip_count, 1, "one accepted hand-pose clip");
  const valid = validateValue("artifacts.processing-result.v3", f.manifest);
  assert.equal(valid.valid, true, JSON.stringify(valid));
  assert.equal(f.manifest.job_id, f.jobId);
  assert.equal(f.manifest.recording_id, f.recordingId);
  assert.equal(f.manifest.recipe_id, recipe.recipeId);
  assert.deepEqual(
    f.manifest.nodes.map((n) => n.stage),
    STAGES,
  );
  for (const [i, stage] of STAGES.entries()) {
    const node = f.manifest.nodes[i];
    const row = f.stages[stage];
    assert.equal(node.status, row.state, `${name} ${stage} node status`);
    assert.equal(node.error_code, row.error_code, `${name} ${stage} node code`);
    assert.equal(
      node.module,
      recipe.stages[i].module,
      `${name} ${stage} module`,
    );
    // The seal node adds the hand detection split; every count the stage row recorded is the same.
    assert.deepEqual(
      Object.fromEntries(
        Object.keys(row.counts).map((k) => [k, node.counts[k]]),
      ),
      row.counts,
      `${name} ${stage} node counts`,
    );
    if (stage === "hand_pose")
      assert.deepEqual(
        [
          node.counts.frames_no_hand,
          node.counts.frames_one_hand,
          node.counts.frames_two_hands,
        ],
        [5, 0, 0],
        "the pattern-free golden has no hands: a truthful no-hand result",
      );
  }
  // Inventory: each non-manifest output belongs to exactly one node (a clip or diagnostic file too).
  const named = f.manifest.nodes.flatMap((n) => n.outputs);
  assert.equal(
    new Set(named).size,
    named.length,
    "no file is named by two nodes",
  );
  const uploaded = f.files
    .filter((x) => x.role !== "result_manifest")
    .map((x) => x.id);
  assert.deepEqual(
    [...named].sort(),
    [...uploaded].sort(),
    `${name}: every uploaded file is named by a node`,
  );
  for (const file of f.files)
    assert.ok(
      ["completed", "verified"].includes(file.state),
      `${file.slot} ${file.state}`,
    );
}

/** The slots of the files a node names. */
const nodeSlots = (f, stage) => {
  const node = f.manifest.nodes[STAGES.indexOf(stage)];
  return f.files
    .filter((x) => node.outputs.includes(x.id))
    .map((x) => x.slot)
    .sort();
};

function assertAnnotationsValid(doc) {
  const valid = validateValue("http.recording-annotations.v1", doc);
  assert.equal(valid.valid, true, JSON.stringify(valid));
  if (doc.segments)
    assert.equal(
      validateValue("artifacts.segments.v1", doc.segments).valid,
      true,
    );
  if (doc.captions)
    assert.equal(
      validateValue("artifacts.captions.v1", doc.captions).valid,
      true,
    );
  if (doc.hand_presence)
    assert.equal(
      validateValue("artifacts.hand-presence.v1", doc.hand_presence).valid,
      true,
    );
  // No caption row has empty text: a complete row has text, any other row has none and a reason.
  for (const row of doc.captions?.rows ?? []) {
    if (row.status === "complete") {
      assert.ok(
        typeof row.text === "string" && row.text.trim().length > 0,
        "complete caption has text",
      );
      assert.equal(row.error_code, null);
    } else {
      assert.equal(row.text, undefined, "a failed caption carries no text");
      assert.ok(row.error_code, "a failed caption carries its code");
    }
  }
}

// ----- browser

async function ev(expression) {
  const { result, exceptionDetails } = await chrome.send("Runtime.evaluate", {
    expression: `(async()=>JSON.stringify(await(${expression})))()`,
    awaitPromise: true,
    returnByValue: true,
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
    if (Date.now() >= end) assert.fail(`timeout: ${what}`);
    await sleep(100);
  }
}
async function open(path, ready) {
  await chrome.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const { errorText } = await chrome.send("Page.navigate", {
    url: stack.origin + path,
  });
  assert.equal(errorText, undefined);
  await until(
    () => ev(`!!document.querySelector(${JSON.stringify(ready)})`),
    `${path} rendered ${ready}`,
  );
}
/** React attaches its props to a DOM node when it hydrates it: the click handler exists from then on. */
const hydrated = (selector) =>
  until(
    () =>
      ev(
        `(() => { const e = document.querySelector(${JSON.stringify(selector)}); return !!e && Object.keys(e).some(k => k.startsWith('__reactProps$')); })()`,
      ),
    `${selector} hydrated`,
  );
const reviewSummary = () =>
  ev(
    `document.querySelector('[data-testid=review-summary]').innerText.replace(/\\s+/g, ' ')`,
  );
const railCards = () =>
  ev(
    `[...document.querySelectorAll('[data-testid=rail-card]')].map(c => ({ failed: c.dataset.failed === 'true', text: c.innerText.replace(/\\s+/g, ' ') }))`,
  );
const railFailed = () =>
  ev(
    `[...document.querySelectorAll('[data-testid=rail-failed]')].map(e => ({ text: e.textContent.trim(), code: e.title }))`,
  );
const count = (testid) =>
  ev(`document.querySelectorAll('[data-testid=${testid}]').length`);

/** Opens the review page, downloads the JSON through the page and returns the saved document. */
async function reviewAndDownload(name) {
  const { recordingId } = rec(name);
  await open(`/clips/${recordingId}`, "[data-testid=review-summary]");
  const doc = await annotationsDoc(name);
  if (
    doc.segments?.rows.some(
      (row) => row.status === "ok" && row.end.timestamp_ns === null,
    )
  ) {
    await until(
      () =>
        ev(
          'document.querySelector("[data-testid=review-video]")?.readyState >= 1',
        ),
      `${name} video metadata for the final caption boundary`,
    );
  }
  const downloadButton = '[data-testid="download-json"]';
  await hydrated(downloadButton);
  const downloads = await mkdtemp(join(scratch, "dl-"));
  await chrome.send("Page.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloads,
  });
  await ev(`document.querySelector(${JSON.stringify(downloadButton)}).click()`);
  const file = await until(
    async () =>
      (await readdir(downloads)).find((n) => !n.endsWith(".crdownload")),
    `${name} download`,
  );
  assert.equal(file, "clip-captions.json");
  const saved = JSON.parse(await readFile(join(downloads, file), "utf8"));
  const expected = new Map(
    doc.captions?.rows.map((row) => [
      row.segment_id,
      row.status === "complete" ? row.text : null,
    ]),
  );
  assert.equal(
    saved.captions.length,
    doc.segments?.rows.filter((row) => row.status === "ok").length ?? 0,
  );
  for (const row of saved.captions) {
    assert.equal(row.caption, expected.get(row.segmentId) ?? null);
    assert.ok(
      row.startSeconds >= 0 && row.endSeconds > row.startSeconds,
      `${name} clip-relative caption ${row.segmentId}: ${row.startSeconds}–${row.endSeconds}`,
    );
  }
}

/** The run links and recorded failure codes on the clip processing page. */
async function pipelineStages(name) {
  const { recordingId, jobId } = rec(name);
  await open(
    `/recordings/${recordingId}/clips/${recordingId}/processing`,
    '[aria-label="Recipe graph"]',
  );
  const rows = [];
  for (const step of ["segment", "caption", "hand_pose"]) {
    const button = `button[data-step="${step}"]`;
    const panel = `[data-step-details="${step}"]`;
    await hydrated(button);
    await ev(`document.querySelector(${JSON.stringify(button)}).click()`);
    await until(
      () => ev(`!!document.querySelector(${JSON.stringify(panel)})`),
      step,
    );
    rows.push(
      await ev(`(section => ({
      text: section.innerText.replace(/\\s+/g, " "),
      code: section.querySelector("code")?.textContent.trim() ?? null,
      hasRun: [...section.querySelectorAll("a")].some(link => new URL(link.href).searchParams.get("run") === "${jobId}"),
    }))(document.querySelector(${JSON.stringify(panel)}))`),
    );
  }
  return rows;
}

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), "recipe-e2e-"));
  dirs = newSeedDirs();
  const indexed = join(scratch, "golden-indexed.mcap");
  const made = spawnSync(
    python,
    ["workers/processing/tools/golden_indexed_mcap.py", indexed],
    {
      cwd: repoRoot,
      encoding: "utf8",
    },
  );
  assert.equal(made.status, 0, made.stderr);
  stack = await startStack({
    storage: true,
    extraEnv: {
      ...jobsEnv(python),
      STATEACTION_LOCAL_RECIPE_DIR: dirs.recipes,
    },
  });
  const scenarios = Object.fromEntries(
    Object.entries(RECIPE_E2E_SCENARIOS).map(([name, s]) => [
      name,
      s.source === "flat-golden" ? { ...s, source: GOLDEN_FLAT } : s,
    ]),
  );
  const seeded = await seedAnnotations(stack, {
    dirs,
    python,
    renderCli,
    source: indexed,
    scenarios,
    rgbProfile: "h264_mcap_v1",
  });
  stopRunner = seeded.stopRunner;
  by = Object.fromEntries(
    seeded.summary.recordings.map((r) => [r.scenario, r]),
  );
  assert.deepEqual(
    Object.keys(by).sort(),
    Object.keys(RECIPE_E2E_SCENARIOS).sort(),
  );
  owner = new pg.Pool({ connectionString: stack.db.ownerUrl, max: 2 });
  s3 = new S3Client({
    endpoint: stack.s3.endpoint,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: {
      accessKeyId: stack.s3.accessKeyId,
      secretAccessKey: stack.s3.secretAccessKey,
    },
  });
  staffJar = await signIn(stack, "staff");
  const binary = await findChrome();
  assert.ok(binary, "Chrome is required for the recipe browser checks");
  chrome = await launchChrome(binary, {});
  const { success } = await chrome.send("Network.setCookie", {
    name: SESSION,
    value: staffJar.cookies.get(SESSION),
    url: stack.origin,
    httpOnly: true,
  });
  assert.equal(success, true);
});

after(async () => {
  try {
    await chrome?.close();
  } finally {
    stopRunner();
    s3?.destroy();
    await owner?.end();
    await stack?.stop();
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
});

describe("stub recipe through upload, admission, the Render loopback controller, seal, acceptance and review", () => {
  test("ok: three succeeded stages, an accepted v3 result and a review page with four clean captions", async () => {
    const f = await facts("ok");
    assertAcceptedRecipeResult("ok", f);
    for (const stage of STAGES)
      assert.equal(f.stages[stage].state, "succeeded");
    assert.equal(f.stages.segment.counts.segments, 4);
    assert.equal(f.stages.segment.counts.failed_windows, 0);
    assert.deepEqual(
      {
        captions: f.stages.caption.counts.captions,
        failed: f.stages.caption.counts.failed_captions,
      },
      { captions: 4, failed: 0 },
    );
    assert.deepEqual(f.claims, STAGES, "one claim per stage");
    const doc = await annotationsDoc("ok");
    assertAnnotationsValid(doc);
    assert.equal(doc.segments.rows.length, 4);
    assert.equal(
      doc.captions.rows.filter((r) => r.status === "complete").length,
      4,
    );
    assert.deepEqual(
      doc.dag_run.stages.map((s) => [s.stage, s.state]),
      STAGES.map((s) => [s, "succeeded"]),
    );
    await reviewAndDownload("ok");
    assert.equal((await railCards()).length, 4);
    assert.equal((await railFailed()).length, 0);
    assert.match(await reviewSummary(), /^4 segments$/);
    const recordingPath = "/recordings/" + f.recordingId;
    const reviewPath = "/clips/" + f.recordingId;
    const processingPath =
      recordingPath + "/clips/" + f.recordingId + "/processing";
    const hasLink = (url) =>
      ev(
        `Boolean(document.querySelector(${JSON.stringify('main a[href="' + url + '"]')}))`,
      );
    await open("/recordings", `main a[href="${recordingPath}"]`);
    const clipsNode = 'button[data-step="$clips"]';
    await open(recordingPath, clipsNode);
    await hydrated(clipsNode);
    await ev(`document.querySelector(${JSON.stringify(clipsNode)}).click()`);
    await until(
      () => hasLink(processingPath),
      "expanded Clips links to processing",
    );
    await open(
      processingPath,
      `main a:is([href="${reviewPath}"], [href^="${reviewPath}?"])`,
    );
    await open(reviewPath, "[data-testid=review-summary]");
    assert.ok(await hasLink(processingPath));
  });

  test("caption_failed: two captions fail inside a succeeded stage; the review page shows them failed with their code, never blank", async () => {
    const f = await facts("caption_failed");
    assertAcceptedRecipeResult("caption_failed", f);
    assert.equal(f.stages.caption.state, "succeeded");
    assert.deepEqual(
      {
        captions: f.stages.caption.counts.captions,
        failed: f.stages.caption.counts.failed_captions,
      },
      { captions: 2, failed: 2 },
    );
    const doc = await annotationsDoc("caption_failed");
    assertAnnotationsValid(doc);
    const failed = doc.captions.rows.filter((r) => r.status === "failed");
    assert.equal(failed.length, 2);
    assert.ok(failed.every((r) => r.error_code === "injected_caption_failure"));
    await reviewAndDownload("caption_failed");
    const shown = await railFailed();
    assert.equal(shown.length, 2, JSON.stringify(shown));
    for (const item of shown)
      assert.deepEqual(item, {
        text: "No caption is available for this segment.",
        code: "injected_caption_failure",
      });
    assert.equal((await railCards()).filter((c) => c.failed).length, 2);
    assert.equal(
      await count("failure-caption"),
      2,
      "two failure ticks on the failures lane",
    );
    assert.match(await reviewSummary(), /2 caption failures/);
    const rows = await pipelineStages("caption_failed");
    assert.match(rows[1].text, /Write captions.*Failed captions: 2/);
    assert.ok(rows[1].hasRun);
  });

  test("window_failed: a failed window is a failed row in segments and not_captioned in captions, shown as failed on the review page", async () => {
    const f = await facts("window_failed");
    assertAcceptedRecipeResult("window_failed", f);
    assert.equal(f.stages.segment.counts.failed_windows, 1);
    assert.equal(f.stages.segment.counts.segments, 3);
    assert.equal(f.stages.caption.counts.not_captioned, 1);
    const doc = await annotationsDoc("window_failed");
    assertAnnotationsValid(doc);
    assert.equal(doc.segments.rows.length, 4);
    assert.deepEqual(
      doc.segments.rows.map((r) => r.status),
      ["ok", "failed_window", "ok", "ok"],
    );
    const notCaptioned = doc.captions.rows.filter(
      (r) => r.status === "not_captioned",
    );
    assert.equal(notCaptioned.length, 1);
    assert.equal(notCaptioned[0].error_code, "segment_failed_window");
    assert.equal(notCaptioned[0].segment_id, doc.segments.rows[1].segment_id);
    await reviewAndDownload("window_failed");
    assert.match(await reviewSummary(), /1 failed window/);
    const cardsShown = await railCards();
    assert.deepEqual(
      cardsShown.map((c) => c.failed),
      [false, true, false, false],
      "exactly the failed window's card is failed",
    );
    assert.deepEqual(await railFailed(), [
      {
        text: "No segments could be produced for this time range.",
        code: "injected_window_failure",
      },
    ]);
    assert.equal(await count("block-failed-window"), 1);
    assert.equal(
      await count("failure-window"),
      1,
      "one failed-window tick on the failures lane",
    );
  });

  test("segment_failed: no receipt means failed(receipt_missing), caption not_run, hand pose still sealed; nothing invented on the pages", async () => {
    const f = await facts("segment_failed");
    assertAcceptedRecipeResult("segment_failed", f);
    assert.deepEqual(
      STAGES.map((s) => [f.stages[s].state, f.stages[s].error_code]),
      [
        ["failed", "receipt_missing"],
        ["not_run", "upstream_failed"],
        ["succeeded", null],
      ],
    );
    assert.deepEqual(
      f.claims,
      ["segment", "hand_pose"],
      "caption was never claimed",
    );
    assert.deepEqual(nodeSlots(f, "segment"), []);
    assert.deepEqual(nodeSlots(f, "caption"), []);
    const doc = await annotationsDoc("segment_failed");
    assertAnnotationsValid(doc);
    assert.equal(doc.segments, null);
    assert.equal(doc.captions, null);
    assert.ok(
      doc.hand_presence,
      "the hand-pose seal still produced its result",
    );
    await reviewAndDownload("segment_failed");
    assert.equal((await railCards()).length, 0);
    assert.match(await reviewSummary(), /^0 segments/);
    assert.match(
      await ev("document.querySelector('[data-testid=rail-list]').innerText"),
      /Segmentation failed.*did not return a stage receipt/,
    );
    const rows = await pipelineStages("segment_failed");
    assert.match(rows[0].text, /Find actions.*Failed/);
    assert.equal(rows[0].code, "receipt_missing");
    assert.match(rows[1].text, /Write captions.*Not run/);
    assert.match(rows[2].text, /Track hands.*Succeeded/);
  });

  test("digest_mismatch: files uploaded under a rejected receipt are attributed to the failed segment node, never served as segments", async () => {
    const f = await facts("digest_mismatch");
    assertAcceptedRecipeResult("digest_mismatch", f);
    assert.deepEqual(
      [f.stages.segment.state, f.stages.segment.error_code],
      ["failed", "receipt_rejected"],
    );
    assert.deepEqual(nodeSlots(f, "segment"), [
      "diagnostics/segment/log.txt",
      "diagnostics/segment/windows.jsonl",
      "segments.json",
    ]);
    const doc = await annotationsDoc("digest_mismatch");
    assertAnnotationsValid(doc);
    assert.equal(
      doc.segments,
      null,
      "a rejected stage's segments.json is not a result",
    );
    assert.equal(doc.captions, null);
    assert.equal(
      doc.dag_run.stages.find((s) => s.stage === "segment").errorCode,
      "receipt_rejected",
    );
    await reviewAndDownload("digest_mismatch");
    assert.equal((await railCards()).length, 0);
    const rows = await pipelineStages("digest_mismatch");
    assert.match(rows[0].text, /could not verify the stage receipt/);
    assert.equal(rows[0].code, "receipt_rejected");
  });

  test("zero_segments: a valid empty segments document is a success, caption is not_run(no_segments), and nothing is reported as failed", async () => {
    const f = await facts("zero_segments");
    assertAcceptedRecipeResult("zero_segments", f);
    assert.deepEqual(
      STAGES.map((s) => [f.stages[s].state, f.stages[s].error_code]),
      [
        ["succeeded", null],
        ["not_run", "no_segments"],
        ["succeeded", null],
      ],
    );
    assert.equal(f.stages.segment.counts.segments, 0);
    assert.deepEqual(f.claims, ["segment", "hand_pose"]);
    const doc = await annotationsDoc("zero_segments");
    assertAnnotationsValid(doc);
    assert.deepEqual(doc.segments.rows, []);
    assert.equal(doc.captions, null);
    await reviewAndDownload("zero_segments");
    assert.equal((await railCards()).length, 0);
    assert.match(await reviewSummary(), /^0 segments$/);
    assert.equal(await count("failure-caption"), 0);
  });

  test("source_unreadable: every stage fails with its own code, the recipe job's v2 failure manifest is accepted and the job ends failed", async () => {
    const { jobId, recordingId } = rec("source_unreadable");
    const f = await facts("source_unreadable");
    assert.equal(f.job.state, "failed");
    assert.deepEqual(
      {
        status: f.cand.status,
        outcome: f.cand.outcome,
        clip_count: f.cand.clip_count,
      },
      { status: "accepted", outcome: "failed", clip_count: 0 },
    );
    const valid = validateValue("artifacts.processing-result.v2", f.manifest);
    assert.equal(valid.valid, true, JSON.stringify(valid));
    assert.equal(
      f.manifest.nodes,
      undefined,
      "a failure manifest is v2 diagnostics only",
    );
    assert.deepEqual(
      STAGES.map((s) => f.stages[s].state),
      ["failed", "not_run", "failed"],
    );
    assert.ok(f.stages.segment.error_code && f.stages.hand_pose.error_code);
    assert.notEqual(f.stages.hand_pose.error_code, "receipt_missing");
    assert.equal(f.cand.error_code, f.stages.hand_pose.error_code);
    // Only diagnostics and the manifest: no result file, clip or video was accepted.
    for (const file of f.files)
      assert.ok(
        file.role === "result_manifest" || file.slot.startsWith("diagnostics/"),
        file.slot,
      );
    assert.equal(
      (await annotations("source_unreadable")).status,
      404,
      "no accepted job, no annotations",
    );
    await open("/recordings/" + recordingId, "main h1");
    assert.match(
      await ev("document.querySelector('main').innerText"),
      /Failed/,
    );
    assert.ok(jobId && recordingId);
  });

  test("retry_mid_caption: the same run re-enters after controller loss while the caption child is alive; the child is adopted, never respawned", async () => {
    // Simulated Render retry: the shared controller is killed mid-caption and the same run ref runs
    // it again once the lease lapsed (the loopback runner cannot re-dispatch a run itself).
    const r = rec("retry_mid_caption");
    const f = await facts("retry_mid_caption");
    assertAcceptedRecipeResult("retry_mid_caption", f);
    assert.equal(r.retry.stage, "caption");
    assert.equal(
      r.retry.pidsBefore.length,
      1,
      "exactly one caption child before the controller died",
    );
    assert.equal(
      r.retry.aliveAtReentry,
      true,
      "the caption child was still running when the second controller took the lease",
    );
    // Every spawn gets a fresh random call id, so the row, the journal and the claim all still
    // naming the first child's id is the proof that nothing was spawned a second time.
    assert.equal(f.stages.caption.call_id, r.retry.executionRef);
    const journal = JSON.parse(readFileSync(r.retry.journalFile, "utf8"));
    assert.equal(journal.executionRef, r.retry.executionRef);
    assert.equal(journal.phase, "exited");
    assert.deepEqual(f.claims, STAGES, "one claim per stage, none repeated");
    assert.equal(Object.keys(f.stages).length, 3, "one row per stage");
    assert.equal(f.stages.caption.state, "succeeded");
    assert.equal(f.stages.caption.counts.captions, 4);
    const doc = await annotationsDoc("retry_mid_caption");
    assertAnnotationsValid(doc);
    assert.equal(doc.captions.rows.length, 4);
  });
});
