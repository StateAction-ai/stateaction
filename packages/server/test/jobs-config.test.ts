import assert from "node:assert/strict";
import test from "node:test";
import { jobsConfigFromEnv } from "../src/jobs/config.js";

const settings = {
  PROCESSING_EXECUTION_BACKEND: "local",
  PROCESSING_CODE_REVISION: "testing",
  PROCESSING_IMAGE_SPEC_SHA256: "0".repeat(64),
  PROCESSING_MODEL_SHA256: "1".repeat(64),
  PROCESSING_CONFIG_SHA256: "2".repeat(64),
};

test("admitted jobs pin a bounded output file budget", () => {
  // The 2 h budget (737) under the default 2000-file ceiling.
  assert.equal(jobsConfigFromEnv(settings).limits.maxOutputFiles, 737);
  assert.equal(
    jobsConfigFromEnv({ ...settings, PROCESSING_MAX_OUTPUT_FILES: "1800" })
      .limits.maxOutputFiles,
    737,
  );
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
