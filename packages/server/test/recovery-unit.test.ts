import assert from "node:assert/strict";
import { test } from "node:test";
import { renderTaskStarterFromEnv } from "../src/jobs/dispatch.js";
import {
  operatorGuidance,
  type RecoverySnapshot,
} from "../src/jobs/recovery.js";

test("no Render settings means no starter (dispatch unavailable, nothing starts)", () => {
  assert.equal(renderTaskStarterFromEnv({ APP_ENV: "production" }), null);
  assert.equal(
    renderTaskStarterFromEnv({
      APP_ENV: "production",
      PROCESS_RECORDING_TASK_SLUG: "wf/process-recording",
    }),
    null,
    "slug without RENDER_API_KEY",
  );
});
test("hosted slugs must be <workflow>/process-recording; bare name only for the explicit local runner", () => {
  assert.throws(() =>
    renderTaskStarterFromEnv({
      APP_ENV: "production",
      RENDER_API_KEY: "k",
      PROCESS_RECORDING_TASK_SLUG: "process-recording",
    }),
  );
  assert.ok(
    renderTaskStarterFromEnv({
      APP_ENV: "production",
      RENDER_API_KEY: "k",
      PROCESS_RECORDING_TASK_SLUG: "wf/process-recording",
    }),
  );
  assert.ok(
    renderTaskStarterFromEnv({
      APP_ENV: "local",
      RENDER_USE_LOCAL_DEV: "true",
    }),
  );
  assert.equal(
    renderTaskStarterFromEnv({
      APP_ENV: "production",
      RENDER_USE_LOCAL_DEV: "true",
    }),
    null,
  );
});

test("local dispatch requires an explicit loopback runner even with hosted credentials present", () => {
  assert.equal(
    renderTaskStarterFromEnv({
      APP_ENV: "local",
      PROCESS_RECORDING_TASK_SLUG: "workflow/process-recording",
      RENDER_API_KEY: "unused-test-token",
    }),
    null,
  );
  for (const url of [
    "http://example.test:8120",
    "https://localhost:8120",
    "http://user@localhost:8120",
  ]) {
    assert.throws(
      () =>
        renderTaskStarterFromEnv({
          APP_ENV: "local",
          RENDER_LOCAL_DEV_URL: url,
        }),
      /loopback HTTP/,
    );
  }
});

const base: RecoverySnapshot = {
  jobId: "j",
  recordingId: "r",
  state: "failed",
  isCurrent: true,
  holdsSlot: false,
  hasEvidence: true,
  evidenceKind: "local_child_reaped",
  neverSubmitted: false,
  submissionIntent: true,
  claimed: true,
  errorCode: null,
  leaseLive: false,
  executionDeadlinePassed: false,
  hasSuccessor: false,
};
test("guidance is derived from state and never suggests clearing the slot", () => {
  assert.equal(operatorGuidance(base).code, "retry_available");
  assert.equal(
    operatorGuidance({ ...base, errorCode: "source_sha_mismatch" }).code,
    "reupload_required",
  );
  assert.equal(
    operatorGuidance({ ...base, holdsSlot: true }).code,
    "retry_blocked_termination_unproven",
  );
  assert.equal(
    operatorGuidance({ ...base, hasSuccessor: true }).code,
    "superseded",
  );
  const unknown = operatorGuidance({ ...base, state: "submit_unknown" });
  assert.equal(unknown.code, "unknown_spawn");
  assert.match(unknown.instruction, /Do not clear the admission slot/);
});
