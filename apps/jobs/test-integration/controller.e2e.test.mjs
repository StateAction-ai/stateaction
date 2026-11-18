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
import { after, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Render } from "@renderinc/sdk";
import { call, freePort, jobsDir, startWorld } from "./harness.mjs";

// Defaults are the dependencies the preceding CI stages install into this tree:
// the checksum-pinned official Render CLI (render-cli stage) and the locked
// processing venv (python-sync stage). An override must still be an executable file.
const repoRoot = resolvePath(
  fileURLToPath(new URL("../../../", import.meta.url)),
);
const RENDER_CLI =
  process.env.RENDER_CLI ??
  join(repoRoot, "artifacts/platform-tools/render/render");
const PYTHON =
  process.env.PYTHON_EXECUTABLE ??
  join(repoRoot, "workers/processing/.venv/bin/python");
for (const file of [RENDER_CLI, PYTHON]) accessSync(file, constants.X_OK); // throws with the path if the stage did not install it
// Local-only run: a loopback runner and API, no provider or cloud credentials.
for (const k of ["RENDER_API_KEY", "RENDER_WORKSPACE_ID"])
  assert.equal(process.env[k], undefined, `${k} must not be set`);
// Controller-only cases schedule tasks through the local runner. The repair
// integration below covers scheduling through the API.
async function dispatchOnce(w, render) {
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
const evidence = {};

const workers = (ref) =>
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

async function world(extraEnv = {}) {
  const w = await startWorld(extraEnv);
  worlds.push(w);
  w.state = join(w.secretsDir, "state");
  mkdirSync(w.state, { mode: 0o700 });
  return w;
}
const ctlEnv = (w, hold, extra = {}) => ({
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
function controllerProcess(w, jobId, runRef, hold = 0) {
  const child = spawn(
    process.execPath,
    [join(jobsDir, "test-integration/controller-process.mjs")],
    {
      cwd: jobsDir,
      env: { ...ctlEnv(w, hold), TEST_JOB_ID: jobId, TEST_RUN_REF: runRef },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  procs.push(child);
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  const done = new Promise((resolve) =>
    child.on("close", () => {
      try {
        resolve(JSON.parse(out.trim().split("\n").at(-1)));
      } catch {
        resolve({ crashed: out.slice(-500) });
      }
    }),
  );
  return { child, done };
}
async function until(what, fn, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${what}`);
    await sleep(250);
  }
}
async function startRunner(w, hold, fixedPort) {
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
const dispatch = (w, runner) => dispatchOnce(w, runner.render.workflows);
async function finished(runner, taskRunId, ms = 120_000) {
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
      try {
        const ref = JSON.parse(
          readFileSync(join(w.state, job, "journal.json"), "utf8"),
        ).executionRef;
        for (const pid of workers(ref)) process.kill(pid, "SIGKILL");
      } catch {}
    }
  }
}

after(async () => {
  for (const p of procs) {
    try {
      process.kill(-p.pid, "SIGKILL");
    } catch {}
  }
  reapOwnedChildren();
  for (const w of worlds) await w.stop().catch(() => {});
  if (process.env.SA26_E2E_EVIDENCE)
    process.stdout.write(`SA26_E2E_EVIDENCE ${JSON.stringify(evidence)}\n`);
});

describe("SA-27 API-owned dispatch: the cron client only calls the API", () => {
  test("a repair pass admits and the API starts the official runner task once; a second pass starts nothing", async () => {
    const { JobsApi } = await import("../dist/api-client.js");
    const { repairOnce } = await import("../dist/repair.js");
    const port = await freePort();
    const w = await world({
      RENDER_USE_LOCAL_DEV: "true",
      RENDER_LOCAL_DEV_URL: `http://127.0.0.1:${port}`,
    });
    const job = await w.queuedJob();
    const runner = await startRunner(w, 1, port);
    // The cron client holds only the API origin and the repair-scoped token.
    const cron = new JobsApi(w.origin, w.cron.token, 55_000);
    assert.equal((await repairOnce(cron)).admission, "admitted");
    const row = await until(
      "controller to record the run and evidence",
      async () => {
        const r = await w.row(job.jobId);
        return r.workflow_run_ref && r.evidence ? r : undefined;
      },
      120_000,
    );
    assert.equal(
      row.slot_holder,
      job.jobId,
      "evidence alone never frees the slot",
    );
    assert.match(row.evidence, /^local_child_reaped:/);
    const run = await finished(runner, row.workflow_run_ref);
    assert.equal(run.results[0].evidence, "recorded");
    const second = await repairOnce(cron);
    assert.equal(
      second.pendingDispatches,
      0,
      "run recorded: nothing left to start",
    );
    assert.equal(
      (await w.row(job.jobId)).workflow_run_ref,
      row.workflow_run_ref,
    );
    runner.kill();
  });
});

describe("SA-26 controller on the official Render local runner with real API, Postgres and a real child", () => {
  test("happy path: dispatch -> process-recording -> one claim -> reaped evidence; slot stays held until a terminal state exists", async () => {
    const w = await world();
    const job = await w.queuedJob();
    const admitted = await w.admit();
    assert.equal(admitted.admission.state, "admitted");
    const runner = await startRunner(w, 2);
    const sent = await dispatch(w, runner);
    assert.deepEqual(
      sent.dispatched.map((d) => d.jobId),
      [job.jobId],
    );
    const run = await finished(runner, sent.dispatched[0].taskRunId);
    const result = run.results[0];
    assert.equal(result.outcome, "child_exited", JSON.stringify(result));
    assert.equal(result.evidence, "recorded");
    assert.equal(result.exit.code, 0);
    const row = await w.row(job.jobId);
    assert.equal(row.workflow_run_ref, sent.dispatched[0].taskRunId);
    assert.equal(row.execution_call_id, result.executionRef);
    assert.ok(
      row.claimed_at && row.invocation_nonce,
      "the physical child won exactly one claim",
    );
    assert.ok(row.last_heartbeat_at, "worker heartbeat reached the API");
    assert.equal(
      row.state,
      "running",
      "no output was accepted, so the job is NOT terminal",
    );
    assert.equal(row.evidence, `local_child_reaped:${result.executionRef}`);
    assert.equal(
      row.slot_holder,
      job.jobId,
      "evidence alone never releases the slot",
    );
    assert.equal(workers(result.executionRef).length, 0);
    const journalDir = readdirSync(w.state);
    for (const f of readdirSync(join(w.state, journalDir[0])))
      assert.ok(
        !/sa_svc_/.test(readFileSync(join(w.state, journalDir[0], f), "utf8")),
        f,
      );
    assert.ok(
      !/sa_svc_/.test(runner.log()),
      "runner log carries no capability",
    );
    assert.equal(
      (await w.admit()).pendingDispatches.length,
      0,
      "run is recorded; nothing left to dispatch",
    );
    // The terminal business state (SA-28's job) is the second release fact.
    await w.owner.query(
      "UPDATE jobs SET state = 'failed', finished_at = now() WHERE id = $1",
      [job.jobId],
    );
    assert.equal((await w.row(job.jobId)).slot_holder, null);
    evidence.happy = {
      taskRunId: sent.dispatched[0].taskRunId,
      executionRef: result.executionRef,
    };
    runner.kill();
  });

  test("controller loss: a restarted controller (same run) adopts the known child; exactly one child and one claim", async () => {
    const w = await world();
    const job = await w.queuedJob();
    await w.admit();
    const first = controllerProcess(w, job.jobId, "run-loss", 25);
    const ref = await until(
      "claimed child",
      async () =>
        (await w.row(job.jobId)).claimed_at &&
        (await w.row(job.jobId)).execution_call_id,
    );
    const pids = workers(ref);
    assert.equal(pids.length, 1);
    const before = await w.row(job.jobId);
    process.kill(-first.child.pid, "SIGKILL"); // controller loss; the detached child survives
    await first.done;
    assert.deepEqual(workers(ref), pids, "child survived controller loss");
    await w.expireLease(job.jobId);
    const second = controllerProcess(w, job.jobId, "run-loss");
    const out = await second.done;
    assert.equal(out.outcome, "child_exited", JSON.stringify(out));
    assert.equal(out.executionRef, ref);
    assert.equal(out.evidence, "recorded");
    const after = await w.row(job.jobId);
    assert.equal(
      after.invocation_nonce,
      before.invocation_nonce,
      "no second claim",
    );
    assert.equal(
      after.evidence_detail.observation,
      "adopted_single_process_exited",
    );
    assert.equal(after.evidence_detail.proof, "seccomp_single_process_exited");
    assert.equal(after.slot_holder, job.jobId);
    assert.equal(workers(ref).length, 0);
    evidence.adopt = { executionRef: ref, originalPid: pids[0] };
  });

  test("runner loss: killing the official runner leaves the child; a new runner's different run is refused with no effects; same-run recovery adopts", async () => {
    const w = await world();
    const job = await w.queuedJob();
    await w.admit();
    const runner1 = await startRunner(w, 25);
    const sent = await dispatch(w, runner1);
    const runRef = sent.dispatched[0].taskRunId;
    const ref = await until(
      "claimed child",
      async () =>
        (await w.row(job.jobId)).claimed_at &&
        (await w.row(job.jobId)).execution_call_id,
    );
    const pids = workers(ref);
    assert.equal(pids.length, 1);
    runner1.kill();
    await sleep(1000);
    assert.deepEqual(workers(ref), pids, "detached child survives runner loss");
    await w.expireLease(job.jobId);
    const runner2 = await startRunner(w, 25);
    const redo = await runner2.render.workflows.startTask(
      "process-recording",
      [{ jobId: job.jobId }],
      { idempotencyKey: `job:${job.jobId}` },
    );
    const second = await finished(runner2, redo.taskRunId);
    assert.deepEqual(second.results[0], {
      outcome: "no_effect",
      reason: "run_rejected",
    });
    assert.deepEqual(
      workers(ref),
      pids,
      "different run touched nothing and spawned nothing",
    );
    assert.equal((await w.row(job.jobId)).evidence, null);
    const adopt = await controllerProcess(w, job.jobId, runRef).done;
    assert.equal(adopt.outcome, "child_exited", JSON.stringify(adopt));
    assert.equal(adopt.executionRef, ref);
    assert.equal(workers(ref).length, 0);
    evidence.runnerLoss = { runRef, differentRun: redo.taskRunId };
    runner2.kill();
  });

  test("lost submission acknowledgement and uncertain local-child identity never spawn a second child", async () => {
    // (a) intent durable server-side, bootstrap token lost: no journal.
    let w = await world();
    let job = await w.queuedJob();
    await w.admit();
    const act = (id, body) =>
      call(w.origin, `/internal/v1/jobs/${id}/controller`, {
        method: "POST",
        body,
        token: w.workflow.token,
      });
    assert.equal(
      (
        await act(job.jobId, {
          action: "claim_lease",
          runRef: "run-a",
          owner: "lost-ack",
        })
      ).json.data.granted,
      true,
    );
    assert.equal(
      (
        await act(job.jobId, {
          action: "record_worker_submission",
          owner: "lost-ack",
        })
      ).json.data.state,
      "recorded",
    );
    await w.expireLease(job.jobId);
    let out = await controllerProcess(w, job.jobId, "run-a").done;
    assert.equal(
      out.outcome === "submit_unknown" || out.outcome === "needs_operator",
      true,
      JSON.stringify(out),
    );
    let row = await w.row(job.jobId);
    assert.equal(row.state, "submit_unknown");
    assert.equal(row.claimed_at, null);
    assert.equal(row.evidence, null);
    assert.equal(row.slot_holder, job.jobId);
    // A forged bootstrap token cannot claim (the real worker exits before any pipeline import).
    const forged = spawnSync(
      PYTHON,
      [
        "-m",
        "stateaction_processing",
        "run-job",
        "--execution-ref",
        "local-forged",
      ],
      {
        input: JSON.stringify({
          schemaVersion: 1,
          apiUrl: w.origin,
          jobId: job.jobId,
          bootstrapToken: `sa_svc_${"A".repeat(43)}`,
          executionRef: "local-forged",
          pipeline: "local_fixture_noop",
        }),
        env: { PATH: process.env.PATH, APP_ENV: "local" },
        encoding: "utf8",
      },
    );
    assert.equal(forged.status, 75, forged.stderr);
    assert.equal((await w.row(job.jobId)).claimed_at, null);

    // (b) journal says "spawning" with no identity: the child may or may not exist.
    w = await world();
    job = await w.queuedJob();
    await w.admit();
    const act2 = (id, body) =>
      call(w.origin, `/internal/v1/jobs/${id}/controller`, {
        method: "POST",
        body,
        token: w.workflow.token,
      });
    await act2(job.jobId, {
      action: "claim_lease",
      runRef: "run-b",
      owner: "pre",
    });
    const sub = await act2(job.jobId, {
      action: "record_worker_submission",
      owner: "pre",
    });
    const ref = "local-uncertain-b";
    await act2(job.jobId, {
      action: "record_execution",
      owner: "pre",
      executor: { kind: "local", localExecutionRef: ref },
    });
    const dir = join(w.state, job.jobId);
    mkdirSync(dir, { mode: 0o700 });
    const { bootId } = await import("../dist/proc.js");
    writeFileSync(
      join(dir, "journal.json"),
      JSON.stringify({
        version: 1,
        jobId: job.jobId,
        runRef: "run-b",
        executionRef: ref,
        phase: "spawning",
        bootId: bootId(),
        startDeadline: sub.json.data.startDeadline,
        executionDeadline: sub.json.data.executionDeadline,
      }),
      { mode: 0o600 },
    );
    await w.expireLease(job.jobId);
    out = await controllerProcess(w, job.jobId, "run-b").done;
    assert.equal(out.outcome, "needs_operator", JSON.stringify(out));
    assert.equal(out.reason, "spawn_outcome_uncertain");
    row = await w.row(job.jobId);
    assert.equal(workers(ref).length, 0, "no second child");
    assert.equal(row.claimed_at, null);
    assert.equal(
      row.evidence,
      null,
      "uncertain identity records no physical evidence",
    );
    assert.equal(row.slot_holder, job.jobId, "nothing released");
    evidence.uncertain = { lostAck: "submit_unknown", spawning: out.reason };
  });
});
