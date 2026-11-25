import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { requestSha256 } from "@stateaction/contracts";
import { findChrome, launchChrome } from "./chrome.mjs";
import { SESSION, signIn, startStack } from "./harness.mjs";

const server = new URL("../../../packages/server/", import.meta.url);
const requireServer = createRequire(new URL("package.json", server));
const { Pool } = requireServer("pg");
const { tsImport } = requireServer("tsx/esm/api");
const fromServer = (path) =>
  tsImport(new URL(path, server).href, import.meta.url);

test("SA-150 Chromium confirms a clip retry and a recording batch without an accepted result", async (t) => {
  const [
    { JOBS_CONFIG, depsFor, queuedJob },
    { processRecordingTaskInputV2 },
    { admitNextJob, requestJobCancel },
    { failUndispatched, finalizeCancellations },
  ] = await Promise.all([
    fromServer("test-integration/jobs-harness.ts"),
    fromServer("src/admission/job-input.ts"),
    fromServer("src/jobs/service.ts"),
    fromServer("src/jobs/recovery.ts"),
  ]);
  const stack = await startStack({
    storage: true,
    extraEnv: {
      PROCESSING_EXECUTION_BACKEND: "local",
      PROCESSING_CODE_REVISION: JOBS_CONFIG.codeRevision,
      PROCESSING_IMAGE_SPEC_SHA256: JOBS_CONFIG.imageSpecSha256,
      PROCESSING_MODEL_SHA256: JOBS_CONFIG.modelSha256,
      PROCESSING_CONFIG_SHA256: JOBS_CONFIG.configSha256,
    },
  });
  const app = new Pool({ connectionString: stack.db.appUrl, max: 1 });
  let chrome;
  t.after(async () => {
    try {
      await chrome?.close();
    } finally {
      try {
        await app.end();
      } finally {
        await stack.stop();
      }
    }
  });
  const actors = {
    staff: stack.users.staff.id,
    collector: stack.users.collector.id,
  };
  const db = { app, actors, signed: [] };
  const resources = {
    gpu: "none",
    budgetSeconds: 60,
    maxContainers: 1,
    retries: 0,
  };
  const recipe = {
    schemaVersion: 1,
    recipeId: "retry_fixture@1",
    maxJobCostUsd: "0.00",
    stages: [
      { stage: "segment", module: "stub_segmenter@1" },
      { stage: "caption", module: "stub_captioner@1" },
      { stage: "hand_pose", module: "hand_pose_cpu_v1@1" },
    ].map((stage) => ({ ...stage, enabled: true, params: {}, resources })),
  };
  const deps = {
    ...depsFor(db),
    taskInput: async (query, job) => ({
      ...(await processRecordingTaskInputV2(query, job.jobId)),
      schemaVersion: 3,
      recipe,
      recipeSha256: requestSha256(recipe),
    }),
  };
  async function interruptedClip(cancelled) {
    const { recordingId, jobId } = await queuedJob(db);
    assert.equal((await admitNextJob(deps)).state, "admitted");
    const repair = { jobId, recordedBy: actors.staff, limit: 1 };
    if (cancelled) {
      assert.equal(
        (await requestJobCancel(deps, jobId)).state,
        "cancel_requested",
      );
      assert.deepEqual(await finalizeCancellations(deps, repair), [jobId]);
    } else {
      assert.deepEqual(
        await failUndispatched(
          { ...deps, config: { repair: { dispatchWindowSeconds: 0 } } },
          repair,
        ),
        [jobId],
      );
    }
    const { rows } = await app.query(
      "SELECT id, selected_job_id FROM review_clips WHERE recording_id = $1",
      [recordingId],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].selected_job_id, null);
    return { recordingId, jobId, clipId: rows[0].id };
  }
  const previousOwnerUrl = process.env.CATALOG_TEST_OWNER_URL;
  process.env.CATALOG_TEST_OWNER_URL = stack.db.ownerUrl;
  let clip, batch;
  try {
    clip = await interruptedClip(true);
    batch = await interruptedClip(false);
  } finally {
    if (previousOwnerUrl === undefined)
      delete process.env.CATALOG_TEST_OWNER_URL;
    else process.env.CATALOG_TEST_OWNER_URL = previousOwnerUrl;
  }

  const binary = await findChrome();
  assert.ok(binary, "Chromium is required for recording retries");
  chrome = await launchChrome(binary);
  const staff = await signIn(stack, "staff");
  const { success } = await chrome.send("Network.setCookie", {
    name: SESSION,
    value: staff.cookies.get(SESSION),
    url: stack.origin,
    httpOnly: true,
  });
  assert.ok(success);
  await chrome.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 900,
    deviceScaleFactor: 1,
    mobile: true,
  });

  async function ev(expression) {
    const { result, exceptionDetails } = await chrome.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
    });
    assert.equal(exceptionDetails, undefined, expression);
    return result.value;
  }
  async function until(predicate, message) {
    const deadline = Date.now() + 15_000;
    while (!(await predicate())) {
      assert.ok(Date.now() < deadline, message);
      await sleep(75);
    }
  }
  const button = (scope, name) =>
    "[...document.querySelectorAll(" +
    JSON.stringify(scope + " button") +
    ")].find(b => b.textContent.trim() === " +
    JSON.stringify(name) +
    ")";
  async function navigate(path) {
    const { errorText } = await chrome.send("Page.navigate", {
      url: stack.origin + path,
    });
    assert.equal(errorText, undefined);
    await until(
      () =>
        ev(
          "location.pathname === " +
            JSON.stringify(path) +
            " && !!document.querySelector('main h1')",
        ),
      path,
    );
    assert.ok(await ev("document.documentElement.scrollWidth <= innerWidth"));
  }
  async function retry(label, target, other) {
    const action = button("main", label);
    await until(async () => {
      await ev("(" + action + ")?.click()");
      return ev('!!document.querySelector("dialog[open]")');
    }, label + " opens its confirmation");
    const confirm = button("dialog[open]", "Confirm retry");
    await until(async () => {
      const error = await ev(
        'document.querySelector("dialog[open] [role=alert]")?.textContent',
      );
      assert.equal(error, undefined);
      return ev("(" + confirm + ")?.disabled === false");
    }, label + " preview");
    assert.deepEqual(
      await ev(
        '[...document.querySelectorAll("dialog[open] li strong")].map(clip => clip.textContent.split(" · ")[0])',
      ),
      ["Clip 1"],
    );
    const preview = await ev(
      'document.querySelector("dialog[open]").innerText',
    );
    assert.match(preview, /Runs Segmentation, Captioning, Hand pose/);
    assert.match(preview, /Captions must follow segmentation/);
    assert.match(preview, /Total estimated cost/);
    await ev("(" + confirm + ").click()");
    await until(async () => {
      const error = await ev(
        'document.querySelector("dialog[open] [role=alert]")?.textContent',
      );
      assert.equal(error, undefined);
      return ev('!document.querySelector("dialog[open]")');
    }, label + " confirmed");
    const { rows } = await app.query(
      `SELECT j.derived_from_job_id, j.recording_id, j.state, p.plan -> 'execute' AS stages
       FROM jobs j JOIN job_rerun_plans p ON p.job_id = j.id
       WHERE j.derived_from_job_id = ANY($1::uuid[])`,
      [[target.jobId, other.jobId]],
    );
    return rows;
  }
  const queued = ({ jobId, recordingId }) => ({
    derived_from_job_id: jobId,
    recording_id: recordingId,
    state: "queued",
    stages: ["segment", "caption", "hand_pose"],
  });

  await navigate(
    "/recordings/" + clip.recordingId + "/clips/" + clip.clipId + "/processing",
  );
  const open = "(" + button("main", "Open processed clip") + ")";
  assert.equal(await ev(open + "?.disabled"), true);
  assert.match(
    await ev(
      "document.getElementById(" +
        open +
        '.getAttribute("aria-describedby"))?.innerText',
    ),
    /Processing was cancelled/,
  );
  assert.deepEqual(await retry("Retry from here", clip, batch), [queued(clip)]);

  await navigate("/recordings/" + batch.recordingId);
  assert.deepEqual(
    (await retry("Retry failed clips", batch, clip)).sort((a, b) =>
      a.recording_id.localeCompare(b.recording_id),
    ),
    [queued(clip), queued(batch)].sort((a, b) =>
      a.recording_id.localeCompare(b.recording_id),
    ),
  );
});
