import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import {
  ObjectReadUnavailableError,
  s3ObjectReader,
} from "../src/admission/object-reader.js";
import {
  ObjectTooLargeError,
  getRecording,
  recordSourceCompletion,
  registerRecording,
  sealRecordingInventory,
  admitRecording,
  type AdmissionDeps,
} from "../src/admission/recordings.js";
import { recordIngestPermission } from "../src/admission/permissions.js";
import { SOURCE_MANIFEST_MAX_BYTES } from "../src/admission/inventory.js";
import {
  createActors,
  freshDatabase,
  writeArtifact,
  type Actors,
  type TestDb,
} from "./harness.js";
import { createBody, reserveSourceScenario } from "./source-scenario.js";
import {
  faultProxy,
  freshBucket,
  storageConfig,
  type TestBucket,
} from "./storage-harness.js";

const MiB = SOURCE_MANIFEST_MAX_BYTES;
const evidence: Record<string, unknown> = {};
let bucket: TestBucket;
let proxy: Awaited<ReturnType<typeof faultProxy>>;

before(async () => {
  bucket = await freshBucket();
  proxy = await faultProxy(bucket.config.endpoint);
});
after(async () => {
  await proxy.close();
  await bucket.remove();
  await writeArtifact("object-reader-evidence.json", evidence);
});

const direct = () => s3ObjectReader(bucket.config, { timeoutMs: 5000 });
const viaProxy = (timeoutMs = 5000) =>
  s3ObjectReader(storageConfig(bucket.config.bucket, proxy.endpoint), {
    timeoutMs,
  });

describe("bounded S3 source-manifest reader (real SeaweedFS)", () => {
  test("reads exact bytes up to and including the limit", async () => {
    const small = randomBytes(1234);
    const exact = randomBytes(MiB);
    await bucket.put("k/small", small);
    await bucket.put("k/exact", exact);
    await bucket.put("k/empty", new Uint8Array(0));
    assert.deepEqual(Buffer.from(await direct().read("k/small", MiB)), small);
    assert.deepEqual(Buffer.from(await direct().read("k/exact", MiB)), exact);
    assert.equal((await direct().read("k/empty", MiB)).byteLength, 0);
  });

  test("known length above the limit is refused without transferring the object", async () => {
    await bucket.put("k/over", randomBytes(MiB + 1));
    await bucket.put("k/huge", randomBytes(8 * MiB));
    proxy.set("pass");
    await assert.rejects(viaProxy().read("k/over", MiB), ObjectTooLargeError);
    await assert.rejects(viaProxy().read("k/huge", MiB), ObjectTooLargeError);
    // The Range request bounds the transfer to maxBytes + 1 even for 8 MiB.
    assert.ok(
      proxy.state.forwardedBytes <= MiB + 1,
      `${proxy.state.forwardedBytes}`,
    );
    evidence.knownLengthHugeForwardedBytes = proxy.state.forwardedBytes;
  });

  test("unknown-length stream above the limit is cancelled once it would exceed", async () => {
    proxy.set("unknown-length");
    await assert.rejects(viaProxy().read("k/huge", MiB), ObjectTooLargeError);
    // Let the proxy observe the client-side close.
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(proxy.state.upstreamEnded, false, "stream was not drained");
    assert.equal(proxy.state.clientCancelled, true);
    assert.ok(proxy.state.forwardedBytes < 8 * MiB);
    evidence.unknownLengthHugeForwardedBytes = proxy.state.forwardedBytes;
    // Unknown length within the limit still reads exact bytes.
    const small = randomBytes(4096);
    await bucket.put("k/small-unknown", small);
    assert.deepEqual(
      Buffer.from(await viaProxy().read("k/small-unknown", MiB)),
      small,
    );
    proxy.set("pass");
  });

  test("temporary failures and missing objects propagate as retryable unavailability", async () => {
    const cases: Record<string, unknown> = {};
    proxy.set("status-503");
    const e503 = await viaProxy()
      .read("k/small", MiB)
      .catch((e) => e);
    assert.ok(e503 instanceof ObjectReadUnavailableError);
    assert.equal(e503.status, 503);
    cases.status503 = e503.code;

    proxy.set("stall-body");
    const started = Date.now();
    const stall = await viaProxy(800)
      .read("k/exact", MiB)
      .catch((e) => e);
    assert.ok(stall instanceof ObjectReadUnavailableError, String(stall));
    assert.ok(Date.now() - started < 5000);
    cases.stalledBody = stall.code;

    proxy.set("reset-mid-body");
    const reset = await viaProxy()
      .read("k/exact", MiB)
      .catch((e) => e);
    assert.ok(reset instanceof ObjectReadUnavailableError, String(reset));
    cases.resetMidBody = reset.code;

    proxy.set("pass");
    const missing = await direct()
      .read("k/absent", MiB)
      .catch((e) => e);
    assert.ok(missing instanceof ObjectReadUnavailableError);
    assert.equal(missing.status, 404);
    cases.missing = missing.code;

    const unreachable = await s3ObjectReader(
      storageConfig(bucket.config.bucket, "http://127.0.0.1:9"),
      { timeoutMs: 2000 },
    )
      .read("k/small", MiB)
      .catch((e) => e);
    assert.ok(unreachable instanceof ObjectReadUnavailableError);
    cases.unreachable = unreachable.code;
    evidence.temporaryFailures = cases;
  });
});

describe("admission through the real storage reader", () => {
  let db: TestDb;
  let actors: Actors;
  let deps: AdmissionDeps;
  let permissionRef: string;
  before(async () => {
    db = await freshDatabase();
    actors = await createActors(db.owner);
    permissionRef = `pilot-${randomUUID().slice(0, 8)}`;
    await recordIngestPermission(db.owner, {
      permissionRef,
      ownerUserId: actors.collector,
      pilotScope: "sa19-storage-integration",
      coversCapture: true,
      coversProcessing: true,
      evidenceRef: "doc://pilot/consent-and-processing",
      recordedBy: "operator@test",
    });
    deps = {
      pool: db.app,
      reader: viaProxy(),
      config: {
        processingProfileRevision: "sa19-storage-1",
        supportedRgbProfiles: ["h264_mcap_v1"],
      },
    };
  });
  after(async () => db.close());

  async function prepared() {
    const owner = { userId: actors.collector };
    const clientRecordingId = randomUUID();
    const { recording } = await registerRecording(
      deps,
      owner,
      createBody(clientRecordingId),
    );
    const s = await reserveSourceScenario(db.app, {
      recordingId: recording.recordingId,
      clientRecordingId,
      owner: actors.collector,
      permissionRef,
    });
    const complete = (role: string) => {
      const f = s.files.find((x) => x.role === role)!;
      return recordSourceCompletion(deps, owner, {
        recordingId: recording.recordingId,
        fileId: f.fileId,
        expectedTransportEpoch: 1,
        observedSizeBytes: f.sizeBytes,
      });
    };
    return { owner, recordingId: recording.recordingId, s, complete };
  }
  const jobs = async (id: string) =>
    (
      await db.owner.query(
        "SELECT state, source_manifest_sha256 FROM jobs WHERE recording_id = $1",
        [id],
      )
    ).rows;

  test("stored manifest bytes admit exactly one job; transient storage failure stays pending then recovers", async () => {
    const { owner, recordingId, s, complete } = await prepared();
    await bucket.put(s.manifestKey, s.manifest);
    await sealRecordingInventory(deps, owner, recordingId, s.seal);
    await complete("source_mcap");
    await complete("recorder_metadata");
    // withAdmission re-reads once after a failed pre-read; fault both reads.
    proxy.set("status-503", 2);
    const first = await complete("source_manifest");
    assert.equal(first.admission.state, "awaiting_manifest_bytes");
    assert.equal((await jobs(recordingId)).length, 0);
    proxy.set("reset-mid-body", 2);
    assert.equal(
      (await admitRecording(deps, recordingId)).state,
      "awaiting_manifest_bytes",
    );
    assert.equal(proxy.state.times, 0);
    proxy.set("pass");
    const recovered = await admitRecording(deps, recordingId);
    assert.equal(recovered.state, "admitted");
    const replay = await complete("source_manifest");
    assert.equal(replay.replayed, true);
    assert.equal(replay.admission.state, "admitted");
    const rows = await jobs(recordingId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].state, "queued");
    assert.equal(rows[0].source_manifest_sha256, s.files.at(-1)!.sha256);
    assert.equal(
      (await getRecording(db.app, owner, recordingId)).status,
      "uploaded",
    );
    evidence.admittedThroughStorage = { recordingId, jobs: rows.length };
  });

  test("oversized or substituted stored manifest never admits and stays retryable", async () => {
    const { owner, recordingId, s, complete } = await prepared();
    await bucket.put(s.manifestKey, randomBytes(MiB + 1));
    await sealRecordingInventory(deps, owner, recordingId, s.seal);
    await complete("source_mcap");
    await complete("recorder_metadata");
    const over = await complete("source_manifest");
    assert.deepEqual(over.admission, {
      state: "manifest_unverified",
      code: "manifest_too_large",
    });
    proxy.set("unknown-length");
    assert.deepEqual(await admitRecording(deps, recordingId), {
      state: "manifest_unverified",
      code: "manifest_too_large",
    });
    proxy.set("pass");
    const tampered = Buffer.from(s.manifest);
    tampered[tampered.length - 2] ^= 1;
    await bucket.put(s.manifestKey, tampered);
    assert.equal(
      (await admitRecording(deps, recordingId)).state,
      "manifest_unverified",
    );
    assert.equal((await jobs(recordingId)).length, 0);
    await bucket.put(s.manifestKey, s.manifest);
    assert.equal((await admitRecording(deps, recordingId)).state, "admitted");
    assert.equal((await jobs(recordingId)).length, 1);
  });
});
