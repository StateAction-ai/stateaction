import assert from "node:assert/strict";
import test from "node:test";
import {
  acceptanceConfigFromEnv,
  clipsForSeconds,
  jobOutputByteLimit,
  jobOutputFileLimit,
  outputFileBudget,
} from "../src/acceptance/config.js";
import {
  admissionDeadlineSeconds,
  jobsConfigFromEnv,
  RECIPE_DEADLINE_ERROR_CODE,
  recipeExecutionDeadlineSeconds,
} from "../src/jobs/config.js";

const GiB = 1024 ** 3;

const settings = {
  PROCESSING_EXECUTION_BACKEND: "local",
  PROCESSING_CODE_REVISION: "testing",
  PROCESSING_IMAGE_SPEC_SHA256: "0".repeat(64),
  PROCESSING_MODEL_SHA256: "1".repeat(64),
  PROCESSING_CONFIG_SHA256: "2".repeat(64),
};

type Stage = {
  stage: string;
  enabled: boolean;
  resources: { budgetSeconds: number };
};
const recipeWith = (budgets: [number, boolean, number, number, number]) => ({
  stages: [
    {
      stage: "segment",
      enabled: budgets[1],
      resources: { budgetSeconds: budgets[0] },
    },
    {
      stage: "caption",
      enabled: budgets[1],
      resources: { budgetSeconds: budgets[2] },
    },
    {
      stage: "hand_pose",
      enabled: true,
      resources: { budgetSeconds: budgets[3] },
    },
  ] as Stage[],
});

test("file budget scales with clips: 60 s, 2 h and 4 h", () => {
  assert.equal(clipsForSeconds(60), 1);
  assert.equal(outputFileBudget(1), 23);
  // 2 h: 120 clips, 720 clip files + 4 annotation + 12 diagnostic + 1 manifest.
  assert.equal(clipsForSeconds(7200), 120);
  assert.equal(outputFileBudget(120), 737);
  assert.equal(clipsForSeconds(14400), 240);
  assert.equal(outputFileBudget(240), 1457);
});

test("the per-job limits never exceed the hard ceilings", () => {
  // A 2 h job fits the default 2000-file ceiling, and a ceiling of 512 wins.
  assert.equal(jobOutputFileLimit(2000, 120), 737);
  assert.equal(jobOutputFileLimit(512, 120), 512);
  assert.equal(jobOutputFileLimit(2000, 10_000), 2000);
  // Bytes: 4 GiB + 12 x 64 MiB + clips x 128 MiB, capped at 16 GiB by default.
  assert.equal(
    jobOutputByteLimit(16 * GiB, 1),
    4 * GiB + 12 * 64 * 1024 ** 2 + 128 * 1024 ** 2,
  );
  assert.equal(jobOutputByteLimit(16 * GiB, 120), 16 * GiB);
  assert.equal(jobOutputByteLimit(8 * GiB, 120), 8 * GiB);
  const defaults = acceptanceConfigFromEnv({});
  assert.equal(defaults.verifyMaxFiles, 2000);
  assert.equal(defaults.verifyMaxBytes, 16 * GiB);
});

test("the admission output file pin is the 2 h budget under the ceiling", () => {
  assert.equal(jobsConfigFromEnv(settings).limits.maxOutputFiles, 737);
  assert.equal(
    jobsConfigFromEnv({ ...settings, PROCESSING_MAX_OUTPUT_FILES: "512" })
      .limits.maxOutputFiles,
    512,
  );
  for (const value of ["0", "2001", "1.5", "NaN"])
    assert.throws(
      () =>
        jobsConfigFromEnv({ ...settings, PROCESSING_MAX_OUTPUT_FILES: value }),
      /PROCESSING_MAX_OUTPUT_FILES/,
    );
});

test("recipe deadline is the enabled budgets plus margin, clamped to 1 h..12 h", () => {
  // 2 h of stage budgets: 1800 + 1800 + 3600 + 1800 margin = 9000 s.
  assert.equal(
    recipeExecutionDeadlineSeconds(recipeWith([1800, true, 1800, 3600])),
    9000,
  );
  // A short recipe is raised to the 1 h floor.
  assert.equal(
    recipeExecutionDeadlineSeconds(recipeWith([60, true, 60, 60])),
    3600,
  );
  // A 4 h budget sum is 14400 + 1800 = 16200 s, inside the bounds.
  assert.equal(
    recipeExecutionDeadlineSeconds(recipeWith([7200, true, 3600, 3600])),
    16200,
  );
  // Disabled stages do not count toward the deadline.
  assert.equal(
    recipeExecutionDeadlineSeconds(recipeWith([1800, false, 40_000, 3600])),
    5400,
  );
});

test("a recipe whose budgets exceed 12 h is refused with a stable code", () => {
  assert.throws(
    () =>
      recipeExecutionDeadlineSeconds(recipeWith([20_000, true, 20_000, 3600])),
    (error: Error) =>
      error.message.startsWith(`${RECIPE_DEADLINE_ERROR_CODE}:`),
  );
  // Exactly at the 12 h bound is allowed: 41400 + 1800 = 43200.
  assert.equal(
    recipeExecutionDeadlineSeconds(recipeWith([30_000, true, 7_800, 3600])),
    43200,
  );
});

test("admission uses the recipe deadline, or the fallback without a recipe", () => {
  const config = jobsConfigFromEnv(settings);
  assert.equal(admissionDeadlineSeconds(config, null), 6 * 3600);
  assert.equal(
    admissionDeadlineSeconds(config, recipeWith([1800, true, 1800, 3600])),
    9000,
  );
  assert.throws(
    () =>
      admissionDeadlineSeconds(
        config,
        recipeWith([20_000, true, 20_000, 3600]),
      ),
    /recipe_deadline_exceeded/,
  );
});
