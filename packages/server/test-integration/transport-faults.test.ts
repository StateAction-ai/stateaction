import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import type pg from "pg";
import {
  allocateSourceUpload,
  journalReceipts,
  signParts,
  TransportError,
  type Authority,
  type TransportDeps,
} from "../src/transport/index.js";
import {
  depsFor,
  FaultProvider,
  newRecording,
  openSession,
  putPart,
  realProvider,
  transportDatabase,
  uploadsAt,
} from "./transport-harness.js";
import { writeArtifact, type Actors, type TestDb } from "./harness.js";

let db: TestDb & { actors: Actors };
let faults: FaultProvider;
let deps: TransportDeps;
let owner: Extract<Authority, { kind: "owner" }>;
const evidence: Record<string, unknown> = {};

before(async () => {
  db = await transportDatabase();
  faults = new FaultProvider(await realProvider());
  deps = depsFor(db, faults);
  owner = {
    kind: "owner",
    userId: db.actors.collector,
    sessionId: await openSession(db, db.actors.collector),
  };
});
after(async () => {
  await writeArtifact("transport-fault-evidence.json", evidence);
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
const rq = async (size = 100) => ({
  recordingId: await newRecording(db, owner.userId),
  clientUploadId: randomUUID(),
  role: "source_mcap" as const,
  sizeBytes: String(size),
  sha256: createHash("sha256").update(randomUUID()).digest("hex"),
});
const fileOf = async (request: {
  recordingId: string;
  clientUploadId: string;
}) =>
  (
    await db.owner.query<{
      id: string;
      object_key: string;
      provider_upload_id: string | null;
      state: string;
    }>(
      "SELECT id, object_key, provider_upload_id, state FROM files WHERE recording_id = $1 AND client_upload_id = $2",
      [request.recordingId, request.clientUploadId],
    )
  ).rows[0];

test("provider outage on init is retryable and leaves a reserved key with no upload ID", async () => {
  const request = await rq();
  faults.failNext.add("createUpload");
  await assert.rejects(
    allocateSourceUpload(deps, owner, request),
    (e: TransportError) => {
      assert.equal(e.code, "provider_unavailable");
      assert.equal(e.status, 503);
      assert.equal(e.retryable, true);
      return true;
    },
  );
  const reserved = await fileOf(request);
  assert.equal(reserved!.state, "reserved");
  assert.equal(reserved!.provider_upload_id, null);
  assert.match(
    reserved!.object_key,
    /^recordings\/.+\/sources\/.+\/e1\/source_mcap$/,
  );
  // No URL can be issued before the provider ID is persisted.
  assert.equal(
    await code(
      signParts(deps, owner, reserved!.id, {
        expectedTransportEpoch: 1,
        partNumbers: [1],
      }),
    ),
    "conflict",
  );
  // Retry reuses the same file and key.
  const plan = await allocateSourceUpload(deps, owner, request);
  assert.equal(plan.fileId, reserved!.id);
  assert.equal((await fileOf(request))!.object_key, reserved!.object_key);
});

test("lost create response is reconciled for the exact key, never repeated", async () => {
  const request = await rq();
  faults.loseCreateResponse = true;
  assert.equal(
    await code(allocateSourceUpload(deps, owner, request)),
    "provider_unavailable",
  );
  const stuck = await fileOf(request);
  assert.equal(stuck!.provider_upload_id, null);
  const before = await uploadsAt(stuck!.object_key);
  assert.equal(
    before.length,
    1,
    "provider created the upload before the response was lost",
  );
  const plan = await allocateSourceUpload(deps, owner, request);
  const after = await uploadsAt(stuck!.object_key);
  assert.equal(
    after.length,
    1,
    "retry adopted the existing upload instead of creating another",
  );
  const row = await fileOf(request);
  assert.equal(row!.provider_upload_id, before[0]!.UploadId);
  assert.equal(plan.state, "uploading");
  evidence.lostCreateResponse = { adopted: true, uploads: after.length };
});

test("database failure after provider success is recoverable and persists the ID before URLs", async () => {
  const request = await rq();
  let failed = false;
  const flaky = new Proxy(db.app, {
    get(target, prop, receiver) {
      if (prop === "query")
        return (sql: unknown, ...rest: unknown[]) => {
          if (
            !failed &&
            typeof sql === "string" &&
            sql.includes("SET provider_upload_id")
          ) {
            failed = true;
            return Promise.reject(new Error("injected database failure"));
          }
          return (target.query as (...a: unknown[]) => unknown)(sql, ...rest);
        };
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as pg.Pool;
  await assert.rejects(
    allocateSourceUpload({ ...deps, pool: flaky }, owner, request),
    /injected database failure/,
  );
  const stuck = await fileOf(request);
  assert.equal(stuck!.provider_upload_id, null);
  assert.equal((await uploadsAt(stuck!.object_key)).length, 1);
  // The claim was released; the retry reconciles the exact key and adopts the existing upload.
  const plan = await allocateSourceUpload(deps, owner, request);
  assert.equal(plan.state, "uploading");
  assert.equal((await uploadsAt(stuck!.object_key)).length, 1);
});

test("several provider uploads for one reserved key are ambiguous and block progress", async () => {
  const request = await rq();
  faults.failNext.add("createUpload");
  await code(allocateSourceUpload(deps, owner, request));
  const row = await fileOf(request);
  await faults.createUpload(row!.object_key);
  await faults.createUpload(row!.object_key);
  assert.equal(
    await code(allocateSourceUpload(deps, owner, request)),
    "provider_ambiguous",
  );
  assert.equal((await fileOf(request))!.provider_upload_id, null);
});

test("concurrent initializers create exactly one provider upload", async () => {
  const request = await rq();
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      allocateSourceUpload(deps, owner, request).then(
        (plan) => plan.fileId,
        (error: unknown) => (error as TransportError).code,
      ),
    ),
  );
  const row = await fileOf(request);
  assert.equal((await uploadsAt(row!.object_key)).length, 1);
  assert.ok(row!.provider_upload_id);
  const files = new Set(results.filter((r) => r === row!.id));
  assert.equal(files.size, 1);
  for (const r of results)
    assert.ok(r === row!.id || r === "conflict", String(r));
  // Every caller can now converge.
  assert.equal(
    (await allocateSourceUpload(deps, owner, request)).fileId,
    row!.id,
  );
  evidence.concurrentInit = results;
});

test("provider failures on sign and receipt corroboration are retryable and record nothing", async () => {
  const request = await rq(5);
  const plan = await allocateSourceUpload(deps, owner, request);
  faults.failNext.add("presignUploadPart");
  assert.equal(
    await code(
      signParts(deps, owner, plan.fileId, {
        expectedTransportEpoch: 1,
        partNumbers: [1],
      }),
    ),
    "provider_unavailable",
  );
  const [part] = (
    await signParts(deps, owner, plan.fileId, {
      expectedTransportEpoch: 1,
      partNumbers: [1],
    })
  ).parts;
  const put = await putPart(part!, Buffer.alloc(5, 1));
  const body = {
    expectedTransportEpoch: 1,
    receipts: [{ partNumber: 1, etag: put.etag!, sizeBytes: "5" }],
  };
  faults.failNext.add("listParts");
  assert.equal(
    await code(journalReceipts(deps, owner, plan.fileId, body)),
    "provider_unavailable",
  );
  const none = await db.owner.query(
    "SELECT count(*)::int AS n FROM file_part_receipts WHERE file_id = $1",
    [plan.fileId],
  );
  assert.equal(none.rows[0].n, 0);
  assert.equal(
    await code(journalReceipts(deps, owner, plan.fileId, body)),
    "ok",
  );
});

test("concurrent identical and conflicting receipt writers converge on one row", async () => {
  const plan = await allocateSourceUpload(deps, owner, await rq(5));
  const [part] = (
    await signParts(deps, owner, plan.fileId, {
      expectedTransportEpoch: 1,
      partNumbers: [1],
    })
  ).parts;
  const put = await putPart(part!, Buffer.alloc(5, 2));
  const body = {
    expectedTransportEpoch: 1,
    receipts: [{ partNumber: 1, etag: put.etag!, sizeBytes: "5" }],
  };
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      journalReceipts(deps, owner, plan.fileId, body).then(
        (r) => r,
        (e: unknown) => String(e),
      ),
    ),
  );
  const journaled = results.filter(
    (r) => typeof r !== "string" && r.journaled.length === 1,
  );
  assert.equal(journaled.length, 1, JSON.stringify(results));
  assert.equal(
    results.filter((r) => typeof r === "string").length,
    0,
    JSON.stringify(results),
  );
  const rows = await db.owner.query(
    "SELECT count(*)::int AS n FROM file_part_receipts WHERE file_id = $1",
    [plan.fileId],
  );
  assert.equal(rows.rows[0].n, 1);
  // Revoked mid-flight: a revoked owner cannot journal even a valid receipt.
  const gone = await openSession(db, owner.userId);
  await db.owner.query('DELETE FROM "session" WHERE id = $1', [gone]);
  assert.equal(
    await code(
      journalReceipts(deps, { ...owner, sessionId: gone }, plan.fileId, {
        ...body,
        receipts: [{ partNumber: 1, etag: put.etag!, sizeBytes: "5" }],
      }),
    ),
    "not_found",
  );
});

test("the database independently enforces plan, epoch, immutability and least privilege", async () => {
  const request = await rq(100);
  const plan = await allocateSourceUpload(deps, owner, request);
  const app = db.app;
  const insert = (part: number, size: string, epoch = 1) =>
    app.query(
      `INSERT INTO file_part_receipts (file_id, transport_epoch, part_number, etag, size_bytes, corroborated_at)
       VALUES ($1, $2, $3, 'abc', $4, now())`,
      [plan.fileId, epoch, part, size],
    );
  await assert.rejects(insert(1, "99"), /frozen part plan/);
  await assert.rejects(insert(2, "100"), /frozen part plan/);
  await assert.rejects(insert(1, "100", 2), /not accepting receipts/);
  await insert(1, "100");
  await assert.rejects(
    app.query(
      "UPDATE file_part_receipts SET size_bytes = 5 WHERE file_id = $1",
      [plan.fileId],
    ),
    /permission denied/,
  );
  await assert.rejects(
    app.query("DELETE FROM file_part_receipts WHERE file_id = $1", [
      plan.fileId,
    ]),
    /permission denied/,
  );
  await assert.rejects(
    app.query("UPDATE file_part_receipts SET etag = 'zzz' WHERE file_id = $1", [
      plan.fileId,
    ]),
    /fresh provider corroboration/,
  );
  await assert.rejects(
    app.query("UPDATE files SET provider_upload_id = 'forged' WHERE id = $1", [
      plan.fileId,
    ]),
    /write-once/,
  );
  await assert.rejects(
    app.query("UPDATE files SET object_key = 'recordings/x/y' WHERE id = $1", [
      plan.fileId,
    ]),
    /./,
  );
  await assert.rejects(
    app
      .query("DELETE FROM file_transport_claims")
      .then(() => app.query("DROP TABLE file_part_receipts")),
    /./,
  );
  // Receipts for a file that is no longer uploading are refused by the guard.
  await db.owner.query("UPDATE files SET state = 'completing' WHERE id = $1", [
    plan.fileId,
  ]);
  await assert.rejects(insert(1, "100"), /duplicate|not accepting/);
});
