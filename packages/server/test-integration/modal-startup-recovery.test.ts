import assert from "node:assert/strict";
import { test } from "node:test";
import { requestSha256 } from "@stateaction/contracts";
import { processRecordingTaskInputV2 } from "../src/admission/job-input.js";
import { recoverModalStartupFailure } from "../src/jobs/modal-startup-recovery.js";
import {
  claimStage,
  issueStageClaim,
  recordStageRun,
} from "../src/jobs/stages.js";
import {
  admitNextJob,
  claimControllerLease,
  recordExecutionEvidence,
} from "../src/jobs/service.js";
import {
  depsFor,
  jobsDatabase,
  nonce,
  owner,
  queuedJob,
  slotHolder,
} from "./jobs-harness.js";
import { recipe } from "./recipe-harness.js";

for (const acquired of [false, true]) {
  test(`Modal startup settlement ${acquired ? "refuses an actual worker claim" : "records exact evidence and releases admission once"}`, async () => {
    const db = await jobsDatabase();
    try {
      const { jobId } = await queuedJob(db);
      const config = depsFor(db);
      const plan = recipe();
      const deps = {
        ...config,
        config: { ...config.config, executionBackend: "modal" as const },
        taskInput: async (
          tx: Parameters<typeof processRecordingTaskInputV2>[0],
        ) => ({
          ...(await processRecordingTaskInputV2(tx, jobId)),
          schemaVersion: 3,
          recipe: plan,
          recipeSha256: requestSha256(plan),
        }),
      };
      assert.equal((await admitNextJob(deps)).state, "admitted");
      const runRef = "trn-original";
      const ctl = owner();
      assert.equal(
        (await claimControllerLease(deps, { jobId, runRef, owner: ctl }))
          .granted,
        true,
      );
      const first = plan.stages[0];
      const second = plan.stages[1];
      const firstClaim = await issueStageClaim(deps, {
        jobId,
        owner: ctl,
        stage: first.stage,
      });
      if (firstClaim.state !== "recorded")
        throw new Error("Fixture did not issue a first claim");
      const firstCall = "fc-EarlierStage";
      await recordStageRun(deps, {
        jobId,
        owner: ctl,
        stage: first.stage,
        module: first.module,
        state: "running",
        callId: firstCall,
      });
      await claimStage(deps, {
        jobId,
        bootstrapToken: firstClaim.bootstrapToken,
        invocationNonce: nonce(),
        executor: { kind: "modal", functionCallId: firstCall },
      });
      await recordExecutionEvidence(deps, {
        jobId,
        recordedBy: "fixture",
        evidence: { kind: "provider_call_terminal", executionRef: firstCall },
      });
      await recordStageRun(deps, {
        jobId,
        owner: ctl,
        stage: first.stage,
        module: first.module,
        state: "failed",
        callId: firstCall,
        errorCode: "fixture_prior_failure",
      });

      const callId = "fc-FailedBeforeStart";
      const current = await issueStageClaim(deps, {
        jobId,
        owner: ctl,
        stage: second.stage,
      });
      if (current.state !== "recorded")
        throw new Error("Fixture did not issue a second claim");
      await recordStageRun(deps, {
        jobId,
        owner: ctl,
        stage: second.stage,
        module: second.module,
        state: "running",
        callId,
      });
      if (acquired) {
        await claimStage(deps, {
          jobId,
          bootstrapToken: current.bootstrapToken,
          invocationNonce: nonce(),
          executor: { kind: "modal", functionCallId: callId },
        });
      }
      const input = { jobId, runRef, stage: second.stage, callId };
      const proof = {
        callId,
        status: "terminated",
        inputId: "in-Exact",
        outputCreatedAt: 1,
      } as const;
      const settle = () =>
        recoverModalStartupFailure(db.owner, input, async () => proof);
      await assert.rejects(settle);
      assert.equal(await slotHolder(db), jobId);
      await db.owner.query(
        "UPDATE jobs SET controller_lease_expires_at = now() - interval '1 second' WHERE id = $1",
        [jobId],
      );

      await assert.rejects(
        recoverModalStartupFailure(
          db.owner,
          { ...input, runRef: "trn-other" },
          async () => proof,
        ),
      );
      await assert.rejects(
        recoverModalStartupFailure(
          db.owner,
          { ...input, callId: "fc-Wrong" },
          async (id) => ({ ...proof, callId: id }),
        ),
        /unclaimed stage/,
      );
      await assert.rejects(
        recoverModalStartupFailure(db.owner, input, async () => ({
          ...proof,
          callId: "fc-Wrong",
        })),
        /Invalid Modal startup evidence/,
      );
      assert.equal(await slotHolder(db), jobId);
      if (acquired) {
        await assert.rejects(settle, /unclaimed stage/);
        assert.equal(await slotHolder(db), jobId);
        return;
      }

      async function snapshot() {
        const { rows } = await db.owner.query(
          "SELECT stage,state,error_code,call_id FROM job_stage_runs WHERE job_id=$1 ORDER BY stage",
          [jobId],
        );
        return rows;
      }
      assert.deepEqual(await settle(), {
        state: "failed",
        stageState: "failed",
        reason: "terminated_before_start",
        replayed: false,
      });
      assert.equal(await slotHolder(db), null);
      const initial = await snapshot();
      assert.equal(
        initial.find((row) => row.stage === first.stage).error_code,
        "fixture_prior_failure",
      );
      assert.deepEqual(
        initial.find((row) => row.stage === second.stage),
        {
          stage: second.stage,
          state: "failed",
          error_code: "terminated_before_start",
          call_id: callId,
        },
      );
      assert.equal((await settle()).replayed, true);
      assert.deepEqual(await snapshot(), initial);
      const { rows } = await db.owner.query(
        "SELECT execution_ref, detail FROM job_execution_evidence WHERE job_id=$1",
        [jobId],
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].execution_ref, callId);
      assert.equal(rows[0].detail.proof, "modal_terminal_before_input_start");
    } finally {
      await db.close();
    }
  });
}
