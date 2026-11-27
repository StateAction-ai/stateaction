import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
// Policy guards for render.yaml. Schema/platform validity is checked separately with
// `render blueprints validate render.yaml` (needs an authenticated CLI; see docs).
const text = readFileSync(
  new URL("../../render.yaml", import.meta.url),
  "utf8",
);
const blocks = Object.fromEntries(
  text
    .split(/^ {2}- type: /m)
    .slice(1)
    .map((block) => [block.split("\n")[0], block]),
);
const envKeys = (block) =>
  [...block.matchAll(/- key: ([A-Z0-9_]+)/g)].map((match) => match[1]);
test("topology is web + workflow + one repair cron with a private database and no scheduled migrator", () => {
  assert.deepEqual(Object.keys(blocks).sort(), ["cron", "web", "workflow"]);
  assert.equal((text.match(/type: cron/g) ?? []).length, 1);
  assert.match(text, /ipAllowList: \[\]/);
});
test("no literal secrets and no owner connection string in runtime services", () => {
  assert.doesNotMatch(text, /connectionString|MIGRATION_DATABASE_URL/);
  assert.doesNotMatch(text, /(SECRET|PASSWORD|TOKEN|API_KEY)\S*\n\s+value:/);
  for (const key of [
    "S3_ENDPOINT",
    "S3_BUCKET",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
    "APP_DB_PASSWORD",
    "BETTER_AUTH_URL",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
  ])
    assert.match(blocks.web, new RegExp(`key: ${key}\\n\\s+sync: false`));
  assert.match(blocks.web, /key: BETTER_AUTH_SECRET\n\s+generateValue: true/);
});
test("auth settings are web-only and unsupported or local-only overrides are never set", () => {
  const keys = envKeys(blocks.web);
  for (const forbidden of [
    "AUTH_LOCAL_PASSWORD",
    "BETTER_AUTH_TRUSTED_ORIGINS",
    "BETTER_AUTH_SECRETS",
    "DATABASE_URL",
    "S3_PUBLIC_ENDPOINT",
  ])
    assert.ok(!keys.includes(forbidden), `${forbidden} must not be set`);
  for (const key of keys.filter((k) => /AUTH|GOOGLE/.test(k)))
    assert.ok(!envKeys(blocks.workflow).includes(key));
});
test("the Render start key lives on the API only; the repair cron has an API capability and nothing else (SA-27)", () => {
  assert.match(blocks.web, /key: RENDER_API_KEY\n\s+sync: false/);
  assert.match(blocks.web, /key: PROCESS_RECORDING_TASK_SLUG\n\s+sync: false/);
  assert.ok(!envKeys(blocks.workflow).includes("RENDER_API_KEY"));
  assert.deepEqual(envKeys(blocks.cron).sort(), [
    "APP_ENV",
    "PYTHON_VERSION",
    "REPAIR_CAPABILITY_TOKEN",
    "STATEACTION_API_URL",
  ]);
  for (const key of ["REPAIR_CAPABILITY_TOKEN", "STATEACTION_API_URL"])
    assert.match(blocks.cron, new RegExp(`key: ${key}\\n\\s+sync: false`));
  assert.match(blocks.cron, /schedule: "\* \* \* \* \*"/);
  assert.match(blocks.cron, /runtime: python/);
  assert.match(blocks.cron, /python -m stateaction_controller\.repair/);
  assert.doesNotMatch(
    blocks.cron,
    /DATABASE|S3_|RENDER_API_KEY|MODAL|fromDatabase/,
  );
});
test("workflow tasks receive no database, storage or dispatch credentials", () => {
  const keys = envKeys(blocks.workflow);
  // SA-26: API URL + operator-issued workflow credential (jobs:status/jobs:reconcile) only.
  // SA-42 adds the Modal executor selection, names and credential (this service only).
  assert.deepEqual(keys.sort(), [
    "APP_ENV",
    "CONTROLLER_CAPABILITY_TOKEN",
    "EXECUTION_BACKEND",
    "JOBS_STATE_DIR",
    "MODAL_APP_NAME",
    "MODAL_ENVIRONMENT",
    "MODAL_FUNCTION_NAME",
    "MODAL_STAGE_FUNCTIONS",
    "MODAL_TOKEN_ID",
    "MODAL_TOKEN_SECRET",
    "PYTHON_VERSION",
    "STATEACTION_API_URL",
  ]);
  assert.match(blocks.workflow, /runtime: python/);
  assert.match(blocks.workflow, /python -m stateaction_controller\.workflow/);
  for (const key of ["CONTROLLER_CAPABILITY_TOKEN", "STATEACTION_API_URL"])
    assert.match(blocks.workflow, new RegExp(`key: ${key}\\n\\s+sync: false`));
  assert.ok(!envKeys(blocks.web).includes("CONTROLLER_CAPABILITY_TOKEN"));
  assert.doesNotMatch(
    blocks.workflow,
    /DATABASE|S3_|DISPATCH_CAPABILITY|REPAIR_CAPABILITY/,
  );
});
test("the Modal credential lives on the workflow controller only and is never a literal (SA-42)", () => {
  for (const key of ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"]) {
    assert.match(
      blocks.workflow,
      new RegExp(`key: ${key}\\n\\s+sync: false`),
      key,
    );
    for (const name of ["web", "cron"])
      assert.ok(!envKeys(blocks[name]).includes(key), `${key} in ${name}`);
  }
  for (const name of ["web", "cron"])
    assert.ok(
      !envKeys(blocks[name]).some((k) => k.startsWith("MODAL_")),
      `${name} must hold no Modal setting`,
    );
  // Production selects the Modal executor explicitly; the local executor is never configured here.
  assert.match(blocks.workflow, /key: EXECUTION_BACKEND\n\s+sync: false/);
  assert.match(blocks.workflow, /APP_ENV\n\s+value: production/);
  assert.doesNotMatch(
    blocks.workflow,
    /PYTHON_EXECUTABLE|WORKER_PIPELINE|local_fixture/,
  );
  assert.match(
    blocks.workflow,
    /key: MODAL_APP_NAME\n\s+value: stateaction-processing/,
  );
  assert.match(
    blocks.workflow,
    /key: MODAL_FUNCTION_NAME\n\s+value: process_recording/,
  );
});
test("web binds through the health-checked Render start path", () => {
  assert.match(blocks.web, /healthCheckPath: \/api\/v1\/live/);
  assert.match(blocks.web, /APP_ENV\n\s+value: production/);
  assert.match(blocks.web, /--frozen-lockfile/);
});
test("job admission identity is explicit, web-only and never a placeholder", () => {
  // SA-25: backend, code revision, image spec and config digests are operator
  // inputs; only the accepted CPU model digest is a literal nonsecret pin.
  for (const key of [
    "PROCESSING_EXECUTION_BACKEND",
    "PROCESSING_CODE_REVISION",
    "PROCESSING_IMAGE_SPEC_SHA256",
    "PROCESSING_CONFIG_SHA256",
  ])
    assert.match(blocks.web, new RegExp(`key: ${key}\\n\\s+sync: false`), key);
  assert.match(
    blocks.web,
    /key: PROCESSING_MODEL_SHA256\n\s+value: fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1\n/,
  );
  for (const key of [
    "PROCESSING_EXECUTION_BACKEND",
    "PROCESSING_CODE_REVISION",
    "PROCESSING_IMAGE_SPEC_SHA256",
    "PROCESSING_MODEL_SHA256",
    "PROCESSING_CONFIG_SHA256",
  ])
    assert.ok(!envKeys(blocks.workflow).includes(key), key);
});
test("hosted Blueprints never define the development-only simulated capture flag", () => {
  // SA-71: ALLOW_SIMULATED_CAPTURE_INPUTS is refused by the server outside
  // APP_ENV local/development and on Render; it must not appear at all.
  for (const [name, block] of Object.entries(blocks))
    assert.doesNotMatch(block, /ALLOW_SIMULATED_CAPTURE_INPUTS/, name);
  assert.doesNotMatch(text, /h264_mcap_simulation_v1/);
});
test("recording admission settings are explicit and web-only", () => {
  assert.match(blocks.web, /key: PROCESSING_PROFILE_REVISION\n\s+sync: false/);
  assert.match(
    blocks.web,
    /key: SUPPORTED_RGB_PROFILES\n\s+value: h264_mcap_v1\n/,
  );
  for (const key of ["PROCESSING_PROFILE_REVISION", "SUPPORTED_RGB_PROFILES"])
    assert.ok(!envKeys(blocks.workflow).includes(key));
});
