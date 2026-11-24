import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  immutableModalAppName,
  requestSha256,
  validateValue,
  type ModalRerunBinding,
  type RecipeV1,
  type Stage,
  type StageReceiptV1,
} from "@stateaction/contracts";
import { JobsApi } from "../src/api-client.js";
import {
  stageModuleRefusal,
  type LocalControllerSettings,
  type ModalControllerSettings,
} from "../src/config.js";
import { runController, type Outcome } from "../src/controller.js";
import { JournalStore, type ModalJournal } from "../src/journal.js";
import { lastLogLine } from "../src/local-process.js";
import {
  parseRunResult,
  parseStageReceipt,
  type CallObservation,
  type ModalBootstrap,
  type ModalClient,
  type HandPoseBootstrap,
  type StageBootstrap,
} from "../src/modal-executor.js";
import { closeStubs, startStub, type StubOptions } from "./stub-api.js";

/**
 * SA-91: the recipe stage runner against a fake Modal client and the contract-shaped stub API
 * (which enforces the 011 ordering, write-once call and proof-before-end rules). Every case is
 * table driven over what each fake stage call returns.
 */

let root = "";
before(() => {
  root = mkdtempSync(join(tmpdir(), "sa91-unit-"));
});
after(() => {
  closeStubs();
  rmSync(root, { recursive: true, force: true });
});

const MODULES = {
  segment: "flora_tempseg_vllm_fp8@1",
  caption: "flora_captioner_vllm_fp8@1",
  hand_pose: "hand_pose_cpu_v1@1",
} as const;
const GPU = { segment: "H100", caption: "H100", hand_pose: "none" } as const;

function recipe(
  over: {
    captionEnabled?: boolean;
    budget?: Partial<Record<Stage, number>>;
  } = {},
): RecipeV1 {
  const res = (stage: Stage) => ({
    gpu: GPU[stage],
    budgetSeconds: over.budget?.[stage] ?? 60,
    maxContainers: 1,
    retries: 0 as const,
  });
  return {
    schemaVersion: 1,
    recipeId: "flora_mvp@1",
    maxJobCostUsd: "5.00",
    stages: [
      {
        stage: "segment",
        enabled: true,
        module: MODULES.segment,
        params: {},
        resources: res("segment"),
      },
      {
        stage: "caption",
        enabled: over.captionEnabled ?? true,
        module: MODULES.caption,
        params: {},
        resources: res("caption"),
      },
      {
        stage: "hand_pose",
        enabled: true,
        module: MODULES.hand_pose,
        params: {},
        resources: res("hand_pose"),
      },
    ],
  } as RecipeV1;
}

const settings = (apiUrl: string, graceMs = 400): ModalControllerSettings => ({
  executor: "modal",
  apiUrl,
  stateDir: join(root, `state-${randomUUID()}`),
  renewIntervalMs: 100,
  pollIntervalMs: 20,
  leaseWaitMs: 0,
  reapGraceMs: graceMs,
  apiTimeoutMs: 5000,
  appName: "stateaction-processing",
  functionName: "process_recording",
  pipeline: "hand_pose_cpu_v1",
  stageFunctions: {
    [MODULES.segment]: "flora_tempseg",
    [MODULES.caption]: "flora_captioner",
  },
});

const SEGMENTS_SHA = "b".repeat(64);
const SEGMENTS_FILE = randomUUID();

/** A contract-valid stage receipt; `over` replaces fields (status failed needs an errorCode). */
function receipt(
  jobId: string,
  stage: Stage,
  over: Partial<StageReceiptV1> = {},
): StageReceiptV1 {
  const outputs =
    stage === "segment"
      ? [
          {
            fileId: SEGMENTS_FILE,
            role: "segments_json" as const,
            sizeBytes: "1200",
            sha256: SEGMENTS_SHA,
          },
        ]
      : stage === "caption"
        ? [
            {
              fileId: randomUUID(),
              role: "captions_json" as const,
              sizeBytes: "900",
              sha256: "c".repeat(64),
            },
          ]
        : [];
  const counts: Record<Stage, Record<string, number>> = {
    segment: { frames: 300, segments: 4, windows: 2, failed_windows: 0 },
    caption: { captions: 4, failed_captions: 0, not_captioned: 0 },
    hand_pose: { clips: 1 },
  };
  return {
    schemaVersion: 1,
    jobId,
    stage,
    module: MODULES[stage],
    status: "succeeded",
    errorCode: null,
    outputs,
    counts: counts[stage],
    gpu: {
      requestedType: GPU[stage],
      observedType: stage === "hand_pose" ? null : "NVIDIA H100 80GB HBM3",
    },
    startedAt: "2026-11-22T10:00:00Z",
    finishedAt: "2026-11-22T10:01:00Z",
    ...over,
  } as StageReceiptV1;
}
const failed = (jobId: string, stage: Stage, code: string) =>
  receipt(jobId, stage, { status: "failed", errorCode: code, outputs: [] });

const callId = () => `fc-${randomBytes(10).toString("hex")}`;
const pending: CallObservation = { kind: "pending", detail: "poll_timeout" };
const returned = (value: unknown): CallObservation => ({
  kind: "returned",
  value,
});
const v2 = (id: string, exitCode: number, r: StageReceiptV1 | null) => ({
  schemaVersion: 2,
  functionCallId: id,
  exitCode,
  receipt: r,
});

/** What one fake stage call does, by stage. Default: succeeds with a valid receipt. */
type Behaviour = {
  spawn?: () => Promise<string>;
  poll?: (id: string, n: number, cancelled: boolean) => CallObservation;
};

class FakeModal implements ModalClient {
  spawns: (StageBootstrap | HandPoseBootstrap)[] = [];
  cancels: string[] = [];
  private readonly stageOf = new Map<string, Stage>();
  private readonly polls = new Map<string, number>();
  constructor(
    private readonly jobId: string,
    private readonly by: Partial<Record<Stage, Behaviour>> = {},
  ) {}
  async spawn(b: ModalBootstrap): Promise<string> {
    // GPU stages get the v2 stage bootstrap; the sealing hand_pose stage the v1 run-job shape.
    const boot = b as StageBootstrap | HandPoseBootstrap;
    assert.equal(boot.schemaVersion, boot.stage === "hand_pose" ? 1 : 2);
    this.spawns.push(boot);
    const id = await (this.by[boot.stage]?.spawn ?? (async () => callId()))();
    this.stageOf.set(id, boot.stage);
    return id;
  }
  async poll(id: string): Promise<CallObservation> {
    const stage = this.stageOf.get(id)!;
    const n = (this.polls.get(id) ?? 0) + 1;
    this.polls.set(id, n);
    const custom = this.by[stage]?.poll;
    if (custom) return custom(id, n, this.cancels.includes(id));
    return returned(
      stage === "hand_pose"
        ? v2(id, 0, null)
        : v2(id, 0, receipt(this.jobId, stage)),
    );
  }
  async cancel(id: string): Promise<void> {
    this.cancels.push(id);
  }
  stages(): Stage[] {
    return this.spawns.map((b) => b.stage);
  }
}

type Stub = Awaited<ReturnType<typeof startStub>>;
async function world(
  over: Partial<StubOptions> & {
    recipeOver?: Parameters<typeof recipe>[0];
  } = {},
  deadlineMs = 600_000,
) {
  const jobId = randomUUID();
  const { recipeOver, ...rest } = over;
  const stub = await startStub({
    jobId,
    state: "submitting",
    submission: "recorded",
    statusBackend: "modal",
    executionDeadline: new Date(
      Math.ceil((Date.now() + deadlineMs) / 1000) * 1000,
    ),
    recipe: recipe(recipeOver),
    ...rest,
  });
  return { jobId, stub, cfg: settings(stub.url) };
}
let n = 0;
const enter = (
  stub: Stub,
  jobId: string,
  cfg: ModalControllerSettings | LocalControllerSettings,
  modal: ModalClient,
  runRef = `run-${++n}`,
) =>
  runController(
    {
      settings: cfg,
      api: new JobsApi(stub.url, "cap", 5000),
      store: new JournalStore(cfg.stateDir),
      modal,
    },
    { jobId, runRef },
  );
const rows = (stub: Stub) =>
  Object.fromEntries(
    [...stub.runs].map(([stage, r]) => [stage, [r.state, r.errorCode ?? null]]),
  );
const stagesOf = (out: Outcome) => {
  assert.equal(out.outcome, "recipe_run");
  return out.outcome === "recipe_run" ? out : undefined!;
};

describe("SA-91 recipe stages from process-recording (fake Modal, stub API)", () => {
  test("a job without a recipe is unchanged: no stage action, the v1 path", async () => {
    const jobId = randomUUID();
    const stub = await startStub({
      jobId,
      state: "submitting",
      submission: "recorded",
      statusBackend: "modal",
      executionDeadline: new Date(
        Math.ceil((Date.now() + 60_000) / 1000) * 1000,
      ),
    });
    const spawned: ModalBootstrap[] = [];
    const modal: ModalClient = {
      spawn: async (b) => (spawned.push(b), callId()),
      poll: async (id) =>
        returned({ schemaVersion: 1, functionCallId: id, exitCode: 0 }),
      cancel: async () => undefined,
    };
    const out = await enter(stub, jobId, settings(stub.url), modal);
    assert.equal(out.outcome, "call_terminal");
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0]!.schemaVersion, 1);
    assert.ok(!stub.actions().some((a) => a.includes("stage")));
    assert.ok(stub.calls.some((c) => c.path.endsWith("/recipe")));
  });

  test("parallel hand pose can end before caption starts, but seal waits for both branches", async () => {
    const { jobId, stub, cfg } = await world(
      {
        parallelRecipe: true,
        recipeOver: { budget: { segment: 10, hand_pose: 30, caption: 30 } },
      },
      50_000,
    );
    const hands = receipt(jobId, "hand_pose", {
      outputs: (["recording_mp4", "hand_presence_json"] as const).map(
        (role) => ({
          fileId: randomUUID(),
          role,
          sizeBytes: "240",
          sha256: SEGMENTS_SHA,
        }),
      ),
    });
    const modal = new FakeModal(jobId, {
      hand_pose: { poll: (id) => returned(v2(id, 0, hands)) },
      segment: {
        poll: (id) =>
          stub.runs.get("hand_pose")?.state === "succeeded"
            ? returned(v2(id, 0, receipt(jobId, "segment")))
            : pending,
      },
    });
    const out = stagesOf(await enter(stub, jobId, cfg, modal));
    assert.equal(out.stopped, undefined);
    assert.deepEqual(
      modal.stages().filter((stage) => stage !== "hand_pose"),
      ["segment", "caption"],
    );
    const calls = stub.calls.map((c) => c.body);
    const handEnd = calls.findIndex(
      (b) =>
        b?.action === "record_stage_run" &&
        b.stage === "hand_pose" &&
        b.state === "succeeded",
    );
    const captionStart = calls.findIndex(
      (b) => b?.action === "issue_stage_claim" && b.stage === "caption",
    );
    const captionEnd = calls.findIndex(
      (b) =>
        b?.action === "record_stage_run" &&
        b.stage === "caption" &&
        b.state === "succeeded",
    );
    const seal = calls.findIndex((b) => b?.action === "seal_parallel_recipe");
    assert.ok(
      handEnd >= 0 &&
        handEnd < captionStart &&
        captionStart < captionEnd &&
        captionEnd < seal,
    );
    assert.equal(stub.stageEvidence.size, 3);
  });

  test("a parallel sibling settles its own proof when a spawn is ambiguous, and seal is withheld", async () => {
    const { jobId, stub, cfg } = await world({ parallelRecipe: true });
    const modal = new FakeModal(jobId, {
      segment: {
        spawn: async () => {
          throw new Error("lost spawn acknowledgement");
        },
      },
    });
    const out = stagesOf(await enter(stub, jobId, cfg, modal));
    assert.equal(out.stopped?.outcome, "submit_unknown");
    assert.equal(stub.runs.get("hand_pose")?.state, "failed");
    assert.equal(stub.stageEvidence.size, 1);
    assert.equal(stub.runs.get("segment")?.state, "submit_unknown");
    assert.ok(!stub.actions().includes("seal_parallel_recipe"));
    assert.ok(!modal.stages().includes("caption"));
  });

  // Table: the downstream rules and partial-success policy.
  const cases: {
    name: string;
    over?: Parameters<typeof world>[0];
    by?: (jobId: string) => Partial<Record<Stage, Behaviour>>;
    spawns: Stage[];
    rows: Record<string, [string, string | null]>;
  }[] = [
    {
      name: "all stages succeed in order with their receipts",
      spawns: ["segment", "caption", "hand_pose"],
      rows: {
        segment: ["succeeded", null],
        caption: ["succeeded", null],
        hand_pose: ["failed", "receipt_missing"],
      },
    },
    {
      name: "a failed window is counted data: the segment still succeeds and caption runs",
      by: (jobId) => ({
        segment: {
          poll: (id) =>
            returned(
              v2(
                id,
                0,
                receipt(jobId, "segment", {
                  counts: { segments: 3, windows: 2, failed_windows: 1 },
                }),
              ),
            ),
        },
      }),
      spawns: ["segment", "caption", "hand_pose"],
      rows: {
        segment: ["succeeded", null],
        caption: ["succeeded", null],
        hand_pose: ["failed", "receipt_missing"],
      },
    },
    {
      name: "a failed caption stage is recorded failed; hand_pose still runs",
      by: (jobId) => ({
        caption: {
          poll: (id) =>
            returned(v2(id, 3, failed(jobId, "caption", "engine_timeout"))),
        },
      }),
      spawns: ["segment", "caption", "hand_pose"],
      rows: {
        segment: ["succeeded", null],
        caption: ["failed", "engine_timeout"],
        hand_pose: ["failed", "receipt_missing"],
      },
    },
    {
      name: "zero segments: caption is not_run (no_segments)",
      by: (jobId) => ({
        segment: {
          poll: (id) =>
            returned(
              v2(
                id,
                0,
                receipt(jobId, "segment", {
                  counts: { segments: 0, windows: 1, failed_windows: 0 },
                }),
              ),
            ),
        },
      }),
      spawns: ["segment", "hand_pose"],
      rows: {
        segment: ["succeeded", null],
        caption: ["not_run", "no_segments"],
        hand_pose: ["failed", "receipt_missing"],
      },
    },
    {
      name: "upstream failure: a failed segment makes caption not_run (upstream_failed)",
      by: (jobId) => ({
        segment: {
          poll: (id) =>
            returned(v2(id, 3, failed(jobId, "segment", "replay_refused"))),
        },
      }),
      spawns: ["segment", "hand_pose"],
      rows: {
        segment: ["failed", "replay_refused"],
        caption: ["not_run", "upstream_failed"],
        hand_pose: ["failed", "receipt_missing"],
      },
    },
    {
      name: "digest mismatch: a receipt the server refuses is a failure, never a success",
      over: { rejectReceiptSha256: SEGMENTS_SHA },
      spawns: ["segment", "hand_pose"],
      rows: {
        segment: ["failed", "receipt_rejected"],
        caption: ["not_run", "upstream_failed"],
        hand_pose: ["failed", "receipt_missing"],
      },
    },
    {
      name: "a stage that exits without a receipt (crash) is failed (receipt_missing)",
      by: () => ({ segment: { poll: (id) => returned(v2(id, 86, null)) } }),
      spawns: ["segment", "hand_pose"],
      rows: {
        segment: ["failed", "receipt_missing"],
        caption: ["not_run", "upstream_failed"],
        hand_pose: ["failed", "receipt_missing"],
      },
    },
    {
      name: "a disabled stage is not_run (stage_disabled) and never claimed",
      over: { recipeOver: { captionEnabled: false } },
      spawns: ["segment", "hand_pose"],
      rows: {
        segment: ["succeeded", null],
        caption: ["not_run", "stage_disabled"],
        hand_pose: ["failed", "receipt_missing"],
      },
    },
    {
      name: "a sealing hand_pose stage with a v2 receipt is recorded succeeded",
      by: (jobId) => ({
        hand_pose: {
          poll: (id) => returned(v2(id, 0, receipt(jobId, "hand_pose"))),
        },
      }),
      spawns: ["segment", "caption", "hand_pose"],
      rows: {
        segment: ["succeeded", null],
        caption: ["succeeded", null],
        hand_pose: ["succeeded", null],
      },
    },
  ];
  for (const c of cases)
    test(c.name, async () => {
      const { jobId, stub, cfg } = await world(c.over);
      const modal = new FakeModal(jobId, c.by?.(jobId));
      const out = stagesOf(await enter(stub, jobId, cfg, modal));
      assert.equal(out.stopped, undefined);
      assert.deepEqual(modal.stages(), c.spawns);
      assert.deepEqual(rows(stub), c.rows);
      // Only spawned stages were claimed, and each ended only after proof for its exact call.
      assert.deepEqual([...stub.claims.keys()], c.spawns);
      for (const stage of c.spawns)
        assert.equal(
          stub.stageEvidence.get(stage),
          stub.runs.get(stage)!.callId,
        );
      assert.equal(modal.cancels.length, 0);
    });

  test("stage bootstraps: v2, the stage token, the recipe digest, caption pins the segments output", async () => {
    const { jobId, stub, cfg } = await world();
    const modal = new FakeModal(jobId);
    await enter(stub, jobId, cfg, modal);
    const [seg, cap, hand] = modal.spawns;
    for (const [b, stage] of [
      [seg, "segment"],
      [cap, "caption"],
      [hand, "hand_pose"],
    ] as const) {
      assert.equal(b!.stage, stage);
      assert.equal(b!.module, MODULES[stage]);
      assert.equal(b!.bootstrapToken, stub.claims.get(stage)!.token);
      assert.ok(!("executionRef" in b!), "Modal supplies the call ID");
    }
    assert.equal(seg!.recipeSha256, cap!.recipeSha256);
    assert.equal(hand!.recipeSha256, seg!.recipeSha256);
    const c = cap as StageBootstrap;
    assert.equal(c.segmentsFileId, SEGMENTS_FILE);
    assert.equal(c.segmentsSha256, SEGMENTS_SHA);
    assert.equal((seg as StageBootstrap).segmentsFileId, undefined);
    // The sealing stage: run-job v1 with the four recipe keys; priorStages are the server rows
    // with every file their slots attribute to each stage (SA-92 seam).
    const h = hand as HandPoseBootstrap;
    assert.equal(h.pipeline, "hand_pose_cpu_v1");
    assert.deepEqual(
      h.priorStages.map((p) => [p.stage, p.state, p.errorCode]),
      [
        ["segment", "succeeded", null],
        ["caption", "succeeded", null],
      ],
    );
    assert.deepEqual(h.priorStages[0]!.outputs, [
      {
        fileId: SEGMENTS_FILE,
        role: "segments_json",
        sizeBytes: "1200",
        sha256: SEGMENTS_SHA,
        slot: "segments.json",
      },
    ]);
    assert.equal(h.priorStages[1]!.outputs[0]!.slot, "captions.json");
    // Order per stage: claim, the server row (submitting) before the spawn, then running.
    const acts = stub.calls
      .filter((c) => c.body?.stage === "segment")
      .map((c) => `${c.body!.action}:${c.body!.state ?? ""}`);
    assert.deepEqual(acts, [
      "issue_stage_claim:",
      "record_stage_run:submitting",
      "record_stage_run:running",
      "record_stage_run:succeeded",
    ]);
    // No token is left on disk; each stage has its own journal directory.
    const store = new JournalStore(cfg.stateDir);
    for (const stage of ["segment", "caption", "hand_pose"] as const) {
      assert.equal(store.readModal(jobId, stage)?.phase, "terminal");
      assert.ok(!existsSync(join(store.dir(jobId, stage), "bootstrap.token")));
    }
    assert.equal(store.readModal(jobId), undefined);
  });

  test("budget before spawn: a GPU stage whose budget exceeds the remaining deadline is not_run (budget); hand_pose still runs and seals", async () => {
    const { jobId, stub, cfg } = await world(
      { recipeOver: { budget: { caption: 3600, hand_pose: 30 } } },
      120_000,
    );
    const modal = new FakeModal(jobId);
    const out = stagesOf(await enter(stub, jobId, cfg, modal));
    assert.deepEqual(modal.stages(), ["segment", "hand_pose"]);
    assert.deepEqual(rows(stub), {
      segment: ["succeeded", null],
      caption: ["not_run", "budget"],
      hand_pose: ["failed", "receipt_missing"],
    });
    assert.deepEqual(
      out.stages.map((s) => s.state),
      ["succeeded", "not_run", "failed"],
    );
  });

  test("a GPU stage must leave the seal its budget: segment fits alone but not with hand_pose, so it is not_run (budget) and hand_pose runs", async () => {
    // 600 s left: segment 400 s fits on its own, not with hand_pose's 300 s.
    const { jobId, stub, cfg } = await world(
      { recipeOver: { budget: { segment: 400, hand_pose: 300 } } },
      600_000,
    );
    const modal = new FakeModal(jobId);
    await enter(stub, jobId, cfg, modal);
    assert.deepEqual(modal.stages(), ["hand_pose"]);
    assert.deepEqual(rows(stub), {
      segment: ["not_run", "budget"],
      caption: ["not_run", "budget"],
      hand_pose: ["failed", "receipt_missing"],
    });
  });

  test("an adopted local child with no observed exit keeps its logged receipt; a mixed log yields the last receipt line", () => {
    const jobId = randomUUID();
    const hp = {
      jobId,
      stage: "hand_pose" as const,
      module: MODULES.hand_pose,
    };
    const ok = receipt(jobId, "hand_pose");
    // Exit observed: it must agree with the receipt. Not observed (adopted): the receipt decides.
    assert.equal(parseStageReceipt(ok, hp, 3), undefined);
    assert.deepEqual(parseStageReceipt(ok, hp, null), ok);
    assert.equal(parseStageReceipt(null, hp, null), undefined);
    assert.equal(parseStageReceipt("x", hp, 0), undefined);
    const dir = mkdtempSync(join(root, "log-"));
    const log = join(dir, "child.log");
    writeFileSync(
      log,
      [
        "Worker started",
        JSON.stringify({ stage: "x", status: "y" }), // not receipt-shaped: no schemaVersion/jobId
        JSON.stringify(ok),
        'sa_metrics {"kind":"sa_metrics"}',
        JSON.stringify({ kind: "sa_metrics", stage: "worker", exitCode: 0 }),
        "Worker failed: boom",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    assert.deepEqual(lastLogLine(log), ok);
    writeFileSync(log, "no receipt here\n", { mode: 0o600 });
    assert.equal(lastLogLine(log), undefined);
  });

  test("a segment over its budget makes caption not_run (budget) too, never hand_pose", async () => {
    const { jobId, stub, cfg } = await world(
      { recipeOver: { budget: { segment: 3600 } } },
      120_000,
    );
    const modal = new FakeModal(jobId);
    await enter(stub, jobId, cfg, modal);
    assert.deepEqual(modal.stages(), ["hand_pose"]);
    assert.deepEqual(rows(stub), {
      segment: ["not_run", "budget"],
      caption: ["not_run", "budget"],
      hand_pose: ["failed", "receipt_missing"],
    });
  });

  test("a sealing bootstrap over 8 KiB is failed (bootstrap_too_large) and never spawned or claimed", async () => {
    const { jobId, stub, cfg } = await world();
    const diagnostics = Array.from({ length: 60 }, () => ({
      fileId: randomUUID(),
      role: "diagnostic_blob" as const,
      sizeBytes: "10",
      sha256: "d".repeat(64),
    }));
    const modal = new FakeModal(jobId, {
      segment: {
        poll: (id) => {
          const r = receipt(jobId, "segment");
          return returned(
            v2(id, 0, { ...r, outputs: [...r.outputs, ...diagnostics] }),
          );
        },
      },
    });
    const out = stagesOf(await enter(stub, jobId, cfg, modal));
    assert.equal(out.stopped, undefined);
    assert.deepEqual(modal.stages(), ["segment", "caption"]);
    assert.deepEqual(rows(stub).hand_pose, ["failed", "bootstrap_too_large"]);
    assert.equal(stub.claims.has("hand_pose"), false);
  });

  test("crash requeue: Modal re-runs a crashed call under the same ID; the budget cancels it (terminateContainers) and a proven end is failed budget_exceeded", async () => {
    const { jobId, stub, cfg } = await world({
      recipeOver: { budget: { segment: 1 } },
    });
    // Never returns while requeued; after the cancel the wrapper's result is observed.
    const modal = new FakeModal(jobId, {
      segment: {
        poll: (id, _n, cancelled) =>
          cancelled ? returned(v2(id, 137, null)) : pending,
      },
    });
    const out = stagesOf(await enter(stub, jobId, cfg, modal));
    assert.equal(modal.cancels.length, 1);
    assert.equal(modal.cancels[0], stub.runs.get("segment")!.callId);
    assert.deepEqual(rows(stub), {
      segment: ["failed", "budget_exceeded"],
      caption: ["not_run", "upstream_failed"],
      hand_pose: ["failed", "receipt_missing"],
    });
    assert.equal(out.stopped, undefined);
    const j = new JournalStore(cfg.stateDir).readModal(jobId, "segment");
    assert.equal(j?.termination, "budget_exceeded");
  });

  function verifiedRecipeSettings(
    cfg: ModalControllerSettings,
  ): ModalControllerSettings {
    const codeRevision = "a".repeat(40);
    const paramsSha256 = requestSha256({});
    return {
      ...cfg,
      verifiedBindings: new Map(
        Object.entries(MODULES).map(([stage, module]) => [
          module,
          {
            appName: immutableModalAppName(module, codeRevision, paramsSha256),
            codeRevision,
            paramsSha256,
            definitionSha256: "f".repeat(64),
            definitionId: "fd-Test",
            functionId: "fu-Test",
            environment: "fixture",
            gpu: GPU[stage as Stage],
            maxBilledSeconds: 760,
            maxContainers: 1,
            maxCpuMilli: 8000,
            maxMemoryMib: 8192,
            microUsdPerCpuSecond: 211,
            microUsdPerGpuSecond: stage === "hand_pose" ? 0 : 1100,
          } satisfies ModalRerunBinding,
        ]),
      ),
    };
  }

  for (const signal of [
    "budget_exceeded",
    "provider_container_restarted",
    "gpu_watchdog_unavailable",
  ] as const) {
    test(`a verified GPU call is cancelled when the watchdog reports ${signal}`, async () => {
      const { jobId, stub, cfg } = await world({
        recipeOver: { budget: { segment: 1 } },
      });
      const modal = Object.assign(
        new FakeModal(jobId, {
          segment: {
            poll: (id, _n, cancelled) =>
              cancelled ? returned(v2(id, 137, null)) : pending,
          },
        }),
        {
          async checkFunction() {
            return true;
          },
          async watchGpuCall() {
            if (signal === "gpu_watchdog_unavailable")
              throw new Error("lookup lost");
            return signal === "provider_container_restarted"
              ? ["one", "two"]
              : ["one"];
          },
        },
      );
      const out = stagesOf(
        await enter(stub, jobId, verifiedRecipeSettings(cfg), modal),
      );
      assert.equal(out.stopped, undefined);
      assert.deepEqual(modal.cancels, [stub.runs.get("segment")!.callId]);
      assert.deepEqual(rows(stub).segment, ["failed", signal]);
      assert.equal(
        new JournalStore(cfg.stateDir).readModal(jobId, "segment")?.termination,
        signal,
      );
    });
  }

  for (const cancelAcknowledged of [true, false]) {
    test(`execution-record refusal handles its exact GPU call with cancellation ${cancelAcknowledged ? "accepted" : "unconfirmed"}`, async () => {
      const { jobId, stub, cfg } = await world({
        fault(body) {
          return body.action === "record_stage_run" &&
            body.stage === "segment" &&
            body.state === "running"
            ? 409
            : undefined;
        },
      });
      const exactCall = "fc-RefusedKnownGpu";
      const modal = Object.assign(
        new FakeModal(jobId, {
          segment: {
            spawn: async () => exactCall,
            poll: () =>
              assert.fail(
                "A refused execution record must not report a terminal result",
              ),
          },
        }),
        {
          async checkFunction() {
            return true;
          },
          async watchGpuCall() {
            return ["one"];
          },
          async cancel(ref: string) {
            modal.cancels.push(ref);
            if (!cancelAcknowledged) throw new Error("provider unavailable");
          },
        },
      );
      const out = stagesOf(
        await enter(stub, jobId, verifiedRecipeSettings(cfg), modal),
      );
      assert.deepEqual(out.stopped, {
        outcome: "needs_operator",
        reason: cancelAcknowledged
          ? "execution_ref_conflict"
          : "gpu_cancel_unconfirmed",
        executionRef: exactCall,
      });
      assert.deepEqual(modal.stages(), ["segment"]);
      assert.deepEqual(modal.cancels, [exactCall]);
      assert.equal(stub.stageEvidence.size, 0);
      const stored = new JournalStore(cfg.stateDir).readModal(jobId, "segment");
      assert.equal(stored?.callId, exactCall);
      assert.equal(stored?.phase, "submitted");
      assert.equal(!!stored?.cancelRequestedAt, cancelAcknowledged);
    });
  }

  test("an unexpected supervisor failure cancels a known GPU call", async () => {
    const { jobId, stub, cfg } = await world();
    const modal = Object.assign(
      new FakeModal(jobId, {
        segment: {
          poll() {
            throw new Error("unexpected poll failure");
          },
        },
      }),
      {
        async checkFunction() {
          return true;
        },
        async watchGpuCall() {
          return ["one"];
        },
      },
    );
    const out = stagesOf(
      await enter(stub, jobId, verifiedRecipeSettings(cfg), modal),
    );
    const executionRef = stub.runs.get("segment")?.callId;
    assert.ok(executionRef);
    assert.deepEqual(out.stopped, {
      outcome: "needs_operator",
      reason: "gpu_supervision_failed",
      executionRef,
    });
    assert.deepEqual(modal.cancels, [executionRef]);
    assert.equal(stub.stageEvidence.size, 0);
  });

  for (const journalState of [
    "acknowledged",
    "terminal",
    "uncancelled",
  ] as const) {
    test(`a conflicting ${journalState} GPU journal cannot exempt the catalog call`, async () => {
      const { jobId, stub, cfg } = await world();
      const catalogId = "fc-CatalogGpu";
      const journalId = "fc-OlderJournalGpu";
      const store = new JournalStore(cfg.stateDir);
      const now = Date.now();
      const incoming: ModalJournal = {
        version: 1,
        executor: "modal",
        jobId,
        stage: "segment",
        runRef: "run-0",
        phase: journalState === "terminal" ? "terminal" : "submitted",
        callId: journalId,
        startDeadline: new Date(now + 60_000).toISOString(),
        executionDeadline: new Date(now + 60_000).toISOString(),
        ...(journalState === "terminal" ? { exitCode: 0 } : {}),
        ...(journalState === "acknowledged"
          ? {
              cancelRequestedAt: new Date(now - 2000).toISOString(),
              termination: "gpu_supervision_stopped",
            }
          : {}),
      };
      store.writeModal(incoming);
      stub.runs.set("segment", {
        state: "running",
        module: MODULES.segment,
        callId: catalogId,
      });
      const modal = Object.assign(new FakeModal(jobId), {
        async watchGpuCall() {
          assert.fail("Conflicting calls must not be polled");
        },
        async cancel(ref: string) {
          modal.cancels.push(ref);
          if (journalState === "terminal")
            throw new Error("fixture: no cancel acknowledgement");
        },
      });
      const out = stagesOf(
        await enter(stub, jobId, verifiedRecipeSettings(cfg), modal),
      );
      assert.deepEqual(out.stopped, {
        outcome: "needs_operator",
        reason: "execution_ref_mismatch",
        executionRef: catalogId,
        conflictingExecutionRef: journalId,
        ...(journalState === "terminal"
          ? { unconfirmedCancellationRefs: [catalogId] }
          : {}),
      });
      assert.deepEqual(
        modal.cancels,
        journalState === "uncancelled" ? [catalogId, journalId] : [catalogId],
      );
      assert.equal(stub.stageEvidence.size, 0);
      assert.deepEqual(modal.stages(), []);
      const after = store.readModal(jobId, "segment");
      assert.equal(after?.callId, journalId);
      if (journalState !== "uncancelled") assert.deepEqual(after, incoming);
    });
  }

  test("verified GPU stages refuse to issue a claim without a watchdog", async () => {
    const { jobId, stub, cfg } = await world();
    const modal = Object.assign(new FakeModal(jobId), {
      async checkFunction() {
        return true;
      },
    });
    const out = stagesOf(
      await enter(stub, jobId, verifiedRecipeSettings(cfg), modal),
    );
    assert.deepEqual(out.stopped, {
      outcome: "needs_operator",
      reason: "rerun_binding_unavailable",
    });
    assert.equal(stub.claims.size, 0);
    assert.deepEqual(modal.stages(), []);
  });

  test("bound execution records provider identity alongside the original receipt digest", async () => {
    const seen: unknown[] = [];
    const { jobId, stub, cfg } = await world({
      fault(body) {
        if (
          body.action === "record_stage_run" &&
          body.stage === "segment" &&
          body.receipt
        )
          seen.push(body.receipt);
        return undefined;
      },
    });
    const modal = Object.assign(new FakeModal(jobId), {
      async checkFunction() {
        return true;
      },
      async watchGpuCall() {
        return ["one"];
      },
    });
    const settings = verifiedRecipeSettings(cfg);
    await enter(stub, jobId, settings, modal);
    const binding = settings.verifiedBindings!.get(MODULES.segment)!;
    const original = receipt(jobId, "segment");
    assert.deepEqual(seen, [
      {
        ...original,
        schemaVersion: 2,
        providerBinding: {
          appName: binding.appName,
          codeRevision: binding.codeRevision,
          environment: binding.environment,
          functionId: binding.functionId,
          definitionId: binding.definitionId,
          paramsSha256: binding.paramsSha256,
          definitionSha256: binding.definitionSha256,
          workerReceiptSha256: requestSha256(original),
        },
      },
    ]);
  });

  test("a budget cancel that is not provably terminal is needs_operator: the stage stays open, nothing later starts", async () => {
    const { jobId, stub, cfg } = await world({
      recipeOver: { budget: { segment: 1 } },
    });
    const modal = new FakeModal(jobId, {
      segment: { poll: () => ({ kind: "unavailable", detail: "RemoteError" }) },
    });
    const out = stagesOf(await enter(stub, jobId, cfg, modal));
    assert.equal(out.stopped?.outcome, "needs_operator");
    if (out.stopped?.outcome === "needs_operator")
      assert.equal(
        out.stopped.reason,
        "call_not_provably_terminal_after_cancel",
      );
    assert.equal(modal.cancels.length, 1);
    assert.deepEqual(modal.stages(), ["segment"]);
    assert.deepEqual(rows(stub), { segment: ["running", null] });
    assert.equal(stub.stageEvidence.size, 0);
  });

  for (const stage of ["segment", "caption", "hand_pose"] as const)
    test(`submit_unknown per stage: a lost ${stage} spawn acknowledgement is never respawned`, async () => {
      const { jobId, stub, cfg } = await world();
      const modal = new FakeModal(jobId, {
        [stage]: {
          spawn: async () => {
            throw new Error("connection reset after the request was sent");
          },
        },
      });
      const out = stagesOf(await enter(stub, jobId, cfg, modal));
      assert.deepEqual(out.stopped, {
        outcome: "submit_unknown",
        reason: "spawn_outcome_uncertain",
      });
      assert.equal(stub.runs.get(stage)!.state, "submit_unknown");
      assert.ok(stub.actions().includes("mark_submit_unknown"));
      // A Render retry of the same task: still one spawn of that stage, nothing after it.
      const again = stagesOf(await enter(stub, jobId, cfg, modal));
      assert.equal(again.stopped?.outcome, "submit_unknown");
      assert.equal(modal.stages().filter((s) => s === stage).length, 1);
      const order = ["segment", "caption", "hand_pose"];
      assert.deepEqual(
        modal.stages(),
        order.slice(0, order.indexOf(stage) + 1),
      );
    });

  test("re-entry at intent: a lost answer to the submitting record re-enters at intent and spawns once", async () => {
    let failOnce = true;
    const { jobId, stub, cfg } = await world({
      fault: (b) => {
        if (
          failOnce &&
          b.action === "record_stage_run" &&
          b.stage === "caption" &&
          b.state === "submitting"
        ) {
          failOnce = false;
          return 503;
        }
        return undefined;
      },
    });
    const modal = new FakeModal(jobId);
    await assert.rejects(enter(stub, jobId, cfg, modal));
    assert.equal(
      new JournalStore(cfg.stateDir).readModal(jobId, "caption")?.phase,
      "intent",
    );
    const out = stagesOf(await enter(stub, jobId, cfg, modal));
    assert.equal(out.stopped, undefined);
    assert.deepEqual(modal.stages(), ["segment", "caption", "hand_pose"]);
    assert.equal(
      stub.calls.filter(
        (c) =>
          c.body?.action === "issue_stage_claim" && c.body.stage === "caption",
      ).length,
      1,
    );
  });

  test("re-entry at spawning: a journaled spawn mark without a call ID is never spawned again", async () => {
    const { jobId, stub, cfg } = await world();
    // The caption spawn request leaves no acknowledgement (as if the process died at the spawn).
    const modal = new FakeModal(jobId, {
      caption: {
        spawn: async () => {
          throw new ProcessCrash();
        },
      },
    });
    const first = stagesOf(await enter(stub, jobId, cfg, modal));
    assert.equal(first.stopped?.outcome, "submit_unknown");
    const store = new JournalStore(cfg.stateDir);
    const j = store.readModal(jobId, "caption");
    assert.equal(j?.phase, "spawning");
    assert.equal(j?.callId, undefined);
    assert.ok(
      !existsSync(join(store.dir(jobId, "caption"), "bootstrap.token")),
    );
    const again = stagesOf(await enter(stub, jobId, cfg, new FakeModal(jobId)));
    assert.deepEqual(again.stopped, {
      outcome: "submit_unknown",
      reason: "spawn_outcome_uncertain",
    });
    assert.deepEqual(modal.stages(), ["segment", "caption"]);
    assert.equal(stub.runs.get("caption")!.state, "submit_unknown");
  });

  test("re-entry at submitted: a controller crash while polling adopts the journaled call, never respawns", async () => {
    let crash = true;
    const { jobId, stub, cfg } = await world();
    const modal = new FakeModal(jobId, {
      caption: {
        poll: (id, k) => {
          if (crash && k === 1) {
            crash = false;
            throw new ProcessCrash();
          }
          return returned(v2(id, 0, receipt(jobId, "caption")));
        },
      },
    });
    await assert.rejects(enter(stub, jobId, cfg, modal), ProcessCrash);
    const store = new JournalStore(cfg.stateDir);
    assert.equal(store.readModal(jobId, "caption")?.phase, "submitted");
    const out = stagesOf(await enter(stub, jobId, cfg, modal));
    assert.equal(out.stopped, undefined);
    assert.deepEqual(modal.stages(), ["segment", "caption", "hand_pose"]);
    assert.equal(stub.runs.get("caption")!.state, "succeeded");
  });

  test("re-entry at terminal: an unconfirmed proof is retried from the journal; the stage then settles once", async () => {
    let failOnce = true;
    const { jobId, stub, cfg } = await world({
      fault: (b) => {
        if (failOnce && b.action === "record_execution_evidence") {
          failOnce = false;
          return 503;
        }
        return undefined;
      },
    });
    const modal = new FakeModal(jobId);
    const first = stagesOf(await enter(stub, jobId, cfg, modal));
    assert.equal(first.stopped?.outcome, "call_terminal");
    assert.equal(stub.runs.get("segment")!.state, "running");
    const store = new JournalStore(cfg.stateDir);
    assert.equal(store.readModal(jobId, "segment")?.phase, "terminal");
    const out = stagesOf(await enter(stub, jobId, cfg, modal));
    assert.equal(out.stopped, undefined);
    assert.deepEqual(modal.stages(), ["segment", "caption", "hand_pose"]);
    assert.equal(stub.runs.get("segment")!.state, "succeeded");
  });

  test("re-entry on a fresh host (lost task-local disk): the server's stage call is adopted, never respawned", async () => {
    const { jobId, stub, cfg } = await world();
    let crash = true;
    const modal = new FakeModal(jobId, {
      segment: {
        poll: (id) => {
          if (crash) {
            crash = false;
            throw new ProcessCrash();
          }
          return returned(v2(id, 0, receipt(jobId, "segment")));
        },
      },
    });
    await assert.rejects(enter(stub, jobId, cfg, modal), ProcessCrash);
    const call = stub.runs.get("segment")!.callId!;
    // The worker had claimed with the same call ID; the new host has no journal at all.
    assert.ok(stub.claimStage("segment", call));
    const fresh = { ...cfg, stateDir: join(root, `state-${randomUUID()}`) };
    const out = await enter(stub, jobId, fresh, modal);
    // The new host observed the adopted call's result itself, so caption gets its segments input.
    assert.equal(modal.stages().filter((s) => s === "segment").length, 1);
    assert.equal(stub.runs.get("segment")!.state, "succeeded");
    assert.equal(
      new JournalStore(fresh.stateDir).readModal(jobId, "segment")?.callId,
      call,
    );
    assert.equal(stagesOf(out).stopped, undefined);
  });

  test("a claim issued before a crash with no journal and no row is never spawned (intent_recorded_without_token)", async () => {
    const { jobId, stub, cfg } = await world();
    const api = new JobsApi(stub.url, "cap", 5000);
    // Another (lost) entry issued the segment claim and died before journaling its token.
    await api.act(jobId, {
      action: "claim_lease",
      runRef: "run-x",
      owner: "o",
    });
    await api.act(jobId, {
      action: "issue_stage_claim",
      owner: "o",
      stage: "segment",
    });
    const modal = new FakeModal(jobId);
    const out = stagesOf(await enter(stub, jobId, cfg, modal));
    assert.deepEqual(out.stopped, {
      outcome: "submit_unknown",
      reason: "intent_recorded_without_token",
    });
    assert.equal(modal.spawns.length, 0);
    assert.equal(stub.runs.get("segment")!.state, "submit_unknown");
  });

  test("a stage call recorded on the server that differs from the journal is needs_operator, no evidence", async () => {
    const { jobId, stub, cfg } = await world();
    const store = new JournalStore(cfg.stateDir);
    const mine = callId();
    const j: ModalJournal = {
      version: 1,
      executor: "modal",
      jobId,
      stage: "segment",
      runRef: "run-0",
      phase: "submitted",
      callId: mine,
      startDeadline: new Date(Date.now() + 60_000).toISOString(),
      executionDeadline: new Date(Date.now() + 60_000).toISOString(),
    };
    store.writeModal(j);
    stub.runs.set("segment", {
      state: "running",
      module: MODULES.segment,
      callId: callId(),
    });
    const out = stagesOf(await enter(stub, jobId, cfg, new FakeModal(jobId)));
    assert.equal(out.stopped?.outcome, "needs_operator");
    if (out.stopped?.outcome === "needs_operator")
      assert.equal(out.stopped.reason, "execution_ref_mismatch");
    assert.equal(stub.stageEvidence.size, 0);
  });

  test("module policy: a local-only stub module never runs on the Modal executor; outside APP_ENV=local never at all", async () => {
    const local: LocalControllerSettings = {
      executor: "local",
      apiUrl: "http://127.0.0.1:1",
      stateDir: root,
      renewIntervalMs: 100,
      pollIntervalMs: 20,
      leaseWaitMs: 0,
      reapGraceMs: 100,
      apiTimeoutMs: 1000,
      python: "python3",
      pipeline: "hand_pose_cpu_v1",
    };
    const modal = settings("https://api.example.test");
    assert.equal(
      stageModuleRefusal(local, "segment", "stub_segmenter@1", "local"),
      undefined,
    );
    assert.equal(
      stageModuleRefusal(local, "segment", "stub_segmenter@1", "development"),
      "module_local_only",
    );
    assert.equal(
      stageModuleRefusal(modal, "segment", "stub_segmenter@1", "local"),
      "module_local_only",
    );
    assert.equal(
      stageModuleRefusal(local, "segment", MODULES.segment, "local"),
      "module_needs_gpu",
    );
    assert.equal(
      stageModuleRefusal(modal, "segment", MODULES.segment),
      undefined,
    );
    assert.equal(
      stageModuleRefusal(modal, "segment", "flora_tempseg_hf@1"),
      "module_unbound",
    );
    assert.equal(
      stageModuleRefusal(modal, "caption", MODULES.segment),
      "module_unknown",
    );
    assert.equal(
      stageModuleRefusal(modal, "hand_pose", MODULES.hand_pose),
      undefined,
    );
  });

  test("an unbound GPU module is not_run before any claim; hand_pose still runs", async () => {
    const { jobId, stub, cfg } = await world();
    const modal = new FakeModal(jobId);
    const out = stagesOf(
      await enter(stub, jobId, { ...cfg, stageFunctions: {} }, modal),
    );
    assert.equal(out.stopped, undefined);
    assert.deepEqual(modal.stages(), ["hand_pose"]);
    assert.deepEqual(rows(stub), {
      segment: ["not_run", "module_unbound"],
      caption: ["not_run", "upstream_failed"],
      hand_pose: ["failed", "receipt_missing"],
    });
  });

  test("the run result is parsed strictly: v2 with a valid receipt for exactly this stage", () => {
    const jobId = randomUUID();
    const id = callId();
    const seg = { jobId, stage: "segment" as const, module: MODULES.segment };
    const ok = receipt(jobId, "segment");
    assert.ok(validateValue("jobs.stage-receipt.v1", ok).valid);
    assert.ok(parseRunResult(v2(id, 0, ok), id, seg));
    assert.equal(parseRunResult(v2(id, 0, null), id, seg)?.receipt, null);
    // v1 is the non-recipe job-level result. Every recipe stage requires v2.
    assert.equal(
      parseRunResult(
        { schemaVersion: 1, functionCallId: id, exitCode: 0 },
        id,
        seg,
      ),
      undefined,
    );
    assert.equal(
      parseRunResult(
        { schemaVersion: 1, functionCallId: id, exitCode: 0 },
        id,
        {
          jobId,
          stage: "hand_pose",
          module: MODULES.hand_pose,
        },
      ),
      undefined,
    );
    assert.equal(
      parseRunResult(v2(id, 0, ok), id),
      undefined,
      "no v2 without a stage",
    );
    for (const bad of [
      v2(id, 3, ok), // exit code disagrees with the receipt status
      v2(callId(), 0, ok), // another call
      v2(id, 0, { ...ok, stage: "caption" }),
      v2(id, 0, { ...ok, jobId: randomUUID() }),
      v2(id, 0, { ...ok, module: "flora_tempseg_hf@1" }),
      v2(id, 0, { ...ok, outputs: [] }), // a succeeded segment lists exactly one segments_json
      { ...v2(id, 0, ok), extra: 1 },
      { schemaVersion: 2, functionCallId: id, exitCode: 0 },
    ])
      assert.equal(
        parseRunResult(bad, id, seg),
        undefined,
        JSON.stringify(bad).slice(0, 80),
      );
  });
});

class ProcessCrash extends Error {}
