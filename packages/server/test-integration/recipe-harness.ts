import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  requestSha256,
  segmentId,
  validateValue,
  type RecipeV1,
  type StageReceiptV1,
} from "@stateaction/contracts";
import { processRecordingTaskInputV2 } from "../src/admission/job-input.js";
import { closeOutputs, submitCandidate } from "../src/acceptance/service.js";
import {
  admitNextJob,
  claimControllerLease,
  recordExecutionEvidence,
  type JobsDeps,
} from "../src/jobs/service.js";
import {
  claimStage,
  issueStageClaim,
  readStageOutput,
  recordStageRun,
} from "../src/jobs/stages.js";
import type { TransportDeps } from "../src/transport/index.js";
import type { AcceptanceDeps } from "../src/acceptance/service.js";
import {
  acceptanceDatabase,
  acceptanceDeps,
  candidateBody,
  checksSummary,
  manifestFor,
  uploadOutput,
  type AcceptanceDb,
  type RunningJob,
  type Uploaded,
  uploadClip,
} from "./acceptance-harness.js";
import { JOBS_CONFIG, nonce, owner, queuedJob } from "./jobs-harness.js";

/**
 * SA-88/SA-91/SA-98 recipe-job helpers shared by the integration tests: a queued
 * job admitted with an inline recipe, per-stage claims, the whole stub recipe
 * through the real services (segment, caption, hand_pose seal), result closure
 * and acceptance. Every call goes through the real services and the real
 * restricted Postgres role and storage; nothing here edits state directly.
 */

export const fixture = (name: string, caseName?: string) => {
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

export const MODULES = {
  segment: "stub_segmenter@1",
  caption: "stub_captioner@1",
  hand_pose: "hand_pose_cpu_v1@1",
} as const;

export function recipe(over: { captionEnabled?: boolean } = {}): RecipeV1 {
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

export type Scenario = {
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
export async function recipeJob(
  over: { captionEnabled?: boolean } = {},
  track: (db: AcceptanceDb) => void = () => {},
): Promise<Scenario> {
  const db = await acceptanceDatabase();
  track(db);
  return recipeJobOn(db, await acceptanceDeps(db), over);
}

/**
 * The same job on a caller-provided database and storage (SA-98: the browser
 * e2e seeds the stack's own Postgres and bucket through these real services).
 */
export async function recipeJobOn(
  db: AcceptanceDb,
  { transport, accept }: { transport: TransportDeps; accept: AcceptanceDeps },
  over: { captionEnabled?: boolean } = {},
  runRef = "run-1",
): Promise<Scenario> {
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
    runRef,
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

export type Claimed = {
  stage: "segment" | "caption" | "hand_pose";
  nonce: string;
  callId: string;
  bootstrapToken: string;
  job: RunningJob;
};

export async function claimed(
  s: Scenario,
  stage: Claimed["stage"],
): Promise<Claimed> {
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

export const receiptOf = (
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

export async function finish(
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

export function segmentsDoc(s: Scenario) {
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

export function captionsDoc(
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

export function handPresenceDoc(s: Scenario) {
  const doc = fixture("artifacts.hand-presence.v1");
  doc.job_id = s.jobId;
  doc.recording_id = s.recordingId;
  doc.source_manifest_sha256 = s.sourceManifestSha256;
  return doc;
}

export const json = (doc: unknown) => Buffer.from(JSON.stringify(doc));

/**
 * The whole stub recipe through the real services: segment, caption (reading
 * segments through the stage-scoped read), then the hand_pose seal with zero
 * clips. Returns everything needed to submit and accept.
 */
export async function runRecipe(
  s: Scenario,
  mutateCaptions: (doc: Record<string, any>) => void = () => {},
  opts: {
    /** SA-91: a segment diagnostic its receipt does not name (a stage that lost its receipt). */
    orphan?: boolean;
    /** SA-91: edit the v3 manifest before it is uploaded. */
    mutateDoc?: (doc: Record<string, any>, ids: Record<string, string>) => void;
    /** SA-91: stop before the v3 manifest (the caller uploads its own result). */
    noManifest?: boolean;
    /** SA-98: the hand_pose stage also seals one clip with this source range (clock-domain ns). */
    clip?: { sourceStartNs: string; sourceEndNs: string };
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
  const clipFiles = opts.clip ? await uploadClip(s.transport, hand.job, 0) : [];
  const files = [
    segFile,
    diag,
    ...(orphan ? [orphan] : []),
    capFile,
    hp,
    mp4,
    ...clipFiles,
  ];
  if (opts.noManifest)
    return {
      seg,
      cap,
      hand,
      files,
      hp,
      mp4,
      orphan,
      segFile,
      diag,
      capFile,
      clipFiles,
    };
  const bytes = await manifestFor(
    s.db,
    hand.job,
    opts.clip ? [clipFiles] : [],
    (doc) => {
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
      if (opts.clip) {
        const start = BigInt(opts.clip.sourceStartNs);
        const end = BigInt(opts.clip.sourceEndNs);
        Object.assign(doc.clips[0], {
          source_start_ns: start.toString(),
          source_end_ns: end.toString(),
          duration_ns: (end - start).toString(),
        });
      } else doc.clips = [];
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
          outputs: [hp.fileId, mp4.fileId, ...clipFiles.map((f) => f.fileId)],
          counts: { clips: opts.clip ? 1 : 0 },
        },
      ];
      opts.mutateDoc?.(doc, {
        segments: segFile.fileId,
        diag: diag.fileId,
        captions: capFile.fileId,
        hp: hp.fileId,
        mp4: mp4.fileId,
      });
    },
  );
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
    clipFiles,
  };
}

export async function seal(
  s: Scenario,
  r: Awaited<ReturnType<typeof runRecipe>>,
): Promise<void> {
  const closure = await closeOutputs(s.accept, {
    jobId: s.jobId,
    invocationNonce: r.hand.nonce,
    outcome: "succeeded",
  });
  // Annotation files are not clip files (009 counted every non-manifest file).
  const clips = r.clipFiles.length ? 1 : 0;
  assert.equal(closure.clipCount, clips);
  assert.equal(closure.fileCount, r.files.length + 1);
  await submitCandidate(s.accept, {
    ...candidateBody(r.hand.job, r.manifest, r.doc),
    summary: {
      outcome: "succeeded",
      clipCount: clips,
      checks: checksSummary(r.doc),
      errorCode: null,
    },
  });
  // The seal's proof is also the job's terminal evidence (every spawned
  // stage already has its own).
  await finish(s, r.hand, [r.hp, r.mp4, ...r.clipFiles], { clips });
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

export const jobFacts = async (s: Scenario) =>
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
