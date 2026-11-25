import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { advanceResult } from "../src/acceptance/service.js";
import { selectReviewClipResult } from "../src/datasets/select-review-result.js";
import { admitNextJob, claimControllerLease } from "../src/jobs/service.js";
import {
  confirmStageRerunV2,
  planStageRerunV2,
} from "../src/jobs/stage-rerun-v2.js";
import { recipeJob, runRecipe, seal } from "./recipe-harness.js";

test("manual selection of a migrated whole recording keeps both result ledgers aligned", async (t) => {
  const original = await recipeJob({}, (db) => t.after(() => db.close()));
  const { db, deps, accept, jobId, recordingId, ctl } = original;
  await seal(original, await runRecipe(original));
  assert.equal(
    (await advanceResult(accept, jobId))?.candidateStatus,
    "accepted",
  );

  const staff = db.actors.staff;
  const rerun = { pool: db.app, reader: accept.reader };
  const input = {
    schemaVersion: 2,
    scope: "clip",
    clipId: recordingId,
    parentJobId: jobId,
    stages: ["segment", "caption", "hand_pose"],
  } as const;
  const request = { ...input, stages: [...input.stages] };
  const plan = await planStageRerunV2(rerun, staff, recordingId, request);
  const secondJobId = randomUUID();
  const receipt = await confirmStageRerunV2(rerun, staff, recordingId, {
    ...request,
    requestId: secondJobId,
    expectedPlanSha256: plan.planSha256,
    expectedMaxComputeCostUsd: plan.maxComputeCostUsd,
    expectedMaxGpuCostUsd: plan.maxGpuCostUsd,
    reason: "Verify a second accepted result",
  });
  assert.equal(receipt.jobs[0]?.jobId, secondJobId);
  assert.equal((await admitNextJob(deps)).state, "admitted");
  assert.equal(
    (
      await claimControllerLease(deps, {
        jobId: secondJobId,
        runRef: "run-2",
        owner: ctl,
      })
    ).granted,
    true,
  );
  const second = { ...original, jobId: secondJobId };
  await seal(second, await runRecipe(second));
  assert.equal(
    (await advanceResult(accept, secondJobId))?.candidateStatus,
    "accepted",
  );

  async function pointers() {
    return (
      await db.app.query(
        `
      SELECT c.selected_job_id AS clip, recording_selected_job(c.recording_id) AS recording,
        (SELECT max(seq) FROM clip_result_selections s WHERE s.clip_id = c.id) AS seq
      FROM review_clips c WHERE c.id = $1
    `,
        [recordingId],
      )
    ).rows[0];
  }
  const before = await pointers();
  assert.deepEqual(before, {
    clip: secondJobId,
    recording: secondJobId,
    seq: 2,
  });
  assert.deepEqual(
    await selectReviewClipResult(db.app, {
      clipId: recordingId,
      viewerUserId: staff,
      expectedSelectionSeq: before.seq,
      jobId,
      reason: "Return to the first result",
    }),
    { jobId, selectionRevision: 3 },
  );
  assert.deepEqual(await pointers(), { clip: jobId, recording: jobId, seq: 3 });
});
