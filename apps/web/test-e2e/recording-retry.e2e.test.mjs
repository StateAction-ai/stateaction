import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { requestSha256 } from "@stateaction/contracts";
import { findChrome, launchChrome } from "./chrome.mjs";
import {
  SESSION,
  browserHeaders,
  call,
  signIn,
  startStack,
} from "./harness.mjs";

const server = new URL("../../../packages/server/", import.meta.url);
const requireServer = createRequire(new URL("package.json", server));
const { Pool } = requireServer("pg");
const { tsImport } = requireServer("tsx/esm/api");
const fromServer = (path) =>
  tsImport(new URL(path, server).href, import.meta.url);

test("staff can read a historical interrupted clip, but graph retry requires admitted graph proof", async (t) => {
  const [
    { JOBS_CONFIG, closeOwnerPools, depsFor, queuedJob },
    { processRecordingTaskInputV2 },
    { admitNextJob, requestJobCancel },
    { finalizeCancellations },
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
        await Promise.all([closeOwnerPools(), app.end()]);
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
  const previousOwnerUrl = process.env.CATALOG_TEST_OWNER_URL;
  process.env.CATALOG_TEST_OWNER_URL = stack.db.ownerUrl;
  let interrupted;
  try {
    const { recordingId, jobId } = await queuedJob(db);
    assert.equal((await admitNextJob(deps)).state, "admitted");
    assert.equal(
      (await requestJobCancel(deps, jobId)).state,
      "cancel_requested",
    );
    assert.deepEqual(
      await finalizeCancellations(deps, {
        jobId,
        recordedBy: actors.staff,
        limit: 1,
      }),
      [jobId],
    );
    const {
      rows: [clip],
    } = await app.query(
      "SELECT id, selected_job_id FROM review_clips WHERE recording_id = $1",
      [recordingId],
    );
    assert.equal(clip.selected_job_id, null);
    interrupted = { recordingId, jobId, clipId: clip.id };
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
  const path =
    "/recordings/" +
    interrupted.recordingId +
    "/clips/" +
    interrupted.clipId +
    "/processing";
  const { errorText } = await chrome.send("Page.navigate", {
    url: stack.origin + path,
  });
  assert.equal(errorText, undefined);
  const deadline = Date.now() + 15000;
  for (;;) {
    const { result } = await chrome.send("Runtime.evaluate", {
      expression: `location.pathname === ${JSON.stringify(path)} &&
        Array.from(document.querySelectorAll("button")).some(
          b => b.textContent.trim() === "Open processed clip" && b.disabled &&
          document.getElementById(b.getAttribute("aria-describedby"))?.textContent.includes("cancelled")
        ) && !Array.from(document.querySelectorAll("button")).some(
          b => b.textContent.trim() === "Retry failed steps" && !b.disabled
        )`,
      returnByValue: true,
    });
    if (result.value) break;
    assert.ok(
      Date.now() < deadline,
      "The historical interrupted clip must be readable without a graph retry",
    );
    await sleep(75);
  }
  const preview = await call(
    stack.origin,
    "/api/v1/recordings/" + interrupted.recordingId + "/graph-retries/preview",
    {
      method: "POST",
      jar: staff,
      body: JSON.stringify({
        schemaVersion: 1,
        clipId: interrupted.clipId,
        parentJobId: interrupted.jobId,
        nodes: [],
      }),
      headers: browserHeaders(stack.origin),
    },
  );
  assert.equal(preview.status, 409);
  assert.match(preview.text, /retry_source_unproved/);
});
