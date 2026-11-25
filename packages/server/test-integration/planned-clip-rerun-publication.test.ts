import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import {
  captionSteps,
  requestSha256,
  validateBytes,
  type ClipPlanV1,
  type ClipTaskInputV4,
} from "@stateaction/contracts";
import {
  advanceResult,
  closeOutputs,
  sealParallelRecipe,
  submitCandidate,
} from "../src/acceptance/service.js";
import { processRecordingTaskInputV2 } from "../src/admission/job-input.js";
import {
  recordSourceCompletion,
  registerRecording,
  sealRecordingInventory,
  type AdmissionDeps,
} from "../src/admission/recordings.js";
import { CatalogError } from "../src/catalog/errors.js";
import { selectReviewClipResult } from "../src/datasets/select-review-result.js";
import {
  admitNextJob,
  claimControllerLease,
  claimWorker,
  recordExecutionEvidence,
  recordWorkerSubmissionIntent,
  type JobsDeps,
} from "../src/jobs/service.js";
import { prepareStageRerun } from "../src/jobs/stage-rerun-preparation.js";
import { s3RerunCopy } from "../src/jobs/stage-rerun-storage.js";
import {
  confirmStageRerunV2,
  planStageRerunV2,
} from "../src/jobs/stage-rerun-v2.js";
import { planStageRerun } from "../src/jobs/stage-reruns.js";
import { readStageOutput, startParallelRecipe } from "../src/jobs/stages.js";
import { persistedClipReads } from "../src/pipeline/clip-reads.js";
import { getRecordingOperations } from "../src/pipeline/recording-operations.js";
import {
  acceptanceDeps,
  manifestFor,
  sha,
  uploadClip,
  uploadOutput,
  type AcceptanceDb,
} from "./acceptance-harness.js";
import { depsFor, jobsDatabase, nonce, owner } from "./jobs-harness.js";
import {
  MODULES,
  captionsDoc,
  claimed,
  finish,
  handPresenceDoc,
  json,
  recipe,
  segmentsDoc,
  type Scenario,
} from "./recipe-harness.js";
import { createBody, reserveSourceScenario } from "./source-scenario.js";
import {
  BUCKET,
  ensurePermission,
  realS3,
  s3Config,
} from "./transport-harness.js";

async function acceptedPlan(
  db: AcceptanceDb,
  deps: JobsDeps,
  storage: Awaited<ReturnType<typeof acceptanceDeps>>,
) {
  const userId = db.actors.collector;
  await ensurePermission(db, userId);
  const permission = await db.owner.query<{ permission_ref: string }>(
    "SELECT permission_ref FROM ingest_permissions WHERE owner_user_id = $1 AND status = 'active'",
    [userId],
  );
  const admission: AdmissionDeps = {
    pool: db.app,
    reader: storage.accept.reader,
    config: {
      processingProfileRevision: "test-1",
      supportedRgbProfiles: ["h264_mcap_v1"],
    },
  };
  // Match the shared segment and hand-presence fixtures' source timeline.
  const sourceRange = {
    kind: "clip",
    start_ordinal: 0,
    end_ordinal: 600,
    first_source_frame_id: "1000",
    last_source_frame_id: "1599",
    start_ts_ns: "5000000000",
    end_ts_ns: "24966666467",
  } as const;
  const body = createBody();
  const {
    recording: { recordingId },
  } = await registerRecording(admission, { userId }, body);
  const source = await reserveSourceScenario(db.app, {
    recordingId,
    clientRecordingId: body.clientRecordingId,
    owner: userId,
    permissionRef: permission.rows[0]!.permission_ref,
    mutate: (doc) => {
      const counts = doc.counts as Record<string, string>;
      counts.video_frames = String(sourceRange.end_ordinal);
    },
  });
  const s3 = realS3();
  try {
    for (const file of source.files) {
      await s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: file.key,
          Body:
            file.role === "source_manifest"
              ? source.manifest
              : Buffer.from(`${file.role}:${file.fileId}`),
        }),
      );
      await recordSourceCompletion(
        admission,
        { userId },
        {
          recordingId,
          fileId: file.fileId,
          expectedTransportEpoch: 1,
          observedSizeBytes: file.sizeBytes,
        },
      );
    }
  } finally {
    s3.destroy();
  }
  const sealed = await sealRecordingInventory(
    admission,
    { userId },
    recordingId,
    source.seal,
  );
  assert.equal(sealed.admission.state, "admitted");
  const { jobId, sourceManifestSha256 } = sealed.admission;
  const admitted = await admitNextJob(deps);
  assert.equal(admitted.state === "admitted" && admitted.job.jobId, jobId);
  const ctl = owner();
  assert.equal(
    (
      await claimControllerLease(deps, {
        jobId,
        owner: ctl,
        runRef: "local-plan",
      })
    ).granted,
    true,
  );
  const intent = await recordWorkerSubmissionIntent(deps, {
    jobId,
    owner: ctl,
  });
  assert.equal(intent.state, "recorded");
  const invocationNonce = nonce();
  const executionRef = "local-" + randomUUID();
  await claimWorker(deps, {
    jobId,
    bootstrapToken: intent.bootstrapToken,
    invocationNonce,
    executor: { kind: "local", localExecutionRef: executionRef },
  });

  const plan: ClipPlanV1 = {
    schema: "stateaction.clip-plan.v1",
    recording_id: recordingId,
    plan_version: 1,
    source_manifest_sha256: sourceManifestSha256,
    frame_count: sourceRange.end_ordinal,
    origin_ts_ns: sourceRange.start_ts_ns,
    clock_domain: "android.elapsed_realtime",
    mode: "passthrough",
    state: "succeeded",
    error_code: null,
    filter_version: "clip_filter@0",
    params_sha256: requestSha256({}),
    producer: {
      module_id: "clip_filter",
      revision: "0",
      weights_sha256: null,
      gpu_type: null,
    },
    spans: [sourceRange],
  };
  const worker = {
    jobId,
    recordingId,
    nonce: invocationNonce,
    authority: { kind: "job" as const, jobId },
  };
  await uploadOutput(
    storage.transport,
    worker,
    "recording.mp4",
    "recording_mp4",
    Buffer.from("fixture original"),
  );
  const manifest = await uploadOutput(
    storage.transport,
    worker,
    "result-manifest.json",
    "result_manifest",
    json(plan),
  );
  await closeOutputs(storage.accept, {
    jobId,
    invocationNonce,
    outcome: "succeeded",
  });
  await submitCandidate(storage.accept, {
    jobId,
    invocationNonce,
    manifestFileId: manifest.fileId,
    manifestSha256: manifest.sha,
    summary: {
      outcome: "succeeded",
      clipCount: 0,
      errorCode: null,
      checks: { pass: 0, warn: 0, fail: 0, measured: 0, notEvaluated: 0 },
    },
  });
  await recordExecutionEvidence(deps, {
    jobId,
    recordedBy: ctl,
    evidence: { kind: "local_child_reaped", executionRef },
  });
  const ack = await advanceResult(storage.accept, jobId);
  assert.equal(ack?.candidateStatus, "accepted", JSON.stringify(ack));
  const clip = await db.app.query<{ live_job_id: string }>(
    "SELECT live_job_id FROM review_clips WHERE id = $1",
    [recordingId],
  );
  return {
    clipId: recordingId,
    planSha: manifest.sha,
    sourceRange,
    recordingId,
    sourceManifestSha256,
    jobId: clip.rows[0]!.live_job_id,
  };
}

async function start(s: Scenario) {
  const admitted = await admitNextJob(s.deps);
  assert.equal(
    admitted.state === "admitted" && admitted.job.jobId,
    s.jobId,
    JSON.stringify(admitted),
  );
  assert.equal(
    (
      await claimControllerLease(s.deps, {
        jobId: s.jobId,
        owner: s.ctl,
        runRef: s.ctl,
      })
    ).granted,
    true,
  );
  assert.equal(await startParallelRecipe(s.db.app, s.jobId, s.ctl), true);
  const result = await s.db.app.query<{ task_input: ClipTaskInputV4 }>(
    "SELECT task_input FROM job_inputs WHERE job_id = $1",
    [s.jobId],
  );
  const task = result.rows[0]!.task_input;
  assert.equal(task.schemaVersion, 4);
  return task;
}

async function runCaption(
  s: Scenario,
  segments: ReturnType<typeof segmentsDoc>,
  segmentFile: { fileId: string; sha: string },
  producerJobId: string,
  text?: string,
) {
  const stage = await claimed(s, "caption");
  const read = await readStageOutput(s.deps, {
    jobId: s.jobId,
    stage: "caption",
    fileId: segmentFile.fileId,
  });
  assert.equal(read.fileId, segmentFile.fileId);
  assert.equal(read.producerJobId, producerJobId);
  const captions = captionsDoc(s, segments, segmentFile.sha);
  if (text) {
    captions.rows[0].text = text;
    captions.rows[0].derived.short_label = text;
    captions.rows[0].derived.steps = captionSteps(text);
  }
  const output = await uploadOutput(
    s.transport,
    stage.job,
    "captions.json",
    "captions_json",
    json(captions),
  );
  await finish(s, stage, [output], {
    captions_complete: 2,
    captions_failed: 1,
  });
  return output;
}

async function runParent(s: Scenario, task: ClipTaskInputV4) {
  const stage = await claimed(s, "segment");
  const segments = segmentsDoc(s);
  const segmentFile = await uploadOutput(
    s.transport,
    stage.job,
    "segments.json",
    "segments_json",
    json(segments),
  );
  await finish(s, stage, [segmentFile], { segments: 3, failed_windows: 1 });
  const caption = await runCaption(s, segments, segmentFile, s.jobId);
  const hand = await claimed(s, "hand_pose");
  const handPresence = await uploadOutput(
    s.transport,
    hand.job,
    "hand-presence.json",
    "hand_presence_json",
    json(handPresenceDoc(s)),
  );
  const clipFiles = await uploadClip(s.transport, hand.job, 0);
  const sourceRange = task.clip.sourceRange;
  const draft = await manifestFor(s.db, hand.job, [clipFiles], (doc) => {
    doc.schema = "stateaction.processing_result.v5";
    doc.recipe_id = s.recipe.recipeId;
    doc.recipe_sha256 = task.recipeSha256;
    doc.review_clip_id = task.clip.id;
    doc.clip_plan_sha256 = task.clip.planSha256;
    const { start_ts_ns, end_ts_ns, start_ordinal, end_ordinal } = sourceRange;
    const frameCount = end_ordinal - start_ordinal;
    const clip = doc.clips[0];
    Object.assign(clip, {
      source_start_ns: start_ts_ns,
      source_end_ns: end_ts_ns,
      duration_ns: (BigInt(end_ts_ns) - BigInt(start_ts_ns)).toString(),
      frame_count: frameCount,
    });
    for (const array of clip.hand_arrays.arrays) array.shape[0] = frameCount;
    doc.outputs.push({
      file_id: handPresence.fileId,
      role: handPresence.role,
      relative_path: handPresence.slot,
      size_bytes: String(handPresence.size),
      sha256: handPresence.sha,
    });
    doc.nodes = [
      {
        stage: "hand_pose",
        status: "succeeded",
        module: MODULES.hand_pose,
        error_code: null,
        outputs: [...clipFiles, handPresence].map((f) => f.fileId),
        counts: { clips: 1 },
      },
    ];
  });
  await uploadOutput(
    s.transport,
    { ...hand.job, authority: { ...hand.job.authority, stage: hand.stage } },
    "diagnostics/hand_pose/prepared-result.json",
    "diagnostic_blob",
    draft,
  );
  const handFiles = [...clipFiles, handPresence];
  await finish(s, hand, handFiles, { clips: 1 });
  await sealAndAccept(s);
  return { segments, segmentFile, caption, handFiles };
}

async function sealAndAccept(
  s: Scenario,
  duringVerification?: () => Promise<void>,
) {
  assert.equal(
    await sealParallelRecipe(s.accept, s.jobId, s.ctl, s.ctl, s.transport),
    true,
  );
  let markReading!: (started: boolean) => void;
  let resume!: () => void;
  const reading = new Promise<boolean>((resolve) => {
    markReading = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const deps = duringVerification
    ? {
        ...s.accept,
        reader: {
          async read(key: string, maxBytes: number) {
            const bytes = await s.accept.reader.read(key, maxBytes);
            markReading(true);
            await resumed;
            return bytes;
          },
        },
      }
    : s.accept;
  const acceptance = advanceResult(deps, s.jobId);
  if (duringVerification) {
    try {
      // Pause acceptance during the object read, before it takes the selection lock.
      assert.equal(
        await Promise.race([reading, acceptance.then(() => false)]),
        true,
      );
      await duringVerification();
    } finally {
      resume();
      await acceptance;
    }
  }
  const ack = await acceptance;
  assert.equal(ack?.candidateStatus, "accepted", JSON.stringify(ack));
}

async function acceptedManifest(s: Scenario, version: "v5" | "v6") {
  const {
    rows: [file],
  } = await s.db.app.query<{
    object_key: string;
    sha256: string;
    state: string;
  }>(
    `SELECT f.object_key, f.sha256, f.state FROM jobs j
     JOIN files f ON f.id = j.result_manifest_file_id AND f.sha256 = j.result_manifest_sha256
     WHERE j.id = $1 AND j.state = 'succeeded'`,
    [s.jobId],
  );
  assert.ok(file);
  assert.equal(file.state, "verified");
  const bytes = await s.accept.reader.read(file.object_key, 1024 * 1024);
  assert.equal(sha(Buffer.from(bytes)), file.sha256);
  const parsed = validateBytes(`artifacts.processing-result.${version}`, bytes);
  assert.ok(parsed.valid, JSON.stringify(parsed));
  return { sha: file.sha256, doc: parsed.value as Record<string, any> };
}

test("recording retry excludes a clip cancelled before its recipe was assigned", async (t) => {
  const db = await jobsDatabase();
  t.after(() => db.close());
  const storage = await acceptanceDeps(db);
  const deps = {
    ...depsFor(db),
    taskInput: async () => {
      throw new CatalogError("not_found", "Fixture source is unavailable");
    },
  };
  const planned = await acceptedPlan(db, deps, storage);
  await admitNextJob(deps);
  const { rows } = await db.app.query(
    "SELECT state, recipe FROM jobs WHERE id = $1",
    [planned.jobId],
  );
  assert.deepEqual(rows, [{ state: "cancelled", recipe: null }]);

  const staff = db.actors.staff;
  const recording = await getRecordingOperations(
    db.app,
    staff,
    planned.recordingId,
  );
  assert.equal(recording?.clips[0]?.status, "cancelled");
  assert.equal(recording?.retryTarget, null);
  await assert.rejects(
    planStageRerunV2(
      { pool: db.app, reader: storage.accept.reader, backend: "local" },
      staff,
      planned.recordingId,
      { schemaVersion: 2, scope: "failed_clips" },
    ),
    /no_failed_clips/,
  );
});

test("a planned clip publishes v6 after a caption retry and preserves a newer staff selection", async (t) => {
  const db = await jobsDatabase();
  t.after(() => db.close());
  const storage = await acceptanceDeps(db);
  const fixtureRecipe = recipe();
  const deps: JobsDeps = {
    ...depsFor(db),
    acceptance: storage.accept,
    rerunCopy: s3RerunCopy(s3Config()),
    taskInput: async (q, job) => ({
      ...(await processRecordingTaskInputV2(q as never, job.jobId)),
      schemaVersion: 3,
      recipe: fixtureRecipe,
      recipeSha256: requestSha256(fixtureRecipe),
    }),
  };
  const planned = await acceptedPlan(db, deps, storage);
  const parent: Scenario = {
    ...storage,
    ...planned,
    db,
    deps,
    ctl: owner(),
    recipe: fixtureRecipe,
  };
  const task = await start(parent);
  assert.deepEqual(task.clip, {
    id: planned.clipId,
    planVersion: 1,
    planSha256: planned.planSha,
    sourceRange: planned.sourceRange,
  });
  const artifacts = await runParent(parent, task);
  const original = await acceptedManifest(parent, "v5");
  const actor = db.actors.staff;
  const reads = persistedClipReads({
    pool: db.app,
    reader: storage.accept.reader,
    signer: { presignRead: async ({ key }) => `http://example.test/${key}` },
  });
  const reviewClip = await reads.getClip(actor, planned.clipId);
  assert.ok(reviewClip?.selectedResult);
  const source = await reads.getSelectedResult(
    actor,
    planned.clipId,
    reviewClip.selectedResult,
  );
  assert.ok(source);
  assert.equal(source.sourcePlaybackDurationNs, null);
  const reruns = {
    pool: db.app,
    reader: storage.accept.reader,
    backend: "local" as const,
  };
  await assert.rejects(
    planStageRerun(reruns, actor, planned.recordingId, {
      parentJobId: parent.jobId,
      stage: "caption",
      scope: "only",
    }),
    /clip_rerun_unavailable/,
  );

  const selection = async () =>
    (
      await db.app.query(
        `SELECT c.live_job_id, c.selected_job_id, s.seq, s.kind,
              EXISTS (SELECT 1 FROM recording_result_selections r WHERE r.recording_id = c.recording_id) AS legacy_selection
       FROM review_clips c JOIN clip_result_selections s ON s.clip_id = c.id
       WHERE c.id = $1 ORDER BY s.seq DESC LIMIT 1`,
        [planned.clipId],
      )
    ).rows[0];
  assert.deepEqual(await selection(), {
    live_job_id: parent.jobId,
    selected_job_id: parent.jobId,
    seq: 1,
    kind: "auto",
    legacy_selection: false,
  });

  async function retryCaption(previous: Scenario, text: string) {
    const request = {
      schemaVersion: 2 as const,
      scope: "clip" as const,
      clipId: planned.clipId,
      parentJobId: previous.jobId,
      stages: ["caption" as const],
    };
    const preview = await planStageRerunV2(
      reruns,
      actor,
      planned.recordingId,
      request,
    );
    assert.deepEqual(
      preview.clips[0]!.execute.map(({ stage }) => stage),
      ["caption"],
    );
    assert.deepEqual(
      preview.clips[0]!.reuse.map(({ stage, executionJobId }) => [
        stage,
        executionJobId,
      ]),
      [
        ["segment", parent.jobId],
        ["hand_pose", parent.jobId],
      ],
    );
    assert.equal(preview.maxComputeCostUsd, "0.00");
    assert.equal(preview.maxGpuCostUsd, "0.00");
    const child = { ...parent, jobId: randomUUID(), ctl: owner() };
    const confirmed = await confirmStageRerunV2(
      reruns,
      actor,
      planned.recordingId,
      {
        ...request,
        requestId: child.jobId,
        reason: "Retry captions with the original hand evidence",
        expectedPlanSha256: preview.planSha256,
        expectedMaxComputeCostUsd: preview.maxComputeCostUsd,
        expectedMaxGpuCostUsd: preview.maxGpuCostUsd,
      },
    );
    assert.deepEqual(confirmed.jobs, [
      {
        clipId: planned.clipId,
        parentJobId: previous.jobId,
        jobId: child.jobId,
      },
    ]);
    assert.equal((await selection()).selected_job_id, previous.jobId);
    assert.deepEqual((await start(child)).clip, task.clip);
    for (let step = 0; ; step++) {
      assert.ok(step < 40, "reuse preparation did not settle");
      const result = await prepareStageRerun(deps, child.jobId, child.ctl);
      if (result.state === "copying") continue;
      assert.equal(result.state, "ready", JSON.stringify(result));
      break;
    }
    const {
      rows: [copiedSegments],
    } = await db.app.query<{ fileId: string; sha: string }>(
      `SELECT file_id AS "fileId", sha256 AS sha FROM job_rerun_copies WHERE job_id = $1 AND stage = 'segment' AND role = 'segments_json'`,
      [child.jobId],
    );
    assert.ok(copiedSegments);
    assert.equal(copiedSegments.sha, artifacts.segmentFile.sha);
    const caption = await runCaption(
      child,
      artifacts.segments,
      copiedSegments,
      parent.jobId,
      text,
    );
    const claims = await db.app.query(
      "SELECT stage FROM job_stage_claims WHERE job_id = $1",
      [child.jobId],
    );
    assert.deepEqual(claims.rows, [{ stage: "caption" }]);
    return { child, caption };
  }

  const { child, caption } = await retryCaption(parent, "First caption retry.");
  await sealAndAccept(child);
  const published = await acceptedManifest(child, "v6");
  const clip = published.doc.clips[0];
  assert.notEqual(clip.clip_id, original.doc.clips[0].clip_id);
  assert.deepEqual(published.doc.reused_hand, {
    job_id: parent.jobId,
    manifest_sha256: original.sha,
    clips: [
      {
        clip_id: clip.clip_id,
        original_clip_id: original.doc.clips[0].clip_id,
      },
    ],
  });
  assert.equal(published.doc.review_clip_id, planned.clipId);
  assert.equal(published.doc.clip_plan_sha256, planned.planSha);
  assert.deepEqual(
    [clip.source_start_ns, clip.source_end_ns, clip.frame_count],
    [
      planned.sourceRange.start_ts_ns,
      planned.sourceRange.end_ts_ns,
      planned.sourceRange.end_ordinal,
    ],
  );
  const { rows: copies } = await db.app.query<{
    source_file_id: string;
    file_id: string;
    object_key: string;
    state: string;
  }>(
    `SELECT c.source_file_id, c.file_id, f.object_key, f.state
     FROM job_rerun_copies c JOIN files f ON f.id = c.file_id AND f.job_id = c.job_id
     WHERE c.job_id = $1 AND c.stage = 'hand_pose'`,
    [child.jobId],
  );
  assert.equal(copies.length, artifacts.handFiles.length);
  for (const hand of artifacts.handFiles) {
    const copy = published.doc.outputs.find(
      (f: { relative_path: string }) => f.relative_path === hand.slot,
    );
    assert.ok(copy, hand.slot);
    assert.notEqual(copy.file_id, hand.fileId);
    assert.equal(copy.sha256, hand.sha);
    assert.equal(copy.size_bytes, String(hand.size));
    const stored = copies.find((row) => row.source_file_id === hand.fileId);
    assert.ok(stored, hand.slot);
    assert.equal(stored.file_id, copy.file_id);
    assert.equal(stored.state, "verified");
    const bytes = await storage.accept.reader.read(
      stored.object_key,
      hand.size,
    );
    assert.deepEqual(Buffer.from(bytes), hand.body);
  }
  assert.notEqual(caption.sha, artifacts.caption.sha);
  assert.ok(
    published.doc.outputs.some(
      (f: { file_id: string }) => f.file_id === caption.fileId,
    ),
  );
  assert.deepEqual(await selection(), {
    live_job_id: child.jobId,
    selected_job_id: child.jobId,
    seq: 2,
    kind: "auto",
    legacy_selection: false,
  });

  const next = await retryCaption(child, "Second caption retry.");
  await sealAndAccept(next.child, async () => {
    await assert.rejects(
      selectReviewClipResult(db.app, {
        viewerUserId: actor,
        clipId: planned.clipId,
        jobId: parent.jobId,
        expectedSelectionSeq: 1,
        reason: "Stale selection",
      }),
      /selected clip result changed/,
    );
    assert.deepEqual(
      await selectReviewClipResult(db.app, {
        viewerUserId: actor,
        clipId: planned.clipId,
        jobId: parent.jobId,
        expectedSelectionSeq: 2,
        reason: "Prefer the original result",
      }),
      { jobId: parent.jobId, selectionRevision: 3 },
    );
  });
  const fenced = await acceptedManifest(next.child, "v6");
  assert.equal(fenced.doc.reused_hand.job_id, parent.jobId);
  assert.deepEqual(await selection(), {
    live_job_id: next.child.jobId,
    selected_job_id: parent.jobId,
    seq: 3,
    kind: "manual",
    legacy_selection: false,
  });
});
