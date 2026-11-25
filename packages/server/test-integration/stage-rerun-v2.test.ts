import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  requestSha256,
  validateValue,
  type RecipeV1,
} from "@stateaction/contracts";
import { processRecordingTaskInputV2 } from "../src/admission/job-input.js";
import { failUndispatched, retryJob } from "../src/jobs/recovery.js";
import { admitNextJob } from "../src/jobs/service.js";
import {
  confirmStageRerunV2,
  planStageRerunV2,
  type StageRerunCommandV2,
} from "../src/jobs/stage-rerun-v2.js";
import { depsFor, jobsDatabase, queuedJob } from "./jobs-harness.js";

const resources = {
  gpu: "none",
  budgetSeconds: 60,
  maxContainers: 1,
  retries: 0,
} as const;

const recipe: RecipeV1 = {
  schemaVersion: 1,
  recipeId: "retry_fixture@1",
  maxJobCostUsd: "0.00",
  stages: [
    {
      stage: "segment",
      enabled: true,
      module: "stub_segmenter@1",
      params: {},
      resources,
    },
    {
      stage: "caption",
      enabled: true,
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

test("stage-set retry admission, caps, stale requests and concurrent replay", async (t) => {
  const db = await jobsDatabase();
  t.after(() => db.close());
  const { recordingId, jobId } = await queuedJob(db);
  const owner = db.actors.staff;
  const deps = {
    ...depsFor(db),
    taskInput: async (_q: unknown, job: { jobId: string }) => ({
      ...(await processRecordingTaskInputV2(db.app, job.jobId)),
      schemaVersion: 3,
      recipe,
      recipeSha256: requestSha256(recipe),
    }),
  };
  assert.equal((await admitNextJob(deps)).state, "admitted");
  assert.deepEqual(
    await failUndispatched(
      { ...deps, config: { repair: { dispatchWindowSeconds: 0 } } },
      { jobId, recordedBy: owner, limit: 1 },
    ),
    [jobId],
  );

  const rerun = {
    pool: db.app,
    reader: {
      async read(): Promise<Uint8Array> {
        throw new Error("This parent has no completed outputs");
      },
    },
  };
  const input = { schemaVersion: 2, scope: "failed_clips" } as const;
  const plan = await planStageRerunV2(rerun, owner, recordingId, input);
  assert.equal(validateValue("http.stage-rerun-plan.v2", plan).valid, true);
  assert.deepEqual(
    plan.clips.map((clip) => ({
      clipId: clip.clipId,
      parentJobId: clip.parentJobId,
      stages: clip.execute.map((step) => step.stage),
    })),
    [
      {
        clipId: recordingId,
        parentJobId: jobId,
        stages: ["segment", "caption", "hand_pose"],
      },
    ],
  );
  const command: StageRerunCommandV2 = {
    ...input,
    requestId: randomUUID(),
    reason: "Retry interrupted fixture job",
    expectedPlanSha256: plan.planSha256,
    expectedMaxComputeCostUsd: plan.maxComputeCostUsd,
    expectedMaxGpuCostUsd: plan.maxGpuCostUsd,
  };
  await assert.rejects(
    confirmStageRerunV2(rerun, owner, recordingId, {
      ...command,
      expectedMaxComputeCostUsd: "1.00",
    }),
    /plan_changed/,
  );
  assert.equal(
    (
      await db.app.query("SELECT 1 FROM jobs WHERE id = $1", [
        command.requestId,
      ])
    ).rowCount,
    0,
  );
  const results = await Promise.all([
    confirmStageRerunV2(rerun, owner, recordingId, command),
    confirmStageRerunV2(rerun, owner, recordingId, command),
  ]);
  assert.deepEqual(results.map((result) => result.replayed).sort(), [
    false,
    true,
  ]);
  for (const result of results)
    assert.deepEqual(result.jobs, [
      { clipId: recordingId, parentJobId: jobId, jobId: command.requestId },
    ]);
  await assert.rejects(
    confirmStageRerunV2(rerun, owner, recordingId, {
      ...command,
      reason: "Different command",
    }),
    /request_id_in_use/,
  );
  await assert.rejects(
    planStageRerunV2(rerun, owner, recordingId, {
      schemaVersion: 2,
      scope: "clip",
      clipId: recordingId,
      parentJobId: jobId,
      stages: ["segment"],
    }),
    /stale_current_job/,
  );
  assert.equal((await admitNextJob(deps)).state, "admitted");
  const {
    rows: [child],
  } = await db.app.query(
    `SELECT j.kind, j.derived_from_job_id, j.previous_job_id, j.recipe, p.plan -> 'execute' AS execute
     FROM jobs j JOIN job_rerun_plans p ON p.job_id = j.id
     WHERE j.id = $1 AND job_is_current(j.id)`,
    [command.requestId],
  );
  assert.deepEqual(child, {
    kind: "process_recording",
    derived_from_job_id: jobId,
    previous_job_id: null,
    recipe,
    execute: ["segment", "caption", "hand_pose"],
  });
  await assert.rejects(
    retryJob(deps, { jobId: command.requestId, expectedState: "submitting" }),
    /partial attempt/,
  );
});
