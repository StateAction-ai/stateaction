// SA-26 REAL INTEGRATION: the official `render workflows dev` runner invokes the
// registered `process-recording` task, which runs the shared controller against
// the production Next API (restricted role) and Postgres, spawning the real
// Python CLI as a detached child. Controller loss, runner loss, lost
// acknowledgement and uncertain child identity use REAL processes and the
// REAL state machine. The pipeline is the explicit local-only no-output fixture:
// this proves controller/executor/claim plumbing only. No hand pose, no output
// acceptance (SA-28), no Modal, no Render cloud, no physical device.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Render } from "@renderinc/sdk";
import { call, freePort, jobsDir, startWorld } from "./harness.mjs";

// Defaults are the dependencies the preceding CI stages install into this tree:
// the checksum-pinned official Render CLI (render-cli stage) and the locked
// processing venv (python-sync stage). An override must still be an executable file.
const repoRoot = resolvePath(
  fileURLToPath(new URL("../../../", import.meta.url)),
);
export const RENDER_CLI =
  process.env.RENDER_CLI ??
  join(repoRoot, "artifacts/platform-tools/render/render");
export const PYTHON =
  process.env.PYTHON_EXECUTABLE ??
  join(repoRoot, "workers/processing/.venv/bin/python");
for (const file of [RENDER_CLI, PYTHON]) accessSync(file, constants.X_OK); // throws with the path if the stage did not install it
// Local-only run: a loopback runner and API, no provider or cloud credentials.
for (const k of ["RENDER_API_KEY", "RENDER_WORKSPACE_ID"])
  assert.equal(process.env[k], undefined, `${k} must not be set`);
// Controller-only cases schedule tasks through the local runner. The repair
// integration below covers scheduling through the API.
export async function dispatchOnce(w, render) {
  const result = await w.admit();
  const dispatched = [];
  for (const pending of result.pendingDispatches) {
    const run = await render.startTask(
      "process-recording",
      [{ jobId: pending.jobId }],
      {
        idempotencyKey: pending.dispatchKey,
        signal: AbortSignal.timeout(10_000),
      },
    );
    dispatched.push({ jobId: pending.jobId, taskRunId: run.taskRunId });
  }
  return { admission: result.admission, dispatched };
}
const worlds = [];
const procs = [];
export const evidence = {};

export const workers = (ref) =>
  readdirSync("/proc")
    .filter((n) => /^\d+$/.test(n))
    .filter((n) => {
      try {
        return readFileSync(`/proc/${n}/cmdline`, "utf8")
          .split("\0")
          .includes(ref);
      } catch {
        return false;
      }
    })
    .map(Number);

export async function world(extraEnv = {}) {
  const w = await startWorld(extraEnv);
  worlds.push(w);
  w.state = join(w.secretsDir, "state");
  mkdirSync(w.state, { mode: 0o700 });
  return w;
}
export const ctlEnv = (w, hold, extra = {}) => ({
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  APP_ENV: "local",
  EXECUTION_BACKEND: "local",
  STATEACTION_API_URL: w.origin,
  CONTROLLER_CAPABILITY_FILE: w.workflow.file,
  JOBS_STATE_DIR: w.state,
  PYTHON_EXECUTABLE: PYTHON,
  WORKER_PIPELINE: "local_fixture_noop",
  WORKER_FIXTURE_HOLD_SECONDS: String(hold),
  CONTROLLER_RENEW_MS: "1000",
  CONTROLLER_POLL_MS: "200",
  CONTROLLER_LEASE_WAIT_MS: "0",
  ...extra,
});
export function controllerProcess(w, jobId, runRef, hold = 0, extraEnv = {}) {
  const child = spawn(
    process.execPath,
    [join(jobsDir, "test-integration/controller-process.mjs")],
    {
      cwd: jobsDir,
      env: {
        ...ctlEnv(w, hold),
        ...extraEnv,
        TEST_JOB_ID: jobId,
        TEST_RUN_REF: runRef,
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  procs.push(child);
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  // Bounded: a controller that never finishes fails the case with its output, not a 300 s timeout.
  const done = new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
      resolve({ crashed: out.slice(-4000), timedOut: true });
    }, 150_000);
    child.on("close", () => clearTimeout(timer));
    child.on("close", (code, signal) => {
      try {
        resolve(JSON.parse(out.trim().split("\n").at(-1)));
      } catch {
        resolve({ crashed: out.slice(-4000), code, signal });
      }
    });
  });
  return { child, done };
}
export async function until(what, fn, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await sleep(250);
  }
}
export async function startRunner(w, hold, fixedPort) {
  const port = fixedPort ?? (await freePort());
  const envFile = join(w.secretsDir, `runner-${port}.env`);
  writeFileSync(
    envFile,
    Object.entries(ctlEnv(w, hold, { CONTROLLER_LEASE_WAIT_MS: "5000" }))
      .filter(([k]) => !["PATH", "HOME"].includes(k))
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
    { mode: 0o600 },
  );
  chmodSync(envFile, 0o600);
  const runner = spawn(
    RENDER_CLI,
    [
      "workflows",
      "dev",
      "--port",
      String(port),
      "--env-file",
      envFile,
      "--",
      "node",
      "dist/index.js",
    ],
    {
      cwd: jobsDir,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  procs.push(runner);
  let log = "";
  runner.stdout.on("data", (c) => (log += c));
  runner.stderr.on("data", (c) => (log += c));
  await until("official runner to list process-recording", () => {
    const r = spawnSync(
      RENDER_CLI,
      [
        "workflows",
        "tasks",
        "list",
        "--local",
        "--port",
        String(port),
        "-o",
        "text",
      ],
      { encoding: "utf8" },
    );
    return r.status === 0 && r.stdout.includes("process-recording");
  });
  const url = `http://127.0.0.1:${port}`;
  assert.equal(
    new URL(url).hostname,
    "127.0.0.1",
    "loopback local runner only",
  );
  assert.equal(ctlEnv(w, 0).EXECUTION_BACKEND, "local");
  const render = new Render({ useLocalDev: true, localDevUrl: url });
  return {
    port,
    render,
    log: () => log,
    kill: () => {
      try {
        process.kill(-runner.pid, "SIGKILL");
      } catch {}
    },
  };
}
export const dispatch = (w, runner) => dispatchOnce(w, runner.render.workflows);
export async function finished(runner, taskRunId, ms = 120_000) {
  return until(
    "task run result",
    async () => {
      const run = await runner.render.workflows.getTaskRun(taskRunId);
      if (["failed", "canceled"].includes(run.status))
        throw new Error(
          `task ${run.status}: ${JSON.stringify(run).slice(0, 400)}`,
        );
      return run.status === "completed" ? run : undefined;
    },
    ms,
  );
}

/** Kill only children this test's own journals created (never other workers' jobs). */
function reapOwnedChildren() {
  for (const w of worlds) {
    let jobs = [];
    try {
      jobs = readdirSync(w.state);
    } catch {}
    for (const job of jobs) {
      // The job journal, and (SA-91) one journal per recipe stage.
      for (const dir of ["", "segment", "caption", "hand_pose"]) {
        try {
          const ref = JSON.parse(
            readFileSync(join(w.state, job, dir, "journal.json"), "utf8"),
          ).executionRef;
          for (const pid of workers(ref)) process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
  }
}

// Tear down every process a case started (Next API, runner, controller, child) as
// soon as the case ends, not at the end of the file. The CI guard runs the whole
// stage in one scope capped at 256 tasks (threads included); worlds kept alive until
// the end exhausted it on the fifth case, and Node then aborted (SIGABRT) with no
// output when libuv could not create a worker thread (clone3 EAGAIN).
async function teardownCase() {
  for (const p of procs.splice(0)) {
    try {
      process.kill(-p.pid, "SIGKILL");
    } catch {}
  }
  reapOwnedChildren();
  for (const w of worlds.splice(0)) await w.stop().catch(() => {});
}
/** Register the per-case and end-of-file teardown; call once at the top of each test file. */
export function installTeardown() {
  afterEach(teardownCase);
  after(async () => {
    await teardownCase();
    if (process.env.SA26_E2E_EVIDENCE)
      process.stdout.write(`SA26_E2E_EVIDENCE ${JSON.stringify(evidence)}\n`);
  });
}
