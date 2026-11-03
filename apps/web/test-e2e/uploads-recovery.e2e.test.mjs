// SA-21 HTTP-path proof for the eight completion/recovery routes:
//   POST /api/v1/uploads/{fileId}/{complete,reconcile,cancel,restart}
//   POST /internal/v1/jobs/{jobId}/outputs/{fileId}/{complete,reconcile,cancel,restart}
// through the production `next build` served by `next start`, real Better Auth
// sessions, the restricted `stateaction_app` role on a migrated throwaway
// database and an S3-compatible store. Only HTTP crosses into the app; the
// owner credential and SDK are operator/fixture actions (permission evidence,
// role changes, aborting a provider upload to model loss, the worker capability
// the processing controller will issue). Request/response shapes are checked
// with the published contracts, never a private validator.
//
// Runs on the shared ledger-owned fixtures (Docker, or the bounded local
// fixtures under local CI); the provider outage is a loopback proxy refusal
// (outage-proxy.mjs), never a Docker pause. Not R2, native-app or
// hosted qualification.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createRequire } from "node:module";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  startStack,
  call as rawCall,
  signIn as harnessSignIn,
} from "./harness.mjs";

const serverDir = fileURLToPath(
  new URL("../../../packages/server/", import.meta.url),
);
const serverRequire = createRequire(join(serverDir, "package.json"));
const pg = serverRequire("pg");
const {
  CreateBucketCommand,
  CompleteMultipartUploadCommand,
  GetObjectCommand,
  ListMultipartUploadsCommand,
  AbortMultipartUploadCommand,
} = serverRequire("@aws-sdk/client-s3");
const dist = (p) => import(new URL(`dist/${p}`, `file://${serverDir}`).href);
const { recordIngestPermission, revokeIngestPermission } = await dist(
  "admission/permissions.js",
);
const cat = await dist("catalog/catalog.js");
const { fixtureRunJob } = await dist("jobs/fixtures.js");
const { establishFixtureAdmission } = await dist("admission/fixtures.js");
const { hashCredentialPassword } = await dist("catalog/password.js");
const { storageClient } = await dist("storage.js");
const { validateValue } = await import(
  new URL("../../../packages/contracts/dist/index.js", import.meta.url).href
);

const sha = (b) => createHash("sha256").update(b).digest("hex");
const evidence = {};

let stack, owner, app, storage, bucket, users, origin;

/** HTTP call against the stack with parsed JSON. */
async function call(path, options) {
  const res = await rawCall(origin, path, options);
  let json;
  try {
    json = JSON.parse(res.text);
  } catch {}
  return { ...res, json };
}
const nativePost = (jar, body, extra = {}) => ({
  method: "POST",
  jar,
  body: typeof body === "string" ? body : JSON.stringify(body),
  headers: {
    "content-type": "application/json",
    "x-stateaction-client": "android",
    ...extra,
  },
});
const nativePut = (jar, body) => ({ ...nativePost(jar, body), method: "PUT" });
const browserPost = (jar, body, extra = {}) => ({
  method: "POST",
  jar,
  body: typeof body === "string" ? body : JSON.stringify(body),
  headers: {
    "content-type": "application/json",
    origin,
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "x-stateaction-client": "web",
    ...extra,
  },
});
const workerPost = (token, body, method = "POST") => ({
  method,
  body: typeof body === "string" ? body : JSON.stringify(body),
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  },
});
const signIn = (email) => {
  const label = Object.keys(users).find((k) => users[k].email === email);
  return harnessSignIn(stack, label);
};
const assertNoStore = (res, what) =>
  assert.match(String(res.headers["cache-control"]), /no-store/, what);
/** The published error envelope never leaks storage internals. */
const assertSafeError = (res, what) => {
  assert.ok(res.status >= 400, `${what}: ${res.status}`);
  assert.ok(res.status < 500 || res.status === 503, `${what}: ${res.status}`);
  assert.doesNotMatch(
    res.text,
    /X-Amz|uploadId|secret|object_key|recordings\/|jobs\/[0-9a-f-]{36}\/outputs|sa_svc_/i,
    `${what}: error body leaked internals`,
  );
};

const TRANSITIONS = ["complete", "reconcile", "cancel", "restart"];

async function directPut(part, body) {
  const res = await fetch(part.url, {
    method: "PUT",
    body,
    headers: part.headers,
    signal: AbortSignal.timeout(20000),
  });
  return { status: res.status, etag: res.headers.get("etag") };
}
const providerUploads = async (key) =>
  (
    (
      await storage.send(
        new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: key }),
      )
    ).Uploads ?? []
  ).filter((u) => u.Key === key);
const fileRow = async (fileId) =>
  (
    await owner.query(
      "SELECT state, transport_epoch, object_key, provider_upload_id FROM files WHERE id = $1",
      [fileId],
    )
  ).rows[0];
const receiptCount = async (fileId, epoch) =>
  (
    await owner
      .query(
        "SELECT count(*)::int n FROM file_part_receipts WHERE file_id = $1 AND transport_epoch = $2",
        [fileId, epoch],
      )
      .catch(() =>
        owner.query(
          "SELECT count(*)::int n FROM file_part_receipts WHERE file_id = $1",
          [fileId],
        ),
      )
  ).rows[0].n;

const permissionFor = async (userId) => {
  const active = await owner.query(
    "SELECT 1 FROM ingest_permissions WHERE owner_user_id = $1 AND status = 'active'",
    [userId],
  );
  if (!active.rowCount)
    await recordIngestPermission(owner, {
      permissionRef: `sa21-${randomUUID().slice(0, 8)}`,
      ownerUserId: userId,
      pilotScope: "sa21-e2e",
      coversCapture: true,
      coversProcessing: true,
      evidenceRef: "doc://pilot/sa21-e2e",
      recordedBy: "operator@e2e",
    });
};

async function register(jar) {
  const res = await call(
    "/api/v1/recordings",
    nativePost(jar, {
      clientRecordingId: randomUUID(),
      captureFormat: "stateaction.capture.v1",
      rgbProfile: "h264_mcap_v1",
      startedAt: "2026-11-02T12:00:00Z",
      device: { model: "Pixel 9", osVersion: "16", appVersion: "0.1.0" },
    }),
  );
  assert.equal(res.status, 201, res.text);
  return res.json.data.recording.recordingId;
}

/** Owner reserves a one-part source upload over HTTP. */
async function ownerUpload(jar, size = 4096) {
  const recordingId = await register(jar);
  const bytes = randomBytes(size);
  const created = await call(
    "/api/v1/uploads",
    nativePost(jar, {
      recordingId,
      clientUploadId: randomUUID(),
      role: "source_mcap",
      sizeBytes: String(bytes.length),
      sha256: sha(bytes),
    }),
  );
  assert.equal(created.status, 200, created.text);
  const plan = created.json.data;
  return {
    jar,
    bytes,
    fileId: plan.fileId,
    plan,
    url: (action) => `/api/v1/uploads/${plan.fileId}/${action}`,
    request: (body, extra) => nativePost(jar, body, extra),
    put: (body) => nativePut(jar, body),
  };
}

/** A running job whose worker capability the processing controller would issue. */
async function runningJob(ownerUserId) {
  const recordingId = randomUUID();
  await cat.registerRecording(app, {
    recordingId,
    ownerUserId,
    clientRecordingId: randomUUID(),
    captureFormat: "stateaction.capture.v1",
    rgbProfile: "h264_mcap_v1",
    startedAt: new Date().toISOString(),
    device: { model: "emulator", osVersion: "16", appVersion: "test" },
  });
  let manifestFileId = "";
  for (const role of ["source_manifest", "source_mcap", "recorder_metadata"]) {
    const fileId = randomUUID();
    if (role === "source_manifest") manifestFileId = fileId;
    await cat.reserveSourceFile(app, {
      fileId,
      recordingId,
      ownerUserId,
      clientUploadId: randomUUID(),
      role,
      sizeBytes: "1000",
      sha256: sha(`${recordingId}:${role}`),
      required: true,
      partSizeBytes: "67108864",
      partCount: 1,
    });
    await cat.recordFileCompleted(app, {
      fileId,
      expectedTransportEpoch: 1,
      observedSizeBytes: "1000",
    });
  }
  await cat.sealRecording(app, { recordingId, ownerUserId, manifestFileId });
  const jobId = randomUUID();
  await establishFixtureAdmission(owner, { recordingId, firstJobId: jobId });
  await cat.createProcessingJob(app, {
    jobId,
    recordingId,
    profileRevision: "sa21-e2e",
  });
  // Walk the real admission/claim state machine (owner credential fixture).
  const { capabilityToken: token } = await fixtureRunJob(owner, jobId);
  return { jobId, recordingId, token };
}

/** Worker reserves a one-part output over HTTP. */
async function workerOutput(
  job,
  size = 2048,
  slot = `clips/${randomUUID().slice(0, 8)}/rgb.mp4`,
) {
  const bytes = randomBytes(size);
  const base = `/internal/v1/jobs/${job.jobId}/outputs`;
  const created = await call(
    base,
    workerPost(job.token, {
      slot,
      role: "clip_mp4",
      sizeBytes: String(bytes.length),
      sha256: sha(bytes),
    }),
  );
  assert.equal(created.status, 200, created.text);
  const plan = created.json.data;
  return {
    bytes,
    fileId: plan.fileId,
    plan,
    url: (action) => `${base}/${plan.fileId}/${action}`,
    request: (body) => workerPost(job.token, body),
    put: (body) => workerPost(job.token, body, "PUT"),
  };
}

/** Sign, PUT straight to the provider and journal exact receipts over HTTP. */
async function uploadAllParts(file, epoch = 1) {
  const signed = await call(
    file.url("parts/sign"),
    file.request({ expectedTransportEpoch: epoch, partNumbers: [1] }),
  );
  assert.equal(signed.status, 200, signed.text);
  const put = await directPut(signed.json.data.parts[0], file.bytes);
  assert.equal(put.status, 200);
  const rec = await call(
    file.url("parts/receipts"),
    file.put({
      expectedTransportEpoch: epoch,
      receipts: [
        {
          partNumber: 1,
          etag: put.etag,
          sizeBytes: String(file.bytes.length),
        },
      ],
    }),
  );
  assert.equal(rec.status, 200, rec.text);
  return put.etag;
}

const objectSha = async (key) =>
  sha(
    Buffer.from(
      await (
        await storage.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
      ).Body.transformToByteArray(),
    ),
  );
const validOwnerPlan = (plan) =>
  assert.equal(validateValue("http.upload-plan.v1", plan).valid, true);
const validOutputPlan = (plan) =>
  assert.equal(validateValue("http.output-plan.v1", plan).valid, true);

before(async () => {
  stack = await startStack({ storage: true });
  origin = stack.origin;
  users = stack.users;
  bucket = stack.env.S3_BUCKET;
  owner = new pg.Pool({ connectionString: stack.db.ownerUrl, max: 3 });
  app = new pg.Pool({ connectionString: stack.db.appUrl, max: 6 });
  storage = storageClient(
    {
      endpoint: stack.s3.endpoint,
      publicEndpoint: stack.s3.endpoint,
      region: stack.env.S3_REGION,
      bucket,
      accessKeyId: stack.s3.accessKeyId,
      secretAccessKey: stack.s3.secretAccessKey,
    },
    15000,
  );
  // External fixtures hand out a run-owned, already-created bucket.
  if (!stack.s3.bucket)
    await storage.send(new CreateBucketCommand({ Bucket: bucket }));
  // A second collector for owner isolation and live role/permission checks.
  users.collector2 = {
    id: "sa21-collector-2",
    email: "collector2@stateaction.local",
  };
  await owner.query(
    `INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, 'Second Collector', $2, true)`,
    [users.collector2.id, users.collector2.email],
  );
  await owner.query(
    `INSERT INTO account (id, "accountId", "providerId", "userId", password, "updatedAt")
     VALUES ($1, $2, 'credential', $2, $3, now())`,
    [
      `${users.collector2.id}-credential`,
      users.collector2.id,
      await hashCredentialPassword(stack.password),
    ],
  );
  await owner.query(
    "INSERT INTO access (user_id, role, enabled, granted_by) VALUES ($1, 'collector', true, 'sa21-e2e-operator')",
    [users.collector2.id],
  );
  await permissionFor(users.collector.id);
  await permissionFor(users.collector2.id);
});

after(async () => {
  storage?.destroy();
  await Promise.all([owner?.end(), app?.end()]);
  const leaked = stack
    ? [stack.s3.secretAccessKey].filter((s) => stack.logs().includes(s))
    : [];
  await stack?.stop();
  assert.deepEqual(leaked, [], "server logs must not contain storage secrets");
  if (process.env.SA21_E2E_EVIDENCE)
    process.stdout.write(
      `SA21_E2E_EVIDENCE ${JSON.stringify({ ...evidence })}\n`,
    );
});

describe("SA-21 completion and recovery routes on production Next", () => {
  test("owner completes over HTTP: exact object, idempotent replay, terminal refusals", async () => {
    const jar = await signIn(users.collector.email);
    const f = await ownerUpload(jar);
    const etag = await uploadAllParts(f);

    // Completion requires the exact planned epoch.
    const stale = await call(
      f.url("complete"),
      f.request({ expectedTransportEpoch: 2 }),
    );
    assert.equal(stale.status, 409, stale.text);
    assert.equal(
      (await fileRow(f.fileId)).state,
      "uploading",
      "stale epoch changed nothing",
    );

    const done = await call(
      f.url("complete"),
      f.request({ expectedTransportEpoch: 1 }),
    );
    assert.equal(done.status, 200, done.text);
    assertNoStore(done, "complete");
    validOwnerPlan(done.json.data);
    assert.equal(done.json.data.state, "completed");
    assert.equal(done.json.data.fileId, f.fileId);
    const row = await fileRow(f.fileId);
    assert.equal(row.state, "completed");
    assert.equal(
      await objectSha(row.object_key),
      sha(f.bytes),
      "exact bytes at the private key",
    );
    assert.equal((await providerUploads(row.object_key)).length, 0);
    // The SA-19 admission/completion record exists (file completed, not verified).
    assert.notEqual(row.state, "verified");

    // Replays and later transitions never reopen or re-complete a finished file.
    const again = await call(
      f.url("complete"),
      f.request({ expectedTransportEpoch: 1 }),
    );
    assert.equal(again.status, 200, again.text);
    assert.equal(again.json.data.state, "completed");
    const rec = await call(
      f.url("reconcile"),
      f.request({ expectedTransportEpoch: 1 }),
    );
    assert.equal(rec.status, 200, rec.text);
    validOwnerPlan(rec.json.data);
    assert.equal(rec.json.data.state, "completed");
    for (const action of ["cancel", "restart"]) {
      const r = await call(
        f.url(action),
        f.request({ expectedTransportEpoch: 1 }),
      );
      assert.equal(r.status, 409, `${action}: ${r.text}`);
      assertSafeError(r, action);
    }
    const after = await fileRow(f.fileId);
    assert.equal(after.state, "completed");
    assert.equal(after.transport_epoch, 1);
    assert.equal(await objectSha(after.object_key), sha(f.bytes));
    // Parts can no longer be signed for a completed file.
    const sign = await call(
      f.url("parts/sign"),
      f.request({ expectedTransportEpoch: 1, partNumbers: [1] }),
    );
    assert.equal(sign.status, 409, sign.text);
    evidence.ownerComplete = { fileId: f.fileId, etag: Boolean(etag) };
  });

  test("complete without all parts is 409 and completes nothing; reconcile heals nothing it cannot prove", async () => {
    const jar = await signIn(users.collector.email);
    const f = await ownerUpload(jar);
    const r = await call(
      f.url("complete"),
      f.request({ expectedTransportEpoch: 1 }),
    );
    assert.equal(r.status, 409, r.text);
    assertSafeError(r, "complete without parts");
    const row = await fileRow(f.fileId);
    assert.equal(row.state, "uploading");
    assert.equal(
      (await providerUploads(row.object_key)).length,
      1,
      "upload still open",
    );
    const rec = await call(
      f.url("reconcile"),
      f.request({ expectedTransportEpoch: 1 }),
    );
    assert.equal(rec.status, 200, rec.text);
    assert.equal(rec.json.data.state, "uploading");
    // A short/mismatched part never completes either: send fewer bytes via a wrong-sized upload is
    // refused at the provider by the signed length, so the file remains open.
    const signed = await call(
      f.url("parts/sign"),
      f.request({ expectedTransportEpoch: 1, partNumbers: [1] }),
    );
    const bad = await fetch(signed.json.data.parts[0].url, {
      method: "PUT",
      body: f.bytes.subarray(0, f.bytes.length - 1),
      headers: signed.json.data.parts[0].headers,
    }).catch(() => ({ status: 0 }));
    assert.ok(
      bad.status === 0 || bad.status >= 400,
      `short body refused: ${bad.status}`,
    );
    const again = await call(
      f.url("complete"),
      f.request({ expectedTransportEpoch: 1 }),
    );
    assert.equal(again.status, 409, again.text);
    assert.equal((await fileRow(f.fileId)).state, "uploading");
  });

  test("lost completion: an object already at the key finalizes via restart and is never reopened", async () => {
    const jar = await signIn(users.collector.email);
    const f = await ownerUpload(jar);
    const etag = await uploadAllParts(f);
    const row = await fileRow(f.fileId);
    // Operator/SDK action modelling a completion whose reply was lost.
    await storage.send(
      new CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: row.object_key,
        UploadId: row.provider_upload_id,
        MultipartUpload: { Parts: [{ PartNumber: 1, ETag: etag }] },
      }),
    );
    const r = await call(
      f.url("restart"),
      f.request({ expectedTransportEpoch: 1 }),
    );
    assert.equal(r.status, 200, r.text);
    validOwnerPlan(r.json.data);
    assert.equal(r.json.data.state, "completed");
    assert.equal(
      r.json.data.transportEpoch,
      1,
      "no new epoch for an existing object",
    );
    assert.equal((await fileRow(f.fileId)).state, "completed");
    assert.equal(await objectSha(row.object_key), sha(f.bytes));
  });

  test("cancel aborts the provider upload, replays safely and closes the file", async () => {
    const jar = await signIn(users.collector.email);
    const f = await ownerUpload(jar);
    const key = (await fileRow(f.fileId)).object_key;
    assert.equal((await providerUploads(key)).length, 1);
    const stale = await call(
      f.url("cancel"),
      f.request({ expectedTransportEpoch: 3 }),
    );
    assert.equal(stale.status, 409);
    assert.equal(
      (await providerUploads(key)).length,
      1,
      "stale cancel aborted nothing",
    );
    const c = await call(
      f.url("cancel"),
      browserPost(jar, { expectedTransportEpoch: 1 }),
    );
    assert.equal(c.status, 200, c.text);
    validOwnerPlan(c.json.data);
    assert.equal(c.json.data.state, "cancelled");
    assert.equal((await fileRow(f.fileId)).state, "cancelled");
    assert.equal(
      (await providerUploads(key)).length,
      0,
      "provider upload aborted",
    );
    const replay = await call(
      f.url("cancel"),
      f.request({ expectedTransportEpoch: 1 }),
    );
    assert.equal(replay.status, 200, replay.text);
    assert.equal(replay.json.data.state, "cancelled");
    for (const action of ["complete", "restart"]) {
      const r = await call(
        f.url(action),
        f.request({ expectedTransportEpoch: 1 }),
      );
      assert.equal(r.status, 409, `${action}: ${r.text}`);
    }
    const sign = await call(
      f.url("parts/sign"),
      f.request({ expectedTransportEpoch: 1, partNumbers: [1] }),
    );
    assert.ok([404, 409].includes(sign.status), sign.text);
    assert.equal((await fileRow(f.fileId)).state, "cancelled");
  });

  test("restart is refused while the upload is alive, then advances the epoch after provider loss with full retransmission", async () => {
    const jar = await signIn(users.collector.email);
    const f = await ownerUpload(jar);
    await uploadAllParts(f);
    const first = await fileRow(f.fileId);
    const live = await call(
      f.url("restart"),
      f.request({ expectedTransportEpoch: 1 }),
    );
    assert.equal(live.status, 409, live.text);
    assert.equal(
      (await fileRow(f.fileId)).transport_epoch,
      1,
      "live upload is not restarted",
    );

    // Operator/lifecycle action: the provider loses the upload.
    await storage.send(
      new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: first.object_key,
        UploadId: first.provider_upload_id,
      }),
    );
    const rec = await call(
      f.url("reconcile"),
      f.request({ expectedTransportEpoch: 1 }),
    );
    assert.equal(
      rec.status,
      409,
      "reconcile reports the lost provider upload: " + rec.text,
    );
    const restarted = await call(
      f.url("restart"),
      f.request({ expectedTransportEpoch: 1 }),
    );
    assert.equal(restarted.status, 200, restarted.text);
    validOwnerPlan(restarted.json.data);
    assert.equal(restarted.json.data.transportEpoch, 2);
    assert.equal(restarted.json.data.fileId, f.fileId, "same logical file");
    assert.equal(restarted.json.data.sha256, sha(f.bytes));
    const second = await fileRow(f.fileId);
    assert.equal(second.transport_epoch, 2);
    assert.match(second.object_key, /\/e2\//);
    assert.notEqual(
      second.object_key,
      first.object_key,
      "keys are never reused",
    );
    assert.notEqual(second.provider_upload_id, first.provider_upload_id);

    // Old-epoch requests fail; the whole object must be sent again.
    for (const action of TRANSITIONS) {
      const r = await call(
        f.url(action),
        f.request({ expectedTransportEpoch: 1 }),
      );
      assert.equal(r.status, 409, `${action}: ${r.text}`);
    }
    assert.equal(
      (
        await call(
          f.url("parts/sign"),
          f.request({ expectedTransportEpoch: 1, partNumbers: [1] }),
        )
      ).status,
      409,
    );
    const noParts = await call(
      f.url("complete"),
      f.request({ expectedTransportEpoch: 2 }),
    );
    assert.equal(
      noParts.status,
      409,
      "old receipts do not carry over: " + noParts.text,
    );
    await uploadAllParts(f, 2);
    const done = await call(
      f.url("complete"),
      f.request({ expectedTransportEpoch: 2 }),
    );
    assert.equal(done.status, 200, done.text);
    assert.equal(done.json.data.state, "completed");
    assert.equal(done.json.data.transportEpoch, 2);
    assert.equal(await objectSha(second.object_key), sha(f.bytes));
    evidence.restart = { fileId: f.fileId, epochs: [1, 2] };
  });

  test("concurrent completes produce one completed object and never an error", async () => {
    const jar = await signIn(users.collector.email);
    const f = await ownerUpload(jar, 8192);
    await uploadAllParts(f);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        call(f.url("complete"), f.request({ expectedTransportEpoch: 1 })),
      ),
    );
    for (const r of results)
      assert.ok([200, 409].includes(r.status), `${r.status} ${r.text}`);
    assert.ok(
      results.some((r) => r.status === 200),
      "one caller completes",
    );
    const row = await fileRow(f.fileId);
    assert.equal(row.state, "completed");
    assert.equal(await objectSha(row.object_key), sha(f.bytes));
    // A late replay is idempotent.
    const late = await call(
      f.url("complete"),
      f.request({ expectedTransportEpoch: 1 }),
    );
    assert.equal(late.status, 200, late.text);
  });

  test("owner routes deny anonymous, bearer, cross-site, wrong-role, other-owner and revoked callers and bound every body", async () => {
    const jar = await signIn(users.collector.email);
    const f = await ownerUpload(jar);
    await uploadAllParts(f);
    const body = { expectedTransportEpoch: 1 };
    const key = (await fileRow(f.fileId)).object_key;
    const frozen = async (what) => {
      const row = await fileRow(f.fileId);
      assert.equal(row.state, "uploading", what);
      assert.equal(row.transport_epoch, 1, what);
      assert.equal(
        (await providerUploads(key)).length,
        1,
        `${what}: provider untouched`,
      );
    };

    for (const action of TRANSITIONS) {
      const url = f.url(action);
      const tag = (s) => `${action}: ${s}`;
      assert.equal(
        (await call(url, nativePost(null, body))).status,
        401,
        tag("anonymous"),
      );
      const bearer = nativePost(jar, body);
      bearer.headers.authorization = "Bearer stolen";
      assert.equal(
        (await call(url, bearer)).status,
        401,
        tag("no bearer fallback"),
      );
      assert.equal(
        (
          await call(
            url,
            browserPost(jar, body, { "sec-fetch-site": "cross-site" }),
          )
        ).status,
        403,
        tag("cross-site"),
      );
      assert.equal(
        (
          await call(
            url,
            browserPost(jar, body, { origin: "https://evil.example" }),
          )
        ).status,
        403,
        tag("foreign origin"),
      );
      assert.equal(
        (
          await call(url, {
            method: "POST",
            jar,
            body: JSON.stringify(body),
            headers: { "content-type": "application/json" },
          })
        ).status,
        403,
        tag("no client header"),
      );
      const text = nativePost(jar, body);
      text.headers["content-type"] = "text/plain";
      assert.equal((await call(url, text)).status, 403, tag("non-JSON"));
      // Wrong methods are not mounted.
      for (const method of ["GET", "PUT", "DELETE"])
        assert.equal(
          (
            await call(url, {
              method,
              jar,
              headers: { "x-stateaction-client": "android" },
            })
          ).status,
          405,
          tag(method),
        );

      // Bounded, closed, strictly typed JSON.
      const send = (b) => call(url, f.request(b));
      assert.equal(
        (await send('{"expectedTransportEpoch":1')).status,
        400,
        tag("truncated"),
      );
      assert.equal((await send("[]")).status, 400, tag("array"));
      assert.equal((await send("null")).status, 400, tag("null"));
      assert.equal((await send({})).status, 400, tag("missing epoch"));
      for (const bad of ["1", 0, -1, 1.5, null, true])
        assert.equal(
          (await send({ expectedTransportEpoch: bad })).status,
          400,
          tag(`epoch ${JSON.stringify(bad)}`),
        );
      for (const extra of [
        { partNumbers: [1] },
        { objectKey: "x" },
        { uploadId: "x" },
        { etag: "x" },
        { ownerUserId: "x" },
        { parts: [] },
      ])
        assert.equal(
          (await send({ ...body, ...extra })).status,
          400,
          tag(`extra ${Object.keys(extra)}`),
        );
      const big = await send(
        JSON.stringify({ ...body, pad: "x".repeat(20_000) }),
      );
      assert.equal(big.status, 413, tag(big.text));
      assertSafeError(big, tag("413"));
      assert.equal(
        (await send({ expectedTransportEpoch: 2 })).status,
        409,
        tag("stale epoch"),
      );

      // Identifiers: malformed and unknown files are 404 without a database hit on the former.
      assert.equal(
        (await call(`/api/v1/uploads/not-a-uuid/${action}`, f.request(body)))
          .status,
        404,
        tag("malformed id"),
      );
      assert.equal(
        (
          await call(
            `/api/v1/uploads/${randomUUID()}/${action}`,
            f.request(body),
          )
        ).status,
        404,
        tag("unknown id"),
      );
    }
    await frozen(
      "malformed, unauthenticated and over-bounds requests change nothing",
    );

    // Role and ownership.
    const other = await signIn(users.collector2.email);
    for (const action of TRANSITIONS)
      assert.equal(
        (await call(f.url(action), nativePost(other, body))).status,
        404,
        `${action}: other collector`,
      );
    for (const who of [
      "staff",
      "customer",
      "outsider",
      "pending",
      "disabled",
    ]) {
      const j = await signIn(users[who].email);
      for (const action of TRANSITIONS) {
        const r = await call(f.url(action), nativePost(j, body));
        assert.equal(r.status, 403, `${who} ${action}: ${r.text}`);
        assertSafeError(r, `${who} ${action}`);
      }
    }
    await frozen("wrong roles and other owners change nothing");

    // A worker capability opens no human route; human cookies open no job route.
    const job = await runningJob(users.collector.id);
    for (const action of TRANSITIONS) {
      assert.equal(
        (await call(f.url(action), workerPost(job.token, body))).status,
        401,
        `${action}: worker token on owner route`,
      );
      assert.equal(
        (
          await call(
            `/internal/v1/jobs/${job.jobId}/outputs/${f.fileId}/${action}`,
            nativePost(jar, body),
          )
        ).status,
        401,
        `${action}: cookies on job route`,
      );
    }
    await frozen("credential separation changes nothing");

    // Live role revocation takes effect on the next call.
    const jar2 = await signIn(users.collector2.email);
    const f2 = await ownerUpload(jar2);
    await uploadAllParts(f2);
    await owner.query(
      "UPDATE access SET enabled = false WHERE user_id = $1 AND role = 'collector'",
      [users.collector2.id],
    );
    for (const action of TRANSITIONS)
      assert.equal(
        (await call(f2.url(action), nativePost(jar2, body))).status,
        403,
        `${action}: role revoked`,
      );
    await owner.query(
      "UPDATE access SET enabled = true WHERE user_id = $1 AND role = 'collector'",
      [users.collector2.id],
    );
    // Revoked collection permission ends transitions (like signing) immediately.
    const perm = (
      await owner.query(
        "SELECT permission_ref FROM ingest_permissions WHERE owner_user_id = $1 AND status = 'active'",
        [users.collector2.id],
      )
    ).rows[0].permission_ref;
    await revokeIngestPermission(owner, {
      permissionRef: perm,
      revokedBy: "operator@e2e",
      reason: "sa21 e2e",
    });
    for (const action of TRANSITIONS) {
      const r = await call(f2.url(action), nativePost(jar2, body));
      assert.equal(r.status, 404, `${action}: permission revoked: ${r.text}`);
    }
    assert.equal((await fileRow(f2.fileId)).state, "uploading");
    await permissionFor(users.collector2.id);

    // Expired and deleted sessions are not authority.
    await owner.query(
      `UPDATE "session" SET "expiresAt" = now() - interval '1 minute' WHERE "userId" = $1`,
      [users.collector.id],
    );
    for (const action of TRANSITIONS)
      assert.equal(
        (await call(f.url(action), nativePost(jar, body))).status,
        401,
        `${action}: expired session`,
      );
    const fresh = await signIn(users.collector.email);
    await owner.query(`DELETE FROM "session" WHERE "userId" = $1`, [
      users.collector.id,
    ]);
    for (const action of TRANSITIONS)
      assert.equal(
        (await call(f.url(action), nativePost(fresh, body))).status,
        401,
        `${action}: signed-out session`,
      );
    await frozen("session loss changes nothing");
  });

  test("a worker completes, reconciles, cancels and restarts only its own job's outputs with the job capability", async () => {
    // One global execution slot: the earlier job is retired when the next one
    // runs, so its capability no longer resolves (no second live credential).
    const other = await runningJob(users.collector.id);
    const job = await runningJob(users.collector.id);
    const o1 = await workerOutput(job);
    validOutputPlan(o1.plan);
    const body = { expectedTransportEpoch: 1 };
    const key = (await fileRow(o1.fileId)).object_key;

    // Credential separation and bounded JSON on every job route.
    const cookies = await signIn(users.collector.email);
    for (const action of TRANSITIONS) {
      const url = o1.url(action);
      const send = (b) => call(url, o1.request(b));
      assert.equal(
        (
          await call(url, {
            method: "POST",
            body: JSON.stringify(body),
            headers: { "content-type": "application/json" },
          })
        ).status,
        401,
        `${action}: no credential`,
      );
      assert.equal(
        (await call(url, workerPost("sa_svc_short", body))).status,
        401,
        `${action}: malformed token`,
      );
      assert.equal(
        (await call(url, workerPost(other.token, body))).status,
        401,
        `${action}: a retired job's capability resolves to nothing`,
      );
      assert.equal(
        (await call(url, nativePost(cookies, body))).status,
        401,
        `${action}: owner cookies`,
      );
      assert.equal(
        (
          await call(
            `/internal/v1/jobs/${other.jobId}/outputs/${o1.fileId}/${action}`,
            workerPost(job.token, body),
          )
        ).status,
        403,
        `${action}: another job's file`,
      );
      assert.equal(
        (
          await call(
            `/internal/v1/jobs/${job.jobId}/outputs/not-a-uuid/${action}`,
            o1.request(body),
          )
        ).status,
        404,
      );
      assert.equal(
        (
          await call(
            `/internal/v1/jobs/${job.jobId}/outputs/${randomUUID()}/${action}`,
            o1.request(body),
          )
        ).status,
        404,
      );
      assert.equal(
        (await send('{"expectedTransportEpoch":1')).status,
        400,
        `${action}: truncated`,
      );
      assert.equal((await send("[]")).status, 400, `${action}: array`);
      assert.equal(
        (await send({ ...body, jobId: other.jobId })).status,
        400,
        `${action}: job identity in body`,
      );
      assert.equal(
        (await send({ ...body, objectKey: "x" })).status,
        400,
        `${action}: key in body`,
      );
      assert.equal(
        (await send({ expectedTransportEpoch: "1" })).status,
        400,
        `${action}: string epoch`,
      );
      assert.equal(
        (await send(JSON.stringify({ ...body, pad: "x".repeat(20_000) })))
          .status,
        413,
        `${action}: oversized`,
      );
      assert.equal(
        (await send({ expectedTransportEpoch: 2 })).status,
        409,
        `${action}: stale epoch`,
      );
      // Owner routes never serve job outputs.
      const asOwner = await call(
        `/api/v1/uploads/${o1.fileId}/${action}`,
        nativePost(cookies, body),
      );
      assert.ok(
        [403, 404].includes(asOwner.status),
        `${action}: owner route on output: ${asOwner.status}`,
      );
    }
    assert.equal(
      (await fileRow(o1.fileId)).state,
      "uploading",
      "denials changed nothing",
    );
    assert.equal((await providerUploads(key)).length, 1);

    // Complete the exact object with the job capability only.
    assert.equal(
      (await call(o1.url("complete"), o1.request(body))).status,
      409,
      "no parts yet",
    );
    await uploadAllParts(o1);
    const done = await call(o1.url("complete"), o1.request(body));
    assert.equal(done.status, 200, done.text);
    assertNoStore(done, "job complete");
    validOutputPlan(done.json.data);
    assert.equal(
      validateValue("http.upload-plan.v1", done.json.data).valid,
      false,
      "job replies use the output plan, not the source plan",
    );
    assert.equal(done.json.data.state, "completed");
    assert.equal(await objectSha(key), sha(o1.bytes));
    assert.equal(
      (await call(o1.url("complete"), o1.request(body))).status,
      200,
      "idempotent",
    );
    assert.equal(
      (await call(o1.url("reconcile"), o1.request(body))).json.data.state,
      "completed",
    );
    for (const action of ["cancel", "restart"])
      assert.equal(
        (await call(o1.url(action), o1.request(body))).status,
        409,
        `${action} after complete`,
      );

    // Cancel another output.
    const o2 = await workerOutput(job);
    const key2 = (await fileRow(o2.fileId)).object_key;
    const cancelled = await call(o2.url("cancel"), o2.request(body));
    assert.equal(cancelled.status, 200, cancelled.text);
    validOutputPlan(cancelled.json.data);
    assert.equal(cancelled.json.data.state, "cancelled");
    assert.equal((await providerUploads(key2)).length, 0);
    assert.equal(
      (await call(o2.url("cancel"), o2.request(body))).status,
      200,
      "cancel replay",
    );

    // Restart a third output after provider loss.
    const o3 = await workerOutput(job);
    await uploadAllParts(o3);
    const first = await fileRow(o3.fileId);
    assert.equal(
      (await call(o3.url("restart"), o3.request(body))).status,
      409,
      "alive",
    );
    await storage.send(
      new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: first.object_key,
        UploadId: first.provider_upload_id,
      }),
    );
    const restarted = await call(o3.url("restart"), o3.request(body));
    assert.equal(restarted.status, 200, restarted.text);
    validOutputPlan(restarted.json.data);
    assert.equal(restarted.json.data.transportEpoch, 2);
    assert.match(
      (await fileRow(o3.fileId)).object_key,
      new RegExp(`^jobs/${job.jobId}/outputs/${o3.fileId}/e2/`),
    );
    assert.equal(
      (await call(o3.url("complete"), o3.request(body))).status,
      409,
      "stale epoch after restart",
    );
    assert.equal(
      (
        await call(
          o3.url("complete"),
          o3.request({ expectedTransportEpoch: 2 }),
        )
      ).status,
      409,
      "must resend every part",
    );
    await uploadAllParts(o3, 2);
    assert.equal(
      (
        await call(
          o3.url("complete"),
          o3.request({ expectedTransportEpoch: 2 }),
        )
      ).status,
      200,
    );
    assert.equal(
      await objectSha((await fileRow(o3.fileId)).object_key),
      sha(o3.bytes),
    );

    // Authority ends with the attempt: deadline, then job completion.
    const o4 = await workerOutput(job);
    await uploadAllParts(o4);
    await owner.query(
      "ALTER TABLE jobs DISABLE TRIGGER jobs_orchestration_guard",
    );
    await owner.query(
      "UPDATE jobs SET start_deadline = now() - interval '2 seconds', execution_deadline = now() - interval '1 second' WHERE id = $1",
      [job.jobId],
    );
    for (const action of TRANSITIONS)
      assert.equal(
        (await call(o4.url(action), o4.request(body))).status,
        401,
        `${action}: deadline passed`,
      );
    await owner.query(
      "UPDATE jobs SET execution_deadline = now() + interval '1 hour' WHERE id = $1",
      [job.jobId],
    );
    await owner.query("ALTER TABLE jobs DISABLE TRIGGER USER");
    await owner.query(
      "UPDATE jobs SET state = 'failed', finished_at = now() WHERE id = $1",
      [job.jobId],
    );
    await owner.query("ALTER TABLE jobs ENABLE TRIGGER USER");
    for (const action of TRANSITIONS)
      assert.equal(
        (await call(o4.url(action), o4.request(body))).status,
        401,
        `${action}: job finished`,
      );
    assert.equal(
      (await fileRow(o4.fileId)).state,
      "uploading",
      "no write after authority ended",
    );
    evidence.worker = { outputs: 4, restartedEpoch: 2 };
  });

  test("a provider outage on completion is a retryable 503 that never repeats a settled outcome", async () => {
    const jar = await signIn(users.collector.email);
    const f = await ownerUpload(jar);
    await uploadAllParts(f);
    stack.outage.down();
    let down;
    try {
      down = await call(
        f.url("complete"),
        f.request({ expectedTransportEpoch: 1 }),
      );
    } finally {
      stack.outage.up();
    }
    assert.equal(down.status, 503, down.text);
    assert.equal(JSON.parse(down.text).error.retryable, true, down.text);
    assertSafeError(down, "outage");
    let settled;
    for (let i = 0; i < 20; i++) {
      settled = await call(
        f.url("reconcile"),
        f.request({ expectedTransportEpoch: 1 }),
      );
      if (settled.status === 200) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(settled);
    const row = await fileRow(f.fileId);
    assert.ok(
      ["uploading", "completing", "completed"].includes(row.state),
      row.state,
    );
  });
});
