import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { validateValue, type InventoryFile } from "@stateaction/contracts";
import { reserveSourceFile, sourceObjectKey } from "../src/catalog/catalog.js";
import {
  getRecording,
  recordSourceCompletion,
  registerRecording,
  sealRecordingInventory,
  type AdmissionDeps,
  type ObjectReader,
} from "../src/admission/recordings.js";
import { processRecordingTaskInputV2 } from "../src/admission/job-input.js";
import { recordIngestPermission } from "../src/admission/permissions.js";
import type { AuthenticateCollector } from "../src/admission/http.js";
import {
  createActors,
  freshDatabase,
  writeArtifact,
  type Actors,
  type TestDb,
} from "./harness.js";
import { startRecordingServer } from "./http-adapter.js";

// SA-71: explicitly labelled simulated capture over the real restricted-role
// database, the real v1/v2 route handlers and real sockets. Storage is the
// same in-memory reader the SA-19 admission suite uses (no provider calls).
const sha = (b: Uint8Array | string) =>
  createHash("sha256").update(b).digest("hex");
const SIM = "h264_mcap_simulation_v1";
const V2 = "application/vnd.stateaction.recording.v2+json";
const evidence: Record<string, unknown> = {};

const simulation = {
  schema: "stateaction.simulation_provenance.v1",
  qualification: "simulation_only",
  mappedTimelineSemantics: "simulation_transport_only",
  productionQualified: false,
  provenance: {
    camera: { status: "known", label: "android-emulator-virtualscene" },
    encoder: { status: "unknown" },
    clock: { status: "known", label: "host-receipt-transport-only" },
  },
};
const artifactSimulation = {
  schema: simulation.schema,
  qualification: simulation.qualification,
  mapped_timeline_semantics: simulation.mappedTimelineSemantics,
  production_qualified: false,
  provenance: simulation.provenance,
};

class MemoryReader implements ObjectReader {
  objects = new Map<string, Uint8Array>();
  async read(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes) throw new Error("NoSuchKey");
    return bytes;
  }
}

let db: TestDb;
let actors: Actors;
let reader: MemoryReader;
let enabled: AdmissionDeps;
let disabled: AdmissionDeps;
let permissionRef: string;

before(async () => {
  db = await freshDatabase();
  actors = await createActors(db.owner);
  reader = new MemoryReader();
  permissionRef = `pilot-${randomUUID().slice(0, 8)}`;
  await recordIngestPermission(db.owner, {
    permissionRef,
    ownerUserId: actors.collector,
    pilotScope: "sa71-integration",
    coversCapture: true,
    coversProcessing: true,
    evidenceRef: "doc://pilot/consent-and-processing",
    recordedBy: "operator@test",
  });
  const config = {
    processingProfileRevision: "sa71-test-1",
    supportedRgbProfiles: ["h264_mcap_v1"],
  };
  disabled = { pool: db.app, reader, config };
  enabled = {
    pool: db.app,
    reader,
    config: {
      ...config,
      supportedRgbProfiles: ["h264_mcap_v1", SIM],
      simulatedCaptureInputs: true,
    },
  };
});
after(async () => {
  await writeArtifact("simulated-capture-evidence.json", evidence);
  await db.close();
});

const v2Body = (
  rgbProfile: string,
  clientRecordingId = randomUUID(),
  extra: Record<string, unknown> = {},
) => ({
  schema: "stateaction.recording_create.v2",
  clientRecordingId,
  captureFormat: "stateaction.capture.v1",
  rgbProfile,
  ...(rgbProfile === SIM ? { simulation } : {}),
  startedAt: "2026-11-02T08:00:00.000000Z",
  device: {
    model: "sdk_gphone64_x86_64",
    osVersion: "15",
    appVersion: "0.1.0+1",
  },
  ...extra,
});

type Prepared = {
  recordingId: string;
  clientRecordingId: string;
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
/** Registers (v2), reserves the logical source files and builds a v2 manifest. */
async function prepare(
  rgbProfile: string,
  options: {
    deps?: AdmissionDeps;
    mutate?: (doc: Record<string, unknown>) => void;
  } = {},
): Promise<Prepared> {
  const clientRecordingId = randomUUID();
  const { recording } = await registerRecording(
    options.deps ?? enabled,
    { userId: actors.collector },
    v2Body(rgbProfile, clientRecordingId),
  );
  const recordingId = recording.recordingId;
  const files: Prepared["files"] = [];
  for (const role of ["source_mcap", "recorder_metadata"] as const) {
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
    owner_user_id: actors.collector,
    capture_format: "stateaction.capture.v1",
    rgb_profile: rgbProfile,
    ...(rgbProfile === SIM ? { simulation: artifactSimulation } : {}),
    capture_config_sha256: sha("capture-config"),
    close_status: "closed_clean",
    files: files.map((f) => ({
      file_id: f.fileId,
      role: f.role,
      required: true,
      size_bytes: f.sizeBytes,
      sha256: f.sha256,
    })),
    clock_domains: ["android.elapsed_realtime"],
    channels: [
      {
        topic: "/camera/rgb",
        message_encoding: "protobuf",
        schema_name: "foxglove.CompressedVideo",
        clock_domain: "android.elapsed_realtime",
        message_count: "30",
      },
      {
        topic: "/pose",
        message_encoding: "cdr",
        schema_name: "geometry_msgs/msg/PoseStamped",
        clock_domain: "android.elapsed_realtime",
        message_count: "30",
      },
    ],
    counts: {
      video_frames: "30",
      dropped_video_frames: "0",
      motion_events: "30",
    },
    collection_permission_ref: permissionRef,
    source_verification: "pending",
  };
  options.mutate?.(doc);
  const manifest = Buffer.from(JSON.stringify(doc));
  const manifestId = randomUUID();
  files.push({
    fileId: manifestId,
    role: "source_manifest",
    sizeBytes: String(manifest.byteLength),
    sha256: sha(manifest),
    key: sourceObjectKey(recordingId, manifestId, 1, "source_manifest"),
  });
  for (const f of files)
    await reserveSourceFile(db.app, {
      fileId: f.fileId,
      recordingId,
      ownerUserId: actors.collector,
      clientUploadId: randomUUID(),
      role: f.role,
      sizeBytes: f.sizeBytes,
      sha256: f.sha256,
      required: true,
      partSizeBytes: "67108864",
      partCount: 1,
    });
  reader.objects.set(files.at(-1)!.key, manifest);
  return {
    recordingId,
    clientRecordingId,
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
const completeAll = async (deps: AdmissionDeps, p: Prepared) => {
  for (const f of p.files)
    await recordSourceCompletion(
      deps,
      { userId: actors.collector },
      {
        recordingId: p.recordingId,
        fileId: f.fileId,
        expectedTransportEpoch: 1,
        observedSizeBytes: f.sizeBytes,
      },
    );
};
const jobsOf = async (recordingId: string) =>
  (
    await db.owner.query("SELECT id FROM jobs WHERE recording_id = $1", [
      recordingId,
    ])
  ).rows;

describe("registration", () => {
  test("default configuration rejects simulated input and writes nothing", async () => {
    const client = randomUUID();
    await assert.rejects(
      registerRecording(
        disabled,
        { userId: actors.collector },
        v2Body(SIM, client),
      ),
      (e: { code?: string }) => e.code === "forbidden",
    );
    const rows = await db.owner.query(
      "SELECT 1 FROM recordings WHERE client_recording_id = $1",
      [client],
    );
    assert.equal(rows.rowCount, 0);
    evidence.defaultReject = "forbidden, no row";
  });

  test("enabled development config accepts it and returns the v2 view with the explicit marker", async () => {
    const client = randomUUID();
    const first = await registerRecording(
      enabled,
      { userId: actors.collector },
      v2Body(SIM, client),
    );
    assert.equal(first.created, true);
    const view = await getRecording(
      db.app,
      { userId: actors.collector },
      first.recording.recordingId,
    );
    assert.deepEqual({ ...view, files: [] }, { ...first.recording, files: [] });
    assert.ok("simulation" in view);
    assert.equal(
      validateValue("http.recording.v2", { ...view, rgbProfile: SIM }).valid,
      true,
    );
    const replay = await registerRecording(
      enabled,
      { userId: actors.collector },
      v2Body(SIM, client),
    );
    assert.equal(replay.created, false);
    assert.deepEqual(replay.recording, first.recording);
    // The same clientRecordingId with a different marker is a conflict.
    await assert.rejects(
      registerRecording(
        enabled,
        { userId: actors.collector },
        v2Body(SIM, client, {
          simulation: {
            ...simulation,
            provenance: {
              ...simulation.provenance,
              clock: { status: "unknown" },
            },
          },
        }),
      ),
      (e: { code?: string }) => e.code === "idempotency_conflict",
    );
    evidence.enabledCreate = "created + replay + conflict";
  });

  test("hardware path keeps the frozen v1 body and view; a v2 hardware body adds only the profile", async () => {
    const client = randomUUID();
    const v1 = await registerRecording(
      disabled,
      { userId: actors.collector },
      {
        clientRecordingId: client,
        captureFormat: "stateaction.capture.v1",
        rgbProfile: "h264_mcap_v1",
        startedAt: "2026-11-02T08:00:00Z",
        device: { model: "Pixel 9", osVersion: "16", appVersion: "0.1.0" },
      },
    );
    assert.equal(validateValue("http.recording.v1", v1.recording).valid, true);
    const v2 = await registerRecording(
      disabled,
      { userId: actors.collector },
      v2Body("h264_mcap_v1"),
    );
    assert.equal(validateValue("http.recording.v1", v2.recording).valid, true);
  });

  test("the database refuses a relabelled row: simulation needs its marker, hardware never has one", async () => {
    const owner = actors.collector;
    const insert = (rgb: string, marker: unknown) =>
      db.owner.query(
        `INSERT INTO recordings (id, owner_user_id, client_recording_id, capture_format, rgb_profile, started_at, device, simulation)
         VALUES ($1, $2, $3, 'stateaction.capture.v1', $4, now(), '{}', $5)`,
        [
          randomUUID(),
          owner,
          randomUUID(),
          rgb,
          marker === null ? null : JSON.stringify(marker),
        ],
      );
    await assert.rejects(insert(SIM, null), /recordings_rgb_profile_check/);
    await assert.rejects(
      insert("h264_mcap_v1", simulation),
      /recordings_rgb_profile_check/,
    );
    await assert.rejects(
      insert("h264_mcap_other", null),
      /recordings_rgb_profile_check/,
    );
    await insert(SIM, simulation);
    const { rows } = await db.owner.query<{ id: string }>(
      "SELECT id FROM recordings WHERE rgb_profile = $1 LIMIT 1",
      [SIM],
    );
    await assert.rejects(
      db.owner.query("UPDATE recordings SET simulation = $2 WHERE id = $1", [
        rows[0]!.id,
        JSON.stringify({ ...simulation, productionQualified: false, extra: 1 }),
      ]),
      /immutable/,
    );
    // The restricted application role cannot rewrite the marker either.
    await assert.rejects(
      db.app.query("UPDATE recordings SET simulation = NULL WHERE id = $1", [
        rows[0]!.id,
      ]),
      /permission denied/,
    );
  });
});

describe("admission", () => {
  test("simulated manifest admits through the real path; marker survives into job input", async () => {
    const p = await prepare(SIM);
    await completeAll(enabled, p);
    const sealed = await sealRecordingInventory(
      enabled,
      { userId: actors.collector },
      p.recordingId,
      p.seal,
    );
    assert.equal(sealed.admission.state, "admitted");
    assert.equal(sealed.recording.status, "uploaded");
    const jobs = await jobsOf(p.recordingId);
    assert.equal(jobs.length, 1);
    const adm = (
      await db.owner.query(
        "SELECT rgb_profile, simulation FROM recording_admissions WHERE recording_id = $1",
        [p.recordingId],
      )
    ).rows[0];
    assert.equal(adm.rgb_profile, SIM);
    assert.deepEqual(adm.simulation, simulation);
    const input = await processRecordingTaskInputV2(
      db.app,
      jobs[0].id as string,
    );
    assert.equal(validateValue("jobs.task-input.v2", input).valid, true);
    assert.deepEqual(input, {
      schemaVersion: 2,
      jobId: jobs[0].id,
      targetId: p.recordingId,
      profileRevision: "sa71-test-1",
      kind: "process_recording",
      sourceManifestSha256: sha(p.manifest),
      rgbProfile: SIM,
      simulation,
    });
    // Unknown provenance stays explicit; nothing was upgraded to hardware.
    assert.deepEqual(
      (input as { simulation: typeof simulation }).simulation.provenance
        .encoder,
      { status: "unknown" },
    );
    evidence.simulatedAdmission = { jobs: 1, rgbProfile: SIM };
  });

  test("hardware v2 manifest (with a ROS slash schema name) admits without any marker", async () => {
    const p = await prepare("h264_mcap_v1");
    await completeAll(enabled, p);
    const sealed = await sealRecordingInventory(
      disabled,
      { userId: actors.collector },
      p.recordingId,
      p.seal,
    );
    assert.equal(sealed.admission.state, "admitted");
    const job = (await jobsOf(p.recordingId))[0]!;
    const input = await processRecordingTaskInputV2(db.app, job.id as string);
    assert.equal(validateValue("jobs.task-input.v2", input).valid, true);
    assert.equal((input as { rgbProfile: string }).rgbProfile, "h264_mcap_v1");
    assert.equal("simulation" in input, false);
  });

  test("a server that does not enable simulation defers a simulated recording and creates no job", async () => {
    const p = await prepare(SIM);
    await completeAll(enabled, p);
    const sealed = await sealRecordingInventory(
      disabled,
      { userId: actors.collector },
      p.recordingId,
      p.seal,
    );
    assert.deepEqual(sealed.admission, {
      state: "deferred",
      code: "profile_unsupported",
    });
    assert.equal((await jobsOf(p.recordingId)).length, 0);
    // The write path is durable-safe: enabling later admits the same recording.
    const later = await sealRecordingInventory(
      enabled,
      { userId: actors.collector },
      p.recordingId,
      p.seal,
    );
    assert.equal(later.admission.state, "admitted");
  });

  test("a manifest that relabels simulation as hardware (or the reverse) is rejected durably", async () => {
    const hardwareLabelled = await prepare(SIM, {
      mutate: (doc) => {
        doc.rgb_profile = "h264_mcap_v1";
        delete doc.simulation;
      },
    });
    await completeAll(enabled, hardwareLabelled);
    const a = await sealRecordingInventory(
      enabled,
      { userId: actors.collector },
      hardwareLabelled.recordingId,
      hardwareLabelled.seal,
    );
    assert.deepEqual(a.admission, {
      state: "rejected",
      code: "profile_mismatch",
    });
    const simLabelled = await prepare("h264_mcap_v1", {
      mutate: (doc) => {
        doc.rgb_profile = SIM;
        doc.simulation = artifactSimulation;
      },
    });
    await completeAll(enabled, simLabelled);
    const b = await sealRecordingInventory(
      enabled,
      { userId: actors.collector },
      simLabelled.recordingId,
      simLabelled.seal,
    );
    assert.deepEqual(b.admission, {
      state: "rejected",
      code: "profile_mismatch",
    });
    assert.equal((await jobsOf(simLabelled.recordingId)).length, 0);
  });

  test("an invalid marker is a schema rejection", async () => {
    const p = await prepare(SIM, {
      mutate: (doc) => {
        (
          doc.simulation as { production_qualified: boolean }
        ).production_qualified = true;
      },
    });
    await completeAll(enabled, p);
    const out = await sealRecordingInventory(
      enabled,
      { userId: actors.collector },
      p.recordingId,
      p.seal,
    );
    assert.deepEqual(out.admission, {
      state: "rejected",
      code: "manifest_schema_violation",
    });
  });
});

describe("routes over real sockets", () => {
  const tokens = new Map<string, string>([["t", "collector"]]);
  const authenticate: AuthenticateCollector = async (request) => {
    const token =
      request.headers.get("authorization")?.replace("Bearer ", "") ?? "";
    return tokens.has(token)
      ? { ok: true, principal: { userId: actors.collector } }
      : { ok: false, response: new Response(null, { status: 401 }) };
  };

  test("v2 create/seal/get representations never conceal a simulation", async () => {
    const server = await startRecordingServer({
      ...enabled,
      authenticateCollector: authenticate,
    });
    const call = (path: string, init: RequestInit = {}) =>
      fetch(`${server.url}${path}`, {
        ...init,
        headers: {
          authorization: "Bearer t",
          ...(init.body !== undefined
            ? { "content-type": "application/json" }
            : {}),
          ...(init.headers as Record<string, string>),
        },
      });
    try {
      const created = await call("/api/v1/recordings", {
        method: "POST",
        body: JSON.stringify(v2Body(SIM)),
      });
      assert.equal(created.status, 201);
      assert.equal(created.headers.get("content-type"), V2);
      const envelope = (await created.json()) as {
        data: {
          recording: {
            recordingId: string;
            rgbProfile: string;
            simulation: unknown;
          };
        };
      };
      assert.equal(
        validateValue("http.recording-registration.v2", envelope.data).valid,
        true,
      );
      assert.equal(envelope.data.recording.rgbProfile, SIM);
      assert.deepEqual(envelope.data.recording.simulation, simulation);
      const id = envelope.data.recording.recordingId;
      // No downgrade: a plain GET of a simulated recording is refused.
      const plain = await call(`/api/v1/recordings/${id}`);
      assert.equal(plain.status, 406);
      assert.equal(
        ((await plain.json()) as { error: { code: string } }).error.code,
        "not_acceptable",
      );
      const v2 = await call(`/api/v1/recordings/${id}`, {
        headers: { accept: V2 },
      });
      assert.equal(v2.status, 200);
      assert.equal(v2.headers.get("content-type"), V2);
      assert.equal(
        validateValue(
          "http.recording.v2",
          ((await v2.json()) as { data: unknown }).data,
        ).valid,
        true,
      );
      // A v1 body is hardware-only: the v1 contract rejects the simulation profile.
      const { schema: _s, ...v1Sim } = v2Body(SIM);
      const refused = await call("/api/v1/recordings", {
        method: "POST",
        body: JSON.stringify(v1Sim),
      });
      assert.equal(refused.status, 422);
      // Hardware v1 stays as published: v1 body, plain GET, JSON content type.
      const hw = await call("/api/v1/recordings", {
        method: "POST",
        body: JSON.stringify({
          clientRecordingId: randomUUID(),
          captureFormat: "stateaction.capture.v1",
          rgbProfile: "h264_mcap_v1",
          startedAt: "2026-11-02T08:00:00Z",
          device: { model: "Pixel 9", osVersion: "16", appVersion: "0.1.0" },
        }),
      });
      assert.equal(hw.status, 201);
      assert.match(hw.headers.get("content-type") ?? "", /^application\/json/);
      const hwBody = (await hw.json()) as {
        data: { recording: { recordingId: string } };
      };
      assert.equal(
        validateValue("http.recording-registration.v1", hwBody.data).valid,
        true,
      );
      const hwGet = await call(
        `/api/v1/recordings/${hwBody.data.recording.recordingId}`,
      );
      assert.equal(hwGet.status, 200);
      assert.equal(
        validateValue(
          "http.recording.v1",
          ((await hwGet.json()) as { data: unknown }).data,
        ).valid,
        true,
      );
      evidence.routes = {
        createSim: 201,
        plainGetSim: 406,
        v2GetSim: 200,
        v1Sim: 422,
        hardwareV1: 201,
      };
    } finally {
      await server.close();
    }
  });

  test("a default server rejects simulated create over HTTP", async () => {
    const server = await startRecordingServer({
      ...disabled,
      authenticateCollector: authenticate,
    });
    try {
      const res = await fetch(`${server.url}/api/v1/recordings`, {
        method: "POST",
        headers: {
          authorization: "Bearer t",
          "content-type": "application/json",
        },
        body: JSON.stringify(v2Body(SIM)),
      });
      assert.equal(res.status, 403);
    } finally {
      await server.close();
    }
  });
});
