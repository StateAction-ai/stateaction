import assert from "node:assert/strict";
import test from "node:test";
import { admissionDepsFromEnv } from "../src/admission/runtime.js";

const base = {
  APP_ENV: "development",
  DATABASE_URL: "postgresql://stateaction_app:x@db.invalid/stateaction",
  S3_ENDPOINT: "https://account.r2.cloudflarestorage.com",
  S3_REGION: "auto",
  S3_BUCKET: "stateaction-dev",
  S3_ACCESS_KEY_ID: "id",
  S3_SECRET_ACCESS_KEY: "secret",
};
const pool = {} as never;

test("admission deps require explicit profile settings (no implicit defaults)", () => {
  assert.throws(
    () => admissionDepsFromEnv(pool, { ...base }),
    /PROCESSING_PROFILE_REVISION/,
  );
  assert.throws(
    () =>
      admissionDepsFromEnv(pool, {
        ...base,
        PROCESSING_PROFILE_REVISION: "dev-1",
      }),
    /SUPPORTED_RGB_PROFILES/,
  );
  assert.throws(
    () =>
      admissionDepsFromEnv(pool, {
        ...base,
        PROCESSING_PROFILE_REVISION: "dev-1",
        SUPPORTED_RGB_PROFILES: "h264_mcap_v1,mp4",
      }),
    /SUPPORTED_RGB_PROFILES/,
  );
});

test("admission deps compose the given pool, storage reader and config", () => {
  const deps = admissionDepsFromEnv(pool, {
    ...base,
    PROCESSING_PROFILE_REVISION: "dev-1",
    SUPPORTED_RGB_PROFILES: "h264_mcap_v1",
  });
  assert.equal(deps.pool, pool);
  assert.equal(typeof deps.reader.read, "function");
  assert.deepEqual(deps.config, {
    processingProfileRevision: "dev-1",
    supportedRgbProfiles: ["h264_mcap_v1"],
  });
});

test("storage settings are still required for the manifest reader", () => {
  const { S3_BUCKET: _omit, ...noBucket } = base;
  assert.throws(
    () =>
      admissionDepsFromEnv(pool, {
        ...noBucket,
        PROCESSING_PROFILE_REVISION: "dev-1",
        SUPPORTED_RGB_PROFILES: "h264_mcap_v1",
      }),
    /S3_BUCKET/,
  );
});
