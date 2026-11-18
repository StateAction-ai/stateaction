import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import {
  AbortMultipartUploadCommand,
  CreateMultipartUploadCommand,
} from "@aws-sdk/client-s3";
import type pg from "pg";
import {
  ObjectReadUnavailableError,
  type AdmissionDeps,
} from "../src/admission/index.js";
import {
  allocateJobOutput,
  allocateSourceUpload,
  cancelTransport,
  completeTransport,
  journalReceipts,
  reconcileTransport,
  restartTransport,
  signParts,
  TransportError,
  type Authority,
  type TransportDeps,
  type UploadPlan,
} from "../src/transport/index.js";
import {
  BUCKET,
  completeAndRead,
  depsFor,
  FaultProvider,
  newRecording,
  openSession,
  putPart,
  realProvider,
  realS3,
  ScriptedProvider,
  transportDatabase,
  uploadsAt,
} from "./transport-harness.js";
import {
  processedRecording,
  writeArtifact,
  type Actors,
  type TestDb,
} from "./harness.js";

let db: TestDb & { actors: Actors };
let faults: FaultProvider;
let deps: TransportDeps;
let owner: Extract<Authority, { kind: "owner" }>;
let breakDb: () => void;
/** Real SA-19 admission over the real database; no manifest is ever read here. */
const admission = (pool: pg.Pool): AdmissionDeps => ({
  pool,
  reader: {
    read: async () => {
      throw new ObjectReadUnavailableError("not used by these tests");
    },
  },
  config: {
    processingProfileRevision: "sa21-recovery-1",
    supportedRgbProfiles: ["h264_mcap_v1"],
  },
});
const evidence: Record<string, unknown> = {};

/** Pool whose next transaction fails to open once armed (DB write lost). */
function flaky(pool: pg.Pool) {
  let armed = false;
  const proxy = new Proxy(pool, {
    get(target, prop) {
      if (prop === "connect")
        return (...args: unknown[]) => {
          if (armed) {
            armed = false;
            return Promise.reject(new Error("injected database failure"));
          }
          return (target.connect as (...a: unknown[]) => unknown)(...args);
        };
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    pool: proxy as pg.Pool,
    arm: () => {
      armed = true;
    },
  };
}

before(async () => {
  db = await transportDatabase();
  faults = new FaultProvider(await realProvider());
  const f = flaky(db.app);
  breakDb = f.arm;
  deps = {
    pool: f.pool,
    provider: faults,
    admission: () => admission(f.pool),
  };
  owner = {
    kind: "owner",
    userId: db.actors.collector,
    sessionId: await openSession(db, db.actors.collector),
  };
});
after(async () => {
  await writeArtifact("transport-recovery-evidence.json", evidence);
  await db.close();
});

const code = async (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: unknown) =>
      error instanceof TransportError
        ? error.code
        : `unexpected:${String(error)}`,
  );
const request = async (size: number | bigint = 100) => ({
  recordingId: await newRecording(db, owner.userId),
  clientUploadId: randomUUID(),
  role: "source_mcap" as const,
  sizeBytes: String(size),
  // The declared hash is deliberately NOT derived from the bytes or ETags.
  sha256: createHash("sha256").update(randomUUID()).digest("hex"),
});
const row = async (fileId: string) =>
  (
    await db.owner.query<{
      state: string;
      transport_epoch: number;
      object_key: string;
      provider_upload_id: string | null;
      observed_size_bytes: string | null;
      sha256: string;
    }>(
      `SELECT state, transport_epoch, object_key, provider_upload_id,
              observed_size_bytes::text, sha256 FROM files WHERE id = $1`,
      [fileId],
    )
  ).rows[0]!;
const epochOf = (plan: UploadPlan) => ({
  expectedTransportEpoch: plan.transportEpoch,
});

async function putAndJournal(
  d: TransportDeps,
  plan: UploadPlan,
  partNumber: number,
  body: Buffer,
  journal = true,
) {
  const [part] = (
    await signParts(d, owner, plan.fileId, {
      expectedTransportEpoch: plan.transportEpoch,
      partNumbers: [partNumber],
    })
  ).parts;
  const put = await putPart(part!, body);
  assert.equal(put.status, 200);
  if (journal)
    await journalReceipts(d, owner, plan.fileId, {
      expectedTransportEpoch: plan.transportEpoch,
      receipts: [
        { partNumber, etag: put.etag!, sizeBytes: String(body.length) },
      ],
    });
  return put.etag!;
}

test("complete: provider verifies parts, object size is checked, ETag never becomes the SHA", async () => {
  const body = Buffer.from("a complete tiny object");
  const plan = await allocateSourceUpload(
    deps,
    owner,
    await request(body.length),
  );
  await putAndJournal(deps, plan, 1, body);
  const done = await completeTransport(deps, owner, plan.fileId, epochOf(plan));
  assert.equal(done.state, "completed");
  const r = await row(plan.fileId);
  assert.equal(r.observed_size_bytes, String(body.length));
  assert.equal(r.sha256, plan.sha256, "declared SHA-256 untouched");
  // Idempotent replay; the closed file never reopens.
  const again = await completeTransport(
    deps,
    owner,
    plan.fileId,
    epochOf(plan),
  );
  assert.equal(again.state, "completed");
  assert.equal(
    await code(restartTransport(deps, owner, plan.fileId, epochOf(plan))),
    "conflict",
  );
  assert.equal(
    await code(cancelTransport(deps, owner, plan.fileId, epochOf(plan))),
    "conflict",
  );
  assert.equal(
    await code(
      signParts(deps, owner, plan.fileId, {
        ...epochOf(plan),
        partNumbers: [1],
      }),
    ),
    "conflict",
  );
  assert.equal(
    faults.calls.filter((c) => c === "completeUpload").length >= 1,
    true,
  );
  evidence.completeHappyPath = {
    state: done.state,
    observed: r.observed_size_bytes,
  };
});

test("a multi-part object completes in order across real parts", async () => {
  const size = 64 * 1024 * 1024 + 10;
  const plan = await allocateSourceUpload(deps, owner, await request(size));
  assert.equal(plan.partCount, 2);
  const big = Buffer.alloc(64 * 1024 * 1024, 7);
  await putAndJournal(deps, plan, 2, Buffer.alloc(10, 1));
  // Incomplete part set is refused with the missing part named.
  await assert.rejects(
    completeTransport(deps, owner, plan.fileId, epochOf(plan)),
    /missing \[1\]/,
  );
  assert.equal((await row(plan.fileId)).state, "uploading");
  await putAndJournal(deps, plan, 1, big);
  const done = await completeTransport(deps, owner, plan.fileId, epochOf(plan));
  assert.equal(done.state, "completed");
  assert.equal((await row(plan.fileId)).observed_size_bytes, String(size));
});

test("lost complete reply: reconcile proves success by HEAD and never completes twice", async () => {
  const body = Buffer.from("lost reply");
  const plan = await allocateSourceUpload(
    deps,
    owner,
    await request(body.length),
  );
  await putAndJournal(deps, plan, 1, body);
  const before = faults.calls.filter((c) => c === "completeUpload").length;
  faults.loseCompleteResponse = true;
  // The reply is lost, but the object exists, so HEAD settles it at once.
  const settled = await completeTransport(
    deps,
    owner,
    plan.fileId,
    epochOf(plan),
  );
  assert.equal(settled.state, "completed");
  assert.equal(
    faults.calls.filter((c) => c === "completeUpload").length - before,
    1,
  );
  evidence.lostCompleteReply = { state: settled.state, completeCalls: 1 };
});

test("provider success then database failure leaves completing; reconcile finishes without a second complete", async () => {
  const body = Buffer.from("db failed after provider success");
  const plan = await allocateSourceUpload(
    deps,
    owner,
    await request(body.length),
  );
  await putAndJournal(deps, plan, 1, body);
  faults.afterComplete = () => breakDb();
  const before = faults.calls.filter((c) => c === "completeUpload").length;
  const failure = await code(
    completeTransport(deps, owner, plan.fileId, epochOf(plan)),
  );
  faults.afterComplete = undefined;
  assert.equal(failure.startsWith("unexpected:"), true, failure);
  assert.equal((await row(plan.fileId)).state, "completing");
  // While completing nothing else may touch the transport.
  for (const act of [
    () =>
      signParts(deps, owner, plan.fileId, {
        ...epochOf(plan),
        partNumbers: [1],
      }),
    () => cancelTransport(deps, owner, plan.fileId, epochOf(plan)),
  ])
    assert.equal(await code(act()), "conflict");
  const reconciled = await reconcileTransport(
    deps,
    owner,
    plan.fileId,
    epochOf(plan),
  );
  assert.equal(reconciled.state, "completed");
  assert.equal(
    faults.calls.filter((c) => c === "completeUpload").length - before,
    1,
    "the provider was asked to complete exactly once",
  );
  evidence.providerSuccessDbFailure = {
    state: reconciled.state,
    completeCalls: 1,
  };
});

test("completion-in-flight race: a second request is refused and cancel/sign cannot interleave", async () => {
  const body = Buffer.from("race");
  const plan = await allocateSourceUpload(
    deps,
    owner,
    await request(body.length),
  );
  await putAndJournal(deps, plan, 1, body);
  let release!: () => void;
  faults.holdComplete = new Promise((resolve) => (release = resolve));
  const entered = new Promise<void>(
    (resolve) => (faults.enteredComplete = resolve),
  );
  const first = completeTransport(deps, owner, plan.fileId, epochOf(plan));
  await entered;
  assert.equal((await row(plan.fileId)).state, "completing");
  assert.equal(
    await code(completeTransport(deps, owner, plan.fileId, epochOf(plan))),
    "conflict",
  );
  assert.equal(
    await code(reconcileTransport(deps, owner, plan.fileId, epochOf(plan))),
    "conflict",
  );
  assert.equal(
    await code(cancelTransport(deps, owner, plan.fileId, epochOf(plan))),
    "conflict",
  );
  assert.equal(
    await code(restartTransport(deps, owner, plan.fileId, epochOf(plan))),
    "conflict",
  );
  faults.holdComplete = undefined;
  faults.enteredComplete = undefined;
  release();
  assert.equal((await first).state, "completed");
  evidence.completionInFlightRace =
    "second complete/reconcile/cancel/restart refused; first settled";
});

test("a first completion blocked beyond the lease: reconcile/restart/cancel never repeat, abort or advance", async () => {
  const body = Buffer.from("blocked beyond lease");
  const short: TransportDeps = { ...deps, transitionLeaseMs: 1 };
  const plan = await allocateSourceUpload(
    short,
    owner,
    await request(body.length),
  );
  await putAndJournal(short, plan, 1, body);
  const key = (await row(plan.fileId)).object_key;
  let release!: () => void;
  faults.holdComplete = new Promise((resolve) => (release = resolve));
  const entered = new Promise<void>(
    (resolve) => (faults.enteredComplete = resolve),
  );
  const first = completeTransport(short, owner, plan.fileId, epochOf(plan));
  await entered;
  await new Promise((resolve) => setTimeout(resolve, 50)); // lease and any grace long gone
  const calls = faults.calls.length;
  const later = {
    ...short,
    now: () => new Date(Date.now() + 8 * 24 * 3600 * 1000),
  };
  for (const act of [
    () => reconcileTransport(short, owner, plan.fileId, epochOf(plan)),
    () => completeTransport(short, owner, plan.fileId, epochOf(plan)),
    () => restartTransport(later, owner, plan.fileId, epochOf(plan)),
    () => cancelTransport(short, owner, plan.fileId, epochOf(plan)),
    () =>
      journalReceipts(short, owner, plan.fileId, {
        ...epochOf(plan),
        receipts: [
          { partNumber: 1, etag: "x", sizeBytes: String(body.length) },
        ],
      }),
  ])
    assert.equal(await code(act()), "conflict");
  const issued = faults.calls.slice(calls);
  assert.equal(issued.includes("completeUpload"), false, "no second complete");
  assert.equal(issued.includes("abortUpload"), false, "no abort");
  assert.equal(issued.includes("createUpload"), false, "no new upload");
  const mid = await row(plan.fileId);
  assert.equal(mid.state, "completing");
  assert.equal(mid.transport_epoch, 1);
  assert.equal(mid.object_key, key);
  faults.holdComplete = undefined;
  faults.enteredComplete = undefined;
  release();
  assert.equal((await first).state, "completed");
  evidence.blockedCompletion =
    "reads only while unknown; first call then settled";
});

test("stale epochs fail every transition", async () => {
  const plan = await allocateSourceUpload(deps, owner, await request());
  for (const act of [
    completeTransport,
    reconcileTransport,
    cancelTransport,
    restartTransport,
  ])
    assert.equal(
      await code(act(deps, owner, plan.fileId, { expectedTransportEpoch: 2 })),
      "conflict",
    );
  assert.equal(
    await code(
      completeTransport(deps, owner, plan.fileId, {
        expectedTransportEpoch: 0,
      }),
    ),
    "invalid_request",
  );
});

test("incomplete provider parts never complete; lost receipt writes are healed from the provider listing", async () => {
  const body = Buffer.from("unjournaled part");
  const plan = await allocateSourceUpload(
    deps,
    owner,
    await request(body.length),
  );
  await putAndJournal(deps, plan, 1, body, false); // part at provider, no receipt
  assert.equal(
    (
      await db.owner.query(
        "SELECT 1 FROM file_part_receipts WHERE file_id = $1",
        [plan.fileId],
      )
    ).rowCount,
    0,
  );
  const plain = await reconcileTransport(
    deps,
    owner,
    plan.fileId,
    epochOf(plan),
  );
  assert.equal(plain.state, "uploading");
  assert.equal(
    (
      await db.owner.query(
        "SELECT 1 FROM file_part_receipts WHERE file_id = $1",
        [plan.fileId],
      )
    ).rowCount,
    1,
    "receipt journaled from the provider's own listing",
  );
  assert.equal(
    (await completeTransport(deps, owner, plan.fileId, epochOf(plan))).state,
    "completed",
  );
});

test("lost create response on a reserved file is reconciled for the exact key", async () => {
  const req = await request();
  faults.loseCreateResponse = true;
  await assert.rejects(allocateSourceUpload(deps, owner, req));
  const stuck = (
    await db.owner.query<{ id: string }>(
      "SELECT id FROM files WHERE recording_id = $1 AND client_upload_id = $2",
      [req.recordingId, req.clientUploadId],
    )
  ).rows[0]!;
  assert.equal((await row(stuck.id)).state, "reserved");
  const plan = await reconcileTransport(deps, owner, stuck.id, {
    expectedTransportEpoch: 1,
  });
  assert.equal(plan.state, "uploading");
  assert.equal((await uploadsAt((await row(stuck.id)).object_key)).length, 1);
});

test("several uploads at the exact key block reconciliation and completion", async () => {
  const body = Buffer.from("ambiguous");
  const plan = await allocateSourceUpload(
    deps,
    owner,
    await request(body.length),
  );
  await putAndJournal(deps, plan, 1, body);
  const key = (await row(plan.fileId)).object_key;
  await realS3().send(
    new CreateMultipartUploadCommand({ Bucket: BUCKET, Key: key }),
  );
  const before = faults.calls.filter((c) => c === "completeUpload").length;
  const err = await reconcileTransport(
    deps,
    owner,
    plan.fileId,
    epochOf(plan),
  ).then(
    () => undefined,
    (e: TransportError) => e,
  );
  assert.equal(err?.code, "provider_ambiguous");
  assert.equal(
    faults.calls.filter((c) => c === "completeUpload").length,
    before,
    "no blind completion while ambiguous",
  );
  // Clean the extra upload so the suite leaves no stray state.
  for (const u of await uploadsAt(key))
    await realS3().send(
      new AbortMultipartUploadCommand({
        Bucket: BUCKET,
        Key: key,
        UploadId: u.UploadId,
      }),
    );
});

test("cancel aborts the provider upload, is idempotent and cannot cancel completed data", async () => {
  const plan = await allocateSourceUpload(deps, owner, await request());
  const key = (await row(plan.fileId)).object_key;
  assert.equal((await uploadsAt(key)).length, 1);
  const cancelled = await cancelTransport(
    deps,
    owner,
    plan.fileId,
    epochOf(plan),
  );
  assert.equal(cancelled.state, "cancelled");
  assert.equal((await uploadsAt(key)).length, 0);
  assert.equal(
    (await cancelTransport(deps, owner, plan.fileId, epochOf(plan))).state,
    "cancelled",
  );
  for (const act of [completeTransport, restartTransport])
    assert.equal(
      await code(act(deps, owner, plan.fileId, epochOf(plan))),
      "conflict",
    );
  evidence.cancel = { state: cancelled.state, providerUploadsAfter: 0 };
});

test("restart after the seven-day window: next epoch/key, same logical file, no old receipts, full retransmission", async () => {
  const body = Buffer.from("will be retransmitted");
  const plan = await allocateSourceUpload(
    deps,
    owner,
    await request(body.length),
  );
  await putAndJournal(deps, plan, 1, body);
  const before = await row(plan.fileId);
  // Not expired and the provider upload is alive: restart is refused.
  assert.equal(
    await code(restartTransport(deps, owner, plan.fileId, epochOf(plan))),
    "conflict",
  );
  assert.equal((await row(plan.fileId)).transport_epoch, 1);
  const later = {
    ...deps,
    now: () => new Date(Date.now() + 8 * 24 * 3600 * 1000),
  };
  const restarted = await restartTransport(
    later,
    owner,
    plan.fileId,
    epochOf(plan),
  );
  assert.equal(restarted.transportEpoch, 2);
  assert.equal(restarted.state, "uploading");
  assert.equal(restarted.sha256, plan.sha256);
  assert.equal(restarted.sizeBytes, plan.sizeBytes);
  assert.equal(restarted.fileId, plan.fileId);
  const after = await row(plan.fileId);
  assert.match(after.object_key, /\/e2\//);
  assert.notEqual(after.object_key, before.object_key);
  assert.notEqual(after.provider_upload_id, before.provider_upload_id);
  assert.equal(
    (await uploadsAt(before.object_key)).length,
    0,
    "old upload retired",
  );
  assert.equal((await uploadsAt(after.object_key)).length, 1);
  // Old receipts do not carry over: epoch 2 starts empty and must resend.
  assert.equal(
    (
      await db.owner.query(
        "SELECT 1 FROM file_part_receipts WHERE file_id = $1 AND transport_epoch = 2",
        [plan.fileId],
      )
    ).rowCount,
    0,
  );
  await assert.rejects(
    completeTransport(deps, owner, plan.fileId, { expectedTransportEpoch: 2 }),
    /missing \[1\]/,
  );
  // Stale epoch-1 requests fail.
  for (const act of [
    () =>
      signParts(deps, owner, plan.fileId, {
        expectedTransportEpoch: 1,
        partNumbers: [1],
      }),
    () =>
      completeTransport(deps, owner, plan.fileId, {
        expectedTransportEpoch: 1,
      }),
    () =>
      restartTransport(deps, owner, plan.fileId, { expectedTransportEpoch: 1 }),
  ])
    assert.equal(await code(act()), "conflict");
  await putAndJournal(deps, restarted, 1, body);
  assert.equal(
    (
      await completeTransport(deps, owner, plan.fileId, {
        expectedTransportEpoch: 2,
      })
    ).state,
    "completed",
  );
  evidence.sevenDayRestart = {
    epoch: [1, 2],
    keyChanged: true,
    oldReceiptsCarriedOver: 0,
    sameLogicalFile: true,
  };
});

test("a provider that lost the upload before expiry proves retirement; restart advances the epoch", async () => {
  const plan = await allocateSourceUpload(deps, owner, await request());
  const r = await row(plan.fileId);
  await realS3().send(
    new AbortMultipartUploadCommand({
      Bucket: BUCKET,
      Key: r.object_key,
      UploadId: r.provider_upload_id!,
    }),
  );
  assert.equal(
    await code(completeTransport(deps, owner, plan.fileId, epochOf(plan))),
    "conflict",
  );
  assert.equal(
    await code(reconcileTransport(deps, owner, plan.fileId, epochOf(plan))),
    "conflict",
  );
  const restarted = await restartTransport(
    deps,
    owner,
    plan.fileId,
    epochOf(plan),
  );
  assert.equal(restarted.transportEpoch, 2);
  assert.equal(restarted.state, "uploading");
});

test("restart never reopens a file whose object already exists", async () => {
  const body = Buffer.from("object exists, db behind");
  const plan = await allocateSourceUpload(
    deps,
    owner,
    await request(body.length),
  );
  const etag = await putAndJournal(deps, plan, 1, body);
  const r = await row(plan.fileId);
  // The object is completed directly at the provider; the DB never heard.
  await completeAndRead(r.object_key, r.provider_upload_id!, [
    { partNumber: 1, etag },
  ]);
  const later = {
    ...deps,
    now: () => new Date(Date.now() + 8 * 24 * 3600 * 1000),
  };
  const out = await restartTransport(later, owner, plan.fileId, epochOf(plan));
  assert.equal(out.state, "completed");
  assert.equal(out.transportEpoch, 1);
});

test("more than 1,000 parts: the complete frozen set is verified across pages and ordered", async () => {
  const parts = 1537; // 1537 x 64 MiB < 100 GiB transport cap
  const size = BigInt(parts - 1) * 67_108_864n + 12_345n;
  const scripted = new ScriptedProvider();
  const sd: TransportDeps = {
    pool: db.app,
    provider: scripted,
    admission: () => admission(db.app),
  };
  const plan = await allocateSourceUpload(sd, owner, await request(size));
  assert.equal(plan.partCount, parts);
  for (let n = 1; n <= parts; n++)
    scripted.parts.set(n, {
      etag: `etag-${n}`,
      sizeBytes: n === parts ? 12_345n : 67_108_864n,
    });
  // Missing part 1200 (past the first 1,000-part page) must block completion.
  const hole = scripted.parts.get(1200)!;
  scripted.parts.delete(1200);
  await assert.rejects(
    completeTransport(sd, owner, plan.fileId, epochOf(plan)),
    /missing \[1200\]/,
  );
  // A wrong length on the final part blocks too.
  scripted.parts.set(1200, hole);
  scripted.parts.set(parts, { etag: "bad", sizeBytes: 12_346n });
  await assert.rejects(
    completeTransport(sd, owner, plan.fileId, epochOf(plan)),
    /wrong length \[1537\]/,
  );
  scripted.parts.set(parts, { etag: `etag-${parts}`, sizeBytes: 12_345n });
  const done = await completeTransport(sd, owner, plan.fileId, epochOf(plan));
  assert.equal(done.state, "completed");
  assert.equal(scripted.completed.length, 1);
  const sent = scripted.completed[0]!;
  assert.equal(sent.length, parts);
  assert.deepEqual(
    sent.map((p) => p.partNumber),
    Array.from({ length: parts }, (_, i) => i + 1),
  );
  assert.equal(sent[1199]!.etag, "etag-1200");
  // The journal was healed from the provider for all 1,537 parts.
  assert.equal(
    (
      await db.owner.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM file_part_receipts WHERE file_id = $1",
        [plan.fileId],
      )
    ).rows[0]!.n,
    String(parts),
  );
  evidence.pagination = { parts, completionListLength: sent.length };
});

test("opaque upload-ID aliases: inequality never retires or aborts anything", async () => {
  const scripted = new ScriptedProvider(); // create ID differs from list ID
  scripted.listIds = []; // nothing listed yet, so init creates the upload
  const sd: TransportDeps = {
    pool: db.app,
    provider: scripted,
    admission: () => admission(db.app),
  };
  const plan = await allocateSourceUpload(sd, owner, await request(100));
  scripted.listIds = ["list-alias"]; // R2 now lists the same upload by another ID
  scripted.parts.set(1, { etag: "e1", sizeBytes: 100n });
  // Active alias listing, not expired: restart refused, nothing aborted.
  assert.equal(
    await code(restartTransport(sd, owner, plan.fileId, epochOf(plan))),
    "conflict",
  );
  assert.equal(
    scripted.calls.some((c) => c.startsWith("abortUpload")),
    false,
  );
  const done = await completeTransport(sd, owner, plan.fileId, epochOf(plan));
  assert.equal(done.state, "completed");
  assert.equal(
    scripted.calls.some((c) => c.startsWith("abortUpload")),
    false,
  );
  evidence.opaqueAliases = {
    createId: scripted.createId,
    listId: scripted.listIds[0],
  };
});

test("worker outputs: the job capability completes, then a second output is cancelled; humans cannot reach them", async () => {
  // An OPEN inventory on a running job: no state hack, no trigger disable.
  const processed = await processedRecording(db.app, db.actors, 1, {
    open: true,
  });
  const job = { kind: "job" as const, jobId: processed.jobId };
  const body = Buffer.from("0123456789");
  const out = (slot: string) => ({
    slot,
    role: "clip_mp4" as const,
    sizeBytes: "10",
    sha256: createHash("sha256").update(slot).digest("hex"),
  });
  const plan = await allocateJobOutput(deps, job, out("clips/a.mp4"));
  const [part] = (
    await signParts(deps, job, plan.fileId, {
      expectedTransportEpoch: 1,
      partNumbers: [1],
    })
  ).parts;
  const put = await putPart(part!, body);
  await journalReceipts(deps, job, plan.fileId, {
    expectedTransportEpoch: 1,
    receipts: [{ partNumber: 1, etag: put.etag!, sizeBytes: "10" }],
  });
  assert.equal(
    await code(completeTransport(deps, owner, plan.fileId, epochOf(plan))),
    "forbidden",
  );
  const done = await completeTransport(deps, job, plan.fileId, epochOf(plan));
  assert.equal(done.state, "completed");
  const second = await allocateJobOutput(deps, job, out("clips/b.mp4"));
  const cancelled = await cancelTransport(
    deps,
    job,
    second.fileId,
    epochOf(second),
  );
  assert.equal(cancelled.state, "cancelled");
  evidence.workerOutputs = {
    completed: done.state,
    cancelled: cancelled.state,
  };
});
