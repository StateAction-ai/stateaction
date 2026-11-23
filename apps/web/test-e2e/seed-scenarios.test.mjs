import assert from "node:assert/strict";
import { test } from "node:test";
import { validateValue } from "@stateaction/contracts";
import {
  RECIPE_E2E_SCENARIOS,
  REPLAY_SCENARIOS,
  SYNTHETIC_SCENARIOS,
  refuseNonLocalEnv,
  refuseSpend,
  scenarioMismatch,
} from "./seed-scenarios.mjs";

test("every seed scenario recipe is a valid jobs.recipe.v1 and uses only local stub or replay modules", () => {
  const all = { ...SYNTHETIC_SCENARIOS, ...REPLAY_SCENARIOS };
  assert.deepEqual(Object.keys(SYNTHETIC_SCENARIOS), [
    "ok",
    "caption_failed",
    "segment_failed",
    "running",
  ]);
  for (const [name, { recipe }] of Object.entries(all)) {
    const verdict = validateValue("jobs.recipe.v1", recipe);
    assert.equal(verdict.valid, true, `${name}: ${verdict.code}`);
    for (const s of recipe.stages.slice(0, 2))
      assert.match(
        s.module,
        /^(stub|replay)_/,
        `${name}: ${s.stage} is never a live model`,
      );
  }
});

test("every SA-100 gate scenario is a valid stub recipe that spends nothing and has an expectation", () => {
  assert.deepEqual(Object.keys(RECIPE_E2E_SCENARIOS), [
    "ok",
    "caption_failed",
    "window_failed",
    "segment_failed",
    "digest_mismatch",
    "zero_segments",
    "source_unreadable",
    "retry_mid_caption",
  ]);
  for (const [name, s] of Object.entries(RECIPE_E2E_SCENARIOS)) {
    const verdict = validateValue("jobs.recipe.v1", s.recipe);
    assert.equal(verdict.valid, true, `${name}: ${verdict.code}`);
    refuseSpend(s.recipe);
    for (const st of s.recipe.stages.slice(0, 2))
      assert.match(st.module, /^stub_/, `${name}: ${st.stage} is a stub`);
    assert.ok(s.expect.job && s.expect.segment, name);
  }
  assert.equal(
    scenarioMismatch(
      {
        scenario: "source_unreadable",
        jobState: "failed",
        stages: [
          { stage: "segment", state: "failed", error_code: "x" },
          { stage: "caption", state: "not_run", error_code: "upstream_failed" },
          { stage: "hand_pose", state: "failed", error_code: "x" },
        ],
      },
      RECIPE_E2E_SCENARIOS,
    ),
    "",
  );
});

test("a scenario whose job or stages end differently from its expectation is a mismatch", () => {
  const rows = (segment, caption, hand_pose, error_code = null) => [
    { stage: "segment", state: segment, error_code },
    { stage: "caption", state: caption, error_code: null },
    { stage: "hand_pose", state: hand_pose, error_code },
  ];
  assert.equal(
    scenarioMismatch({
      scenario: "ok",
      jobState: "succeeded",
      stages: rows("succeeded", "succeeded", "succeeded"),
    }),
    "",
  );
  assert.equal(
    scenarioMismatch({
      scenario: "running",
      jobState: "failed",
      stages: rows("failed", "not_run", "failed", "blockingioerror"),
    }),
    "job failed, hand_pose failed(blockingioerror)",
  );
  assert.match(
    scenarioMismatch({ scenario: "ok", jobState: "succeeded", stages: [] }),
    /segment missing/,
  );
});

test("the seed refuses a non-local env, a Render deployment and any paid module or GPU", () => {
  refuseNonLocalEnv({});
  refuseNonLocalEnv({ APP_ENV: "local" });
  for (const env of [
    { APP_ENV: "production" },
    { APP_ENV: "staging" },
    { RENDER_SERVICE_ID: "srv-x" },
  ])
    assert.throws(() => refuseNonLocalEnv(env), /refuses/);
  for (const sc of Object.values({
    ...SYNTHETIC_SCENARIOS,
    ...REPLAY_SCENARIOS,
  }))
    refuseSpend(sc.recipe);
  const base = SYNTHETIC_SCENARIOS.ok.recipe;
  const withStage = (i, patch) => ({
    ...base,
    stages: base.stages.map((st, j) => (j === i ? { ...st, ...patch } : st)),
  });
  assert.throws(
    () => refuseSpend(withStage(1, { module: "flora_captioner_vllm_fp8@1" })),
    /paid/,
  );
  assert.throws(
    () =>
      refuseSpend(
        withStage(0, {
          resources: { ...base.stages[0].resources, gpu: "A10G" },
        }),
      ),
    /GPU/,
  );
  assert.throws(
    () => refuseSpend(withStage(0, { module: "other_segmenter@1" })),
    /only stub or replay/,
  );
  assert.throws(
    () => refuseSpend({ ...base, maxJobCostUsd: "1.00" }),
    /cost cap/,
  );
});
