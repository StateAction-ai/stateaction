// SA-27 dispatch and the controller-loss / runner-loss cases (own world per case).
// Split from the former single controller.e2e.test.mjs (SA-114); shared helpers live in
// controller-support.mjs. Each file is its own process and creates its own worlds.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Render } from "@renderinc/sdk";
import { freePort } from "./harness.mjs";
import {
  controllerProcess,
  dispatch,
  evidence,
  finished,
  installTeardown,
  startRunner,
  until,
  workers,
  world,
} from "./controller-support.mjs";

installTeardown();

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
});
