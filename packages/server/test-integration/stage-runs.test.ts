import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { after, afterEach, test } from "node:test";
import {
  requestSha256,
  segmentId,
  validateValue,
  type RecipeV1,
  type StageReceiptV1,
} from "@stateaction/contracts";
import { processRecordingTaskInputV2 } from "../src/admission/job-input.js";
import {
  advanceResult,
  closeOutputs,
  submitCandidate,
} from "../src/acceptance/service.js";
import { BootstrapCapabilityStore } from "../src/jobs/credentials.js";
import {
  admitNextJob,
  claimControllerLease,
  recordExecutionEvidence,
  recordWorkerSubmissionIntent,
  type JobsDeps,
} from "../src/jobs/service.js";
import {
  claimStage,
  getDagRun,
  getPriorStages,
  issueStageClaim,
  readStageOutput,
  recordStageHeartbeat,
  recordStageRun,
} from "../src/jobs/stages.js";
import { hashServiceToken } from "../src/auth/service.js";
import { TransportError } from "../src/transport/errors.js";
import type { TransportDeps } from "../src/transport/index.js";
import type { AcceptanceDeps } from "../src/acceptance/service.js";
import {
  acceptanceDatabase,
  acceptanceDeps,
  candidateBody,
  checksSummary,
  manifestFor,
  runningJob,
  uploadClip,
  uploadOutput,
  type AcceptanceDb,
  type RunningJob,
  type Uploaded,
} from "./acceptance-harness.js";
import { writeArtifact } from "./harness.js";
import { JOBS_CONFIG, nonce, owner, queuedJob } from "./jobs-harness.js";

/**
 * SA-88 migration 011 against the real restricted Postgres and real object
 * storage: recipe admission, per-stage claims, forward-only stage runs, the
 * stage-scoped output read, 0-clip annotation acceptance, the caption subset
 * rule and the unchanged clip path.
 */

const evidence: Record<string, unknown> = {};
const open: AcceptanceDb[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((db) => db.close()));
});
after(async () => {
  await writeArtifact("stage-runs.json", evidence);
});

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: unknown) =>
      error instanceof TransportError
        ? error.code
        : ((error as { code?: string }).code ?? `unexpected:${String(error)}`),
  );

const fixture = (name: string, caseName?: string) => {
  const doc = JSON.parse(
    readFileSync(
      new URL(
        `../../contracts/conformance/fixtures/contracts/${name}.json`,
        import.meta.url,
      ),
      "utf8",
    ),
  ) as {
    cases: {
      name: string;
      input: { document: Record<string, any> };
      expect: { valid: boolean };
    }[];
  };
  const c = doc.cases.find(
    (x) => x.expect.valid && (caseName === undefined || x.name === caseName),
  );
  assert.ok(c, `${name} fixture case`);
  return structuredClone(c.input.document);
};

const MODULES = {
  segment: "stub_segmenter@1",
  caption: "stub_captioner@1",
  hand_pose: "hand_pose_cpu_v1@1",
} as const;

function recipe(over: { captionEnabled?: boolean } = {}): RecipeV1 {
  const resources = {
    gpu: "none" as const,
    budgetSeconds: 600,
    maxContainers: 1,
    retries: 0 as const,
  };
  return {
    schemaVersion: 1,
    recipeId: "stub_local@1",
    maxJobCostUsd: "0.00",
    stages: [
      {
        stage: "segment",
        enabled: true,
        module: MODULES.segment,
        params: {},
        resources,
      },
      {
        stage: "caption",
        enabled: over.captionEnabled ?? true,
        module: MODULES.caption,
        params: {},
        resources,
      },
      {
        stage: "hand_pose",
        enabled: true,
        module: MODULES.hand_pose,
        params: {},
        resources,
      },
    ],
  };
}

type Scenario = {
  db: AcceptanceDb;
  transport: TransportDeps;
  accept: AcceptanceDeps;
  deps: JobsDeps;
  jobId: string;
  recordingId: string;
  ctl: string;
  recipe: RecipeV1;
  sourceManifestSha256: string;
};

/** A queued job admitted with a v3 task input (inline recipe) and a live lease. */
async function recipeJob(
  over: { captionEnabled?: boolean } = {},
): Promise<Scenario> {
  const db = await acceptanceDatabase();
  open.push(db);
  const { transport, accept } = await acceptanceDeps(db);
  const { jobId, recordingId } = await queuedJob(db);
  const r = recipe(over);
  const deps: JobsDeps = {
    pool: db.app,
    config: JOBS_CONFIG,
    presignRead: async (key, ttl) => `http://127.0.0.1:9/${key}?ttl=${ttl}`,
    taskInput: async (q, job) => {
      const v2 = (await processRecordingTaskInputV2(
        q as never,
        job.jobId,
      )) as unknown as Record<string, unknown>;
      return {
        ...v2,
        schemaVersion: 3,
        recipe: r,
        recipeSha256: requestSha256(r),
      };
    },
  };
  const admitted = await admitNextJob(deps);
  assert.equal(admitted.state, "admitted");
  const ctl = owner();
  const lease = await claimControllerLease(deps, {
    jobId,
    runRef: "run-1",
    owner: ctl,
  });
  assert.equal(lease.granted, true);
  const sms = (
    await db.owner.query(
      "SELECT source_manifest_sha256 FROM jobs WHERE id = $1",
      [jobId],
    )
  ).rows[0].source_manifest_sha256 as string;
  return {
    db,
    transport,
    accept,
    deps,
    jobId,
    recordingId,
    ctl,
    recipe: r,
    sourceManifestSha256: sms,
  };
}

type Claimed = {
  stage: "segment" | "caption" | "hand_pose";
  nonce: string;
  callId: string;
  bootstrapToken: string;
  job: RunningJob;
};

async function claimed(s: Scenario, stage: Claimed["stage"]): Promise<Claimed> {
  const issued = await issueStageClaim(s.deps, {
    jobId: s.jobId,
    owner: s.ctl,
    stage,
  });
  assert.equal(issued.state, "recorded");
  if (issued.state !== "recorded") throw new Error("unreachable");
  assert.equal(
    validateValue("jobs.controller-result.v1", {
      ...issued,
      startDeadline: issued.startDeadline.toISOString(),
      executionDeadline: issued.executionDeadline.toISOString(),
    }).valid,
    true,
  );
  const n = nonce();
  const callId = `stage-${stage}-${randomUUID()}`;
  const grant = await claimStage(s.deps, {
    jobId: s.jobId,
    bootstrapToken: issued.bootstrapToken,
    invocationNonce: n,
    executor: { kind: "local", localExecutionRef: callId },
  });
  assert.equal(grant.invocationNonce, n);
  return {
    stage,
    nonce: n,
    callId,
    bootstrapToken: issued.bootstrapToken,
    job: {
      jobId: s.jobId,
      recordingId: s.recordingId,
      nonce: n,
      authority: { kind: "job", jobId: s.jobId },
    },
  };
}

const receiptOf = (
  s: Scenario,
  stage: Claimed["stage"],
  files: Uploaded[],
  counts: Record<string, number> = {},
): StageReceiptV1 => ({
  schemaVersion: 1,
  jobId: s.jobId,
  stage,
  module: MODULES[stage],
  status: "succeeded",
  errorCode: null,
  outputs: files.map((f) => ({
    fileId: f.fileId,
    role: f.role as never,
    sizeBytes: String(f.size),
    sha256: f.sha,
  })),
  counts,
  gpu: { requestedType: "none", observedType: null },
  startedAt: "2026-11-22T10:00:00Z",
  finishedAt: "2026-11-22T10:01:00Z",
});

async function finish(
  s: Scenario,
  c: Claimed,
  files: Uploaded[],
  counts: Record<string, number> = {},
) {
  await recordStageRun(s.deps, {
    jobId: s.jobId,
    owner: s.ctl,
    stage: c.stage,
    state: "running",
    module: MODULES[c.stage],
    callId: c.callId,
  });
  // A spawned stage ends only after terminal proof for its exact call.
  const proof = await recordExecutionEvidence(s.deps, {
    jobId: s.jobId,
    recordedBy: "controller-test",
    evidence: { kind: "local_child_reaped", executionRef: c.callId },
  });
  assert.equal(proof.recorded, true);
  return recordStageRun(s.deps, {
    jobId: s.jobId,
    owner: s.ctl,
    stage: c.stage,
    state: "succeeded",
    module: MODULES[c.stage],
    callId: c.callId,
    receipt: receiptOf(s, c.stage, files, counts),
  });
}

function segmentsDoc(s: Scenario) {
  const doc = fixture(
    "artifacts.segments.v1",
    "stub module may leave model provenance null",
  );
  doc.job_id = s.jobId;
  doc.recording_id = s.recordingId;
  doc.source_manifest_sha256 = s.sourceManifestSha256;
  for (const row of doc.rows)
    row.segment_id = segmentId(
      s.sourceManifestSha256,
      MODULES.segment,
      doc.producer.params_sha256,
      row.start.source_frame_id,
      row.end.source_frame_id,
    );
  return doc;
}

function captionsDoc(
  s: Scenario,
  segments: Record<string, any>,
  segmentsSha: string,
) {
  const doc = fixture(
    "artifacts.captions.v1",
    "complete, failed and not_captioned rows",
  );
  doc.job_id = s.jobId;
  doc.recording_id = s.recordingId;
  doc.source_manifest_sha256 = s.sourceManifestSha256;
  doc.segments_sha256 = segmentsSha;
  doc.producer = {
    ...doc.producer,
    module_id: "stub_captioner",
    model_name: "stub_captioner",
    model_revision: null,
    weights_sha256: null,
    quant: null,
    prompt_sha256: null,
    decoding_params: {},
    engine: { name: "stub", version: "1" },
    gpu: { requested_type: "none", observed_type: null },
  };
  doc.rows.forEach((row: Record<string, any>, i: number) => {
    row.segment_id = segments.rows[i].segment_id;
  });
  return doc;
}

function handPresenceDoc(s: Scenario) {
  const doc = fixture("artifacts.hand-presence.v1");
  doc.job_id = s.jobId;
  doc.recording_id = s.recordingId;
  doc.source_manifest_sha256 = s.sourceManifestSha256;
  return doc;
}

const json = (doc: unknown) => Buffer.from(JSON.stringify(doc));

/**
 * The whole stub recipe through the real services: segment, caption (reading
 * segments through the stage-scoped read), then the hand_pose seal with zero
 * clips. Returns everything needed to submit and accept.
 */
async function runRecipe(
  s: Scenario,
  mutateCaptions: (doc: Record<string, any>) => void = () => {},
  opts: {
    /** SA-91: a segment diagnostic its receipt does not name (a stage that lost its receipt). */
    orphan?: boolean;
    /** SA-91: edit the v3 manifest before it is uploaded. */
    mutateDoc?: (doc: Record<string, any>, ids: Record<string, string>) => void;
    /** SA-91: stop before the v3 manifest (the caller uploads its own result). */
    noManifest?: boolean;
  } = {},
) {
  const seg = await claimed(s, "segment");
  // job-level claim follows the first claimed stage (SA-25 invariants hold)
  const job = (
    await s.db.owner.query(
      "SELECT state, invocation_nonce, submission_intent_at IS NOT NULL AS intent FROM jobs WHERE id = $1",
      [s.jobId],
    )
  ).rows[0];
  assert.deepEqual(job, {
    state: "running",
    invocation_nonce: seg.nonce,
    intent: true,
  });
  const segments = segmentsDoc(s);
  const segFile = await uploadOutput(
    s.transport,
    seg.job,
    "segments.json",
    "segments_json",
    json(segments),
    { http: true },
  );
  const diag = await uploadOutput(
    s.transport,
    seg.job,
    "diagnostics/segment/windows.jsonl",
    "diagnostic_blob",
    Buffer.from('{"window":0}\n'),
    { http: true },
  );
  const orphan = opts.orphan
    ? await uploadOutput(
        s.transport,
        seg.job,
        "diagnostics/segment/log.txt",
        "diagnostic_blob",
        Buffer.from("orphan log\n"),
        { http: true },
      )
    : undefined;
  await finish(s, seg, [segFile, diag], { segments: 3, failed_windows: 1 });

  const cap = await claimed(s, "caption");
  const read = await readStageOutput(s.deps, {
    jobId: s.jobId,
    fileId: segFile.fileId,
    stage: "caption",
  });
  assert.equal(read.fileId, segFile.fileId);
  const captions = captionsDoc(s, segments, segFile.sha);
  mutateCaptions(captions);
  const capFile = await uploadOutput(
    s.transport,
    cap.job,
    "captions.json",
    "captions_json",
    json(captions),
    { http: true },
  );
  await finish(s, cap, [capFile], { captions_complete: 2 });

  const hand = await claimed(s, "hand_pose");
  const hp = await uploadOutput(
    s.transport,
    hand.job,
    "hand-presence.json",
    "hand_presence_json",
    json(handPresenceDoc(s)),
    { http: true },
  );
  const mp4 = await uploadOutput(
    s.transport,
    hand.job,
    "recording.mp4",
    "recording_mp4",
    Buffer.from(`mp4:${randomUUID()}`),
    { http: true },
  );
  const files = [segFile, diag, ...(orphan ? [orphan] : []), capFile, hp, mp4];
  if (opts.noManifest)
    return { seg, cap, hand, files, hp, mp4, orphan, segFile, diag, capFile };
  const bytes = await manifestFor(s.db, hand.job, [], (doc) => {
    const v3 = fixture(
      "artifacts.processing-result.v3",
      "recording-level outputs with zero clips",
    );
    doc.schema = "stateaction.processing_result.v3";
    doc.recipe_id = s.recipe.recipeId;
    doc.recipe_sha256 = requestSha256(s.recipe);
    doc.checks = v3.checks;
    doc.outputs = files.map((o) => ({
      file_id: o.fileId,
      role: o.role,
      relative_path: o.slot,
      size_bytes: String(o.size),
      sha256: o.sha,
    }));
    doc.clips = [];
    doc.nodes = [
      {
        stage: "segment",
        status: "succeeded",
        module: MODULES.segment,
        error_code: null,
        outputs: [
          segFile.fileId,
          diag.fileId,
          ...(orphan ? [orphan.fileId] : []),
        ],
        counts: { segments: 3 },
      },
      {
        stage: "caption",
        status: "succeeded",
        module: MODULES.caption,
        error_code: null,
        outputs: [capFile.fileId],
        counts: { captions_complete: 2 },
      },
      {
        stage: "hand_pose",
        status: "succeeded",
        module: MODULES.hand_pose,
        error_code: null,
        outputs: [hp.fileId, mp4.fileId],
        counts: { clips: 0 },
      },
    ];
    opts.mutateDoc?.(doc, {
      segments: segFile.fileId,
      diag: diag.fileId,
      captions: capFile.fileId,
      hp: hp.fileId,
      mp4: mp4.fileId,
    });
  });
  const manifest = await uploadOutput(
    s.transport,
    hand.job,
    "result-manifest.json",
    "result_manifest",
    bytes,
  );
  const doc = JSON.parse(bytes.toString()) as Record<string, any>;
  assert.equal(
    validateValue("artifacts.processing-result.v3", doc).valid,
    true,
    "the test manifest is a valid processing-result.v3",
  );
  return {
    seg,
    cap,
    hand,
    files,
    hp,
    mp4,
    manifest,
    doc,
    orphan,
    segFile,
    diag,
    capFile,
  };
}

async function seal(
  s: Scenario,
  r: Awaited<ReturnType<typeof runRecipe>>,
): Promise<void> {
  const closure = await closeOutputs(s.accept, {
    jobId: s.jobId,
    invocationNonce: r.hand.nonce,
    outcome: "succeeded",
  });
  // Annotation files are not clip files (009 counted every non-manifest file).
  assert.equal(closure.clipCount, 0);
  assert.equal(closure.fileCount, r.files.length + 1);
  await submitCandidate(s.accept, {
    ...candidateBody(r.hand.job, r.manifest, r.doc),
    summary: {
      outcome: "succeeded",
      clipCount: 0,
      checks: checksSummary(r.doc),
      errorCode: null,
    },
  });
  // The seal's proof is also the job's terminal evidence (every spawned
  // stage already has its own).
  await finish(s, r.hand, [r.hp, r.mp4], { clips: 0 });
  assert.equal(
    (
      await s.db.owner.query(
        "SELECT count(*)::int AS n FROM job_execution_evidence WHERE job_id = $1",
        [s.jobId],
      )
    ).rows[0].n,
    1,
  );
}

const jobFacts = async (s: Scenario) =>
  (
    await s.db.owner.query(
      `SELECT j.state, j.error_code, j.segment_count, j.failed_window_count, j.caption_count,
              j.caption_failed_count, r.status AS recording,
              (SELECT count(*)::int FROM clips c WHERE c.job_id = j.id) AS clips,
              (SELECT job_id FROM dispatch_admission WHERE slot = 1) AS holder
       FROM jobs j JOIN recordings r ON r.id = j.recording_id WHERE j.id = $1`,
      [s.jobId],
    )
  ).rows[0] as Record<string, unknown>;

// --------------------------------------------------------------------- tests

test("an over-12h recipe is rejected at admission and does not block the queue", async () => {
  const db = await acceptanceDatabase();
  open.push(db);
  const bad = await queuedJob(db);
  const good = await queuedJob(db);
  const over = recipe();
  for (const st of over.stages) st.resources.budgetSeconds = 15_000;
  const fine = recipe();
  const deps: JobsDeps = {
    pool: db.app,
    config: JOBS_CONFIG,
    presignRead: async (key, ttl) => `http://127.0.0.1:9/${key}?ttl=${ttl}`,
    taskInput: async (q, job) => {
      const v2 = (await processRecordingTaskInputV2(
        q as never,
        job.jobId,
      )) as unknown as Record<string, unknown>;
      const r = job.jobId === bad.jobId ? over : fine;
      return {
        ...v2,
        schemaVersion: 3,
        recipe: r,
        recipeSha256: requestSha256(r),
      };
    },
  };
  const result = await admitNextJob(deps);
  assert.equal(result.state, "admitted");
  if (result.state !== "admitted") return;
  assert.equal(result.job.jobId, good.jobId);
  assert.deepEqual(result.rejectedJobIds, [bad.jobId]);
  const row = (
    await db.owner.query(
      "SELECT state, error_code, finished_at FROM jobs WHERE id = $1",
      [bad.jobId],
    )
  ).rows[0];
  assert.equal(row.state, "cancelled");
  assert.equal(row.error_code, "recipe_deadline_exceeded");
  assert.ok(row.finished_at);
  const inputs = await db.owner.query(
    "SELECT 1 FROM job_inputs WHERE job_id = $1",
    [bad.jobId],
  );
  assert.equal(inputs.rowCount, 0);
  const dl = (
    await db.owner.query(
      "SELECT extract(epoch FROM execution_deadline - admitted_at)::int AS secs FROM jobs WHERE id = $1",
      [good.jobId],
    )
  ).rows[0];
  assert.equal(dl.secs, 3 * 600 + 1800);
});

test("an invalid task input is rejected at admission and does not block the queue", async () => {
  const db = await acceptanceDatabase();
  open.push(db);
  const bad = await queuedJob(db);
  const good = await queuedJob(db);
  const deps: JobsDeps = {
    pool: db.app,
    config: JOBS_CONFIG,
    presignRead: async (key, ttl) => `http://127.0.0.1:9/${key}?ttl=${ttl}`,
    taskInput: async (q, job) => {
      const v2 = (await processRecordingTaskInputV2(
        q as never,
        job.jobId,
      )) as unknown as Record<string, unknown>;
      // v3 without its recipe fails contract validation.
      return job.jobId === bad.jobId ? { ...v2, schemaVersion: 3 } : v2;
    },
  };
  const result = await admitNextJob(deps);
  assert.equal(result.state, "admitted");
  if (result.state !== "admitted") return;
  assert.equal(result.job.jobId, good.jobId);
  assert.deepEqual(result.rejectedJobIds, [bad.jobId]);
  const row = (
    await db.owner.query(
      "SELECT state, error_code, error_message, finished_at FROM jobs WHERE id = $1",
      [bad.jobId],
    )
  ).rows[0];
  assert.equal(row.state, "cancelled");
  assert.equal(row.error_code, "task_input_invalid");
  assert.match(row.error_message, /^task input rejected: /);
  assert.ok(row.finished_at);
  assert.equal(
    (
      await db.owner.query("SELECT 1 FROM job_inputs WHERE job_id = $1", [
        bad.jobId,
      ])
    ).rowCount,
    0,
  );
  const slot = await db.owner.query(
    "SELECT job_id FROM dispatch_admission WHERE slot = 1",
  );
  assert.equal(slot.rows[0].job_id, good.jobId);
  // The rejected job never comes back: the next call finds the slot busy.
  assert.equal((await admitNextJob(deps)).state, "slot_busy");
});

test("recipe admission stores the recipe once and dag-run renders every stage", async () => {
  const s = await recipeJob({ captionEnabled: false });
  const row = (
    await s.db.owner.query(
      "SELECT recipe, recipe_sha256 FROM jobs WHERE id = $1",
      [s.jobId],
    )
  ).rows[0];
  assert.deepEqual(row.recipe, s.recipe);
  assert.equal(row.recipe_sha256, requestSha256(s.recipe));
  assert.equal(
    await code(
      s.db.owner.query("UPDATE jobs SET recipe = '{}'::jsonb WHERE id = $1", [
        s.jobId,
      ]),
    ),
    "SAC01",
  );
  const dag = await getDagRun(s.deps, s.jobId);
  assert.equal(validateValue("http.dag-run.v1", dag).valid, true);
  assert.deepEqual(
    dag.stages.map((n) => [n.stage, n.state, n.errorCode]),
    [
      ["segment", "pending", null],
      ["caption", "not_run", "stage_disabled"],
      ["hand_pose", "pending", null],
    ],
  );
  // A disabled stage is never claimed and only ever recorded as not_run.
  assert.equal(
    await code(
      issueStageClaim(s.deps, {
        jobId: s.jobId,
        owner: s.ctl,
        stage: "caption",
      }),
    ),
    "conflict",
  );
  assert.equal(
    await code(
      recordStageRun(s.deps, {
        jobId: s.jobId,
        owner: s.ctl,
        stage: "caption",
        state: "pending",
        module: MODULES.caption,
      }),
    ),
    "conflict",
  );
  // The single-claim path is refused for a recipe job.
  assert.equal(
    await code(
      recordWorkerSubmissionIntent(s.deps, { jobId: s.jobId, owner: s.ctl }),
    ),
    "conflict",
  );
  evidence.dagDisabled = dag.stages;
});

test("stage claims: own nonce and token per stage, replay and second claim rejected, recipe order", async () => {
  const s = await recipeJob();
  // caption cannot start before segment has a terminal run
  assert.equal(
    await code(
      issueStageClaim(s.deps, {
        jobId: s.jobId,
        owner: s.ctl,
        stage: "caption",
      }),
    ),
    "conflict",
  );
  assert.equal(
    await code(
      issueStageClaim(s.deps, {
        jobId: s.jobId,
        owner: "ctl-other",
        stage: "segment",
      }),
    ),
    "conflict",
    "lease-fenced",
  );
  const seg = await claimed(s, "segment");
  assert.deepEqual(
    await issueStageClaim(s.deps, {
      jobId: s.jobId,
      owner: s.ctl,
      stage: "segment",
    }),
    { state: "already_recorded" },
  );
  // A replayed bootstrap token resolves to nothing and cannot claim again.
  assert.equal(
    await new BootstrapCapabilityStore(s.db.app).findByTokenSha256(
      hashServiceToken(seg.bootstrapToken),
    ),
    null,
  );
  assert.equal(
    await code(
      claimStage(s.deps, {
        jobId: s.jobId,
        bootstrapToken: seg.bootstrapToken,
        invocationNonce: nonce(),
        executor: { kind: "local", localExecutionRef: "replayed-1" },
      }),
    ),
    "conflict",
  );
  // Heartbeat is per stage and nonce; a wrong nonce is not current.
  const hb = await recordStageHeartbeat(s.deps, {
    jobId: s.jobId,
    stage: "segment",
    invocationNonce: seg.nonce,
    phase: "segmenting",
    processedFrames: "10",
    totalFrames: "100",
  });
  assert.equal(hb.accepted, true);
  assert.equal(
    await code(
      recordStageHeartbeat(s.deps, {
        jobId: s.jobId,
        stage: "segment",
        invocationNonce: nonce(),
        phase: "segmenting",
      }),
    ),
    "forbidden",
  );
  const phase = (
    await s.db.owner.query(
      "SELECT j.heartbeat_phase AS job, c.heartbeat_phase AS stage, c.processed_frames::text AS done FROM jobs j JOIN job_stage_claims c ON c.job_id = j.id AND c.stage = 'segment' WHERE j.id = $1",
      [s.jobId],
    )
  ).rows[0];
  assert.deepEqual(phase, {
    job: "segmenting",
    stage: "segmenting",
    done: "10",
  });

  // Forward-only transitions and the write-once call ID.
  await recordStageRun(s.deps, {
    jobId: s.jobId,
    owner: s.ctl,
    stage: "segment",
    state: "running",
    module: MODULES.segment,
    callId: seg.callId,
  });
  const replay = await recordStageRun(s.deps, {
    jobId: s.jobId,
    owner: s.ctl,
    stage: "segment",
    state: "running",
    module: MODULES.segment,
    callId: seg.callId,
  });
  assert.equal(replay.recorded, false);
  const back = await code(
    recordStageRun(s.deps, {
      jobId: s.jobId,
      owner: s.ctl,
      stage: "segment",
      state: "submitting",
      module: MODULES.segment,
    }),
  );
  assert.equal(back, "conflict");
  // The recorded call ID can never change (write-once; also bound to the claim).
  assert.ok(
    ["SAC01", "SAC04"].includes(
      await code(
        s.db.owner.query(
          "UPDATE job_stage_runs SET call_id = 'other-call' WHERE job_id = $1 AND stage = 'segment'",
          [s.jobId],
        ),
      ),
    ),
  );
  assert.equal(
    await code(
      s.db.owner.query(
        "UPDATE job_stage_runs SET state = 'pending' WHERE job_id = $1 AND stage = 'segment'",
        [s.jobId],
      ),
    ),
    "SAC04",
  );
  assert.equal(
    await code(
      s.db.owner.query("DELETE FROM job_stage_runs WHERE job_id = $1", [
        s.jobId,
      ]),
    ),
    "SAC01",
  );
  // A succeeded run needs a receipt naming completed outputs of this job.
  assert.equal(
    await code(
      recordStageRun(s.deps, {
        jobId: s.jobId,
        owner: s.ctl,
        stage: "segment",
        state: "succeeded",
        module: MODULES.segment,
        receipt: receiptOf(s, "segment", [
          {
            fileId: randomUUID(),
            slot: "segments.json",
            role: "segments_json",
            size: 10,
            sha: "0".repeat(64),
            body: Buffer.alloc(0),
          },
        ]),
      }),
    ),
    "conflict",
  );
  // A conflicting call ID through the controller action is a double spawn:
  // refused, never masked.
  assert.equal(
    await code(
      recordStageRun(s.deps, {
        jobId: s.jobId,
        owner: s.ctl,
        stage: "segment",
        state: "running",
        module: MODULES.segment,
        callId: "second-spawn-1",
      }),
    ),
    "conflict",
  );
  // A spawned stage cannot be recorded failed without proof its call ended
  // (a timed-out GPU call could otherwise keep running).
  const unproven = await code(
    recordStageRun(s.deps, {
      jobId: s.jobId,
      owner: s.ctl,
      stage: "segment",
      state: "failed",
      module: MODULES.segment,
      errorCode: "engine_timeout",
    }),
  );
  assert.equal(unproven, "conflict");
  // not_run is reachable only from nothing or pending.
  assert.equal(
    await code(
      recordStageRun(s.deps, {
        jobId: s.jobId,
        owner: s.ctl,
        stage: "segment",
        state: "not_run",
        module: MODULES.segment,
        errorCode: "skipped",
      }),
    ),
    "conflict",
  );
  // Stage proof names exactly that stage's call; it is not the job's
  // evidence while later stages can still run.
  assert.equal(
    await code(
      recordExecutionEvidence(s.deps, {
        jobId: s.jobId,
        recordedBy: "controller-test",
        evidence: { kind: "local_child_reaped", executionRef: "no-such-call" },
      }),
    ),
    "conflict",
  );
  const proof = await recordExecutionEvidence(s.deps, {
    jobId: s.jobId,
    recordedBy: "controller-test",
    evidence: { kind: "local_child_reaped", executionRef: seg.callId },
  });
  assert.deepEqual(proof, { recorded: true, slotReleased: false });
  assert.equal(
    (
      await s.db.owner.query(
        "SELECT count(*)::int AS n FROM job_execution_evidence WHERE job_id = $1",
        [s.jobId],
      )
    ).rows[0].n,
    0,
  );
  await recordStageRun(s.deps, {
    jobId: s.jobId,
    owner: s.ctl,
    stage: "segment",
    state: "failed",
    module: MODULES.segment,
    errorCode: "engine_timeout",
  });
  // The finished stage's capability is over: its heartbeat is refused.
  assert.equal(
    await code(
      recordStageHeartbeat(s.deps, {
        jobId: s.jobId,
        stage: "segment",
        invocationNonce: seg.nonce,
        phase: "uploading",
      }),
    ),
    "forbidden",
  );
  const cap = await claimed(s, "caption");
  assert.notEqual(cap.nonce, seg.nonce);
  // A phase of another stage is a malformed heartbeat, not a server error.
  assert.equal(
    await code(
      recordStageHeartbeat(s.deps, {
        jobId: s.jobId,
        stage: "caption",
        invocationNonce: cap.nonce,
        phase: "segmenting",
      }),
    ),
    "invalid_request",
  );
  // Slot release needs proof for EVERY spawned stage: job evidence naming the
  // latest (caption) call is refused while caption has no stage proof, and
  // naming the earlier segment call is refused too.
  assert.equal(
    await code(
      s.db.owner.query(
        "INSERT INTO job_execution_evidence (job_id, kind, execution_ref, recorded_by) VALUES ($1, 'local_child_reaped', $2, 'test')",
        [s.jobId, cap.callId],
      ),
    ),
    "SAC04",
  );
  assert.equal(
    await code(
      s.db.owner.query(
        "INSERT INTO job_execution_evidence (job_id, kind, execution_ref, recorded_by) VALUES ($1, 'local_child_reaped', $2, 'test')",
        [s.jobId, seg.callId],
      ),
    ),
    "SAC04",
  );
  // A caption stage reads only segments_json outputs of the same job.
  assert.equal(
    await code(
      readStageOutput(s.deps, {
        jobId: s.jobId,
        fileId: randomUUID(),
        stage: "segment",
      }),
    ),
    "forbidden",
  );
  assert.equal(
    await code(
      readStageOutput(s.deps, {
        jobId: s.jobId,
        fileId: randomUUID(),
        stage: "caption",
      }),
    ),
    "not_found",
  );
  const dag = await getDagRun(s.deps, s.jobId);
  assert.deepEqual(
    dag.stages.map((n) => [n.stage, n.state, n.errorCode, n.callId]),
    [
      ["segment", "failed", "engine_timeout", seg.callId],
      ["caption", "pending", null, null],
      ["hand_pose", "pending", null, null],
    ],
  );
  evidence.claims = { dag: dag.stages };
});

test("0-clip annotation-only recipe result is accepted with its counts", async () => {
  const s = await recipeJob();
  const r = await runRecipe(s);
  await seal(s, r);
  const ack = await advanceResult(s.accept, s.jobId);
  assert.equal(ack?.candidateStatus, "accepted");
  const facts = await jobFacts(s);
  assert.deepEqual(facts, {
    state: "succeeded",
    error_code: null,
    segment_count: 3,
    failed_window_count: 1,
    caption_count: 2,
    caption_failed_count: 1,
    recording: "reviewable",
    clips: 0,
    holder: null,
  });
  const dag = await getDagRun(s.deps, s.jobId);
  assert.equal(validateValue("http.dag-run.v1", dag).valid, true);
  assert.deepEqual(
    dag.stages.map((n) => [n.stage, n.state, n.receiptSha256 !== null]),
    [
      ["segment", "succeeded", true],
      ["caption", "succeeded", true],
      ["hand_pose", "succeeded", true],
    ],
  );
  // The diagnostic blob is stored but is never a clip file (the customer
  // broker serves only clip thumbnail/viewer files).
  const diag = (
    await s.db.owner.query(
      "SELECT count(*)::int AS n FROM clips c JOIN files f ON f.id IN (c.thumbnail_file_id, c.viewer_rrd_file_id) WHERE f.role = 'diagnostic_blob'",
    )
  ).rows[0].n;
  assert.equal(diag, 0);
  evidence.zeroClip = { facts, dag };
});

test("a caption row for an unknown segment is rejected and the job fails", async () => {
  const s = await recipeJob();
  // A well-formed segment ID (uuid5) that the accepted segments do not contain.
  const stranger = segmentId(
    s.sourceManifestSha256,
    MODULES.segment,
    "0".repeat(64),
    "999999",
    null,
  );
  const r = await runRecipe(s, (captions) => {
    captions.rows[1].segment_id = stranger;
  });
  await seal(s, r);
  const ack = await advanceResult(s.accept, s.jobId);
  assert.equal(ack?.candidateStatus, "rejected");
  assert.equal(ack?.reasonCode, "caption_unknown_segment");
  const facts = await jobFacts(s);
  assert.equal(facts.state, "failed");
  assert.equal(facts.segment_count, null);
  evidence.unknownSegment = facts;
});

test("clip path unchanged: a single-claim clip result is accepted; annotation roles are refused there", async () => {
  const db = await acceptanceDatabase();
  open.push(db);
  const { transport, accept } = await acceptanceDeps(db);
  const job = await runningJob(db);
  const clip = await uploadClip(transport, job, 0);
  const bytes = await manifestFor(db, job, [clip]);
  const manifest = await uploadOutput(
    transport,
    job,
    "result-manifest.json",
    "result_manifest",
    bytes,
  );
  const closure = await closeOutputs(accept, {
    jobId: job.jobId,
    invocationNonce: job.nonce,
    outcome: "succeeded",
  });
  assert.equal(closure.clipCount, 1);
  await submitCandidate(
    accept,
    candidateBody(job, manifest, JSON.parse(bytes.toString())),
  );
  const ref = (
    await db.owner.query("SELECT execution_call_id FROM jobs WHERE id = $1", [
      job.jobId,
    ])
  ).rows[0].execution_call_id as string;
  await recordExecutionEvidence(
    { pool: db.app },
    {
      jobId: job.jobId,
      recordedBy: "controller-test",
      evidence: { kind: "local_child_reaped", executionRef: ref },
    },
  );
  const ack = await advanceResult(accept, job.jobId);
  assert.equal(ack?.candidateStatus, "accepted");

  // A job without a recipe can never close with recording-level roles.
  const legacy = await runningJob(db);
  await uploadOutput(
    transport,
    legacy,
    "segments.json",
    "segments_json",
    Buffer.from("{}"),
  );
  await uploadOutput(
    transport,
    legacy,
    "result-manifest.json",
    "result_manifest",
    Buffer.from("{}"),
  );
  assert.equal(
    await code(
      closeOutputs(accept, {
        jobId: legacy.jobId,
        invocationNonce: legacy.nonce,
        outcome: "failed",
      }),
    ),
    "conflict",
  );
  // A wrong slot for a role is refused by the slot policy.
  assert.deepEqual(
    {
      ...(
        await db.owner.query(
          "SELECT job_output_slot_role_ok('diagnostics/segment/..', 'diagnostic_blob') AS a, job_output_slot_role_ok('segments.json', 'captions_json') AS b, job_output_slot_role_ok('diagnostics/caption/log.txt', 'diagnostic_blob') AS c",
        )
      ).rows[0],
    },
    { a: false, b: false, c: true },
  );
});

test("files CHECK caps diagnostic blobs at 64 MiB", async () => {
  const db = await acceptanceDatabase();
  open.push(db);
  const r = (
    await db.owner.query(
      "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'files_diagnostic_blob_size_check'",
    )
  ).rows[0];
  assert.match(r.def, /67108864/);
  const sql = readFileSync(
    new URL("../migrations/011_stage_runs.sql", import.meta.url),
    "utf8",
  );
  assert.match(sql, /files_role_v2_check/);
});

test("submit_unknown keeps its reason, then the claim resolves it; not_run is refused after submission", async () => {
  const s = await recipeJob();
  const issued = await issueStageClaim(s.deps, {
    jobId: s.jobId,
    owner: s.ctl,
    stage: "segment",
  });
  assert.equal(issued.state, "recorded");
  if (issued.state !== "recorded") throw new Error("unreachable");
  for (const state of ["pending", "submitting", "submit_unknown"] as const)
    await recordStageRun(s.deps, {
      jobId: s.jobId,
      owner: s.ctl,
      stage: "segment",
      state,
      module: MODULES.segment,
    });
  const unknown = (
    await s.db.owner.query(
      "SELECT state, unknown_reason, error_code FROM job_stage_runs WHERE job_id = $1",
      [s.jobId],
    )
  ).rows[0];
  assert.deepEqual(
    { ...unknown },
    {
      state: "submit_unknown",
      unknown_reason: "submit_outcome_unknown",
      error_code: null,
    },
  );
  assert.equal(
    await code(
      recordStageRun(s.deps, {
        jobId: s.jobId,
        owner: s.ctl,
        stage: "segment",
        state: "not_run",
        module: MODULES.segment,
        errorCode: "skipped",
      }),
    ),
    "conflict",
  );
  // The call is lost (submit_unknown): the stage can be neither failed
  // without proof nor released; it waits for the operator path.
  assert.equal(
    await code(
      recordStageRun(s.deps, {
        jobId: s.jobId,
        owner: s.ctl,
        stage: "segment",
        state: "failed",
        module: MODULES.segment,
        errorCode: "spawn_lost",
      }),
    ),
    "conflict",
  );
  assert.equal(
    await code(
      s.db.owner.query(
        "INSERT INTO job_execution_evidence (job_id, kind, execution_ref, recorded_by) VALUES ($1, 'local_child_reaped', 'guess-1', 'test')",
        [s.jobId],
      ),
    ),
    "SAC04",
  );
  // A recipe job with no stage proof cannot be released at all.
  assert.equal(
    await code(
      recordExecutionEvidence(s.deps, {
        jobId: s.jobId,
        recordedBy: "controller-test",
        evidence: { kind: "pre_submission_rejected" },
      }),
    ),
    "conflict",
  );
  // Defense in depth: the job itself is claimed only with a claimed stage's
  // exact nonce and capability (the single-claim path cannot run it).
  assert.equal(
    await code(
      s.db.owner.query(
        `UPDATE jobs SET state = 'running', claimed_at = now(), invocation_nonce = $2,
           execution_call_id = 'single-claim-1', capability_token_sha256 = repeat('a', 64)
         WHERE id = $1`,
        [s.jobId, nonce()],
      ),
    ),
    "SAC04",
  );
  const callId = `stage-segment-${randomUUID()}`;
  await claimStage(s.deps, {
    jobId: s.jobId,
    bootstrapToken: issued.bootstrapToken,
    invocationNonce: nonce(),
    executor: { kind: "local", localExecutionRef: callId },
  });
  await recordStageRun(s.deps, {
    jobId: s.jobId,
    owner: s.ctl,
    stage: "segment",
    state: "running",
    module: MODULES.segment,
    callId,
  });
  const after = (
    await s.db.owner.query(
      "SELECT state, unknown_reason, call_id FROM job_stage_runs WHERE job_id = $1",
      [s.jobId],
    )
  ).rows[0];
  assert.deepEqual(
    { ...after },
    {
      state: "running",
      unknown_reason: "submit_outcome_unknown",
      call_id: callId,
    },
  );

  // Operator path: once the exact call is known, its proof lets the stage end.
  await recordExecutionEvidence(s.deps, {
    jobId: s.jobId,
    recordedBy: "operator-test",
    evidence: { kind: "local_child_reaped", executionRef: callId },
  });
  await recordStageRun(s.deps, {
    jobId: s.jobId,
    owner: s.ctl,
    stage: "segment",
    state: "failed",
    module: MODULES.segment,
    errorCode: "spawn_lost",
  });
});

test("an issued claim whose call was never learned cannot be failed, not_run or released", async () => {
  const s = await recipeJob();
  const issued = await issueStageClaim(s.deps, {
    jobId: s.jobId,
    owner: s.ctl,
    stage: "segment",
  });
  assert.equal(issued.state, "recorded");
  for (const [state, errorCode] of [
    ["failed", "spawn_lost"],
    ["cancelled", "cancelled_by_controller"],
    ["not_run", "skipped"],
  ] as const)
    assert.equal(
      await code(
        recordStageRun(s.deps, {
          jobId: s.jobId,
          owner: s.ctl,
          stage: "segment",
          state,
          module: MODULES.segment,
          errorCode,
        }),
      ),
      "conflict",
      `${state} without proof`,
    );
  // The next stage cannot start, and the slot cannot be released.
  assert.equal(
    await code(
      issueStageClaim(s.deps, {
        jobId: s.jobId,
        owner: s.ctl,
        stage: "caption",
      }),
    ),
    "conflict",
  );
  for (const evidence of [
    { kind: "local_child_reaped" as const, executionRef: "guess-1" },
    { kind: "pre_submission_rejected" as const },
  ])
    assert.equal(
      await code(
        recordExecutionEvidence(s.deps, {
          jobId: s.jobId,
          recordedBy: "controller-test",
          evidence,
        }),
      ),
      "conflict",
    );
  const held = (
    await s.db.owner.query(
      "SELECT job_id FROM dispatch_admission WHERE slot = 1",
    )
  ).rows[0].job_id;
  assert.equal(held, s.jobId);
});

// ------------------------------------------------------- SA-91 stage files

test("SA-91 prior-stages: every completed file of segment and caption by slot, never a seal file, contract-valid", async () => {
  const s = await recipeJob();
  const r = await runRecipe(s, () => {}, { orphan: true });
  const prior = await getPriorStages(s.deps, s.jobId);
  assert.equal(validateValue("jobs.prior-stages.v1", prior).valid, true);
  const slots = Object.fromEntries(
    prior.stages.map((p) => [
      p.stage,
      p.outputs.map((o) => [o.slot, o.fileId]),
    ]),
  );
  // The orphan diagnostic (no receipt names it) still belongs to segment; hand_pose files,
  // recording.mp4, hand-presence.json and the manifest belong to no earlier stage.
  assert.deepEqual(slots, {
    segment: [
      ["diagnostics/segment/log.txt", r.orphan!.fileId],
      ["diagnostics/segment/windows.jsonl", r.diag.fileId],
      ["segments.json", r.segFile.fileId],
    ],
    caption: [["captions.json", r.capFile.fileId]],
  });
  const seg = prior.stages[0]!;
  assert.deepEqual(
    [seg.state, seg.errorCode, seg.counts.segments],
    ["succeeded", null, 3],
  );
  assert.deepEqual(
    seg.outputs.find((o) => o.slot === "segments.json"),
    {
      fileId: r.segFile.fileId,
      role: "segments_json",
      slot: "segments.json",
      sizeBytes: String(r.segFile.size),
      sha256: r.segFile.sha,
    },
  );
  evidence.priorStages = prior;
});

test("SA-91 acceptance: a stage owns its orphan file by slot, so the seal is accepted", async () => {
  const s = await recipeJob();
  const r = await runRecipe(s, () => {}, { orphan: true });
  await seal(s, r as never);
  const ack = await advanceResult(s.accept, s.jobId);
  assert.equal(ack?.candidateStatus, "accepted");
  assert.equal((await jobFacts(s)).state, "succeeded");
});

for (const [name, mutate] of [
  [
    "a segment file listed by the caption node",
    (d: Record<string, any>, ids: Record<string, string>) => {
      d.nodes[0].outputs = d.nodes[0].outputs.filter(
        (f: string) => f !== ids.diag,
      );
      d.nodes[1].outputs.push(ids.diag);
    },
  ],
  [
    "a segment file left out of the segment node and claimed by hand_pose",
    (d: Record<string, any>, ids: Record<string, string>) => {
      d.nodes[0].outputs = d.nodes[0].outputs.filter(
        (f: string) => f !== ids.diag,
      );
      d.nodes[2].outputs.push(ids.diag);
    },
  ],
] as const)
  test(`SA-91 acceptance rejects ${name} (exact slot attribution)`, async () => {
    const s = await recipeJob();
    const r = await runRecipe(s, () => {}, { mutateDoc: mutate });
    await seal(s, r as never);
    const ack = await advanceResult(s.accept, s.jobId);
    assert.equal(ack?.candidateStatus, "rejected");
    assert.equal(ack?.reasonCode, "manifest_node_mismatch");
    assert.equal((await jobFacts(s)).state, "failed");
  });

test("SA-91 acceptance: a recipe job's v2 failure report is accepted and the job fails truthfully", async () => {
  const s = await recipeJob();
  const r = await runRecipe(s, () => {}, { noManifest: true });
  const bytes = await manifestFor(s.db, r.hand.job, [], (d) => {
    d.verified_sources = [];
    d.attestation.source_eof_verified = false;
    d.outputs = [];
    d.clips = [];
    d.checks = [
      {
        code: "worker_failed",
        status: "fail",
        message: "boom",
        rule_revision: "sa31-export-2",
        measurements: {},
      },
    ];
  });
  const failure = await uploadOutput(
    s.transport,
    r.hand.job,
    "result-manifest.json",
    "result_manifest",
    bytes,
  );
  await closeOutputs(s.accept, {
    jobId: s.jobId,
    invocationNonce: r.hand.nonce,
    outcome: "failed",
  });
  await submitCandidate(s.accept, {
    schemaVersion: 1,
    jobId: s.jobId,
    invocationNonce: r.hand.nonce,
    manifestFileId: failure.fileId,
    manifestSha256: failure.sha,
    summary: {
      outcome: "failed",
      clipCount: 0,
      checks: { pass: 0, warn: 0, fail: 1, measured: 0, notEvaluated: 0 },
      errorCode: "worker_failed",
    },
  } as never);
  // The seal stage itself failed: proof for its call, then its failed row.
  await recordStageRun(s.deps, {
    jobId: s.jobId,
    owner: s.ctl,
    stage: "hand_pose",
    state: "running",
    module: MODULES.hand_pose,
    callId: r.hand.callId,
  });
  await recordExecutionEvidence(s.deps, {
    jobId: s.jobId,
    recordedBy: "controller-test",
    evidence: { kind: "local_child_reaped", executionRef: r.hand.callId },
  });
  await recordStageRun(s.deps, {
    jobId: s.jobId,
    owner: s.ctl,
    stage: "hand_pose",
    state: "failed",
    module: MODULES.hand_pose,
    callId: r.hand.callId,
    errorCode: "worker_failed",
  });
  await advanceResult(s.accept, s.jobId);
  const ack = await advanceResult(s.accept, s.jobId);
  assert.equal(ack?.candidateStatus, "accepted");
  const facts = await jobFacts(s);
  assert.equal(facts.state, "failed");
  assert.equal(facts.error_code, "worker_failed");
  assert.equal(facts.holder, null);
});
