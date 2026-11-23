// SA-26 happy path, late proof and lost-acknowledgement cases (own world per case).
// Split from the former single controller.e2e.test.mjs (SA-114); shared helpers live in
// controller-support.mjs. Each file is its own process and creates its own worlds.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Render } from "@renderinc/sdk";
import { call } from "./harness.mjs";
import {
  PYTHON,
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

  test("SA-72 late proof: controller lost past a short initial deadline -> needs_attention (slot held) -> real late evidence -> repair fails the job and frees the slot", async () => {
    const w = await world();
    const job = await w.queuedJob();
    // Short initial immutable deadline via the library admission seam; never rewritten.
    assert.equal((await w.admitWithDeadline(12)).state, "admitted");
    const first = controllerProcess(w, job.jobId, "run-late", 60);
    const ref = await until(
      "claimed child",
      async () =>
        (await w.row(job.jobId)).claimed_at &&
        (await w.row(job.jobId)).execution_call_id,
    );
    process.kill(-first.child.pid, "SIGKILL"); // controller loss; child survives
    await first.done;
    const deadline = Date.parse((await w.row(job.jobId)).execution_deadline);
    await sleep(Math.max(0, deadline - Date.now()) + 2000);
    await w.lapseLease(job.jobId);
    await w.admit(); // real Next reconcile: no evidence yet -> needs_attention
    let r = await w.row(job.jobId);
    assert.equal(r.state, "needs_attention");
    assert.equal(r.slot_holder, job.jobId);
    assert.equal(r.evidence, null, "no proof: not failed, slot held");
    await w.admit();
    assert.equal((await w.row(job.jobId)).state, "needs_attention");
    // The restarted controller (same run) proves the physical end for real.
    const second = controllerProcess(w, job.jobId, "run-late");
    const out = await second.done;
    assert.equal(out.evidence, "recorded", JSON.stringify(out));
    assert.equal(workers(ref).length, 0);
    await w.admit(); // reconcile repair settles with the late proof
    r = await w.row(job.jobId);
    assert.equal(r.state, "failed");
    assert.equal(r.slot_holder, null);
    const err = await w.owner.query(
      "SELECT error_code, (SELECT count(*)::int FROM clips WHERE job_id = $1) AS clips FROM jobs WHERE id = $1",
      [job.jobId],
    );
    assert.deepEqual(err.rows[0], {
      error_code: "worker_exited_without_result",
      clips: 0,
    });
    evidence.lateProof = { executionRef: ref, finalState: r.state };
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
