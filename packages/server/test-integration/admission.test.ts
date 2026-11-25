import { fixtureRunJob } from "../src/jobs/fixtures.js";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import pg from "pg";
import {
  requestSha256,
  validateValue,
  type InventoryFile,
} from "@stateaction/contracts";
import {
  createProcessingJob,
  recordFileCompleted,
  registerRecording as legacyRegisterRecording,
  reserveSourceFile,
  sealRecording as legacySeal,
  sourceObjectKey,
} from "../src/catalog/catalog.js";
import {
  admitRecording,
  getRecording,
  ObjectTooLargeError,
  recordSourceCompletion,
  registerRecording,
  sealRecordingInventory,
  selectRecordingCaptureRecipe,
  type AdmissionDeps,
  type AdmissionState,
  type ObjectReader,
} from "../src/admission/recordings.js";
import {
  recordIngestPermission,
  revokeIngestPermission,
} from "../src/admission/permissions.js";
import type { AuthenticateCollector } from "../src/admission/http.js";
import {
  PUBLIC_VIDEO_LABEL,
  PUBLIC_VIDEO_RECIPE,
} from "../src/admission/public-video-canary.js";
import { processRecordingTaskInputV2 } from "../src/admission/job-input.js";
import { admitNextJob, listPendingDispatches } from "../src/jobs/service.js";
import { failUndispatched, retryJob } from "../src/jobs/recovery.js";
import { JOBS_CONFIG } from "./jobs-harness.js";
import {
  createActors,
  expectCode,
  freshDatabase,
  writeArtifact,
  type Actors,
  type TestDb,
} from "./harness.js";
import { mobileSourceChannels } from "./source-scenario.js";
import { startRecordingServer } from "./http-adapter.js";

const sha = (b: Uint8Array | string) =>
  createHash("sha256").update(b).digest("hex");
const evidence: Record<string, unknown> = {};

/** In-memory object store standing in for R2/SeaweedFS (no provider calls). */
class MemoryReader implements ObjectReader {
  objects = new Map<string, Uint8Array>();
  reads: string[] = [];
  failNext = 0;
  async read(key: string, maxBytes: number) {
    this.reads.push(key);
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("transient storage failure");
    }
    const bytes = this.objects.get(key);
    if (!bytes) throw new Error("NoSuchKey");
    if (bytes.byteLength > maxBytes) throw new ObjectTooLargeError("too large");
    return bytes;
  }
}

let db: TestDb;
let actors: Actors;
let reader: MemoryReader;
let deps: AdmissionDeps;
let second: string; // a second collector with its own permission
let noPermission: string; // collector role, no recorded evidence
let captureOnly: string; // evidence covers capture but not processing
const permissionRef = new Map<string, string>();

async function addCollector(name: string) {
  const id = `ba_${randomUUID().slice(0, 8)}_${name}`;
  await db.owner.query(
    `INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, $1, $2, true)`,
    [id, `${id}@example.test`],
  );
  await db.owner.query(
    "INSERT INTO access (user_id, role) VALUES ($1, 'collector')",
    [id],
  );
  return id;
}
async function permit(owner: string, processing = true) {
  const ref = `pilot-${randomUUID().slice(0, 8)}`;
  await recordIngestPermission(db.owner, {
    permissionRef: ref,
    ownerUserId: owner,
    pilotScope: "sa19-integration",
    coversCapture: true,
    coversProcessing: processing,
    evidenceRef: "doc://pilot/consent-and-processing",
    recordedBy: "operator@test",
  });
  permissionRef.set(owner, ref);
  return ref;
}

before(async () => {
  db = await freshDatabase();
  actors = await createActors(db.owner);
  reader = new MemoryReader();
  deps = {
    pool: db.app,
    reader,
    config: {
      processingProfileRevision: "sa19-test-1",
      supportedRgbProfiles: ["h264_mcap_v1"],
    },
  };
  second = await addCollector("second");
  noPermission = await addCollector("nopermission");
  captureOnly = await addCollector("captureonly");
  await permit(actors.collector);
  await permit(second);
  await permit(captureOnly, false);
});
after(async () => {
  await writeArtifact("admission-evidence.json", evidence);
  await db.close();
});

const createBody = (
  clientRecordingId = randomUUID(),
  startedAt = "2026-11-01T12:00:00Z",
) => ({
  clientRecordingId,
  captureFormat: "stateaction.capture.v1",
  rgbProfile: "h264_mcap_v1",
  startedAt,
  device: { model: "Pixel 9", osVersion: "16", appVersion: "0.1.0" },
});

type Scenario = {
  recordingId: string;
  clientRecordingId: string;
  owner: string;
  files: {
    fileId: string;
    role: InventoryFile["role"];
    sizeBytes: string;
    sha256: string;
    key: string;
  }[];
  manifest: Uint8Array;
  seal: { files: InventoryFile[] };
};

const publicVideoSimulation = {
  schema: "stateaction.simulation_provenance.v1",
  qualification: "simulation_only",
  mappedTimelineSemantics: "simulation_transport_only",
  productionQualified: false,
  provenance: {
    camera: { status: "known", label: PUBLIC_VIDEO_LABEL },
    encoder: { status: "unknown" },
    clock: { status: "unknown" },
  },
};

/**
 * Registers through SA-19, reserves the logical source files through the
 * SA-13 catalog (the SA-20 transport is not exercised) and builds an exact
 * recording-source/v1 manifest. `mutate` edits the declaration before it is
 * serialized; its reserved sha256 is of the final bytes.
 */
async function scenario(
  owner = actors.collector,
  options: {
    mutate?: (doc: Record<string, unknown>) => void;
    calibration?: boolean;
    rawManifest?: (doc: Record<string, unknown>) => Uint8Array;
    publicVideo?: boolean;
  } = {},
): Promise<Scenario> {
  const clientRecordingId = randomUUID();
  const canary = {
    ownerUserId: owner,
    clientRecordingId,
    sourceSha256: sha("pending"),
  };
  const { recording } = await registerRecording(
    options.publicVideo
      ? { ...deps, config: { ...deps.config, publicVideoCanary: canary } }
      : deps,
    { userId: owner },
    options.publicVideo
      ? {
          ...createBody(clientRecordingId),
          schema: "stateaction.recording_create.v2",
          rgbProfile: "h264_mcap_simulation_v1",
          simulation: publicVideoSimulation,
        }
      : createBody(clientRecordingId),
  );
  const recordingId = recording.recordingId;
  const files: Scenario["files"] = [];
  const roles: InventoryFile["role"][] = ["source_mcap", "recorder_metadata"];
  if (options.calibration) roles.push("calibration");
  for (const role of roles) {
    const fileId = randomUUID();
    const body = Buffer.from(`${role}:${fileId}`);
    files.push({
      fileId,
      role,
      sizeBytes: String(body.byteLength),
      sha256: sha(body),
      key: sourceObjectKey(recordingId, fileId, 1, role),
    });
  }
  const doc: Record<string, unknown> = {
    schema: "stateaction.recording_source.v2",
    recording_id: recordingId,
    client_recording_id: clientRecordingId,
    owner_user_id: owner,
    capture_format: "stateaction.capture.v1",
    rgb_profile: "h264_mcap_v1",
    capture_config_sha256: sha("capture-config"),
    close_status: "closed_clean",
    files: files.map((f) => ({
      file_id: f.fileId,
      role: f.role,
      required: true,
      size_bytes: f.sizeBytes,
      sha256: f.sha256,
    })),
    clock_domains: ["android.elapsed_realtime", "android.sensor_event", "unix"],
    channels: mobileSourceChannels(),
    counts: {
      video_frames: "30",
      dropped_video_frames: "0",
      motion_events: "200",
    },
    collection_permission_ref: permissionRef.get(owner) ?? "none",
    source_verification: "pending",
  };
  if (options.publicVideo) {
    doc.schema = "stateaction.recording_source.v2";
    doc.rgb_profile = "h264_mcap_simulation_v1";
    doc.simulation = {
      schema: publicVideoSimulation.schema,
      qualification: publicVideoSimulation.qualification,
      mapped_timeline_semantics: publicVideoSimulation.mappedTimelineSemantics,
      production_qualified: publicVideoSimulation.productionQualified,
      provenance: publicVideoSimulation.provenance,
    };
  }
  options.mutate?.(doc);
  const manifest = options.rawManifest
    ? options.rawManifest(doc)
    : Buffer.from(JSON.stringify(doc));
  const manifestId = randomUUID();
  files.push({
    fileId: manifestId,
    role: "source_manifest",
    sizeBytes: String(manifest.byteLength),
    sha256: sha(manifest),
    key: sourceObjectKey(recordingId, manifestId, 1, "source_manifest"),
  });
  for (const f of files) {
    await reserveSourceFile(db.app, {
      fileId: f.fileId,
      recordingId,
      ownerUserId: owner,
      clientUploadId: randomUUID(),
      role: f.role,
      sizeBytes: f.sizeBytes,
      sha256: f.sha256,
      required: true,
      partSizeBytes: "67108864",
      partCount: 1,
    });
  }
  // The object store holds the manifest bytes once "uploaded".
  reader.objects.set(files.at(-1)!.key, manifest);
  return {
    recordingId,
    clientRecordingId,
    owner,
    files,
    manifest,
    seal: {
      files: files.map((f) => ({
        fileId: f.fileId,
        role: f.role,
        sizeBytes: f.sizeBytes,
        sha256: f.sha256,
        required: true,
      })),
    },
  };
}
const complete = (s: Scenario, role: string) => {
  const f = s.files.find((x) => x.role === role)!;
  return recordSourceCompletion(
    deps,
    { userId: s.owner },
    {
      recordingId: s.recordingId,
      fileId: f.fileId,
      expectedTransportEpoch: 1,
      observedSizeBytes: f.sizeBytes,
    },
  );
};
const jobsOf = async (recordingId: string) =>
  (
    await db.owner.query(
      "SELECT id, state, source_manifest_sha256, profile_revision FROM jobs WHERE recording_id = $1",
      [recordingId],
    )
  ).rows;
const admissionOf = async (recordingId: string) =>
  (
    await db.owner.query(
      "SELECT * FROM recording_admissions WHERE recording_id = $1",
      [recordingId],
    )
  ).rows[0];

test("a hosted public-video CPU plan binds the collector, client id and source bytes", async (t) => {
  const s = await scenario(actors.collector, { publicVideo: true });
  const canary = {
    ownerUserId: s.owner,
    clientRecordingId: s.clientRecordingId,
    sourceSha256: s.files.find((f) => f.role === "source_mcap")!.sha256,
  };
  const jobs = {
    pool: db.app,
    config: {
      ...JOBS_CONFIG,
      executionBackend: "modal" as const,
      production: true,
    },
    presignRead: async () => "https://example.test",
  };
  const scopedJobs = {
    ...jobs,
    config: { ...jobs.config, publicVideoCanary: canary },
  };
  const registration = {
    ...createBody(s.clientRecordingId),
    schema: "stateaction.recording_create.v2",
    rgbProfile: "h264_mcap_simulation_v1",
    simulation: publicVideoSimulation,
  };
  const scoped = {
    ...deps,
    config: { ...deps.config, publicVideoCanary: canary },
  };
  await expectCode(
    registerRecording(scoped, { userId: second }, registration),
    "forbidden",
  );
  await expectCode(
    registerRecording(
      scoped,
      { userId: s.owner },
      { ...registration, clientRecordingId: randomUUID() },
    ),
    "forbidden",
  );
  for (const file of s.files) await complete(s, file.role);
  const wrongBytes = {
    ...scoped,
    config: {
      ...scoped.config,
      publicVideoCanary: { ...canary, sourceSha256: sha("wrong") },
    },
  };
  const sealed = await sealRecordingInventory(
    wrongBytes,
    { userId: s.owner },
    s.recordingId,
    s.seal,
  );
  assert.deepEqual(sealed.admission, {
    state: "deferred",
    code: "profile_unsupported",
  });
  assert.deepEqual(await admitNextJob(scopedJobs), { state: "idle" });
  const ready = await admitRecording(scoped, s.recordingId);
  assert.equal(ready.state, "admitted");
  if (ready.state !== "admitted") return;
  const abandon = () =>
    failUndispatched(
      {
        ...scopedJobs,
        config: { ...scopedJobs.config, repair: { dispatchWindowSeconds: 0 } },
      },
      { recordedBy: "public-video-test", limit: 1, jobId: ready.jobId },
    );
  t.after(async () => {
    await abandon();
  });
  const started = await admitNextJob(scopedJobs);
  assert.equal(started.state, "admitted");
  if (started.state !== "admitted") return;
  assert.equal(started.job.jobId, ready.jobId);
  assert.equal(
    started.job.executionDeadline.getTime() - started.job.admittedAt.getTime(),
    JOBS_CONFIG.executionDeadlineSeconds * 1000,
  );
  const input = await db.app.query(
    "SELECT task_input FROM job_inputs WHERE job_id = $1",
    [ready.jobId],
  );
  assert.equal(input.rows[0]?.task_input.kind, "clip_plan");
  assert.equal(input.rows[0]?.task_input.schemaVersion, 5);
  assert.deepEqual(input.rows[0]?.task_input.clipFilter, {
    mode: "passthrough",
    module: "clip_filter@0",
    params: {},
  });
  assert.deepEqual(input.rows[0]?.task_input.simulation, publicVideoSimulation);
  assert.deepEqual(await listPendingDispatches(jobs), [
    { jobId: ready.jobId, dispatchKey: started.job.dispatchKey },
  ]);
  assert.deepEqual(await abandon(), [ready.jobId]);
  await assert.rejects(
    retryJob(scopedJobs, { jobId: ready.jobId, expectedState: "failed" }),
    /canary_one_attempt/,
  );
  assert.equal((await jobsOf(s.recordingId)).length, 1);
});
test("a public-video job keeps its retry fence after the recipe budgets change", async (t) => {
  const s = await scenario(actors.collector, { publicVideo: true });
  for (const file of s.files) await complete(s, file.role);
  const { admission } = await sealRecordingInventory(
    {
      ...deps,
      config: {
        ...deps.config,
        publicVideoCanary: {
          ownerUserId: s.owner,
          clientRecordingId: s.clientRecordingId,
          sourceSha256: s.files.find((file) => file.role === "source_mcap")!
            .sha256,
        },
      },
    },
    { userId: s.owner },
    s.recordingId,
    s.seal,
  );
  assert.equal(admission.state, "admitted");
  if (admission.state !== "admitted") return;

  const recipe = { ...PUBLIC_VIDEO_RECIPE, maxJobCostUsd: "5.00" };
  const input = await processRecordingTaskInputV2(db.app, admission.jobId);
  const jobs = {
    pool: db.app,
    config: { ...JOBS_CONFIG, repair: { dispatchWindowSeconds: 0 } },
    presignRead: async () => "https://example.test",
    taskInput: async () => ({
      ...input,
      schemaVersion: 3,
      recipe,
      recipeSha256: requestSha256(recipe),
    }),
  };
  const abandon = () =>
    failUndispatched(jobs, {
      recordedBy: "public-video-test",
      limit: 1,
      jobId: admission.jobId,
    });
  t.after(async () => {
    await abandon();
  });
  const started = await admitNextJob(jobs);
  assert.equal(started.state, "admitted");
  if (started.state !== "admitted") return;
  assert.equal(started.job.jobId, admission.jobId);
  assert.deepEqual(await abandon(), [admission.jobId]);
  await assert.rejects(
    retryJob(jobs, { jobId: admission.jobId, expectedState: "failed" }),
    /canary_one_attempt/,
  );
  assert.equal((await jobsOf(s.recordingId)).length, 1);
});

const settle = async <T>(work: Promise<T>[]) => {
  const results = await Promise.allSettled(work);
  return {
    ok: results
      .filter(
        (r): r is PromiseFulfilledResult<Awaited<T>> =>
          r.status === "fulfilled",
      )
      .map((r) => r.value),
    codes: results
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => (r.reason as { code?: string }).code),
  };
};

// ---------------------------------------------------------------- register
describe("registration", () => {
  test("owner-scoped exact replay returns the original; changed content or spelling conflicts", async () => {
    const client = randomUUID();
    const first = await registerRecording(
      deps,
      { userId: actors.collector },
      createBody(client),
    );
    assert.equal(first.created, true);
    assert.equal(
      first.collectionPermissionRef,
      permissionRef.get(actors.collector),
    );
    assert.equal(
      validateValue("http.recording.v1", first.recording).valid,
      true,
    );
    const base = createBody(client);
    const reordered = {
      device: { appVersion: "0.1.0", osVersion: "16", model: "Pixel 9" },
      startedAt: base.startedAt,
      rgbProfile: base.rgbProfile,
      captureFormat: base.captureFormat,
      clientRecordingId: client,
    };
    const replay = await registerRecording(
      deps,
      { userId: actors.collector },
      reordered,
    );
    assert.equal(replay.created, false);
    assert.deepEqual(replay.recording, first.recording);
    await expectCode(
      registerRecording(
        deps,
        { userId: actors.collector },
        {
          ...createBody(client),
          device: { model: "Pixel 9", osVersion: "17", appVersion: "0.1.0" },
        },
      ),
      "idempotency_conflict",
    );
    // Same instant, different RFC 3339 spelling: distinct sa-cjson-v1 digest.
    await expectCode(
      registerRecording(
        deps,
        { userId: actors.collector },
        createBody(client, "2026-11-01T12:00:00.000Z"),
      ),
      "idempotency_conflict",
    );
    // Scope is per owner: another collector's identical client ID is separate.
    const other = await registerRecording(
      deps,
      { userId: second },
      createBody(client),
    );
    assert.equal(other.created, true);
    assert.notEqual(other.recording.recordingId, first.recording.recordingId);
    // Owner never comes from the body: an owner field is a schema violation.
    await expectCode(
      registerRecording(
        deps,
        { userId: actors.collector },
        { ...createBody(), ownerUserId: second },
      ),
      "invalid_request",
    );
    const stored = await db.owner.query(
      "SELECT request_sha256, permission_ref FROM recording_registrations WHERE recording_id = $1",
      [first.recording.recordingId],
    );
    assert.match(stored.rows[0].request_sha256, /^[0-9a-f]{64}$/);
    evidence.registrationReplay = {
      replay: "original",
      changedDevice: 409,
      startedAtSpelling: 409,
      otherOwner: "separate",
    };
  });

  test("collector role and recorded capture permission are both required; legacy recordings are not adopted", async () => {
    await expectCode(
      registerRecording(deps, { userId: noPermission }, createBody()),
      "forbidden",
    );
    await expectCode(
      registerRecording(deps, { userId: actors.customer }, createBody()),
      "forbidden",
    );
    await expectCode(
      registerRecording(deps, { userId: "unknown-user" }, createBody()),
      "forbidden",
    );
    // A recording created by the SA-13 helper (no registration) conflicts.
    const client = randomUUID();
    await legacyRegisterRecording(db.app, {
      recordingId: randomUUID(),
      ownerUserId: actors.collector,
      clientRecordingId: client,
      captureFormat: "stateaction.capture.v1",
      rgbProfile: "h264_mcap_v1",
      startedAt: "2026-11-01T12:00:00Z",
      device: { model: "Pixel 9", osVersion: "16", appVersion: "0.1.0" },
    });
    await expectCode(
      registerRecording(deps, { userId: actors.collector }, createBody(client)),
      "idempotency_conflict",
    );
  });

  test("concurrent identical registrations create one recording", async () => {
    const client = randomUUID();
    const { ok, codes } = await settle(
      Array.from({ length: 8 }, () =>
        registerRecording(
          deps,
          { userId: actors.collector },
          createBody(client),
        ),
      ),
    );
    assert.deepEqual(codes, []);
    assert.equal(new Set(ok.map((r) => r.recording.recordingId)).size, 1);
    assert.equal(ok.filter((r) => r.created).length, 1);
    const n = await db.owner.query(
      "SELECT count(*)::int AS n FROM recordings WHERE client_recording_id = $1",
      [client],
    );
    assert.equal(n.rows[0].n, 1);
    evidence.concurrentRegistration = { attempts: 8, created: 1 };
  });
});

// -------------------------------------------------------------------- seal
describe("seal and eligibility", () => {
  test("seal before completion: admission waits for every required file, then queues one job", async () => {
    const s = await scenario(actors.collector, { calibration: true });
    const sealed = await sealRecordingInventory(
      deps,
      { userId: s.owner },
      s.recordingId,
      s.seal,
    );
    assert.equal(sealed.replayed, false);
    assert.equal(sealed.admission.state, "awaiting_uploads");
    assert.equal(
      validateValue("http.recording.v1", sealed.recording).valid,
      true,
    );
    assert.equal(sealed.recording.status, "sealed");
    assert.equal(
      reader.reads.filter((k) => k.includes(s.recordingId)).length,
      0,
      "no storage read before the manifest is complete",
    );
    assert.equal(
      (await complete(s, "source_manifest")).admission.state,
      "awaiting_uploads",
    );
    assert.equal(
      (await complete(s, "source_mcap")).admission.state,
      "awaiting_uploads",
    );
    assert.equal(
      (await complete(s, "recorder_metadata")).admission.state,
      "awaiting_uploads",
    );
    const last = await complete(s, "calibration");
    assert.equal(last.admission.state, "admitted");
    const jobs = await jobsOf(s.recordingId);
    assert.equal(jobs.length, 1);
    assert.deepEqual(
      {
        state: jobs[0].state,
        sha: jobs[0].source_manifest_sha256,
        rev: jobs[0].profile_revision,
      },
      { state: "queued", sha: sha(s.manifest), rev: "sa19-test-1" },
    );
    const admission = await admissionOf(s.recordingId);
    assert.equal(admission.outcome, "admitted");
    assert.equal(admission.job_id, jobs[0].id);
    assert.equal(admission.capture_config_sha256, sha("capture-config"));
    const profile = (
      await db.app.query(
        `SELECT capture_source_id, state, recipe_id, recipe_sha256, selected_by, evidence
       FROM recording_capture_profiles WHERE recording_id = $1`,
        [s.recordingId],
      )
    ).rows[0]!;
    assert.equal(profile.state, "selected");
    assert.equal(profile.capture_source_id, "stateaction_mobile@1");
    assert.equal(profile.recipe_id, PUBLIC_VIDEO_RECIPE.recipeId);
    assert.equal(profile.recipe_sha256, requestSha256(PUBLIC_VIDEO_RECIPE));
    assert.equal(profile.selected_by, null);
    assert.equal(profile.evidence.device.appVersion, "0.1.0");

    assert.equal(admission.close_status, "closed_clean");
    assert.deepEqual(admission.clock_domains, [
      "android.elapsed_realtime",
      "android.sensor_event",
      "unix",
    ]);
    assert.deepEqual(admission.calibration_file_ids, [
      s.files.find((f) => f.role === "calibration")!.fileId,
    ]);
    assert.equal(admission.permission_ref, permissionRef.get(s.owner));
    const rec = await getRecording(db.app, { userId: s.owner }, s.recordingId);
    assert.equal(rec.status, "uploaded");
    // Every storage read named a durably reserved, completed manifest object.
    const keys = reader.reads.filter((k) => k.includes(s.recordingId));
    assert.deepEqual(
      [...new Set(keys)],
      [s.files.find((f) => f.role === "source_manifest")!.key],
    );
    // Replays are idempotent and never create a second job.
    assert.equal((await complete(s, "calibration")).replayed, true);
    const again = await sealRecordingInventory(
      deps,
      { userId: s.owner },
      s.recordingId,
      s.seal,
    );
    assert.deepEqual(
      [again.replayed, again.admission],
      [
        true,
        {
          state: "admitted",
          jobId: jobs[0].id,
          sourceManifestSha256: sha(s.manifest),
        },
      ],
    );
    assert.equal((await jobsOf(s.recordingId)).length, 1);
    evidence.sealFirst = { states: "awaiting_uploads x4 -> admitted", jobs: 1 };
  });

  test("completion before seal: seal admits in the same transaction", async () => {
    const s = await scenario();
    for (const role of ["source_mcap", "recorder_metadata", "source_manifest"])
      assert.equal((await complete(s, role)).admission.state, "awaiting_seal");
    const sealed = await sealRecordingInventory(
      deps,
      { userId: s.owner },
      s.recordingId,
      s.seal,
    );
    assert.equal(sealed.admission.state, "admitted");
    assert.equal(sealed.recording.status, "uploaded");
    assert.equal((await jobsOf(s.recordingId)).length, 1);
    evidence.completionFirst = { jobs: 1 };
  });

  test("concurrent seals, final completions and recovery calls create exactly one queued job", async () => {
    for (let round = 0; round < 5; round++) {
      const s = await scenario();
      await complete(s, "source_mcap");
      await complete(s, "recorder_metadata");
      const reversed = { files: [...s.seal.files].reverse() };
      const work: Promise<{ admission: AdmissionState } | AdmissionState>[] =
        [];
      for (let i = 0; i < 4; i++) {
        work.push(
          sealRecordingInventory(
            deps,
            { userId: s.owner },
            s.recordingId,
            i % 2 ? reversed : s.seal,
          ),
        );
        work.push(complete(s, "source_manifest"));
        work.push(admitRecording(deps, s.recordingId));
      }
      const { ok, codes } = await settle(work);
      assert.deepEqual(codes, [], `round ${round}: no failures`);
      const jobs = await jobsOf(s.recordingId);
      assert.equal(jobs.length, 1, `round ${round}: exactly one job`);
      const admitted = ok
        .map((r) => ("admission" in r ? r.admission : r))
        .filter((a) => a.state === "admitted") as { jobId: string }[];
      assert.ok(admitted.length >= 1);
      assert.ok(
        admitted.every((a) => a.jobId === jobs[0].id),
        "every admitted response names the one job",
      );
    }
    evidence.concurrentAdmission = {
      rounds: 5,
      callsPerRound: 12,
      jobsPerRecording: 1,
    };
  });

  test("seal replay is order independent; changed, mismatched or incomplete seals are refused", async () => {
    const s = await scenario(actors.collector, { calibration: true });
    await sealRecordingInventory(
      deps,
      { userId: s.owner },
      s.recordingId,
      s.seal,
    );
    const shuffled = {
      files: [
        s.seal.files[2]!,
        s.seal.files[0]!,
        s.seal.files[3]!,
        s.seal.files[1]!,
      ],
    };
    assert.equal(
      (
        await sealRecordingInventory(
          deps,
          { userId: s.owner },
          s.recordingId,
          shuffled,
        )
      ).replayed,
      true,
    );
    const changed = {
      files: s.seal.files.map((f) =>
        f.role === "calibration" ? { ...f, required: false } : f,
      ),
    };
    await expectCode(
      sealRecordingInventory(deps, { userId: s.owner }, s.recordingId, changed),
      "idempotency_conflict",
    );
    const dropped = {
      files: s.seal.files.filter((f) => f.role !== "calibration"),
    };
    await expectCode(
      sealRecordingInventory(deps, { userId: s.owner }, s.recordingId, dropped),
      "idempotency_conflict",
    );

    // Missing sidecar: a reserved recorder_metadata omitted from the seal.
    const m = await scenario();
    const missingSidecar = {
      files: m.seal.files.filter((f) => f.role !== "recorder_metadata"),
    };
    await expectCode(
      sealRecordingInventory(
        deps,
        { userId: m.owner },
        m.recordingId,
        missingSidecar,
      ),
      "invalid_request",
    );
    // Seal names an unreserved file / wrong digest: live inventory mismatch.
    const extra = {
      files: [
        ...m.seal.files,
        {
          fileId: randomUUID(),
          role: "calibration" as const,
          sizeBytes: "10",
          sha256: sha("x"),
          required: true,
        },
      ],
    };
    await expectCode(
      sealRecordingInventory(deps, { userId: m.owner }, m.recordingId, extra),
      "conflict",
    );
    const wrongDigest = {
      files: m.seal.files.map((f) =>
        f.role === "source_mcap" ? { ...f, sha256: sha("other") } : f,
      ),
    };
    await expectCode(
      sealRecordingInventory(
        deps,
        { userId: m.owner },
        m.recordingId,
        wrongDigest,
      ),
      "conflict",
    );
    // Other owner: indistinguishable from absent.
    await expectCode(
      sealRecordingInventory(deps, { userId: second }, m.recordingId, m.seal),
      "not_found",
    );
    await expectCode(
      getRecording(db.app, { userId: second }, m.recordingId),
      "not_found",
    );
    await expectCode(
      complete({ ...m, owner: second }, "source_mcap"),
      "not_found",
    );
    const unsealed = await db.owner.query(
      "SELECT source_manifest_file_id FROM recordings WHERE id = $1",
      [m.recordingId],
    );
    assert.equal(
      unsealed.rows[0].source_manifest_file_id,
      null,
      "failed seals wrote nothing",
    );
    // A recording created by the SA-13 helper cannot be sealed through SA-19.
    const legacy = randomUUID();
    await legacyRegisterRecording(db.app, {
      recordingId: legacy,
      ownerUserId: actors.collector,
      clientRecordingId: randomUUID(),
      captureFormat: "stateaction.capture.v1",
      rgbProfile: "h264_mcap_v1",
      startedAt: "2026-11-01T12:00:00Z",
      device: { model: "m", osVersion: "1", appVersion: "a" },
    });
    await expectCode(
      sealRecordingInventory(
        deps,
        { userId: actors.collector },
        legacy,
        m.seal,
      ),
      "conflict",
    );
    evidence.sealReplay = {
      orderIndependent: true,
      changed: 409,
      missingSidecar: 422,
      mismatch: 409,
      otherOwner: 404,
    };
  });
});

// -------------------------------------------------------------- manifest
describe("source manifest validation before admission", () => {
  const rejected: Record<string, string> = {};
  const expectRejected = async (
    code: string,
    options: Parameters<typeof scenario>[1],
  ) => {
    const s = await scenario(actors.collector, options);
    for (const role of ["source_mcap", "recorder_metadata", "source_manifest"])
      await complete(s, role);
    const out = await sealRecordingInventory(
      deps,
      { userId: s.owner },
      s.recordingId,
      s.seal,
    );
    assert.deepEqual(out.admission, { state: "rejected", code });
    assert.equal(out.recording.status, "failed");
    assert.equal((await jobsOf(s.recordingId)).length, 0);
    assert.equal((await admissionOf(s.recordingId)).rejection_code, code);
    // Durable and stable on recovery.
    assert.deepEqual(await admitRecording(deps, s.recordingId), {
      state: "rejected",
      code,
    });
    rejected[code] = "durable rejection, no job";
  };

  test("deterministic declaration defects are durably rejected with no job", async () => {
    await expectRejected("manifest_schema_violation", {
      mutate: (d) => (d.extra = true),
    });
    await expectRejected("manifest_malformed_json", {
      rawManifest: () => Buffer.from("{not json"),
    });
    await expectRejected("manifest_unsupported_version", {
      mutate: (d) => (d.schema = "stateaction.recording_source.v3"),
    });
    await expectRejected("source_not_closed", {
      mutate: (d) => (d.close_status = "unclosed"),
    });
    await expectRejected("identity_mismatch", {
      mutate: (d) => (d.owner_user_id = second),
    });
    await expectRejected("identity_mismatch", {
      mutate: (d) => (d.recording_id = randomUUID()),
    });
    await expectRejected("permission_ref_mismatch", {
      mutate: (d) => (d.collection_permission_ref = "client-chosen-ref"),
    });
    await expectRejected("seal_reference_mismatch", {
      mutate: (d) => {
        (d.files as { sha256: string }[])[0]!.sha256 = sha(
          "not the sealed digest",
        );
      },
    });
    await expectRejected("seal_inventory_incomplete", {
      mutate: (d) => {
        (d.files as unknown[]).push({
          file_id: randomUUID(),
          role: "calibration",
          required: true,
          size_bytes: "1",
          sha256: sha("x"),
        });
      },
    });
    // The shared recording_source rule already ties channel clocks to clock_domains.
    await expectRejected("manifest_reference_mismatch", {
      mutate: (d) =>
        ((d.channels as { clock_domain: string }[])[1]!.clock_domain =
          "android.other_clock"),
    });
    evidence.rejections = rejected;
  });

  test("a profile outside the current server allowlist defers admission; a config change admits", async () => {
    const s = await scenario();
    for (const role of ["source_mcap", "recorder_metadata", "source_manifest"])
      await complete(s, role);
    const narrowed: AdmissionDeps = {
      ...deps,
      config: { ...deps.config, supportedRgbProfiles: [] },
    };
    const out = await sealRecordingInventory(
      narrowed,
      { userId: s.owner },
      s.recordingId,
      s.seal,
    );
    assert.deepEqual(out.admission, {
      state: "deferred",
      code: "profile_unsupported",
    });
    assert.equal(
      await admissionOf(s.recordingId),
      undefined,
      "nothing durable",
    );
    assert.equal(out.recording.status, "sealed");
    assert.equal((await admitRecording(deps, s.recordingId)).state, "admitted");
    assert.equal((await jobsOf(s.recordingId)).length, 1);
    evidence.profileAllowlist = {
      excluded: "deferred (retryable)",
      restored: "admitted",
    };
  });

  test("unverifiable bytes and storage failures stay retryable and recover", async () => {
    const s = await scenario();
    for (const role of ["source_mcap", "recorder_metadata"])
      await complete(s, role);
    const key = s.files.find((f) => f.role === "source_manifest")!.key;
    const genuine = reader.objects.get(key)!;
    // Wrong stored bytes (digest mismatch): pending, nothing durable.
    reader.objects.set(
      key,
      Buffer.from(
        JSON.stringify({ tampered: true }).padEnd(genuine.byteLength),
      ),
    );
    const first = await complete(s, "source_manifest");
    assert.equal(first.admission.state, "awaiting_seal");
    const sealed = await sealRecordingInventory(
      deps,
      { userId: s.owner },
      s.recordingId,
      s.seal,
    );
    assert.deepEqual(sealed.admission, {
      state: "manifest_unverified",
      code: "manifest_digest_mismatch",
    });
    assert.equal(await admissionOf(s.recordingId), undefined);
    // Oversized object refused by the bounded reader: still retryable.
    reader.objects.set(key, new Uint8Array(1048577));
    assert.deepEqual(await admitRecording(deps, s.recordingId), {
      state: "manifest_unverified",
      code: "manifest_too_large",
    });
    // Transient read failure: awaiting bytes, nothing durable.
    reader.objects.set(key, genuine);
    reader.failNext = 2;
    assert.deepEqual(await admitRecording(deps, s.recordingId), {
      state: "awaiting_manifest_bytes",
    });
    assert.equal((await jobsOf(s.recordingId)).length, 0);
    // Recovery admits exactly once.
    const recovered = await admitRecording(deps, s.recordingId);
    assert.equal(recovered.state, "admitted");
    assert.equal((await jobsOf(s.recordingId)).length, 1);
    evidence.retryable = {
      digestMismatch: "manifest_unverified",
      tooLarge: "manifest_unverified",
      readFailure: "awaiting_manifest_bytes",
      recovered: "admitted",
    };
  });
});

// ------------------------------------------------------------ permission
describe("permission evidence", () => {
  test("capture-only or revoked evidence blocks admission without a durable rejection", async () => {
    const c = await scenario(captureOnly);
    for (const role of ["source_mcap", "recorder_metadata", "source_manifest"])
      await complete(c, role);
    const out = await sealRecordingInventory(
      deps,
      { userId: c.owner },
      c.recordingId,
      c.seal,
    );
    assert.deepEqual(out.admission, { state: "blocked_permission" });
    assert.equal((await jobsOf(c.recordingId)).length, 0);
    assert.equal(await admissionOf(c.recordingId), undefined);

    const owner = await addCollector("revoked");
    const ref = await permit(owner);
    const s = await scenario(owner);
    for (const role of ["source_mcap", "recorder_metadata"])
      await complete(s, role);
    await sealRecordingInventory(
      deps,
      { userId: owner },
      s.recordingId,
      s.seal,
    );
    await revokeIngestPermission(db.owner, {
      permissionRef: ref,
      revokedBy: "operator@test",
      reason: "withdrawn",
    });
    assert.deepEqual((await complete(s, "source_manifest")).admission, {
      state: "blocked_permission",
    });
    assert.equal((await jobsOf(s.recordingId)).length, 0);
    // New registrations for that owner are refused until new evidence exists.
    await expectCode(
      registerRecording(deps, { userId: owner }, createBody()),
      "forbidden",
    );
    // The app role cannot fabricate evidence or bypass the jobs trigger.
    await expectCode(
      db.app.query(
        `INSERT INTO ingest_permissions (id, permission_ref, owner_user_id, pilot_scope, covers_capture, covers_processing, evidence_ref, recorded_by)
         VALUES (gen_random_uuid(), 'self-grant', $1, 's', true, true, 'e', 'me')`,
        [owner],
      ),
      "42501",
    );
    await expectCode(
      db.app.query(
        "UPDATE ingest_permissions SET status = 'active' WHERE permission_ref = $1",
        [ref],
      ),
      "42501",
    );
    await expectCode(
      db.app.query(
        `INSERT INTO jobs (id, kind, recording_id, source_manifest_sha256, profile_revision)
         SELECT gen_random_uuid(), 'process_recording', id, source_manifest_sha256, 'x' FROM recordings WHERE id = $1`,
        [s.recordingId],
      ),
      "SAC05",
    );
    // Revocation is one-way and evidence is retained.
    await expectCode(
      db.owner.query(
        "UPDATE ingest_permissions SET status = 'active' WHERE permission_ref = $1",
        [ref],
      ),
      "SAC04",
    );
    await expectCode(
      db.owner.query(
        "DELETE FROM ingest_permissions WHERE permission_ref = $1",
        [ref],
      ),
      "SAC01",
    );
    await expectCode(
      db.owner.query(
        "UPDATE ingest_permissions SET covers_processing = false WHERE permission_ref = $1",
        [ref],
      ),
      "SAC01",
    );
    // Renewed approval is a new record; the old declaration still names the old ref.
    await permit(owner);
    assert.deepEqual(await admitRecording(deps, s.recordingId), {
      state: "blocked_permission",
    });
    evidence.permission = {
      captureOnly: "blocked",
      revoked: "blocked",
      appSelfGrant: 42501,
      rawJob: "SAC05",
    };
  });

  test("revocation and admission serialize on the evidence row in both orders", async () => {
    // Order 1: revocation commits while admission waits on the row lock.
    const owner = await addCollector("race1");
    const ref = await permit(owner);
    const s = await scenario(owner);
    for (const role of ["source_mcap", "recorder_metadata"])
      await complete(s, role);
    await sealRecordingInventory(
      deps,
      { userId: owner },
      s.recordingId,
      s.seal,
    );
    const revoker = new pg.Client({ connectionString: db.ownerUrl });
    await revoker.connect();
    try {
      await revoker.query("BEGIN");
      await revoker.query(
        "UPDATE ingest_permissions SET status = 'revoked', revoked_at = now(), revoked_by = 'op' WHERE permission_ref = $1",
        [ref],
      );
      let done = false;
      const pending = complete(s, "source_manifest").then(
        (r) => ((done = true), r),
      );
      await waitForLockWait();
      assert.equal(
        done,
        false,
        "admission waits behind the uncommitted revocation",
      );
      await revoker.query("COMMIT");
      assert.deepEqual((await pending).admission, {
        state: "blocked_permission",
      });
      assert.equal((await jobsOf(s.recordingId)).length, 0);
    } finally {
      await revoker.end();
    }
    // Order 2: a holder of the FOR SHARE lock (as admission takes it) blocks revocation.
    const owner2 = await addCollector("race2");
    const ref2 = await permit(owner2);
    const s2 = await scenario(owner2);
    const holder = new pg.Client({ connectionString: db.appUrl });
    await holder.connect();
    try {
      await holder.query("BEGIN");
      const { rows } = await holder.query(
        "SELECT ingest_permission_ok(id, owner_user_id, true) AS ok FROM ingest_permissions WHERE permission_ref = $1",
        [ref2],
      );
      assert.equal(rows[0].ok, true);
      let revoked = false;
      const revoke = revokeIngestPermission(db.owner, {
        permissionRef: ref2,
        revokedBy: "op",
        reason: "r",
      }).then(() => (revoked = true));
      await waitForLockWait();
      assert.equal(
        revoked,
        false,
        "revocation waits for the admission-side share lock",
      );
      await holder.query("COMMIT");
      await revoke;
    } finally {
      await holder.end();
    }
    // Admitted before revocation: the job stays; any retry is refused afterwards.
    const owner3 = await addCollector("race3");
    const ref3 = await permit(owner3);
    const s3 = await scenario(owner3);
    for (const role of ["source_mcap", "recorder_metadata", "source_manifest"])
      await complete(s3, role);
    const admitted = (
      await sealRecordingInventory(
        deps,
        { userId: owner3 },
        s3.recordingId,
        s3.seal,
      )
    ).admission;
    assert.equal(admitted.state, "admitted");
    await revokeIngestPermission(db.owner, {
      permissionRef: ref3,
      revokedBy: "op",
      reason: "r",
    });
    await fixtureRunJob(db.owner, (admitted as { jobId: string }).jobId);
    await db.owner.query(
      "UPDATE jobs SET state = 'failed', finished_at = now() WHERE recording_id = $1",
      [s3.recordingId],
    );
    await expectCode(
      createProcessingJob(db.app, {
        jobId: randomUUID(),
        recordingId: s3.recordingId,
        previousJobId: (admitted as { jobId: string }).jobId,
        profileRevision: "retry",
      }),
      "forbidden",
    );
    void s2;
    evidence.revocationRace = {
      revokeFirst: "admission blocked, no job",
      shareLockFirst: "revocation waited",
      retryAfterRevocation: "SAC05",
    };
  });
});

/** Waits until a session of this test database waits on a row/xact lock. */
async function waitForLockWait() {
  for (let i = 0; i < 200; i++) {
    const { rows } = await db.owner.query(
      `SELECT count(*)::int AS n FROM pg_locks l
       WHERE NOT l.granted AND l.locktype IN ('transactionid', 'tuple')
         AND l.pid IN (SELECT pid FROM pg_stat_activity WHERE datname = current_database())`,
    );
    if (rows[0].n > 0) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("no lock wait observed");
}

// -------------------------------------------------------------- failures
describe("database failures roll back to a recoverable state", () => {
  test("a fault during admission rolls back the completion; a retry admits once", async () => {
    await db.owner.query(
      "CREATE TABLE IF NOT EXISTS test_faults (target text PRIMARY KEY)",
    );
    await db.owner
      .query(`CREATE OR REPLACE FUNCTION test_fault() RETURNS trigger LANGUAGE plpgsql
      SET search_path = pg_catalog, public, pg_temp AS $$
      BEGIN
        IF EXISTS (SELECT 1 FROM public.test_faults WHERE target = TG_TABLE_NAME) THEN
          RAISE EXCEPTION USING ERRCODE = 'XX001', MESSAGE = 'injected fault';
        END IF;
        RETURN NEW;
      END $$`);
    await db.owner.query("GRANT SELECT ON test_faults TO stateaction_app");
    for (const table of ["jobs", "recording_admissions"])
      await db.owner.query(
        `CREATE TRIGGER zz_test_fault BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION test_fault()`,
      );
    try {
      for (const target of ["recording_admissions", "jobs"]) {
        const s = await scenario();
        for (const role of ["source_mcap", "recorder_metadata"])
          await complete(s, role);
        await sealRecordingInventory(
          deps,
          { userId: s.owner },
          s.recordingId,
          s.seal,
        );
        await db.owner.query("INSERT INTO test_faults VALUES ($1)", [target]);
        await assert.rejects(complete(s, "source_manifest"), /injected fault/);
        const file = await db.owner.query(
          "SELECT state FROM files WHERE id = $1",
          [s.files.find((f) => f.role === "source_manifest")!.fileId],
        );
        assert.equal(
          file.rows[0].state,
          "reserved",
          `${target}: completion rolled back with the failed admission`,
        );
        assert.equal(await admissionOf(s.recordingId), undefined);
        assert.equal((await jobsOf(s.recordingId)).length, 0);
        await db.owner.query("DELETE FROM test_faults");
        assert.equal(
          (await complete(s, "source_manifest")).admission.state,
          "admitted",
        );
        assert.equal((await jobsOf(s.recordingId)).length, 1);
      }
      // A fault during seal leaves the recording unsealed and retryable.
      const s = await scenario();
      for (const role of [
        "source_mcap",
        "recorder_metadata",
        "source_manifest",
      ])
        await complete(s, role);
      await db.owner.query("INSERT INTO test_faults VALUES ('jobs')");
      await assert.rejects(
        sealRecordingInventory(
          deps,
          { userId: s.owner },
          s.recordingId,
          s.seal,
        ),
        /injected fault/,
      );
      const rec = await db.owner.query(
        "SELECT status, source_manifest_file_id FROM recordings WHERE id = $1",
        [s.recordingId],
      );
      assert.deepEqual(rec.rows[0], {
        status: "uploading",
        source_manifest_file_id: null,
      });
      await db.owner.query("DELETE FROM test_faults");
      assert.equal(
        (
          await sealRecordingInventory(
            deps,
            { userId: s.owner },
            s.recordingId,
            s.seal,
          )
        ).admission.state,
        "admitted",
      );
    } finally {
      for (const table of ["jobs", "recording_admissions"])
        await db.owner.query(
          `DROP TRIGGER IF EXISTS zz_test_fault ON ${table}`,
        );
    }
    evidence.faults = {
      admissionFault: "completion rolled back",
      jobFault: "completion rolled back",
      sealFault: "unsealed",
      retries: "admitted once",
    };
  });

  test("the database refuses jobs without validated admission evidence, even for registered recordings", async () => {
    const s = await scenario();
    for (const role of ["source_mcap", "recorder_metadata", "source_manifest"])
      await complete(s, role);
    // Seal through the legacy helper path (no seal/admission rows).
    await legacySeal(db.app, {
      recordingId: s.recordingId,
      ownerUserId: s.owner,
      manifestFileId: s.files.at(-1)!.fileId,
    });
    await expectCode(
      createProcessingJob(db.app, {
        jobId: randomUUID(),
        recordingId: s.recordingId,
        profileRevision: "x",
      }),
      "conflict",
    );
    const row = await db.owner.query(
      "SELECT count(*)::int AS n FROM jobs WHERE recording_id = $1",
      [s.recordingId],
    );
    assert.equal(row.rows[0].n, 0);
    // A complete, sealed SA-13 helper recording without registration (which
    // SA-13 alone would admit) is refused: no auto-adoption, fail closed.
    const legacy = randomUUID();
    await legacyRegisterRecording(db.app, {
      recordingId: legacy,
      ownerUserId: actors.collector,
      clientRecordingId: randomUUID(),
      captureFormat: "stateaction.capture.v1",
      rgbProfile: "h264_mcap_v1",
      startedAt: "2026-11-01T12:00:00Z",
      device: { model: "m", osVersion: "1", appVersion: "a" },
    });
    let manifestId = "";
    for (const role of [
      "source_manifest",
      "source_mcap",
      "recorder_metadata",
    ] as const) {
      const fileId = randomUUID();
      if (role === "source_manifest") manifestId = fileId;
      await reserveSourceFile(db.app, {
        fileId,
        recordingId: legacy,
        ownerUserId: actors.collector,
        clientUploadId: randomUUID(),
        role,
        sizeBytes: "10",
        sha256: sha(fileId),
        required: true,
        partSizeBytes: "67108864",
        partCount: 1,
      });
      await recordFileCompleted(db.app, {
        fileId,
        expectedTransportEpoch: 1,
        observedSizeBytes: "10",
      });
    }
    await legacySeal(db.app, {
      recordingId: legacy,
      ownerUserId: actors.collector,
      manifestFileId: manifestId,
    });
    await expectCode(
      createProcessingJob(db.app, {
        jobId: randomUUID(),
        recordingId: legacy,
        profileRevision: "x",
      }),
      "forbidden",
    );
    await expectCode(
      db.owner.query(
        `INSERT INTO jobs (id, kind, recording_id, source_manifest_sha256, profile_revision)
         SELECT gen_random_uuid(), 'process_recording', id, source_manifest_sha256, 'x' FROM recordings WHERE id = $1`,
        [legacy],
      ),
      "SAC05",
    );
    evidence.failClosed = {
      registeredWithoutAdmission: "SAC04",
      legacyUnregistered: "SAC05 (app and owner)",
    };
  });
});

// -------------------------------------------------------------------- http
describe("HTTP route shapes (test-only adapter, injected auth)", () => {
  const tokens = new Map<string, string>();
  const authenticate: AuthenticateCollector = async (request) => {
    const header = request.headers.get("authorization") ?? "";
    const userId = tokens.get(header.replace(/^Bearer /, ""));
    if (!userId)
      return {
        ok: false,
        response: new Response(
          JSON.stringify({
            error: {
              code: "unauthenticated",
              message: "Sign in required",
              retryable: false,
            },
            requestId: randomUUID(),
          }),
          {
            status: 401,
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "private, no-store, max-age=0",
            },
          },
        ),
      };
    return { ok: true, principal: { userId } };
  };

  test("create/seal/get over real sockets with bounded bodies and safe errors", async () => {
    tokens.set("collector-token", actors.collector);
    tokens.set("second-token", second);
    const server = await startRecordingServer({
      ...deps,
      authenticateCollector: authenticate,
    });
    const call = (path: string, init: RequestInit & { token?: string } = {}) =>
      fetch(`${server.url}${path}`, {
        ...init,
        headers: {
          ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
          ...(init.body !== undefined
            ? { "content-type": "application/json" }
            : {}),
          ...(init.headers as Record<string, string>),
        },
      });
    const results: Record<string, number> = {};
    try {
      const client = randomUUID();
      const body = createBody(client);
      const created = await call("/api/v1/recordings", {
        method: "POST",
        token: "collector-token",
        body: JSON.stringify(body),
      });
      results.create = created.status;
      assert.equal(created.status, 201);
      assert.equal(
        created.headers.get("cache-control"),
        "private, no-store, max-age=0",
      );
      const envelope = (await created.json()) as {
        data: { recording: unknown; collectionPermissionRef: string };
        requestId: string;
      };
      assert.equal(
        validateValue("http.success-envelope.v1", envelope).valid,
        true,
      );
      assert.equal(
        validateValue("http.recording.v1", envelope.data.recording).valid,
        true,
      );
      assert.equal(
        validateValue("http.recording-registration.v1", envelope.data).valid,
        true,
      );
      assert.deepEqual(Object.keys(envelope.data).sort(), [
        "collectionPermissionRef",
        "recording",
      ]);
      assert.equal(
        envelope.data.collectionPermissionRef,
        permissionRef.get(actors.collector),
      );
      // Whitespace/key-order variant is the same canonical request.
      const pretty = JSON.stringify(
        {
          device: body.device,
          startedAt: body.startedAt,
          rgbProfile: body.rgbProfile,
          captureFormat: body.captureFormat,
          clientRecordingId: client,
        },
        null,
        2,
      );
      const replay = await call("/api/v1/recordings", {
        method: "POST",
        token: "collector-token",
        body: pretty,
      });
      results.replay = replay.status;
      assert.equal(replay.status, 200);
      const conflict = await call("/api/v1/recordings", {
        method: "POST",
        token: "collector-token",
        body: JSON.stringify({
          ...body,
          rgbProfile: "h264_mcap_v1",
          startedAt: "2026-11-01T12:00:01Z",
        }),
      });
      results.changed = conflict.status;
      assert.equal(conflict.status, 409);
      const errorBody = await conflict.json();
      assert.equal(
        validateValue("http.error-envelope.v1", errorBody).valid,
        true,
      );
      assert.equal(
        (errorBody as { error: { code: string } }).error.code,
        "idempotency_conflict",
      );

      results.unauthenticated = (
        await call("/api/v1/recordings", {
          method: "POST",
          body: JSON.stringify(createBody()),
        })
      ).status;
      assert.equal(results.unauthenticated, 401);
      const spoof = await call("/api/v1/recordings", {
        method: "POST",
        token: "collector-token",
        body: JSON.stringify({ ...createBody(), ownerUserId: second }),
      });
      results.ownerFieldRejected = spoof.status;
      assert.equal(spoof.status, 422);
      const wrongType = await call("/api/v1/recordings", {
        method: "POST",
        token: "collector-token",
        body: JSON.stringify(createBody()),
        headers: { "content-type": "text/plain" },
      });
      assert.equal(wrongType.status, 422);
      const bom = await call("/api/v1/recordings", {
        method: "POST",
        token: "collector-token",
        body: `﻿${JSON.stringify(createBody())}`,
      });
      assert.equal(bom.status, 422);
      const huge = await call("/api/v1/recordings", {
        method: "POST",
        token: "collector-token",
        body: JSON.stringify({ ...createBody(), pad: "x".repeat(1048576) }),
      });
      results.oversizeDeclared = huge.status;
      assert.equal(huge.status, 413);
      // Streamed (chunked, no Content-Length) oversize is cut off at the bound.
      const chunks = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < 40; i++)
            controller.enqueue(new Uint8Array(64 * 1024).fill(32));
          controller.close();
        },
      });
      const streamed = await fetch(`${server.url}/api/v1/recordings`, {
        method: "POST",
        headers: {
          authorization: "Bearer collector-token",
          "content-type": "application/json",
        },
        body: chunks,
        duplex: "half",
      } as RequestInit);
      results.oversizeStreamed = streamed.status;
      assert.equal(streamed.status, 413);

      // Seal + GET, other-owner 404.
      const s = await scenario();
      for (const role of [
        "source_mcap",
        "recorder_metadata",
        "source_manifest",
      ])
        await complete(s, role);
      const other = await call(`/api/v1/recordings/${s.recordingId}/seal`, {
        method: "POST",
        token: "second-token",
        body: JSON.stringify(s.seal),
      });
      results.otherOwnerSeal = other.status;
      assert.equal(other.status, 404);
      const sealed = await call(`/api/v1/recordings/${s.recordingId}/seal`, {
        method: "POST",
        token: "collector-token",
        body: JSON.stringify(s.seal),
      });
      results.seal = sealed.status;
      assert.equal(sealed.status, 200);
      const sealedBody = (await sealed.json()) as { data: { status: string } };
      assert.equal(
        validateValue("http.recording.v1", sealedBody.data).valid,
        true,
      );
      assert.equal(sealedBody.data.status, "uploaded");
      assert.equal((await jobsOf(s.recordingId)).length, 1);
      const incomplete = await call(
        `/api/v1/recordings/${s.recordingId}/seal`,
        {
          method: "POST",
          token: "collector-token",
          body: JSON.stringify({
            files: s.seal.files.filter((f) => f.role !== "source_mcap"),
          }),
        },
      );
      assert.equal(incomplete.status, 422);
      const got = await call(`/api/v1/recordings/${s.recordingId}`, {
        token: "collector-token",
      });
      assert.equal(got.status, 200);
      results.otherOwnerGet = (
        await call(`/api/v1/recordings/${s.recordingId}`, {
          token: "second-token",
        })
      ).status;
      assert.equal(results.otherOwnerGet, 404);
      results.badId = (
        await call("/api/v1/recordings/not-a-uuid", {
          token: "collector-token",
        })
      ).status;
      assert.equal(results.badId, 404);
      // Permission absent: 403 with a safe message.
      tokens.set("nopermission-token", noPermission);
      const denied = await call("/api/v1/recordings", {
        method: "POST",
        token: "nopermission-token",
        body: JSON.stringify(createBody()),
      });
      results.noPermission = denied.status;
      assert.equal(denied.status, 403);
      assert.doesNotMatch(
        await denied.text(),
        /postgres|SELECT|ingest_permissions/i,
      );
    } finally {
      await server.close();
    }
    evidence.http = results;
  });

  test("route construction refuses a missing authentication boundary", async () => {
    const { recordingRoutes } = await import("../src/admission/http.js");
    assert.throws(
      () => recordingRoutes({ ...deps } as never),
      /authenticateCollector/,
    );
  });
});

test("unmatched verified hardware stays sealed with a durable Needs setup decision", async () => {
  const s = await scenario(actors.collector, {
    mutate: (doc) => {
      (doc.channels as unknown[]).pop();
    },
  });
  for (const role of ["source_mcap", "recorder_metadata", "source_manifest"])
    await complete(s, role);
  const sealed = await sealRecordingInventory(
    deps,
    { userId: s.owner },
    s.recordingId,
    s.seal,
  );
  assert.equal(sealed.recording.status, "sealed");
  const held = {
    state: "held",
    reason: "needs_setup",
    code: "capture_source_unmatched",
  };
  assert.deepEqual(sealed.admission, held);
  assert.deepEqual(await admitRecording(deps, s.recordingId), held);
  assert.deepEqual(await jobsOf(s.recordingId), []);
  assert.equal(await admissionOf(s.recordingId), undefined);
  const { rows } = await db.app.query(
    `SELECT state, reason, code, capture_source_id, source_manifest_sha256
     FROM recording_capture_profiles WHERE recording_id = $1`,
    [s.recordingId],
  );
  assert.deepEqual(rows, [
    {
      ...held,
      capture_source_id: null,
      source_manifest_sha256: sha(s.manifest),
    },
  ]);
});

test("staff can resolve a recipe hold once for the exact source", async () => {
  const s = await scenario();
  for (const role of ["source_mcap", "recorder_metadata", "source_manifest"])
    await complete(s, role);
  const manual: AdmissionDeps = {
    ...deps,
    config: { ...deps.config, captureRecipeSelection: "manual" },
  };
  const sealed = await sealRecordingInventory(
    manual,
    { userId: s.owner },
    s.recordingId,
    s.seal,
  );
  assert.deepEqual(sealed.admission, {
    state: "held",
    reason: "choose_recipe",
    code: "manual_selection",
  });
  assert.deepEqual(await admitRecording(deps, s.recordingId), sealed.admission);
  const request = {
    recipeId: PUBLIC_VIDEO_RECIPE.recipeId,
    sourceManifestSha256: sha(s.manifest),
  };
  const staff = { userId: actors.staff };
  await expectCode(
    selectRecordingCaptureRecipe(
      deps,
      { userId: s.owner },
      s.recordingId,
      request,
    ),
    "forbidden",
  );
  await expectCode(
    selectRecordingCaptureRecipe(deps, staff, s.recordingId, {
      ...request,
      recipeId: "different@1",
    }),
    "conflict",
  );
  await expectCode(
    selectRecordingCaptureRecipe(deps, staff, s.recordingId, {
      ...request,
      sourceManifestSha256: sha("stale"),
    }),
    "conflict",
  );
  assert.deepEqual(await jobsOf(s.recordingId), []);
  const selections = await Promise.all(
    Array.from({ length: 4 }, () =>
      selectRecordingCaptureRecipe(deps, staff, s.recordingId, request),
    ),
  );
  assert.equal(selections[0]?.state, "admitted");
  assert.ok(
    selections.every(
      (selection) =>
        JSON.stringify(selection) === JSON.stringify(selections[0]),
    ),
  );
  assert.equal((await jobsOf(s.recordingId)).length, 1);
  const { rows } = await db.app.query(
    "SELECT selected_by, recipe_sha256 FROM recording_capture_profiles WHERE recording_id = $1",
    [s.recordingId],
  );
  assert.deepEqual(rows, [
    {
      selected_by: actors.staff,
      recipe_sha256: requestSha256(PUBLIC_VIDEO_RECIPE),
    },
  ]);
  await assert.rejects(
    db.app.query(
      "UPDATE recording_capture_profiles SET selected_by = NULL WHERE recording_id = $1",
      [s.recordingId],
    ),
    { code: "SAC04" },
  );
});

test("a public-video-only deployment retains the hardware recipe hold", async () => {
  const s = await scenario();
  for (const file of s.files) await complete(s, file.role);
  const scoped: AdmissionDeps = {
    ...deps,
    config: {
      ...deps.config,
      publicVideoCanary: {
        clientRecordingId: randomUUID(),
        ownerUserId: s.owner,
        sourceSha256: sha("other source"),
      },
    },
  };
  const sealed = await sealRecordingInventory(
    scoped,
    { userId: s.owner },
    s.recordingId,
    s.seal,
  );
  assert.deepEqual(sealed.admission, {
    state: "held",
    reason: "needs_setup",
    code: "recipe_unavailable",
  });
  assert.deepEqual(await jobsOf(s.recordingId), []);
  assert.equal((await admitRecording(deps, s.recordingId)).state, "admitted");
  assert.equal((await jobsOf(s.recordingId)).length, 1);
});
