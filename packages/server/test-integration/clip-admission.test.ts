import assert from "node:assert/strict";
import test from "node:test";
import { requestSha256 } from "@stateaction/contracts";
import { processRecordingTaskInputV2 } from "../src/admission/job-input.js";
import { admitNextJob } from "../src/jobs/service.js";
import { depsFor, jobsDatabase, queuedJob } from "./jobs-harness.js";
import { recipe } from "./recipe-harness.js";

test("clip admission pins output caps and the execution deadline from the admitted range", async () => {
  const db = await jobsDatabase();
  try {
    const { jobId, recordingId } = await queuedJob(db);
    const jobRecipe = recipe();
    const outcome = await admitNextJob({
      ...depsFor(db),
      taskInput: async (tx) => ({
        ...(await processRecordingTaskInputV2(tx, jobId)),
        schemaVersion: 4,
        recipe: jobRecipe,
        recipeSha256: requestSha256(jobRecipe),
        clip: {
          id: recordingId,
          planVersion: 1,
          planSha256: "a".repeat(64),
          sourceRange: {
            kind: "clip",
            start_ordinal: 20,
            end_ordinal: 80,
            first_source_frame_id: "22",
            last_source_frame_id: "84",
            start_ts_ns: "9223371967854000000",
            end_ts_ns: "9223372036854000000",
          },
        },
      }),
    });
    assert.equal(outcome.state, "admitted");
    if (outcome.state !== "admitted") return;
    const { rows } = await db.app.query(
      `SELECT i.task_input, i.max_output_files, i.max_output_bytes::text,
              j.recipe_sha256, a.job_id AS slot
       FROM job_inputs i JOIN jobs j ON j.id = i.job_id
       JOIN dispatch_admission a ON a.job_id = j.id
       WHERE i.job_id = $1`,
      [jobId],
    );
    assert.equal(rows[0]?.slot, jobId);
    assert.equal(rows[0]?.task_input.clip.id, recordingId);
    assert.equal(rows[0]?.recipe_sha256, requestSha256(jobRecipe));
    assert.equal(rows[0]?.max_output_files, 35);
    assert.equal(rows[0]?.max_output_bytes, "5502926848");
    assert.equal(
      outcome.job.executionDeadline.getTime() -
        outcome.job.admittedAt.getTime(),
      2412_000,
    );
  } finally {
    await db.close();
  }
});
