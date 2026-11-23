// SA-91 recipe stages through the local runner (own world per case).
// Split from the former single controller.e2e.test.mjs (SA-114); shared helpers live in
// controller-support.mjs. Each file is its own process and creates its own worlds.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Render } from "@renderinc/sdk";
import { call } from "./harness.mjs";
import {
  controllerProcess,
  evidence,
  finished,
  installTeardown,
  startRunner,
  until,
  workers,
  world,
} from "./controller-support.mjs";

installTeardown();

describe("SA-91 recipe stages through the official local runner, the real API and real stage children", () => {
  const STUB = {
    segment: "stub_segmenter@1",
    caption: "stub_captioner@1",
    hand_pose: "hand_pose_cpu_v1@1",
  };
  const recipe = (captionEnabled = true) => {
    const resources = {
      gpu: "none",
      budgetSeconds: 300,
      maxContainers: 1,
      retries: 0,
    };
    return {
      schemaVersion: 1,
      recipeId: "stub_local@1",
      maxJobCostUsd: "0.00",
      stages: [
        {
          stage: "segment",
          enabled: true,
          module: STUB.segment,
          params: {},
          resources,
        },
        {
          stage: "caption",
          enabled: captionEnabled,
          module: STUB.caption,
          params: {},
          resources,
        },
        {
          stage: "hand_pose",
          enabled: true,
          module: STUB.hand_pose,
          params: {},
          resources,
        },
      ],
    };
  };

  test("process-recording runs every stage in order through local-process.ts; each row is in job_stage_runs with its proof; a same-run retry spawns nothing", async () => {
    // The harness source is synthetic bytes (no committed media), so no stage can remux it: the
    // truthful outcome is a FAILED segment with its receipt, caption not_run (upstream_failed),
    // and hand_pose still run through the SA-92 run-job worker under its stage claim, failing
    // with its own receipt (never a success). A sealing success needs a real simulated
    // recording upload: SA-100 (T15).
    const w = await world();
    const job = await w.queuedJob();
    assert.equal((await w.admitWithRecipe(recipe())).state, "admitted");
    const runner = await startRunner(w, 0);
    const run = await runner.render.workflows.startTask(
      "process-recording",
      [{ jobId: job.jobId }],
      {
        idempotencyKey: `job:${job.jobId}`,
        signal: AbortSignal.timeout(10_000),
      },
    );
    const done = await finished(runner, run.taskRunId, 240_000);
    const result = done.results[0];
    assert.equal(
      result.outcome,
      "recipe_run",
      JSON.stringify(result) + JSON.stringify(await w.stageRows(job.jobId)),
    );
    assert.equal(result.stopped, undefined, JSON.stringify(result));
    assert.deepEqual(
      result.stages.map((s) => s.stage),
      ["segment", "caption", "hand_pose"],
    );
    const rows = await w.stageRows(job.jobId);
    const by = Object.fromEntries(rows.map((r) => [r.stage, r]));
    assert.deepEqual(Object.keys(by), ["segment", "caption", "hand_pose"]);
    // segment: the real stub child claimed its stage with its local execution ref and failed truthfully.
    assert.equal(by.segment.state, "failed", JSON.stringify(by.segment));
    assert.ok(by.segment.error_code, "a failed stage carries its code");
    assert.match(by.segment.call_id, /^local-/);
    assert.equal(by.segment.claimed_call, by.segment.call_id);
    assert.equal(by.segment.proof, by.segment.call_id);
    // caption: never claimed, never spawned.
    assert.equal(by.caption.state, "not_run");
    assert.equal(by.caption.error_code, "upstream_failed");
    assert.equal(by.caption.call_id, null);
    assert.equal(by.caption.claimed_at, null);
    // hand_pose: always runs; the run-job worker claimed its stage, one child, proven gone,
    // recorded failed with the code from its own stage receipt.
    const handLog = () => {
      try {
        return readFileSync(
          join(w.state, job.jobId, "hand_pose", "child.log"),
          "utf8",
        ).slice(-1500);
      } catch {
        return "";
      }
    };
    assert.equal(
      by.hand_pose.state,
      "failed",
      JSON.stringify(by.hand_pose) + handLog(),
    );
    assert.ok(by.hand_pose.error_code);
    assert.notEqual(by.hand_pose.error_code, "receipt_missing", handLog());
    assert.match(by.hand_pose.call_id, /^local-/);
    assert.equal(by.hand_pose.claimed_call, by.hand_pose.call_id);
    assert.equal(by.hand_pose.proof, by.hand_pose.call_id);
    for (const stage of ["segment", "hand_pose"])
      assert.equal(workers(by[stage].call_id).length, 0);
    // The job's terminal evidence names the sealing stage's call, and the worker's recipe-mode
    // failure report (v2, diagnostics only) is accepted: the job ends failed, the slot is freed.
    const row = await until(
      "the failure report to be accepted",
      async () => {
        const r = await w.row(job.jobId);
        return r.state === "failed" ? r : undefined;
      },
      60_000,
    );
    assert.equal(row.evidence, `local_child_reaped:${by.hand_pose.call_id}`);
    assert.equal(row.slot_holder, null);
    // No capability on disk: per-stage journal directories hold no token.
    for (const stage of ["segment", "hand_pose"])
      for (const f of readdirSync(join(w.state, job.jobId, stage)))
        assert.ok(
          !/sa_svc_/.test(
            readFileSync(join(w.state, job.jobId, stage, f), "utf8"),
          ),
          `${stage}/${f}`,
        );
    // Render retry of the same run: the job has ended, so nothing is claimed or spawned again.
    const again = await controllerProcess(w, job.jobId, run.taskRunId).done;
    assert.deepEqual(again, { outcome: "not_admitted", state: "failed" });
    assert.deepEqual(await w.stageRows(job.jobId), rows);
    const claims = await w.owner.query(
      "SELECT stage FROM job_stage_claims WHERE job_id = $1 ORDER BY job_stage_ord(stage)",
      [job.jobId],
    );
    assert.deepEqual(
      claims.rows.map((r) => r.stage),
      ["segment", "hand_pose"],
    );
    evidence.recipe = {
      taskRunId: run.taskRunId,
      stages: rows.map((r) => [r.stage, r.state, r.error_code]),
    };
    runner.kill();
  });

  test("a disabled caption stage is recorded not_run (stage_disabled) and never claimed", async () => {
    const w = await world();
    const job = await w.queuedJob();
    assert.equal((await w.admitWithRecipe(recipe(false))).state, "admitted");
    const out = await controllerProcess(w, job.jobId, "run-disabled").done;
    assert.equal(out.outcome, "recipe_run", JSON.stringify(out));
    const by = Object.fromEntries(
      (await w.stageRows(job.jobId)).map((r) => [r.stage, r]),
    );
    assert.equal(by.caption.state, "not_run");
    assert.equal(by.caption.error_code, "stage_disabled");
    assert.equal(by.caption.claimed_at, null);
    assert.ok(["failed", "succeeded"].includes(by.segment.state));
    assert.ok(["failed", "succeeded"].includes(by.hand_pose.state));
    // The three controller reads: the workflow credential only. The repair (cron) credential,
    // a forged bearer and no bearer get nothing; a random job is not found.
    for (const path of ["recipe", "dag-run", "prior-stages"]) {
      const url = `/internal/v1/jobs/${job.jobId}/${path}`;
      const ok = await call(w.origin, url, { token: w.workflow.token });
      assert.equal(ok.status, 200, `${path}: ${ok.text}`);
      for (const token of [
        w.cron.token,
        `sa_svc_${"A".repeat(43)}`,
        undefined,
      ]) {
        const refused = await call(w.origin, url, { token });
        assert.ok(
          [401, 403].includes(refused.status),
          `${path}: ${refused.status}`,
        );
        assert.ok(
          !refused.text.includes(job.jobId),
          "nothing about the job leaks",
        );
      }
      const other = await call(
        w.origin,
        `/internal/v1/jobs/${crypto.randomUUID()}/${path}`,
        { token: w.workflow.token },
      );
      assert.equal(other.status, 404, `${path} other job: ${other.text}`);
    }
    const prior = (
      await call(w.origin, `/internal/v1/jobs/${job.jobId}/prior-stages`, {
        token: w.workflow.token,
      })
    ).json.data;
    assert.deepEqual(
      prior.stages.map((p) => [p.stage, p.state]),
      [
        ["segment", by.segment.state],
        ["caption", "not_run"],
      ],
    );
  });

  test("controller loss during the local hand_pose stage: the restarted controller adopts the child and keeps its logged receipt (never receipt_missing, never a respawn)", async () => {
    const w = await world();
    const job = await w.queuedJob();
    assert.equal((await w.admitWithRecipe(recipe(false))).state, "admitted");
    const first = controllerProcess(w, job.jobId, "run-restart");
    const journal = join(w.state, job.jobId, "hand_pose", "journal.json");
    const seen = await until(
      "the hand_pose child to be journaled running",
      () => {
        try {
          const j = JSON.parse(readFileSync(journal, "utf8"));
          return j.phase === "running" ? j : undefined;
        } catch {
          return undefined;
        }
      },
      120_000,
    );
    // Controller loss while the stage runs (the child is its own session and survives).
    process.kill(-first.child.pid, "SIGKILL");
    await first.done;
    await until(
      "the hand_pose child to exit",
      () => workers(seen.executionRef).length === 0,
    );
    assert.equal(JSON.parse(readFileSync(journal, "utf8")).phase, "running");
    await w.expireLease(job.jobId);
    const again = await controllerProcess(w, job.jobId, "run-restart").done;
    assert.equal(again.outcome, "recipe_run", JSON.stringify(again));
    const by = Object.fromEntries(
      (await w.stageRows(job.jobId)).map((r) => [r.stage, r]),
    );
    assert.equal(
      by.hand_pose.call_id,
      seen.executionRef,
      "adopted, not respawned",
    );
    assert.equal(by.hand_pose.state, "failed");
    assert.ok(by.hand_pose.error_code);
    assert.notEqual(by.hand_pose.error_code, "receipt_missing");
    assert.equal(by.hand_pose.proof, seen.executionRef);
    const claims = await w.owner.query(
      "SELECT count(*)::int AS n FROM job_stage_claims WHERE job_id = $1 AND stage = 'hand_pose'",
      [job.jobId],
    );
    assert.equal(claims.rows[0].n, 1);
  });
});
