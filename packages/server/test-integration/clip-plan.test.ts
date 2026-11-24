import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { requestSha256, type ClipPlanV1 } from "@stateaction/contracts";
import {
  advanceResult,
  closeOutputs,
  submitCandidate,
} from "../src/acceptance/service.js";
import {
  recordSourceCompletion,
  registerRecording,
  sealRecordingInventory,
  type AdmissionDeps,
} from "../src/admission/recordings.js";
import { failUndispatched, retryJob } from "../src/jobs/recovery.js";
import { stageRerunBlock } from "../src/jobs/stage-reruns.js";
import { jobHandlers } from "../src/jobs/http.js";
import {
  admitNextJob,
  claimControllerLease,
  claimWorker,
  recordExecutionEvidence,
} from "../src/jobs/service.js";
import { persistedClipReads } from "../src/pipeline/clip-reads.js";
import { acceptanceDeps, uploadOutput } from "./acceptance-harness.js";
import { depsFor, jobsDatabase, nonce } from "./jobs-harness.js";
import { createBody, reserveSourceScenario, sha } from "./source-scenario.js";
import { ensurePermission } from "./transport-harness.js";

const scenarios = [
  "the CPU plan owns the original and admits one bounded clip after terminal evidence",
  "a failed remux still admits one whole-recording clip without publishing a video",
];
for (const [index, name] of scenarios.entries())
  test(name, async (t) => {
    const fallback = index === 1;
    const db = await jobsDatabase();
    t.after(() => db.close());
    const jobs = depsFor(db);
    const storage = await acceptanceDeps(db);
    const owner = db.actors.collector;
    await ensurePermission(db, owner);
    const {
      rows: [permission],
    } = await db.owner.query<{ permission_ref: string }>(
      "SELECT permission_ref FROM ingest_permissions WHERE owner_user_id = $1 AND status = 'active'",
      [owner],
    );
    let sourceManifest: Uint8Array | undefined;
    const admissionDeps: AdmissionDeps = {
      pool: db.app,
      reader: {
        async read() {
          assert.ok(sourceManifest);
          return sourceManifest;
        },
      },
      config: {
        processingProfileRevision: "test-1",
        supportedRgbProfiles: ["h264_mcap_v1"],
      },
    };
    const body = createBody();
    const { recording } = await registerRecording(
      admissionDeps,
      { userId: owner },
      body,
    );
    const { recordingId } = recording;
    const source = await reserveSourceScenario(db.app, {
      recordingId,
      clientRecordingId: body.clientRecordingId,
      owner,
      permissionRef: permission!.permission_ref,
    });
    sourceManifest = source.manifest;
    for (const file of source.files)
      await recordSourceCompletion(
        admissionDeps,
        { userId: owner },
        {
          recordingId,
          fileId: file.fileId,
          expectedTransportEpoch: 1,
          observedSizeBytes: file.sizeBytes,
        },
      );
    const sealed = await sealRecordingInventory(
      admissionDeps,
      { userId: owner },
      recordingId,
      source.seal,
    );
    assert.equal(sealed.admission.state, "admitted");
    if (sealed.admission.state !== "admitted")
      throw new Error("expected admitted");
    const { jobId, sourceManifestSha256 } = sealed.admission;
    const admitted = await admitNextJob(jobs);
    assert.equal(admitted.state, "admitted");
    if (admitted.state !== "admitted") throw new Error("expected admitted");
    assert.equal(admitted.job.jobId, jobId);
    const controller = "clip-plan-fixture";
    assert.equal(
      (
        await claimControllerLease(jobs, {
          jobId,
          runRef: "local-run",
          owner: controller,
        })
      ).granted,
      true,
    );
    const submission = await jobHandlers(() => jobs).controller(
      new Request("http://fixture.test/controller", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "record_worker_submission",
          owner: controller,
        }),
      }),
      jobId,
      controller,
    );
    assert.equal(submission.status, 200);
    const { data: intent } = await submission.json();
    assert.equal(intent.state, "recorded");
    assert.equal(intent.taskInput.schemaVersion, 2);
    const invocationNonce = nonce();
    const executionRef = "local-" + randomUUID();
    await claimWorker(jobs, {
      jobId,
      bootstrapToken: intent.bootstrapToken,
      invocationNonce,
      executor: { kind: "local", localExecutionRef: executionRef },
    });
    const admittedTask = async (id: string) =>
      (
        await db.app.query(
          "SELECT task_input, max_output_files FROM job_inputs WHERE job_id = $1",
          [id],
        )
      ).rows[0]!;
    const task = await admittedTask(jobId);
    assert.equal(task.task_input.schemaVersion, 5);
    assert.equal(task.max_output_files, 2);
    const plan: ClipPlanV1 = {
      schema: "stateaction.clip-plan.v1",
      recording_id: recordingId,
      plan_version: 1,
      source_manifest_sha256: sourceManifestSha256,
      frame_count: 30,
      origin_ts_ns: "9223371967854000000",
      clock_domain: "android.elapsed_realtime",
      mode: "passthrough",
      state: fallback ? "failed" : "succeeded",
      error_code: fallback ? "native_remux_failed" : null,
      filter_version: "clip_filter@0",
      params_sha256: requestSha256({}),
      producer: {
        module_id: "clip_filter",
        revision: "0",
        weights_sha256: null,
        gpu_type: null,
      },
      spans: [
        {
          kind: "clip",
          start_ordinal: 0,
          end_ordinal: 30,
          first_source_frame_id: "0",
          last_source_frame_id: "35",
          start_ts_ns: "9223371967854000000",
          end_ts_ns: "9223372036854000000",
        },
      ],
    };
    const worker = {
      jobId,
      recordingId,
      nonce: invocationNonce,
      authority: { kind: "job" as const, jobId },
    };
    const original = fallback
      ? null
      : await uploadOutput(
          storage.transport,
          worker,
          "recording.mp4",
          "recording_mp4",
          Buffer.from("plan original"),
        );
    const manifest = await uploadOutput(
      storage.transport,
      worker,
      "result-manifest.json",
      "result_manifest",
      Buffer.from(JSON.stringify(plan)),
    );
    assert.equal(
      (
        await closeOutputs(storage.accept, {
          jobId,
          invocationNonce,
          outcome: "succeeded",
        })
      ).clipCount,
      0,
    );
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
    assert.equal(
      (await advanceResult(storage.accept, jobId))?.candidateStatus,
      "verified",
    );
    const reads = persistedClipReads({
      pool: db.app,
      reader: storage.accept.reader,
      signer: { presignRead: async ({ key }) => `http://example.test/${key}` },
    });
    assert.equal(
      (await reads.getRecording(db.actors.staff, recordingId))?.state,
      "processing",
    );
    assert.equal(await reads.getClip(db.actors.staff, recordingId), null);
    assert.equal((await admitNextJob(jobs)).state, "slot_busy");
    await recordExecutionEvidence(jobs, {
      jobId,
      evidence: { kind: "local_child_reaped", executionRef },
      recordedBy: controller,
    });
    for (const ack of await Promise.all([
      advanceResult(storage.accept, jobId),
      advanceResult(storage.accept, jobId),
    ]))
      assert.equal(ack?.candidateStatus, "accepted");
    const detail = await reads.getClip(db.actors.staff, recordingId);
    assert.ok(detail?.liveJobId);
    const clipJob = detail.liveJobId;
    assert.equal(detail.canReadOriginal, !fallback);
    assert.deepEqual(detail.sourceRange, plan.spans[0]);
    assert.equal(detail.durationNs, "69000000000");
    assert.equal(detail.selectedResult, null);
    assert.equal(await reads.getClip(owner, recordingId), null);
    assert.equal(await reads.readSource(owner, recordingId), null);
    assert.equal(
      (await reads.listClips(db.actors.staff, { pipelineState: "queued" }))
        .clips.length,
      1,
    );
    const child = await admitNextJob(jobs);
    assert.equal(child.state, "admitted");
    if (child.state !== "admitted") throw new Error("expected admitted");
    assert.equal(child.job.jobId, clipJob);
    const childTask = await admittedTask(clipJob);
    assert.equal(childTask.task_input.schemaVersion, 4);
    assert.deepEqual(childTask.task_input.clip, {
      id: recordingId,
      planVersion: 1,
      planSha256: manifest.sha,
      sourceRange: plan.spans[0],
    });
    assert.equal(
      childTask.task_input.sourceManifestSha256,
      sha(source.manifest),
    );
    assert.equal(childTask.task_input.recipe.maxJobCostUsd, "0.00");
    assert.deepEqual(
      childTask.task_input.recipe.stages
        .filter((s: { enabled: boolean }) => s.enabled)
        .map((s: { stage: string }) => s.stage),
      ["hand_pose"],
    );
    assert.equal(
      (await reads.getClip(db.actors.staff, recordingId))?.currentDag?.jobId,
      clipJob,
    );
    await failUndispatched(
      { ...jobs, config: { repair: { dispatchWindowSeconds: 0 } } },
      { jobId: clipJob, recordedBy: controller, limit: 1 },
    );
    assert.equal(
      (await reads.getRecording(db.actors.staff, recordingId))?.state,
      "failed",
    );
    const sourceRead = await reads.readSource(db.actors.staff, recordingId);
    if (original) {
      assert.equal(sourceRead?.sizeBytes, String(original.size));
      assert.match(
        sourceRead?.url ?? "",
        new RegExp(`/jobs/${jobId}/outputs/${original.fileId}/`),
      );
    } else {
      assert.equal(sourceRead, null);
      assert.equal(
        (await reads.getRecording(db.actors.staff, recordingId))?.plan
          ?.error_code,
        "native_remux_failed",
      );
    }
    const retry = await retryJob(jobs, {
      jobId: clipJob,
      expectedState: "failed",
    });
    assert.equal(
      (await reads.getClip(db.actors.staff, recordingId))?.liveJobId,
      retry.jobId,
    );
    assert.equal(
      (await retryJob(jobs, { jobId: clipJob, expectedState: "failed" }))
        .replayed,
      true,
    );
    assert.equal(
      await stageRerunBlock(db.app, db.actors.staff, recordingId, clipJob),
      "clip_rerun_unavailable",
    );
    const {
      rows: [current],
    } = await db.app.query(
      "SELECT job_is_current($1) AS previous, job_is_current($2) AS successor",
      [clipJob, retry.jobId],
    );
    assert.deepEqual(current, { previous: false, successor: true });
    const wrongClip = {
      ...childTask.task_input,
      jobId: retry.jobId,
      clip: { ...childTask.task_input.clip, id: randomUUID() },
    };
    await assert.rejects(
      db.app.query(
        `INSERT INTO job_inputs (job_id, source_manifest_sha256, profile_revision, execution_backend,
          code_revision, image_spec_sha256, model_sha256, config_sha256, max_output_files,
          max_output_bytes, max_control_document_bytes, task_input, task_input_sha256)
         SELECT $2::uuid, source_manifest_sha256, profile_revision, execution_backend,
          code_revision, image_spec_sha256, model_sha256, config_sha256, max_output_files,
          max_output_bytes, max_control_document_bytes, $3::jsonb, $4::sha256_hex FROM job_inputs WHERE job_id = $1`,
        [
          clipJob,
          retry.jobId,
          JSON.stringify(wrongClip),
          requestSha256(wrongClip),
        ],
      ),
      /clip input must match its recorded plan and source range/,
    );
    const resumed = await admitNextJob(jobs);
    assert.equal(resumed.state, "admitted");
    if (resumed.state !== "admitted")
      throw new Error("expected admitted retry");
    assert.equal(resumed.job.jobId, retry.jobId);
    assert.deepEqual(
      (await admittedTask(retry.jobId)).task_input.clip,
      childTask.task_input.clip,
    );
  });
