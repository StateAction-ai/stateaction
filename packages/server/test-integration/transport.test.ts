import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import test, { after, before } from "node:test";
import { validateValue } from "@stateaction/contracts";
import {
  allocateSourceUpload,
  getUploadPlan,
  journalReceipts,
  PART_SIZE_BYTES,
  signParts,
  transportHandlers,
  TransportError,
  type Authority,
  type SignedPart,
  type TransportDeps,
} from "../src/transport/index.js";
import {
  completeAndRead,
  depsFor,
  newRecording,
  openSession,
  putPart,
  realProvider,
  transportDatabase,
  uploadsAt,
} from "./transport-harness.js";
import { writeArtifact, type TestDb, type Actors } from "./harness.js";

let db: TestDb & { actors: Actors };
let deps: TransportDeps;
let owner: Extract<Authority, { kind: "owner" }>;
let recordingId: string;
const evidence: Record<string, unknown> = {};

before(async () => {
  db = await transportDatabase();
  deps = depsFor(db, await realProvider());
  owner = {
    kind: "owner",
    userId: db.actors.collector,
    sessionId: await openSession(db, db.actors.collector),
  };
  recordingId = await newRecording(db, db.actors.collector);
});
after(async () => {
  await writeArtifact("transport-source-evidence.json", evidence);
  await db.close();
});

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const fail = async (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: unknown) =>
      error instanceof TransportError
        ? error.code
        : `unexpected:${String(error)}`,
  );
const request = (
  role: "source_mcap" | "recorder_metadata" | "calibration",
  size: number,
  forRecording = recordingId,
) => ({
  recordingId: forRecording,
  clientUploadId: randomUUID(),
  role,
  sizeBytes: String(size),
  sha256: sha(Buffer.from(`${role}:${size}:${randomUUID()}`)),
});
const must = (value: Response) =>
  value.json() as Promise<{ data: any; error: any }>;

test("reservation: server key before provider id, plan contract, idempotent replay", async () => {
  const req = request("source_mcap", Number(PART_SIZE_BYTES) + 1000);
  const plan = await allocateSourceUpload(deps, owner, req);
  assert.equal(plan.partSizeBytes, "67108864");
  assert.equal(plan.partCount, 2);
  assert.equal(plan.state, "uploading");
  assert.equal(plan.transportEpoch, 1);
  const checked = validateValue("http.upload-plan.v1", plan);
  assert.ok(checked.valid, JSON.stringify(checked));
  const { rows } = await db.owner.query(
    "SELECT object_key, provider_upload_id, state, request_digest IS NOT NULL AS digest FROM files WHERE id = $1",
    [plan.fileId],
  );
  assert.equal(
    rows[0].object_key,
    `recordings/${recordingId}/sources/${plan.fileId}/e1/source_mcap`,
  );
  assert.ok(rows[0].provider_upload_id);
  assert.equal((await uploadsAt(rows[0].object_key)).length, 1);
  // Identical replay: same file, no second provider upload.
  const again = await allocateSourceUpload(deps, owner, req);
  assert.equal(again.fileId, plan.fileId);
  assert.equal((await uploadsAt(rows[0].object_key)).length, 1);
  // Same identity, different content is a conflict.
  assert.equal(
    await fail(allocateSourceUpload(deps, owner, { ...req, sizeBytes: "5" })),
    "conflict",
  );
  // Invalid requests never reach the provider.
  for (const bad of [
    { ...req, clientUploadId: randomUUID(), sizeBytes: "0" },
    { ...req, clientUploadId: randomUUID(), sizeBytes: "107374182401" },
    { ...req, clientUploadId: randomUUID(), sha256: "ABC" },
    { ...req, clientUploadId: randomUUID(), role: "viewer_rrd" as never },
    {
      ...req,
      clientUploadId: randomUUID(),
      role: "source_manifest" as const,
      sizeBytes: "1048577",
    },
  ])
    assert.equal(
      await fail(allocateSourceUpload(deps, owner, bad)),
      "invalid_request",
    );
  evidence.reservation = { fileId: plan.fileId, key: rows[0].object_key, plan };
});

test("real presigned multipart: sign, direct PUT, receipts, replay, completion", async () => {
  const size = Number(PART_SIZE_BYTES) + 1000;
  const part1 = Buffer.alloc(Number(PART_SIZE_BYTES), 7);
  const part2 = Buffer.alloc(1000, 9);
  const whole = Buffer.concat([part1, part2]);
  const req = {
    ...request(
      "source_mcap",
      size,
      await newRecording(db, db.actors.collector),
    ),
    sha256: sha(whole),
  };
  const plan = await allocateSourceUpload(deps, owner, req);
  const signed = await signParts(deps, owner, plan.fileId, {
    expectedTransportEpoch: 1,
    partNumbers: [2, 1],
  });
  assert.ok(validateValue("http.parts-signed.v1", signed).valid);
  const byNumber = new Map(signed.parts.map((p) => [p.partNumber, p]));
  assert.deepEqual(
    [...byNumber.values()]
      .map((p) => [p.partNumber, p.offsetBytes, p.lengthBytes])
      .sort(),
    [
      [1, "0", "67108864"],
      [2, "67108864", "1000"],
    ],
  );
  for (const p of signed.parts) assert.equal(p.method, "PUT");
  // The signed URL carries only a scoped capability, never account credentials.
  assert.ok(!/secret|X-Amz-Security-Token/i.test(signed.parts[0]!.url));
  const part2Signed = byNumber.get(2)!;
  // The exact part length is signature-bound: a longer body is refused.
  const tooLong = await new Promise<number>((resolve, reject) => {
    const url = new URL(part2Signed.url);
    const r = httpRequest(
      url,
      { method: "PUT", headers: { "content-length": "1001" } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    r.on("error", reject);
    r.end(Buffer.alloc(1001, 9));
  });
  assert.ok(tooLong >= 400, `oversized part accepted: ${tooLong}`);
  const sent1 = await putPart(byNumber.get(1)!, part1);
  const sent2 = await putPart(part2Signed, part2);
  assert.equal(sent1.status, 200);
  assert.equal(sent2.status, 200);
  assert.ok(sent1.etag && sent2.etag);
  const receipts = [
    { partNumber: 1, etag: sent1.etag!, sizeBytes: String(part1.length) },
    { partNumber: 2, etag: sent2.etag!, sizeBytes: "1000" },
  ];
  const first = await journalReceipts(deps, owner, plan.fileId, {
    expectedTransportEpoch: 1,
    receipts,
  });
  assert.deepEqual(first.journaled, [1, 2]);
  // Exact replay is a no-op, even with differently-quoted ETags.
  const replay = await journalReceipts(deps, owner, plan.fileId, {
    expectedTransportEpoch: 1,
    receipts: receipts.map((r) => ({ ...r, etag: r.etag.replaceAll('"', "") })),
  });
  assert.deepEqual(replay, {
    transportEpoch: 1,
    journaled: [],
    alreadyJournaled: [1, 2],
  });
  const stored = await db.owner.query(
    "SELECT part_number, etag, size_bytes::text FROM file_part_receipts WHERE file_id = $1 ORDER BY 1",
    [plan.fileId],
  );
  assert.equal(stored.rowCount, 2);
  // Journaled receipts are exactly what the provider needs to finalize.
  const row = await db.owner.query<{
    object_key: string;
    provider_upload_id: string;
  }>("SELECT object_key, provider_upload_id FROM files WHERE id = $1", [
    plan.fileId,
  ]);
  const bytes = await completeAndRead(
    row.rows[0]!.object_key,
    row.rows[0]!.provider_upload_id,
    stored.rows.map((r) => ({ partNumber: r.part_number, etag: r.etag })),
  );
  assert.equal(bytes.length, size);
  assert.equal(sha(bytes), sha(whole));
  evidence.directPut = { parts: 2, bytes: size, tooLongStatus: tooLong };
});

test("part numbers, epoch and receipts are validated server-side", async () => {
  const plan = await allocateSourceUpload(
    deps,
    owner,
    request("recorder_metadata", 2500),
  );
  const sign = (body: {
    expectedTransportEpoch: unknown;
    partNumbers: unknown;
  }) => fail(signParts(deps, owner, plan.fileId, body));
  assert.equal(
    await sign({ expectedTransportEpoch: 1, partNumbers: [2] }),
    "invalid_request",
  );
  assert.equal(
    await sign({ expectedTransportEpoch: 1, partNumbers: [0] }),
    "invalid_request",
  );
  assert.equal(
    await sign({ expectedTransportEpoch: 1, partNumbers: [1, 1] }),
    "invalid_request",
  );
  assert.equal(
    await sign({ expectedTransportEpoch: 1, partNumbers: [] }),
    "invalid_request",
  );
  assert.equal(
    await sign({ expectedTransportEpoch: 1, partNumbers: [1.5] }),
    "invalid_request",
  );
  assert.equal(
    await sign({ expectedTransportEpoch: 1, partNumbers: ["1"] }),
    "invalid_request",
  );
  assert.equal(
    await sign({
      expectedTransportEpoch: 1,
      partNumbers: Array.from({ length: 33 }, (_, i) => i + 1),
    }),
    "invalid_request",
  );
  assert.equal(
    await sign({ expectedTransportEpoch: 2, partNumbers: [1] }),
    "conflict",
  );
  assert.equal(
    await sign({ expectedTransportEpoch: 0, partNumbers: [1] }),
    "invalid_request",
  );
  assert.equal(
    await fail(
      signParts(deps, owner, randomUUID(), {
        expectedTransportEpoch: 1,
        partNumbers: [1],
      }),
    ),
    "not_found",
  );
  // Small files still use multipart: one signed part, one provider upload.
  const [signed] = (
    await signParts(deps, owner, plan.fileId, {
      expectedTransportEpoch: 1,
      partNumbers: [1],
    })
  ).parts;
  assert.equal(signed!.lengthBytes, "2500");
  const body = Buffer.alloc(2500, 3);
  const put = await putPart(signed!, body);
  const rec = (over: object = {}) => ({
    expectedTransportEpoch: 1,
    receipts: [{ partNumber: 1, etag: put.etag!, sizeBytes: "2500", ...over }],
  });
  const journal = (body: unknown) =>
    fail(journalReceipts(deps, owner, plan.fileId, body as never));
  assert.equal(
    await journal({ ...rec(), expectedTransportEpoch: 2 }),
    "conflict",
  );
  assert.equal(await journal(rec({ sizeBytes: "2499" })), "invalid_request");
  assert.equal(await journal(rec({ partNumber: 2 })), "invalid_request");
  assert.equal(await journal(rec({ etag: "not an etag!" })), "invalid_request");
  assert.equal(
    await journal({ expectedTransportEpoch: 1, receipts: [] }),
    "invalid_request",
  );
  // A receipt the provider never produced (fabricated) or that is wrong is refused.
  assert.equal(await journal(rec({ etag: "deadbeef" })), "conflict");
  assert.equal(await journal(rec()), "ok");
  // A different ETag for a journaled part conflicts unless the provider confirms it.
  assert.equal(await journal(rec({ etag: "deadbeef" })), "conflict");
  // Re-uploading different bytes changes the provider's ETag; the journal follows it.
  const [again] = (
    await signParts(deps, owner, plan.fileId, {
      expectedTransportEpoch: 1,
      partNumbers: [1],
    })
  ).parts;
  const second = await putPart(again!, Buffer.alloc(2500, 4));
  assert.notEqual(second.etag, put.etag);
  assert.equal(await journal(rec({ etag: second.etag! })), "ok");
  const { rows } = await db.owner.query(
    "SELECT etag FROM file_part_receipts WHERE file_id = $1",
    [plan.fileId],
  );
  assert.deepEqual(
    rows.map((r) => `"${r.etag}"`),
    [second.etag],
  );
});

test("authority is rechecked live: owner, role, session and kind", async () => {
  const plan = await allocateSourceUpload(
    deps,
    owner,
    request("calibration", 10),
  );
  const sign = (who: Authority) =>
    fail(
      signParts(deps, who, plan.fileId, {
        expectedTransportEpoch: 1,
        partNumbers: [1],
      }),
    );
  assert.equal(await sign(owner), "ok");
  // Another collector cannot see or sign it; failures are indistinguishable from absence.
  const otherSession = await openSession(db, db.actors.outsider);
  assert.equal(
    await sign({
      kind: "owner",
      userId: db.actors.outsider,
      sessionId: otherSession,
    }),
    "not_found",
  );
  // A session id belonging to someone else cannot be paired with the owner id.
  assert.equal(
    await sign({
      kind: "owner",
      userId: owner.userId,
      sessionId: otherSession,
    }),
    "not_found",
  );
  assert.equal(
    await sign({
      kind: "owner",
      userId: owner.userId,
      sessionId: "sess_missing",
    }),
    "not_found",
  );
  // A job principal can never reach a source file.
  assert.equal(await sign({ kind: "job", jobId: randomUUID() }), "forbidden");
  // Expired and deleted sessions stop working immediately.
  const expired = await openSession(db, owner.userId, 1);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(await sign({ ...owner, sessionId: expired }), "not_found");
  const doomed = await openSession(db, owner.userId);
  assert.equal(await sign({ ...owner, sessionId: doomed }), "ok");
  await db.owner.query('DELETE FROM "session" WHERE id = $1', [doomed]);
  assert.equal(await sign({ ...owner, sessionId: doomed }), "not_found");
  // Role revocation does not revive old authority; re-enabling does not resurrect other sessions' rights.
  await db.owner.query(
    "UPDATE access SET enabled = false WHERE user_id = $1 AND role = 'collector'",
    [owner.userId],
  );
  assert.equal(await sign(owner), "not_found");
  assert.equal(
    await fail(allocateSourceUpload(deps, owner, request("source_mcap", 5))),
    "not_found",
  );
  assert.equal(
    await fail(getUploadPlan(deps, owner, plan.fileId)),
    "not_found",
  );
  await db.owner.query(
    "UPDATE access SET enabled = true WHERE user_id = $1 AND role = 'collector'",
    [owner.userId],
  );
  assert.equal(await sign(owner), "ok");
  // Retired transports never mint URLs.
  await db.owner.query("UPDATE files SET state = 'completing' WHERE id = $1", [
    plan.fileId,
  ]);
  assert.equal(await sign(owner), "conflict");
  assert.equal(
    (await getUploadPlan(deps, owner, plan.fileId)).state,
    "completing",
  );
});

test("stale epoch, expiry and restart do not revive old authority", async () => {
  const plan = await allocateSourceUpload(
    deps,
    owner,
    request("source_mcap", 100, await newRecording(db, db.actors.collector)),
  );
  const row = await db.owner.query<{ object_key: string }>(
    "SELECT object_key FROM files WHERE id = $1",
    [plan.fileId],
  );
  const [p] = (
    await signParts(deps, owner, plan.fileId, {
      expectedTransportEpoch: 1,
      partNumbers: [1],
    })
  ).parts;
  const put = await putPart(p!, Buffer.alloc(100, 1));
  await journalReceipts(deps, owner, plan.fileId, {
    expectedTransportEpoch: 1,
    receipts: [{ partNumber: 1, etag: put.etag!, sizeBytes: "100" }],
  });
  // Expired transport: no new URLs, no new receipts.
  await db.owner.query(
    "UPDATE files SET transport_expires_at = now() - interval '1 second' WHERE id = $1",
    [plan.fileId],
  );
  assert.equal(
    await fail(
      signParts(deps, owner, plan.fileId, {
        expectedTransportEpoch: 1,
        partNumbers: [1],
      }),
    ),
    "conflict",
  );
  // Restart (SA-21 mechanics, simulated at the row level): next epoch, new key and upload ID.
  const provider = deps.provider;
  const fresh = await provider.createUpload(
    `${row.rows[0]!.object_key.replace("/e1/", "/e2/")}`,
  );
  await db.owner.query(
    `UPDATE files SET transport_epoch = 2, object_key = $2, provider_upload_id = $3, state = 'uploading',
       transport_expires_at = now() + interval '7 days' WHERE id = $1`,
    [
      plan.fileId,
      row.rows[0]!.object_key.replace("/e1/", "/e2/"),
      fresh.uploadId,
    ],
  );
  // The old epoch can neither sign nor journal; the new epoch starts with no receipts.
  assert.equal(
    await fail(
      signParts(deps, owner, plan.fileId, {
        expectedTransportEpoch: 1,
        partNumbers: [1],
      }),
    ),
    "conflict",
  );
  assert.equal(
    await fail(
      journalReceipts(deps, owner, plan.fileId, {
        expectedTransportEpoch: 1,
        receipts: [{ partNumber: 1, etag: put.etag!, sizeBytes: "100" }],
      }),
    ),
    "conflict",
  );
  const now = await db.owner.query(
    "SELECT count(*)::int AS n FROM file_part_receipts WHERE file_id = $1 AND transport_epoch = 2",
    [plan.fileId],
  );
  assert.equal(now.rows[0].n, 0);
  assert.equal(
    await fail(
      signParts(deps, owner, plan.fileId, {
        expectedTransportEpoch: 2,
        partNumbers: [1],
      }),
    ),
    "ok",
  );
  assert.equal(
    (await getUploadPlan(deps, owner, plan.fileId)).transportEpoch,
    2,
  );
});

test("HTTP handlers: JSON envelopes only, bounded bodies, wrong credential kind", async () => {
  const handlers = transportHandlers(deps);
  const json = (body: unknown, headers: Record<string, string> = {}) => ({
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const create = await handlers.createSourceUpload(
    new Request(
      "http://x/api/v1/uploads",
      json(
        request(
          "source_mcap",
          4096,
          await newRecording(db, db.actors.collector),
        ),
      ),
    ),
    owner,
  );
  assert.equal(create.status, 200);
  assert.equal(create.headers.get("cache-control"), "no-store");
  const created = await must(create);
  assert.ok(validateValue("http.upload-plan.v1", created.data).valid);
  const signRes = await handlers.signParts(
    new Request(
      "http://x",
      json({ expectedTransportEpoch: 1, partNumbers: [1] }),
    ),
    owner,
    created.data.fileId,
  );
  const signed = await must(signRes);
  assert.ok(validateValue("http.parts-signed.v1", signed.data).valid);
  const put = await putPart(
    signed.data.parts[0] as SignedPart,
    Buffer.alloc(4096, 5),
  );
  const receiptRes = await handlers.putReceipts(
    new Request("http://x", {
      ...json({
        expectedTransportEpoch: 1,
        receipts: [{ partNumber: 1, etag: put.etag, sizeBytes: "4096" }],
      }),
      method: "PUT",
    }),
    owner,
    created.data.fileId,
  );
  assert.equal(receiptRes.status, 200);
  // 12 MiB of "video" posted to a control route is refused without buffering.
  const media = Buffer.alloc(12 * 1024 * 1024, 1);
  const big = await handlers.signParts(
    new Request("http://x", {
      method: "POST",
      headers: { "content-type": "video/mp4" },
      body: media,
    }),
    owner,
    created.data.fileId,
  );
  assert.equal(big.status, 415);
  const bigJson = await handlers.signParts(
    new Request("http://x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: media,
    }),
    owner,
    created.data.fileId,
  );
  assert.equal(bigJson.status, 413);
  const err = await must(bigJson);
  assert.equal(err.error.code, "payload_too_large");
  // Wrong credential kind for a route.
  const wrong = await handlers.createSourceUpload(
    new Request("http://x", json(request("source_mcap", 10))),
    { kind: "job", jobId: randomUUID() },
  );
  assert.equal(wrong.status, 403);
  // Errors use the published envelope.
  const missing = await handlers.getUpload(
    new Request("http://x"),
    owner,
    randomUUID(),
  );
  assert.equal(missing.status, 404);
  assert.ok(
    validateValue("http.error-envelope.v1", await missing.json()).valid,
  );
  evidence.http = { controlOnly: true, rejectedMediaBytes: media.length };
});
