import assert from "node:assert/strict";
import { test } from "node:test";
import { hashServiceToken } from "../src/auth/service.js";
import { modalRecoveryBootstrapHash } from "../src/jobs/operator-db.js";
import { requestSha256, type ControllerActionV2 } from "@stateaction/contracts";
import { processRecordingTaskInputV2 } from "../src/admission/job-input.js";
import { jobHandlers } from "../src/jobs/http.js";
import { reconcileJob } from "../src/jobs/recovery.js";
import { admitNextJob, requestJobCancel } from "../src/jobs/service.js";
import {
  depsFor,
  jobsDatabase,
  jobRow,
  owner,
  queuedJob,
  slotHolder,
} from "./jobs-harness.js";
import { recipe } from "./recipe-harness.js";

for (const staged of [false, true]) {
  test(`exact Modal proof recovers a lost acknowledgement (${staged ? "stage" : "job"})`, async () => {
    const db = await jobsDatabase();
    try {
      const { jobId } = await queuedJob(db);
      const dependencies = depsFor(db);
      const processingRecipe = recipe();
      const stage = processingRecipe.stages[0];
      const deps = {
        ...dependencies,
        config: { ...dependencies.config, executionBackend: "modal" as const },
        ...(staged
          ? {
              taskInput: async (_tx: unknown, job: { jobId: string }) => ({
                ...(await processRecordingTaskInputV2(db.app, job.jobId)),
                schemaVersion: 3,
                recipe: processingRecipe,
                recipeSha256: requestSha256(processingRecipe),
              }),
            }
          : {}),
      };
      const handlers = jobHandlers(() => deps);
      const invoke = async (action: ControllerActionV2, status = 200) => {
        const response = await handlers.controller(
          new Request("http://127.0.0.1/controller", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(action),
          }),
          jobId,
          "test:operator-reconcile",
        );
        const output = await response.json();
        assert.equal(response.status, status, JSON.stringify(output.error));
        return output;
      };

      const admission = await admitNextJob(deps);
      assert.equal(admission.state, "admitted");
      const firstOwner = owner();
      const runRef = "trn-original";
      const callId = "fc-RecoveredCall";
      await invoke({ action: "claim_lease", owner: firstOwner, runRef });
      let claim;
      if (staged) {
        claim = await invoke({
          action: "issue_stage_claim",
          owner: firstOwner,
          stage: stage.stage,
        });
        await invoke({
          action: "record_stage_run",
          owner: firstOwner,
          stage: stage.stage,
          module: stage.module,
          state: "submit_unknown",
        });
      } else {
        claim = await invoke({
          action: "record_worker_submission",
          owner: firstOwner,
        });
      }
      await invoke({ action: "mark_submit_unknown", owner: firstOwner });
      assert.equal((await jobRow(db, jobId)).state, "submit_unknown");
      assert.equal(await slotHolder(db), jobId);
      await requestJobCancel(deps, jobId, {
        expectedState: "submit_unknown",
        requireCurrent: true,
      });
      const held = await reconcileJob(deps, {
        jobId,
        expectedState: "cancel_requested",
        recordedBy: "operator_cli",
      });
      assert.equal(held.state, "cancel_requested");
      assert.equal(held.holdsSlot, true);
      const identity = {
        jobId,
        runRef,
        ...(staged ? { stage: stage.stage } : {}),
      };
      assert.equal(
        await modalRecoveryBootstrapHash(db.owner, identity),
        hashServiceToken(claim.data.bootstrapToken),
      );
      await assert.rejects(() =>
        modalRecoveryBootstrapHash(db.owner, {
          ...identity,
          runRef: "trn-unrelated",
        }),
      );

      await db.owner.query(
        "UPDATE jobs SET controller_lease_expires_at = now() WHERE id = $1",
        [jobId],
      );

      const recoveryOwner = owner();
      const proof = {
        action: "record_execution_evidence",
        evidence: { kind: "provider_call_terminal", executionRef: callId },
      } as const;
      const lease = await invoke({
        action: "claim_lease",
        owner: recoveryOwner,
        runRef,
      });
      assert.equal(lease.data.granted, true);
      await invoke(proof, 409);
      if (staged) {
        await invoke({
          action: "record_stage_run",
          owner: recoveryOwner,
          stage: stage.stage,
          module: stage.module,
          state: "running",
          callId,
        });
      } else {
        await invoke({
          action: "record_execution",
          owner: recoveryOwner,
          executor: { kind: "modal", functionCallId: callId },
        });
      }
      const evidence = await invoke(proof);
      assert.equal(evidence.data.slotReleased, false);
      assert.equal(await slotHolder(db), jobId);
      if (staged) {
        // A lost HTTP acknowledgement after the provider proof commits must not let repair
        // strand this stage in running. A new operator entry can take over the original lease.
        const incomplete = await reconcileJob(deps, {
          jobId,
          expectedState: "cancel_requested",
          recordedBy: "operator_cli",
        });
        assert.equal(incomplete.state, "cancel_requested");
        assert.equal(incomplete.holdsSlot, true);
        assert.equal(incomplete.hasEvidence, true);
        await db.owner.query(
          "UPDATE jobs SET controller_lease_expires_at = now() WHERE id = $1",
          [jobId],
        );
        const successor = owner();
        const newLease = await invoke({
          action: "claim_lease",
          owner: successor,
          runRef,
        });
        assert.equal(newLease.data.granted, true);
        assert.equal((await invoke(proof)).data.slotReleased, false);
        await invoke({
          action: "record_stage_run",
          owner: successor,
          stage: stage.stage,
          module: stage.module,
          state: "cancelled",
          callId,
          errorCode: "cancel_requested",
        });
      }

      const settled = await reconcileJob(deps, {
        jobId,
        expectedState: "cancel_requested",
        recordedBy: "operator_cli",
      });
      assert.equal(settled.state, "cancelled");
      assert.equal(settled.hasEvidence, true);
      assert.equal(settled.holdsSlot, false);
      assert.equal((await invoke(proof)).data.slotReleased, true);
    } finally {
      await db.close();
    }
  });
}
