import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import {
  controllerSettings,
  modalAppFor,
  modalCredentials,
  modalFunctionFor,
} from "../src/config.js";

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
  "MODAL_STAGE_FUNCTIONS",
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

test("MODAL_STAGE_FUNCTIONS binds a module to a function, optionally in another Modal app", () => {
  env({
    ...modal,
    MODAL_STAGE_FUNCTIONS:
      "flora_tempseg_vllm_fp8@1=stateaction-flora-stages/flora_tempseg,flora_captioner_vllm_fp8@1=flora_captioner",
  });
  const s = controllerSettings();
  assert.equal(s.executor, "modal");
  if (s.executor !== "modal") return;
  assert.deepEqual(s.stageFunctions, {
    "flora_tempseg_vllm_fp8@1": "flora_tempseg",
    "flora_captioner_vllm_fp8@1": "flora_captioner",
  });
  assert.equal(
    modalAppFor(s, "flora_tempseg_vllm_fp8@1"),
    "stateaction-flora-stages",
  );
  // No app in the binding: the controller's single MODAL_APP_NAME.
  assert.equal(
    modalAppFor(s, "flora_captioner_vllm_fp8@1"),
    "stateaction-processing",
  );
  assert.equal(modalAppFor(s, "hand_pose_cpu_v1@1"), "stateaction-processing");
  for (const bad of [
    "flora_tempseg_vllm_fp8@1=a/b/c",
    "flora_tempseg_vllm_fp8@1=/flora_tempseg",
    "flora_tempseg_vllm_fp8@1=stateaction-flora-stages/",
    "flora_tempseg_vllm_fp8@1=",
    "flora_tempseg_vllm_fp8@1=a b/flora_tempseg",
    "flora_tempseg_vllm_fp8@1=x/y,flora_tempseg_vllm_fp8@1=x/y",
    "hand_pose_cpu_v1@1=other/hand_pose",
  ]) {
    env({ ...modal, MODAL_STAGE_FUNCTIONS: bad });
    assert.throws(() => controllerSettings(), /MODAL_STAGE_FUNCTIONS/, bad);
  }
});

test("the exact MODAL_STAGE_FUNCTIONS string the FLORA app emits (controller_env) is accepted and routes to its app", () => {
  // Copied from workers/flora/tests/test_stage_runner.py, which asserts controller_env() equals it.
  env({
    ...modal,
    MODAL_STAGE_FUNCTIONS:
      "flora_captioner_hf@1=stateaction-flora-stages/flora_captioner," +
      "flora_captioner_vllm_fp8@1=stateaction-flora-stages/flora_captioner," +
      "flora_tempseg_hf@1=stateaction-flora-stages/flora_tempseg," +
      "flora_tempseg_vllm_fp8@1=stateaction-flora-stages/flora_tempseg",
  });
  const s = controllerSettings();
  assert.equal(s.executor, "modal");
  if (s.executor !== "modal") return;
  for (const [module, fn] of [
    ["flora_captioner_hf@1", "flora_captioner"],
    ["flora_captioner_vllm_fp8@1", "flora_captioner"],
    ["flora_tempseg_hf@1", "flora_tempseg"],
    ["flora_tempseg_vllm_fp8@1", "flora_tempseg"],
  ] as const) {
    assert.equal(modalAppFor(s, module), "stateaction-flora-stages");
    assert.equal(modalFunctionFor(s, module), fn);
  }
  assert.equal(modalAppFor(s, "hand_pose_cpu_v1@1"), "stateaction-processing");
  assert.equal(modalFunctionFor(s, "hand_pose_cpu_v1@1"), "process_recording");
});
