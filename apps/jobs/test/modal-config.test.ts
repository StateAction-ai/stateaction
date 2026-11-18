import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { controllerSettings, modalCredentials } from "../src/config.js";

const KEYS = [
  "APP_ENV",
  "EXECUTION_BACKEND",
  "STATEACTION_API_URL",
  "JOBS_STATE_DIR",
  "PYTHON_EXECUTABLE",
  "WORKER_PIPELINE",
  "MODAL_APP_NAME",
  "MODAL_FUNCTION_NAME",
  "MODAL_ENVIRONMENT",
  "MODAL_TOKEN_ID",
  "MODAL_TOKEN_SECRET",
];
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
const env = (values: Record<string, string>) =>
  Object.assign(process.env, values);
const local = {
  APP_ENV: "local",
  EXECUTION_BACKEND: "local",
  STATEACTION_API_URL: "http://127.0.0.1:3000",
  JOBS_STATE_DIR: "/tmp/jobs",
  PYTHON_EXECUTABLE: "/usr/bin/python3",
};
const modal = {
  APP_ENV: "production",
  EXECUTION_BACKEND: "modal",
  STATEACTION_API_URL: "https://stateaction.example.com",
  JOBS_STATE_DIR: "/tmp/jobs",
  MODAL_APP_NAME: "stateaction-processing",
  MODAL_FUNCTION_NAME: "process_recording",
};

test("local settings are unchanged and only exist in APP_ENV=local", () => {
  env(local);
  const s = controllerSettings();
  assert.equal(s.executor, "local");
  assert.equal(s.pipeline, "hand_pose_cpu_v1");
});

test("development and production reject the local executor and loopback endpoints", () => {
  for (const appEnv of ["development", "production"]) {
    env({ ...local, APP_ENV: appEnv });
    assert.throws(
      () => controllerSettings(),
      /only qualified in APP_ENV=local/,
    );
    for (const k of KEYS) delete process.env[k];
  }
});

test("the executor is never inferred: an unset or unknown backend fails closed", () => {
  env({ ...local, EXECUTION_BACKEND: "" });
  assert.throws(() => controllerSettings(), /must be explicit/);
  env({ EXECUTION_BACKEND: "gpu" });
  assert.throws(() => controllerSettings(), /must be explicit/);
  delete process.env.EXECUTION_BACKEND;
  assert.throws(() => controllerSettings(), /must be explicit/);
});

test("Modal is accepted in production and development only with explicit names and a hosted https origin", () => {
  for (const appEnv of ["production", "development"]) {
    env({ ...modal, APP_ENV: appEnv });
    const s = controllerSettings();
    assert.equal(s.executor, "modal");
    if (s.executor === "modal") {
      assert.equal(s.appName, "stateaction-processing");
      assert.equal(s.functionName, "process_recording");
      assert.equal(s.pipeline, "hand_pose_cpu_v1");
    }
  }
});

test("Modal rejects local APP_ENV, loopback or http origins, missing names, and a selectable pipeline", () => {
  const bad: [string, Record<string, string>, RegExp][] = [
    [
      "local env",
      { APP_ENV: "local" },
      /requires APP_ENV=development or production/,
    ],
    [
      "loopback",
      { STATEACTION_API_URL: "https://localhost" },
      /non-loopback https/,
    ],
    [
      "loopback ip",
      { STATEACTION_API_URL: "https://127.0.0.1" },
      /non-loopback https/,
    ],
    [
      "http origin",
      { STATEACTION_API_URL: "http://stateaction.example.com" },
      /https/,
    ],
    ["no app", { MODAL_APP_NAME: "" }, /MODAL_APP_NAME/],
    ["no function", { MODAL_FUNCTION_NAME: "" }, /MODAL_FUNCTION_NAME/],
    ["bad function", { MODAL_FUNCTION_NAME: "a b" }, /MODAL_FUNCTION_NAME/],
    ["bad environment", { MODAL_ENVIRONMENT: "x y" }, /MODAL_ENVIRONMENT/],
    [
      "fixture pipeline",
      { WORKER_PIPELINE: "local_fixture_noop" },
      /not configurable/,
    ],
    ["no state dir", { JOBS_STATE_DIR: "" }, /JOBS_STATE_DIR/],
  ];
  for (const [name, change, pattern] of bad) {
    for (const k of KEYS) delete process.env[k];
    env({ ...modal, ...change });
    assert.throws(() => controllerSettings(), pattern, name);
  }
});

test("Modal credentials are read only controller-side and both are required", () => {
  assert.throws(() => modalCredentials(), /MODAL_TOKEN_ID/);
  env({ MODAL_TOKEN_ID: "ak-x" });
  assert.throws(() => modalCredentials(), /MODAL_TOKEN_SECRET/);
  env({ MODAL_TOKEN_SECRET: "as-y" });
  assert.deepEqual(modalCredentials(), {
    tokenId: "ak-x",
    tokenSecret: "as-y",
  });
});
