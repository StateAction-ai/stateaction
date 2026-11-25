import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  call,
  freePort,
  startWorld,
} from "../../../apps/jobs/test-integration/harness.mjs";

const cwd = fileURLToPath(new URL(".", import.meta.url));
const render =
  process.env.RENDER_CLI ??
  fileURLToPath(
    new URL("../../../artifacts/platform-tools/render/render", import.meta.url),
  );
const python = join(cwd, ".venv/bin/python");
const port = await freePort();
const localUrl = `http://127.0.0.1:${port}`;
const { Render } = createRequire(
  new URL("../../../apps/jobs/package.json", import.meta.url),
)("@renderinc/sdk");
const renderClient = new Render({ useLocalDev: true, localDevUrl: localUrl });

const runnerEnvironment = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  DO_NOT_TRACK: "1",
  RENDER_CLI_CONFIG_DIR: cwd,
  RENDER_USE_LOCAL_DEV: "true",
  RENDER_LOCAL_DEV_URL: localUrl,
};

function cli(...args) {
  const result = execFileSync(
    render,
    ["workflows", ...args, "--local", "--port", String(port), "-o", "json"],
    {
      cwd,
      encoding: "utf8",
      env: runnerEnvironment,
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return JSON.parse(result);
}

async function until(label, check, deadlineMs = 20000) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${label}`);
    await wait(150);
  }
}

const resources = {
  gpu: "none",
  budgetSeconds: 30,
  maxContainers: 1,
  retries: 0,
};
const recipe = {
  schemaVersion: 1,
  recipeId: "stub_local@1",
  maxJobCostUsd: "0.00",
  stages: [
    {
      stage: "segment",
      enabled: false,
      module: "stub_segmenter@1",
      params: {},
      resources,
    },
    {
      stage: "caption",
      enabled: false,
      module: "stub_captioner@1",
      params: {},
      resources,
    },
    {
      stage: "hand_pose",
      enabled: true,
      module: "hand_pose_cpu_v1@1",
      params: {},
      resources,
    },
  ],
};

const world = await startWorld({
  RENDER_USE_LOCAL_DEV: "true",
  RENDER_LOCAL_DEV_URL: localUrl,
  PROCESS_RECORDING_TASK_SLUG: "process-recording",
});
let runner;
let runnerDone;
let log = "";
try {
  const state = join(world.secretsDir, "spike-state");
  mkdirSync(state, { mode: 0o700 });
  runner = spawn(
    render,
    [
      "workflows",
      "dev",
      "--port",
      String(port),
      "--env-file",
      "/dev/null",
      "--",
      python,
      "workflow.py",
    ],
    {
      cwd,
      env: {
        ...runnerEnvironment,
        SPIKE_MODE: "local-stub",
        STATEACTION_API_URL: world.origin,
        CONTROLLER_CAPABILITY_FILE: world.workflow.file,
        JOBS_STATE_DIR: state,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  runnerDone = once(runner, "close");
  for (const stream of [runner.stdout, runner.stderr]) {
    stream.on("data", (chunk) => {
      log = (log + chunk).slice(-1600);
    });
  }
  await until("registered Python task", () => {
    if (runner.exitCode !== null) throw new Error("Render local runner exited");
    try {
      return JSON.stringify(cli("tasks", "list")).includes("process-recording");
    } catch {
      return false;
    }
  });

  const { jobId } = await world.queuedJob();
  assert.equal((await world.admitWithRecipe(recipe)).state, "admitted");
  await world.admit(); // The unchanged web service starts the task by slug.
  const row = await until("server-dispatched Render task ID", async () => {
    const current = await world.row(jobId);
    return current.workflow_run_ref ? current : undefined;
  });
  const runRef = row.workflow_run_ref;
  const run = await until(
    "terminal Python task",
    async () => {
      const run = await renderClient.workflows.getTaskRun(runRef, {
        signal: AbortSignal.timeout(5000),
      });
      if (["failed", "canceled"].includes(run.status)) {
        throw new Error(`Python task run ${run.status}`);
      }
      return run.status === "completed" ? run : undefined;
    },
    55000,
  );
  assert.deepEqual(run.results?.[0], {
    outcome: "needs_operator",
    reason: "spike_stopped_before_seal",
    stageState: "failed",
  });
  const rows = await world.stageRows(jobId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stage, "hand_pose");
  assert.equal(rows[0].state, "failed");
  assert.equal(rows[0].error_code, "stub_fixture_failure");
  assert.match(rows[0].call_id, /^local-/);
  assert.equal(rows[0].claimed_call, rows[0].call_id);
  assert.equal(rows[0].proof, rows[0].call_id);
  assert.ok(rows[0].claimed_at);
  const dag = await call(world.origin, `/internal/v1/jobs/${jobId}/dag-run`, {
    token: world.workflow.token,
  });
  assert.equal(dag.status, 200);
  assert.equal(
    dag.json.data.stages.find((stage) => stage.stage === "hand_pose").callId,
    rows[0].call_id,
  );
  const after = await world.row(jobId);
  assert.equal(after.slot_holder, jobId);
  assert.equal(after.evidence, null);
  console.log(
    JSON.stringify({
      runRef,
      jobId,
      stage: "hand_pose",
      stageState: "failed",
      physicalClaimRecorded: true,
      stageProofRecorded: true,
      noSeal: true,
      slotHeld: true,
      serverDispatch: true,
    }),
  );
} catch (error) {
  console.error(log.replace(/sa_svc_[A-Za-z0-9_-]+/g, "[credential]"));
  throw error;
} finally {
  try {
    if (runner && runner.exitCode === null && runner.signalCode === null)
      runner.kill("SIGTERM");
    if (runnerDone) {
      const closed = await Promise.race([
        runnerDone.then(() => true),
        wait(3000, false, { ref: false }),
      ]);
      if (!closed) {
        runner.kill("SIGKILL");
        await runnerDone;
      }
    }
  } finally {
    await world.stop();
  }
}
