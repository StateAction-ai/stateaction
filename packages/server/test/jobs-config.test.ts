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
  assert.equal(jobsConfigFromEnv(settings).limits.maxOutputFiles, 512);
  assert.equal(
    jobsConfigFromEnv({ ...settings, PROCESSING_MAX_OUTPUT_FILES: "1800" })
      .limits.maxOutputFiles,
    1800,
  );
  for (const value of ["0", "2001", "1.5", "NaN"])
    assert.throws(
      () =>
        jobsConfigFromEnv({ ...settings, PROCESSING_MAX_OUTPUT_FILES: value }),
      /PROCESSING_MAX_OUTPUT_FILES/,
    );
});
