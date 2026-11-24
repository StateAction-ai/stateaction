import assert from "node:assert/strict";
import test from "node:test";
import { PUBLIC_VIDEO_CANARY } from "../src/admission/public-video-canary.js";
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

test("public-video canary accepts only the approved digest on a production Render web service", () => {
  const clip = {
    ownerUserId: "approved-collector",
    clientRecordingId: "d47e7ade-2642-4ae1-905b-f8cf6f9047f1",
    sourceSha256:
      "4e5e5a2abfe6d867a86ce8a254b1a85f225c0c1d57e05b2a74d8a538861f9e32",
  };
  const env = {
    ...settings,
    APP_ENV: "production",
    RENDER_SERVICE_ID: "srv-test",
    PROCESSING_EXECUTION_BACKEND: "modal",
    [PUBLIC_VIDEO_CANARY]: JSON.stringify(clip),
  };
  assert.deepEqual(jobsConfigFromEnv(env).publicVideoCanary, clip);
  for (const changes of [
    { APP_ENV: "development" },
    { IS_PULL_REQUEST: "true" },
    { RENDER_SERVICE_ID: "wfl-test" },
    {
      [PUBLIC_VIDEO_CANARY]: JSON.stringify({
        ...clip,
        sourceSha256: "f".repeat(64),
      }),
    },
  ])
    assert.throws(
      () => jobsConfigFromEnv({ ...env, ...changes }),
      /STATEACTION_PUBLIC_VIDEO_CANARY/,
    );
});
