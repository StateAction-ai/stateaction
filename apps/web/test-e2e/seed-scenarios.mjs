// SA-96 scenario recipes for the dev-stack seed. Pure data: every recipe is validated against the
// published `jobs.recipe.v1` contract by seed-scenarios.test.mjs. Stub and replay modules are
// localOnly (never a model result); replayed output carries module_id=replay_* in provenance.
export const STUB = {
  segment: "stub_segmenter@1",
  caption: "stub_captioner@1",
  hand_pose: "hand_pose_cpu_v1@1",
};
export const REPLAY = {
  segment: "replay_segmenter@1",
  caption: "replay_captioner@1",
  hand_pose: "hand_pose_cpu_v1@1",
};
const resources = (budgetSeconds) => ({
  gpu: "none",
  budgetSeconds,
  maxContainers: 1,
  retries: 0,
});

function recipe(
  recipeId,
  modules,
  {
    segment = { segment_s: 2 },
    caption = {},
    budget = 600,
    captionEnabled = true,
  } = {},
) {
  return {
    schemaVersion: 1,
    recipeId,
    maxJobCostUsd: "0.00",
    stages: [
      {
        stage: "segment",
        enabled: true,
        module: modules.segment,
        params: segment,
        resources: resources(budget),
      },
      {
        stage: "caption",
        enabled: captionEnabled,
        module: modules.caption,
        params: caption,
        resources: resources(budget),
      },
      {
        stage: "hand_pose",
        enabled: true,
        module: modules.hand_pose,
        params: {},
        resources: resources(600),
      },
    ],
  };
}

/** name -> { recipe, expect }: the seed fails unless the job and every stage end in `expect`. */
export const SYNTHETIC_SCENARIOS = {
  ok: {
    recipe: recipe("seed_ok@1", STUB),
    expect: {
      job: "succeeded",
      segment: "succeeded",
      caption: "succeeded",
      hand_pose: "succeeded",
    },
  },
  caption_failed: {
    recipe: recipe("seed_caption_failed@1", STUB, {
      caption: { fail_captions: "0,1" },
    }),
    expect: {
      job: "succeeded",
      segment: "succeeded",
      caption: "succeeded",
      hand_pose: "succeeded",
    },
    note: "two segments carry a failed caption row inside a succeeded caption stage",
  },
  segment_failed: {
    // A failing segment stage (crash before any output) leaves caption not_run (upstream_failed).
    recipe: recipe("seed_segment_failed@1", STUB, {
      segment: { crash_after_n: 1 },
    }),
    expect: {
      job: "succeeded",
      segment: "failed",
      caption: "not_run",
      hand_pose: "succeeded",
    },
  },
  running: {
    // A hang stub stopped at its 20 s budget: the run is recorded failed (budget_exceeded).
    recipe: recipe("seed_running@1", STUB, {
      segment: { hang: true, hang_s: 600 },
      budget: 20,
    }),
    expect: {
      job: "succeeded",
      segment: "failed",
      caption: "not_run",
      hand_pose: "succeeded",
    },
  },
};

const REPLAY_EXPECT = {
  job: "succeeded",
  segment: "succeeded",
  caption: "succeeded",
  hand_pose: "succeeded",
};
export const REPLAY_SCENARIOS = {
  replay_homer_33: {
    episode: "homer_33",
    recipe: recipe("seed_replay_homer_33@1", REPLAY),
    expect: REPLAY_EXPECT,
  },
  replay_homer_37: {
    episode: "homer_37",
    recipe: recipe("seed_replay_homer_37@1", REPLAY),
    // The cached FLORA segments of this episode overlap and the replay adapter refuses them
    // (replay_segment_overlap_unresolvable): a truthful failed segment, never invented segments.
    expect: {
      ...REPLAY_EXPECT,
      segment: "failed",
      caption: "not_run",
    },
  },
};

const ALL = { ...SYNTHETIC_SCENARIOS, ...REPLAY_SCENARIOS };
/** Empty string when `result` (job state and stage rows) matches the scenario, else what differed. */
export function scenarioMismatch({ scenario, jobState, stages }) {
  const expect = ALL[scenario]?.expect;
  if (!expect) return `unknown scenario ${scenario}`;
  const diffs = [];
  if (jobState !== expect.job) diffs.push(`job ${jobState}`);
  for (const stage of ["segment", "caption", "hand_pose"]) {
    const row = stages.find((r) => r.stage === stage);
    if (row?.state !== expect[stage])
      diffs.push(
        `${stage} ${row?.state ?? "missing"}${row?.error_code ? `(${row.error_code})` : ""}`,
      );
  }
  return diffs.join(", ");
}

const RENDER_MARKERS = [
  "RENDER",
  "RENDER_SERVICE_ID",
  "RENDER_EXTERNAL_URL",
  "RENDER_INSTANCE_ID",
  "IS_PULL_REQUEST",
];
/** The dev seed runs only on a local workstation: refuse any other APP_ENV or a Render deployment. */
export function refuseNonLocalEnv(env) {
  if (env.APP_ENV !== undefined && env.APP_ENV !== "local")
    throw new Error(`--seed refuses APP_ENV=${env.APP_ENV}: local only`);
  const marker = RENDER_MARKERS.find((k) => env[k]);
  if (marker) throw new Error(`--seed refuses a Render deployment (${marker})`);
}

/** The seed spends nothing: no flora_* module, no GPU, a zero cost cap, and no other paid module. */
export function refuseSpend(recipe) {
  if (recipe.maxJobCostUsd !== "0.00")
    throw new Error("seed recipe has a cost cap");
  for (const st of recipe.stages) {
    if (st.module.startsWith("flora_"))
      throw new Error(`seed refuses ${st.module}: paid GPU module`);
    if (st.resources.gpu !== "none")
      throw new Error(`seed refuses a GPU request in ${st.stage}`);
    if (st.stage !== "hand_pose" && !/^(stub|replay)_/.test(st.module))
      throw new Error(
        `seed allows only stub or replay modules, not ${st.module}`,
      );
  }
}
