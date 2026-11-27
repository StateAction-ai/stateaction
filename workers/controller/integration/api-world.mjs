import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { setTimeout as pause } from "node:timers/promises";
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { call, freePort, startWorld } from "./harness.mjs";

const mode = process.argv[2];
const port = ["runner", "runner-loss"].includes(mode) ? await freePort() : null;
const url = port ? `http://127.0.0.1:${port}` : null;
const world = await startWorld(
  port
    ? {
        RENDER_USE_LOCAL_DEV: "true",
        RENDER_LOCAL_DEV_URL: url,
        PROCESS_RECORDING_TASK_SLUG: "process-recording",
      }
    : {},
  (phase) => console.error(`[python-controller fixture] teardown: ${phase}`),
);
let runner;
let runnerClosed;
let commands;
let shutdownRequested = false;

async function until(check) {
  const until = Date.now() + 45_000;
  while (Date.now() < until) {
    const result = await check();
    if (result) return result;
    if (runner.exitCode !== null)
      throw new Error("The local Python runner exited");
    await pause(100);
  }
  throw new Error("The local Python runner did not finish");
}

async function startRunner(stateDir, runnerPort = port, hold = 0) {
  const runnerUrl = `http://127.0.0.1:${runnerPort}`;
  const require = createRequire(
    new URL("../../../packages/server/package.json", import.meta.url),
  );
  const { Render } = require("@renderinc/sdk");
  const client = new Render({ useLocalDev: true, localDevUrl: runnerUrl });
  const cli =
    process.env.RENDER_CLI ??
    join(process.cwd(), "artifacts/platform-tools/render/render");
  const cliEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    DO_NOT_TRACK: "1",
    RENDER_CLI_CONFIG_DIR: join(world.secretsDir, `render-cli-${runnerPort}`),
  };
  runner = spawn(
    cli,
    [
      "workflows",
      "dev",
      "--port",
      String(runnerPort),
      "--env-file",
      "/dev/null",
      "--",
      process.env.SA153_PYTHON,
      "workers/controller/integration/historical-workflow.py",
    ],
    {
      stdio: ["ignore", "ignore", "ignore"],
      env: {
        ...cliEnv,
        APP_ENV: "local",
        EXECUTION_BACKEND: "local",
        STATEACTION_API_URL: world.origin,
        CONTROLLER_CAPABILITY_FILE: world.workflow.file,
        JOBS_STATE_DIR: stateDir,
        PYTHON_EXECUTABLE:
          process.env.PYTHON_EXECUTABLE ??
          join(process.cwd(), "workers/processing/.venv/bin/python"),
        WORKER_PIPELINE: "local_fixture_noop",
        WORKER_FIXTURE_HOLD_SECONDS: String(hold),
        CONTROLLER_POLL_MS: "50",
      },
    },
  );
  runnerClosed = once(runner, "close");
  await until(() => {
    try {
      const tasks = execFileSync(
        cli,
        [
          "workflows",
          "tasks",
          "list",
          "--local",
          "--port",
          String(runnerPort),
          "-o",
          "json",
        ],
        { env: cliEnv, stdio: ["ignore", "pipe", "pipe"], timeout: 3000 },
      );
      return tasks.includes("process-recording");
    } catch {
      return false;
    }
  });
  return client;
}
try {
  const stateDir = join(world.secretsDir, "python-state");
  mkdirSync(stateDir, { mode: 0o700 });
  const render = port
    ? await startRunner(stateDir, port, mode === "runner-loss" ? 60 : 0)
    : null;
  const job = await world.queuedJob();
  let admission;
  if (process.argv[2] === "recipe" || process.argv[2] === "disabled-caption") {
    const spec = {
      schemaVersion: 1,
      recipeId: "stub_local@1",
      maxJobCostUsd: "0.00",
      stages: [
        ["segment", "stub_segmenter@1"],
        ["caption", "stub_captioner@1"],
        ["hand_pose", "hand_pose_cpu_v1@1"],
      ].map(([stage, module]) => ({
        stage,
        module,
        params: {},
        enabled: stage !== "caption" || process.argv[2] !== "disabled-caption",
        resources: {
          gpu: "none",
          budgetSeconds: 300,
          maxContainers: 1,
          retries: 0,
        },
      })),
    };
    admission = await world.admitWithRecipe(spec);
  } else if (mode === "late") {
    admission = await world.admitWithDeadline(9);
  } else {
    ({ admission } = await world.admit());
  }
  if (admission.state !== "admitted")
    throw new Error("Fixture was not admitted");
  const send = (data) => console.log(JSON.stringify(data));
  send({
    jobId: job.jobId,
    origin: world.origin,
    stateDir,
    tokenFile: world.workflow.file,
  });
  commands = createInterface({ input: process.stdin });
  for await (const input of commands) {
    if (input === "stop") {
      shutdownRequested = true;
      break;
    }
    if (input === "terminal") {
      await world.owner.query(
        "UPDATE jobs SET state = 'failed', finished_at = now() WHERE id = $1",
        [job.jobId],
      );
      const { slot_holder } = await world.row(job.jobId);
      send({ slot_holder });
    } else if (input === "kill-runner") {
      runner.kill("SIGKILL");
      await runnerClosed;
      send({ stopped: true });
    } else if (input === "new-runner") {
      const secondPort = await freePort();
      const second = await startRunner(stateDir, secondPort, 60);
      const newer = await second.workflows.startTask(
        "process-recording",
        [{ jobId: job.jobId }],
        {
          idempotencyKey: "runner-loss-check",
          signal: AbortSignal.timeout(5000),
        },
      );
      const result = await until(async () => {
        const current = await second.workflows.getTaskRun(newer.taskRunId, {
          signal: AbortSignal.timeout(5000),
        });
        if (["failed", "canceled"].includes(current.status))
          throw new Error("Replacement runner task failed");
        return current.status === "completed" ? current : null;
      });
      send({ taskRunId: newer.taskRunId, outcome: result.results[0] });
    } else if (["forget-ack", "unknown-child"].includes(input)) {
      const path = `/internal/v1/jobs/${job.jobId}/controller`;
      const act = (body) =>
        call(world.origin, path, {
          method: "POST",
          token: world.workflow.token,
          body,
        });
      const lease = await act({
        action: "claim_lease",
        runRef: "python-lost-ack",
        owner: "lost-owner",
      });
      if (!lease.json?.data?.granted)
        throw new Error("Fixture lease was not granted");
      const result = await act({
        action: "record_worker_submission",
        owner: "lost-owner",
      });
      if (result.json?.data?.state !== "recorded")
        throw new Error("Fixture intent was not recorded");
      const { startDeadline, executionDeadline } = result.json.data;
      if (input === "unknown-child") {
        const recorded = await act({
          action: "record_execution",
          owner: "lost-owner",
          executor: { kind: "local", localExecutionRef: "local-uncertain" },
        });
        if (recorded.status !== 200)
          throw new Error("Fixture execution ID was not recorded");
      }
      await world.expireLease(job.jobId);
      send({ fenced: true, startDeadline, executionDeadline });
    } else if (input === "lapse") {
      await world.lapseLease(job.jobId);
      send((await world.admit()).admission);
    } else if (input === "repair") {
      send((await world.admit()).admission);
    } else if (input === "cancel-after-intent") {
      const result = await world.owner.query(
        "UPDATE jobs SET state = 'cancel_requested' WHERE id = $1 AND state = 'submitting' AND submission_intent_at IS NOT NULL",
        [job.jobId],
      );
      send({ cancelled: result.rowCount === 1 });
    } else if (input === "fail-before-evidence") {
      const result = await world.owner.query(
        "UPDATE jobs SET state = 'failed', finished_at = now(), error_code = 'fixture_result_rejected' WHERE id = $1 AND state = 'running'",
        [job.jobId],
      );
      send({ failed: result.rowCount === 1 });
    } else if (input === "failure") {
      const result = await world.owner.query(
        "SELECT error_code, (SELECT count(*)::int FROM clips WHERE job_id = $1) AS clips FROM jobs WHERE id = $1",
        [job.jobId],
      );
      send(result.rows[0]);
    } else if (input === "runner") {
      const row = await until(async () => {
        const current = await world.row(job.jobId);
        return current.workflow_run_ref ? current : null;
      });
      const run = await until(async () => {
        const current = await render.workflows.getTaskRun(
          row.workflow_run_ref,
          {
            signal: AbortSignal.timeout(5000),
          },
        );
        if (["failed", "canceled"].includes(current.status))
          throw new Error("Python task failed");
        return current.status === "completed" ? current : null;
      });
      const again = await world.admit();
      send({
        stateMode: statSync(stateDir).mode & 0o777,
        taskRunId: row.workflow_run_ref,
        outcome: run.results[0],
        pending: again.pendingDispatches.length,
      });
    } else if (input === "row") {
      const {
        workflow_run_ref,
        execution_call_id,
        claimed_at,
        execution_deadline,
        state,
        evidence,
        slot_holder,
      } = await world.row(job.jobId);
      send({
        workflow_run_ref,
        execution_call_id,
        claimed_at,
        execution_deadline,
        state,
        evidence,
        slot_holder,
      });
    } else if (input === "read-policy") {
      const statuses = {};
      for (const suffix of ["recipe", "dag-run", "prior-stages"]) {
        const path = `/internal/v1/jobs/${job.jobId}/${suffix}`;
        const access = [];
        for (const token of [
          world.workflow.token,
          world.cron.token,
          `sa_svc_${"A".repeat(43)}`,
          undefined,
        ]) {
          const result = await call(world.origin, path, { token });
          access.push(result.status);
          if (access.length > 1 && result.text.includes(job.jobId)) {
            throw new Error("Denied response disclosed the job");
          }
        }
        statuses[suffix] = access;
      }
      send(statuses);
    } else if (input === "hand-claims") {
      const result = await world.owner.query(
        "SELECT count(*)::int AS issued, count(claimed_at)::int AS claimed FROM job_stage_claims WHERE job_id = $1 AND stage = 'hand_pose'",
        [job.jobId],
      );
      send(result.rows[0]);
    } else if (input === "stages") {
      send(await world.stageRows(job.jobId));
    } else if (input === "expire") {
      await world.expireLease(job.jobId);
      send({ expired: true });
    } else {
      throw new Error("Unknown fixture command");
    }
  }
} finally {
  commands?.close();
  process.stdin.pause();
  try {
    if (runner && runner.exitCode === null && runner.signalCode === null) {
      runner.kill("SIGTERM");
      if (
        !(await Promise.race([
          runnerClosed.then(() => true),
          pause(3000).then(() => false),
        ]))
      ) {
        runner.kill("SIGKILL");
        await runnerClosed;
      }
    }
  } finally {
    await world.stop();
    if (shutdownRequested) console.log(JSON.stringify({ stopped: true }));
  }
}
