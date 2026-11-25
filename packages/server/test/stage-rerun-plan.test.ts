import assert from "node:assert/strict";
import test from "node:test";
import type { RecipeV1 } from "@stateaction/contracts";
import {
  executionStages,
  stageFingerprint,
} from "../src/jobs/stage-rerun-plan.js";

import {
  retryExecutionStages,
  retryStagesForOutputs,
} from "../src/jobs/stage-rerun-v2.js";

const recipe: RecipeV1 = {
  schemaVersion: 1,
  recipeId: "stub",
  maxJobCostUsd: "1.00",
  stages: [
    {
      stage: "segment",
      enabled: true,
      module: "stub_segment@1",
      params: {},
      resources: {
        gpu: "none",
        budgetSeconds: 60,
        maxContainers: 1,
        retries: 0,
      },
    },
    {
      stage: "caption",
      enabled: true,
      module: "stub_caption@1",
      params: {},
      resources: {
        gpu: "none",
        budgetSeconds: 60,
        maxContainers: 1,
        retries: 0,
      },
    },
    {
      stage: "hand_pose",
      enabled: true,
      module: "hand_pose_cpu_v1@1",
      params: {},
      resources: {
        gpu: "none",
        budgetSeconds: 60,
        maxContainers: 1,
        retries: 0,
      },
    },
  ],
};

test("recording batch retries jobs that fail after their last stage and partial outputs", () => {
  const noHand = structuredClone(recipe);
  noHand.stages[2].enabled = false;
  const stages = [
    { stage: "segment", counts: { segments: 2 } },
    { stage: "caption", counts: { captions: 2 } },
  ] as const;
  assert.deepEqual(retryStagesForOutputs(noHand, stages, false, null), [
    "caption",
  ]);
  assert.deepEqual(
    retryStagesForOutputs(
      recipe,
      [...stages, { stage: "hand_pose", counts: {} }],
      false,
      null,
    ),
    ["hand_pose"],
  );
  assert.deepEqual(
    retryExecutionStages(
      noHand,
      retryStagesForOutputs(
        noHand,
        [
          { stage: "segment", counts: { segments: 2, failed_windows: 1 } },
          stages[1],
        ],
        true,
        null,
      ),
    ),
    ["segment", "caption"],
  );
});

test("rerun scopes follow data edges, excluding the independent hand stage", () => {
  assert.deepEqual(executionStages(recipe, "hand_pose", "only"), ["hand_pose"]);
  assert.deepEqual(executionStages(recipe, "hand_pose", "from_here"), [
    "hand_pose",
  ]);
  assert.deepEqual(executionStages(recipe, "caption", "only"), ["caption"]);
  assert.deepEqual(executionStages(recipe, "segment", "from_here"), [
    "segment",
    "caption",
  ]);
  assert.throws(
    () => executionStages(recipe, "segment", "only"),
    /requires_caption_rerun/,
  );

  const captionOff = structuredClone(recipe);
  captionOff.stages[1].enabled = false;
  assert.deepEqual(executionStages(captionOff, "segment", "only"), ["segment"]);
  assert.throws(
    () => executionStages(captionOff, "caption", "from_here"),
    /stage_disabled/,
  );
});

test("fingerprints bind stage inputs and declared producer, excluding GPU observation", () => {
  const params = { temperature: "0.1" };
  const fingerprintInput = {
    stage: "caption" as const,
    module: "stub_caption@1",
    params,
    sourceManifestSha256: "a".repeat(64),
    inputDigests: [{ role: "segments_json", sha256: "b".repeat(64) }],
    producer: {
      engine: { name: "cpu", version: "1" },
      model_name: "stub",
      model_revision: "1",
      weights_sha256: null,
      quant: null,
      prompt_sha256: null,
      decoding_params: {},
      gpu: {
        requested_type: "none" as const,
        observed_type: null as string | null,
      },
    },
  };
  const first = stageFingerprint(fingerprintInput);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(
    stageFingerprint({
      ...fingerprintInput,
      producer: {
        ...fingerprintInput.producer,
        gpu: { requested_type: "none", observed_type: "local CPU" },
      },
    }),
    first,
  );
  assert.notEqual(
    stageFingerprint({ ...fingerprintInput, params: { temperature: "0.2" } }),
    first,
  );
  assert.notEqual(
    stageFingerprint({
      ...fingerprintInput,
      inputDigests: [{ role: "segments_json", sha256: "c".repeat(64) }],
    }),
    first,
  );
  assert.notEqual(
    stageFingerprint({
      ...fingerprintInput,
      producer: { ...fingerprintInput.producer, model_revision: "2" },
    }),
    first,
  );
});

test("a stage set follows the caption dependency and keeps hand pose independent", () => {
  assert.deepEqual(retryExecutionStages(recipe, ["segment"]), [
    "segment",
    "caption",
  ]);
  assert.deepEqual(retryExecutionStages(recipe, ["hand_pose", "segment"]), [
    "segment",
    "caption",
    "hand_pose",
  ]);
  assert.deepEqual(retryExecutionStages(recipe, ["hand_pose", "caption"]), [
    "caption",
    "hand_pose",
  ]);
  assert.deepEqual(retryExecutionStages(recipe, ["hand_pose"]), ["hand_pose"]);
  const captionOff = structuredClone(recipe);
  captionOff.stages[1].enabled = false;
  assert.deepEqual(retryExecutionStages(captionOff, ["segment"]), ["segment"]);
  assert.throws(
    () => retryExecutionStages(captionOff, ["caption"]),
    /stage_disabled/,
  );
});
