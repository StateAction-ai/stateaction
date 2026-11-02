// REAL MULTIPART E2E (SA-20 x SA-19 x SA-15 x SA-13): the production
// `next build` output served by `next start`, real Better Auth sessions and
// catalog access rows, a throwaway Postgres migrated by the published
// migrator (Next connects ONLY as the restricted `stateaction_app` role) and
// a throwaway SeaweedFS S3. Media bytes go straight from this test (the
// client) to the presigned provider URL; the API only sees bounded JSON.
// Operator actions (permission evidence, role/session changes, the worker
// capability that the processing controller will issue) use the migration
// owner credential. Complete/reconcile/cancel are SA-21: the test completes
// the provider upload directly with the SDK only to prove receipts are usable.
// Not Google, native app, R2, Tailscale or hosted qualification.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { startCatalogPostgres } from "../../../packages/server/test-auth/postgres.mjs";
import { startSeaweedfs } from "./seaweedfs.mjs";

const webDir = fileURLToPath(new URL("..", import.meta.url));
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

const nextBin = createRequire(join(webDir, "package.json")).resolve(
  "next/dist/bin/next",
);
const PASSWORD = "e2e-only " + randomBytes(9).toString("base64url");
const SESSION = "better-auth.session_token";
const sha = (b) => createHash("sha256").update(b).digest("hex");

let db, s3, next, origin, users, env, owner, app, storage;
let logs = "";
const evidence = {};

async function freePort() {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}

let ipCounter = 0;
class Jar {
  cookies = new Map();
  // TEST-ONLY simulated client address for Better Auth's per-IP limiter.
  ip = `198.51.100.${++ipCounter}`;
  apply(headers) {
    for (const line of [headers["set-cookie"] ?? []].flat()) {
      const [pair] = line.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (/max-age=0/i.test(line) || !value) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

function call(path, { method = "GET", body, headers = {}, jar } = {}) {
  const h = { ...headers };
  if (jar?.cookies.size) h.cookie = jar.header();
  h["x-forwarded-for"] ??= jar?.ip ?? `198.51.100.${++ipCounter}`;
  return new Promise((resolve, reject) => {
    const req = request(origin + path, { method, headers: h }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        jar?.apply(res.headers);
        let json;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** Browser mutation: Origin + Fetch Metadata + client header + JSON. */
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
/** Native mutation (the Android app): no Origin/Fetch Metadata. */
const nativePost = (jar, body) => ({
  method: "POST",
  jar,
  body: JSON.stringify(body),
  headers: {
    "content-type": "application/json",
    "x-stateaction-client": "android",
  },
});

async function signIn(email) {
  const jar = new Jar();
  const res = await call(
    "/api/auth/sign-in/email",
    browserPost(jar, { email, password: PASSWORD }),
  );
  assert.equal(res.status, 200, `${email}: ${res.text}`);
  assert.ok(jar.cookies.get(SESSION));
  return jar;
}

before(async () => {
  [db, s3] = await Promise.all([startCatalogPostgres(), startSeaweedfs()]);
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    APP_ENV: "local",
    DATABASE_HOST: new URL(db.appUrl).hostname,
    DATABASE_PORT: new URL(db.appUrl).port,
    DATABASE_NAME: new URL(db.appUrl).pathname.slice(1),
    APP_DB_PASSWORD: decodeURIComponent(new URL(db.appUrl).password),
    BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
    AUTH_LOCAL_PASSWORD: "true",
    S3_ENDPOINT: s3.endpoint,
    S3_REGION: "us-east-1",
    S3_BUCKET: "stateaction-sa20-e2e",
    S3_ACCESS_KEY_ID: s3.accessKeyId,
    S3_SECRET_ACCESS_KEY: s3.secretAccessKey,
    PROCESSING_PROFILE_REVISION: "sa20-e2e-1",
    SUPPORTED_RGB_PROFILES: "h264_mcap_v1",
    NEXT_TELEMETRY_DISABLED: "1",
  };
  const boot = spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "test-auth/catalog-bootstrap-cli.ts",
    ],
    {
      cwd: serverDir,
      env: {
        PATH: env.PATH,
        HOME: env.HOME,
        CATALOG_OWNER_URL: db.ownerUrl,
        AUTH_TEST_PASSWORD: PASSWORD,
      },
      encoding: "utf8",
    },
  );
  assert.equal(boot.status, 0, boot.stderr);
  users = JSON.parse(boot.stdout);
  owner = new pg.Pool({ connectionString: db.ownerUrl, max: 3 });
  app = new pg.Pool({ connectionString: db.appUrl, max: 6 });
  const storageConfig = {
    endpoint: s3.endpoint,
    publicEndpoint: s3.endpoint,
    region: env.S3_REGION,
    bucket: env.S3_BUCKET,
    accessKeyId: s3.accessKeyId,
    secretAccessKey: s3.secretAccessKey,
  };
  storage = storageClient(storageConfig, 15000);
  await storage.send(new CreateBucketCommand({ Bucket: env.S3_BUCKET }));
  // A second collector (operator action, owner credential) with its own
  // recorded permission evidence, for owner isolation and role revocation.
  users.collector2 = {
    id: "sa20-collector-2",
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
      await hashCredentialPassword(PASSWORD),
    ],
  );
  await owner.query(
    "INSERT INTO access (user_id, role, enabled, granted_by) VALUES ($1, 'collector', true, 'sa20-e2e-operator')",
    [users.collector2.id],
  );
  await recordIngestPermission(owner, {
    permissionRef: "sa20-e2e-c2.r1",
    ownerUserId: users.collector2.id,
    pilotScope: "sa20-e2e",
    coversCapture: true,
    coversProcessing: true,
    evidenceRef: "doc://pilot/sa20-e2e",
    recordedBy: "operator@e2e",
  });
  next = spawn(
    process.execPath,
    [nextBin, "start", "-p", String(port), "-H", "127.0.0.1"],
    {
      cwd: webDir,
      env: { ...env, NODE_ENV: "production" },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  next.stdout.on("data", (c) => (logs += c));
  next.stderr.on("data", (c) => (logs += c));
  for (let i = 0; ; i++) {
    try {
      if ((await call("/login")).status === 200) break;
    } catch {}
    if (i > 120 || next.exitCode !== null)
      throw new Error(`next start failed:\n${logs}`);
    await sleep(500);
  }
});

after(async () => {
  if (next && next.exitCode === null) {
    try {
      process.kill(-next.pid, "SIGTERM");
    } catch {}
    await sleep(500);
  }
  storage?.destroy();
  await Promise.all([owner?.end(), app?.end()]);
  db?.stop();
  s3?.stop();
  if (process.env.SA20_E2E_EVIDENCE)
    process.stdout.write(`SA20_E2E_EVIDENCE ${JSON.stringify(evidence)}\n`);
});

const MiB = 1048576;
const nativePut = (jar, body) => ({ ...nativePost(jar, body), method: "PUT" });
const nativeGet = (jar) => ({ method: "GET", jar, headers: {} });
const assertNoStore = (res, what) =>
  assert.match(String(res.headers["cache-control"]), /no-store/, what);

async function directPut(part, body) {
  try {
    const res = await fetch(part.url, {
      method: "PUT",
      body,
      headers: part.headers,
      signal: AbortSignal.timeout(20000),
    });
    return { status: res.status, etag: res.headers.get("etag") };
  } catch (error) {
    // The provider may drop the connection instead of answering a refused body.
    return { status: 0, etag: null, error };
  }
}
const providerUploads = async (key) =>
  (
    (
      await storage.send(
        new ListMultipartUploadsCommand({ Bucket: env.S3_BUCKET, Prefix: key }),
      )
    ).Uploads ?? []
  ).filter((u) => u.Key === key);

const permissionFor = async (userId) => {
  const active = await owner.query(
    "SELECT 1 FROM ingest_permissions WHERE owner_user_id = $1 AND status = 'active'",
    [userId],
  );
  if (!active.rowCount)
    await recordIngestPermission(owner, {
      permissionRef: `sa20-${randomUUID().slice(0, 8)}`,
      ownerUserId: userId,
      pilotScope: "sa20-e2e",
      coversCapture: true,
      coversProcessing: true,
      evidenceRef: "doc://pilot/sa20-e2e",
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
      startedAt: "2026-11-01T12:00:00Z",
      device: { model: "Pixel 9", osVersion: "16", appVersion: "0.1.0" },
    }),
  );
  assert.equal(res.status, 201, res.text);
  return res.json.data.recording.recordingId;
}
const uploadBody = (recordingId, bytes, over = {}) => ({
  recordingId,
  clientUploadId: randomUUID(),
  role: "source_mcap",
  sizeBytes: String(bytes.length),
  sha256: sha(bytes),
  ...over,
});

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
    profileRevision: "sa20-e2e",
  });
  // Walk the real admission/claim state machine (owner credential fixture).
  const { capabilityToken: token } = await fixtureRunJob(owner, jobId);
  return { jobId, recordingId, token };
}
const workerPost = (token, body, method = "POST") => ({
  method,
  body: typeof body === "string" ? body : JSON.stringify(body),
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  },
});

describe("multipart upload routes on Next.js with Better Auth, admission, Postgres and SeaweedFS", () => {
  test("owner uploads a source file straight to the provider and journals exact receipts", async () => {
    await permissionFor(users.collector.id);
    const jar = await signIn(users.collector.email);
    const recordingId = await register(jar);
    const bytes = randomBytes(300_000);
    const body = uploadBody(recordingId, bytes);
    const created = await call("/api/v1/uploads", nativePost(jar, body));
    assert.equal(created.status, 200, created.text);
    assertNoStore(created, "create");
    const plan = created.json.data;
    assert.equal(plan.partCount, 1);
    assert.equal(plan.partSizeBytes, "67108864");
    assert.equal(plan.transportEpoch, 1);
    assert.deepEqual(Object.keys(plan).sort(), [
      "fileId",
      "partCount",
      "partSizeBytes",
      "recordingId",
      "role",
      "sha256",
      "sizeBytes",
      "state",
      "transportEpoch",
      "transportExpiresAt",
    ]);
    const row = (
      await owner.query(
        "SELECT object_key, provider_upload_id, owner_user_id FROM files f JOIN recordings r ON r.id = f.recording_id WHERE f.id = $1",
        [plan.fileId],
      )
    ).rows[0];
    assert.equal(
      row.object_key,
      `recordings/${recordingId}/sources/${plan.fileId}/e1/source_mcap`,
      "server-chosen private key",
    );
    assert.equal(row.owner_user_id, users.collector.id);
    assert.ok(row.provider_upload_id, "provider upload ID persisted");
    assert.equal((await providerUploads(row.object_key)).length, 1);
    // Identical replay returns the same file and creates no second upload.
    const replay = await call("/api/v1/uploads", nativePost(jar, body));
    assert.equal(replay.json.data.fileId, plan.fileId);
    assert.equal((await providerUploads(row.object_key)).length, 1);
    const got = await call(`/api/v1/uploads/${plan.fileId}`, nativeGet(jar));
    assert.equal(got.status, 200);
    assert.equal(got.json.data.fileId, plan.fileId);

    const signed = await call(
      `/api/v1/uploads/${plan.fileId}/parts/sign`,
      nativePost(jar, { expectedTransportEpoch: 1, partNumbers: [1] }),
    );
    assert.equal(signed.status, 200, signed.text);
    assertNoStore(signed, "sign");
    const part = signed.json.data.parts[0];
    assert.equal(part.lengthBytes, String(bytes.length));
    // The signed length is enforced by the provider: a longer body is refused.
    const tooLong = await directPut(
      part,
      Buffer.concat([bytes, Buffer.from("x")]),
    );
    assert.ok(
      tooLong.status === 0 || tooLong.status >= 400,
      `provider refused an over-long body: ${tooLong.status}`,
    );
    const put = await directPut(part, bytes);
    assert.equal(put.status, 200);
    assert.ok(put.etag);
    const receipt = {
      partNumber: 1,
      etag: put.etag,
      sizeBytes: String(bytes.length),
    };
    // A fabricated ETag or wrong size is never journaled.
    for (const bad of [
      { ...receipt, etag: '"' + "0".repeat(32) + '"' },
      { ...receipt, sizeBytes: String(bytes.length - 1) },
    ]) {
      const refused = await call(
        `/api/v1/uploads/${plan.fileId}/parts/receipts`,
        nativePut(jar, { expectedTransportEpoch: 1, receipts: [bad] }),
      );
      assert.ok([400, 409].includes(refused.status), refused.text);
    }
    assert.equal(
      (
        await owner.query(
          "SELECT count(*)::int n FROM file_part_receipts WHERE file_id = $1",
          [plan.fileId],
        )
      ).rows[0].n,
      0,
    );
    const ok = await call(
      `/api/v1/uploads/${plan.fileId}/parts/receipts`,
      nativePut(jar, { expectedTransportEpoch: 1, receipts: [receipt] }),
    );
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual(ok.json.data.journaled, [1]);
    const again = await call(
      `/api/v1/uploads/${plan.fileId}/parts/receipts`,
      nativePut(jar, { expectedTransportEpoch: 1, receipts: [receipt] }),
    );
    assert.deepEqual(again.json.data.alreadyJournaled, [1]);
    // The journaled receipts are usable: the object assembles to the exact bytes.
    await storage.send(
      new CompleteMultipartUploadCommand({
        Bucket: env.S3_BUCKET,
        Key: row.object_key,
        UploadId: row.provider_upload_id,
        MultipartUpload: { Parts: [{ PartNumber: 1, ETag: put.etag }] },
      }),
    );
    const object = Buffer.from(
      await (
        await storage.send(
          new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: row.object_key }),
        )
      ).Body.transformToByteArray(),
    );
    assert.equal(sha(object), body.sha256);
    evidence.owner = { fileId: plan.fileId, parts: 1, bytes: bytes.length };
  });

  test("anonymous, bearer, cross-site, header-less, non-JSON and malformed bodies are refused", async () => {
    const jar = await signIn(users.collector.email);
    const recordingId = await register(jar);
    const body = uploadBody(recordingId, randomBytes(10));
    assert.equal(
      (await call("/api/v1/uploads", nativePost(null, body))).status,
      401,
    );
    assert.equal((await call(`/api/v1/uploads/${randomUUID()}`)).status, 401);
    const bearer = nativePost(jar, body);
    bearer.headers.authorization = "Bearer stolen";
    assert.equal(
      (await call("/api/v1/uploads", bearer)).status,
      401,
      "no bearer fallback",
    );
    assert.equal(
      (
        await call(
          "/api/v1/uploads",
          browserPost(jar, body, { "sec-fetch-site": "cross-site" }),
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          "/api/v1/uploads",
          browserPost(jar, body, { origin: "https://evil.example" }),
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call("/api/v1/uploads", {
          method: "POST",
          jar,
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        })
      ).status,
      403,
    );
    const text = nativePost(jar, body);
    text.headers["content-type"] = "text/plain";
    assert.equal((await call("/api/v1/uploads", text)).status, 403);
    const created = await call("/api/v1/uploads", nativePost(jar, body));
    const { fileId } = created.json.data;
    const url = `/api/v1/uploads/${fileId}/parts/sign`;
    const sign = (b) => call(url, nativePost(jar, b));
    assert.equal(
      (await sign('{"expectedTransportEpoch":1,"partNumbers":[1')).status,
      400,
      "truncated JSON",
    );
    assert.equal((await sign("[]")).status, 400);
    assert.equal(
      (await sign({ expectedTransportEpoch: 1, partNumbers: [] })).status,
      400,
    );
    assert.equal(
      (await sign({ expectedTransportEpoch: 1, partNumbers: [1, 1] })).status,
      400,
    );
    assert.equal(
      (await sign({ expectedTransportEpoch: 1, partNumbers: [2] })).status,
      400,
      "beyond the frozen plan",
    );
    assert.equal(
      (
        await sign({
          expectedTransportEpoch: 1,
          partNumbers: Array.from({ length: 33 }, (_, i) => i + 1),
        })
      ).status,
      400,
      "at most 32 parts per control request",
    );
    assert.equal(
      (await sign({ expectedTransportEpoch: 2, partNumbers: [1] })).status,
      409,
      "stale epoch",
    );
    assert.equal(
      (
        await sign({
          expectedTransportEpoch: 1,
          partNumbers: [1],
          objectKey: "x",
        })
      ).status,
      400,
      "no client keys",
    );
    const big = await sign(
      JSON.stringify({
        expectedTransportEpoch: 1,
        partNumbers: [1],
        pad: "x".repeat(20_000),
      }),
    );
    assert.equal(big.status, 413, big.text);
    // A client-chosen key/bucket/owner/range in the create body is rejected.
    for (const extra of [
      { objectKey: "a" },
      { bucket: "b" },
      { ownerUserId: "x" },
      { partSizeBytes: "1" },
    ])
      assert.equal(
        (
          await call(
            "/api/v1/uploads",
            nativePost(jar, {
              ...body,
              clientUploadId: randomUUID(),
              ...extra,
            }),
          )
        ).status,
        400,
        JSON.stringify(extra),
      );
    assert.equal(
      (await call(`/api/v1/uploads/not-a-uuid`, nativeGet(jar))).status,
      404,
    );
  });

  test("other collectors, wrong roles, expired sessions, revoked roles and revoked permission lose access", async () => {
    const jar = await signIn(users.collector.email);
    const recordingId = await register(jar);
    const bytes = randomBytes(1000);
    const created = await call(
      "/api/v1/uploads",
      nativePost(jar, uploadBody(recordingId, bytes)),
    );
    const { fileId } = created.json.data;
    const signBody = { expectedTransportEpoch: 1, partNumbers: [1] };
    const sign = (j) =>
      call(`/api/v1/uploads/${fileId}/parts/sign`, nativePost(j, signBody));
    assert.equal((await sign(jar)).status, 200);

    // Another collector sees nothing and cannot reserve under this recording.
    const other = await signIn(users.collector2.email);
    assert.equal((await sign(other)).status, 404);
    assert.equal(
      (await call(`/api/v1/uploads/${fileId}`, nativeGet(other))).status,
      404,
    );
    assert.equal(
      (
        await call(
          "/api/v1/uploads",
          nativePost(other, uploadBody(recordingId, bytes)),
        )
      ).status,
      404,
    );
    // Humans without the collector role are refused by role.
    for (const who of [
      "staff",
      "customer",
      "outsider",
      "pending",
      "disabled",
    ]) {
      const j = await signIn(users[who].email);
      const r = await sign(j);
      assert.equal(r.status, 403, `${who}: ${r.text}`);
    }
    // Disabling the owner's collector role takes effect on the next call.
    await owner.query(
      "UPDATE access SET enabled = false WHERE user_id = $1 AND role = 'collector'",
      [users.collector2.id],
    );
    const j2 = await signIn(users.collector2.email);
    const own2 = await register(other).catch(() => null);
    assert.equal(own2, null, "register is also refused");
    assert.equal(
      (
        await call(
          "/api/v1/uploads",
          nativePost(j2, uploadBody(randomUUID(), bytes)),
        )
      ).status,
      403,
    );
    await owner.query(
      "UPDATE access SET enabled = true WHERE user_id = $1 AND role = 'collector'",
      [users.collector2.id],
    );

    // Revoked collection permission stops signing immediately.
    const jar2 = await signIn(users.collector2.email);
    const rec2 = await register(jar2);
    const f2 = (
      await call("/api/v1/uploads", nativePost(jar2, uploadBody(rec2, bytes)))
    ).json.data.fileId;
    const sign2 = () =>
      call(`/api/v1/uploads/${f2}/parts/sign`, nativePost(jar2, signBody));
    assert.equal((await sign2()).status, 200);
    const perm = (
      await owner.query(
        "SELECT permission_ref FROM ingest_permissions WHERE owner_user_id = $1 AND status = 'active'",
        [users.collector2.id],
      )
    ).rows[0].permission_ref;
    await revokeIngestPermission(owner, {
      permissionRef: perm,
      revokedBy: "operator@e2e",
      reason: "sa20 e2e",
    });
    assert.equal((await sign2()).status, 404, "revoked permission evidence");

    // An expired session row is not authority even if the cookie is replayed.
    await owner.query(
      `UPDATE "session" SET "expiresAt" = now() - interval '1 minute' WHERE "userId" = $1`,
      [users.collector.id],
    );
    assert.equal((await sign(jar)).status, 401);
    // Signing out (session deleted) revokes it too.
    const fresh = await signIn(users.collector.email);
    assert.equal((await sign(fresh)).status, 200);
    await owner.query(`DELETE FROM "session" WHERE "userId" = $1`, [
      users.collector.id,
    ]);
    assert.equal((await sign(fresh)).status, 401);
  });

  test("concurrent identical reservations and receipts produce one provider upload and one receipt", async () => {
    const jar = await signIn(users.collector.email);
    const recordingId = await register(jar);
    const bytes = randomBytes(5000);
    const body = uploadBody(recordingId, bytes);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        call("/api/v1/uploads", nativePost(jar, body)),
      ),
    );
    assert.ok(
      results.every((r) => r.status === 200),
      results.map((r) => r.text).join(),
    );
    const ids = new Set(results.map((r) => r.json.data.fileId));
    assert.equal(ids.size, 1);
    const { fileId } = results[0].json.data;
    const key = (
      await owner.query("SELECT object_key FROM files WHERE id = $1", [fileId])
    ).rows[0].object_key;
    assert.equal((await providerUploads(key)).length, 1);
    const signed = await call(
      `/api/v1/uploads/${fileId}/parts/sign`,
      nativePost(jar, { expectedTransportEpoch: 1, partNumbers: [1] }),
    );
    const put = await directPut(signed.json.data.parts[0], bytes);
    const receipts = {
      expectedTransportEpoch: 1,
      receipts: [
        { partNumber: 1, etag: put.etag, sizeBytes: String(bytes.length) },
      ],
    };
    const raced = await Promise.all(
      Array.from({ length: 6 }, () =>
        call(
          `/api/v1/uploads/${fileId}/parts/receipts`,
          nativePut(jar, receipts),
        ),
      ),
    );
    assert.ok(
      raced.every((r) => r.status === 200),
      raced.map((r) => r.text).join(),
    );
    assert.equal(
      (
        await owner.query(
          "SELECT count(*)::int n FROM file_part_receipts WHERE file_id = $1",
          [fileId],
        )
      ).rows[0].n,
      1,
    );
    // Same clientUploadId with different content conflicts.
    const conflict = await call(
      "/api/v1/uploads",
      nativePost(jar, { ...body, sha256: sha("other") }),
    );
    assert.ok([409, 400].includes(conflict.status), conflict.text);
  });

  test("a worker reserves, signs and journals its own job output with the job-bound capability only", async () => {
    await permissionFor(users.collector.id);
    const job = await runningJob(users.collector.id);
    const other = await runningJob(users.collector.id);
    const base = `/internal/v1/jobs/${job.jobId}/outputs`;
    const bytes = randomBytes(2048);
    const out = {
      slot: "clips/0001/rgb.mp4",
      role: "clip_mp4",
      sizeBytes: String(bytes.length),
      sha256: sha(bytes),
    };
    // No credential, malformed credential, another job's credential, owner cookies.
    assert.equal(
      (
        await call(base, {
          method: "POST",
          body: JSON.stringify(out),
          headers: { "content-type": "application/json" },
        })
      ).status,
      401,
    );
    assert.equal(
      (await call(base, workerPost("sa_svc_short", out))).status,
      401,
    );
    assert.equal((await call(base, workerPost(other.token, out))).status, 403);
    const cookies = await signIn(users.collector.email);
    assert.equal(
      (await call(base, nativePost(cookies, out))).status,
      401,
      "human cookies never reach job routes",
    );
    const created = await call(base, workerPost(job.token, out));
    assert.equal(created.status, 200, created.text);
    assertNoStore(created, "output create");
    const plan = created.json.data;
    // The published (catalog.v5) contracts, not a private validator.
    const { validateValue } = await import(
      new URL("../../../packages/contracts/dist/index.js", import.meta.url).href
    );
    assert.equal(validateValue("http.output-create.v1", out).valid, true);
    assert.equal(validateValue("http.output-plan.v1", plan).valid, true);
    assert.equal(
      validateValue("http.upload-plan.v1", plan).valid,
      false,
      "output role is not a source plan",
    );
    const row = (
      await owner.query(
        "SELECT object_key, purpose, job_id FROM files WHERE id = $1",
        [plan.fileId],
      )
    ).rows[0];
    assert.equal(row.purpose, "output");
    assert.equal(row.job_id, job.jobId);
    assert.equal(
      row.object_key,
      `jobs/${job.jobId}/outputs/${plan.fileId}/e1/clips/0001/rgb.mp4`,
    );
    // Slot idempotency and conflict.
    assert.equal(
      (await call(base, workerPost(job.token, out))).json.data.fileId,
      plan.fileId,
    );
    assert.equal(
      (await call(base, workerPost(job.token, { ...out, sha256: sha("x") })))
        .status,
      409,
    );
    // Closed body: a worker cannot choose keys or buckets; unsafe slots refused.
    for (const bad of [
      { ...out, objectKey: "x" },
      { ...out, slot: "../x" },
      { ...out, role: "source_mcap" },
    ])
      assert.equal(
        (await call(base, workerPost(job.token, bad))).status,
        400,
        JSON.stringify(bad),
      );
    // Owner/job identity fields and an oversized body are refused by the contract cap.
    for (const extra of [{ jobId: other.jobId }, { ownerUserId: "x" }])
      assert.equal(
        (await call(base, workerPost(job.token, { ...out, ...extra }))).status,
        400,
        JSON.stringify(extra),
      );
    assert.equal(
      (
        await call(
          base,
          workerPost(job.token, { ...out, pad: "x".repeat(5000) }),
        )
      ).status,
      413,
    );
    const one = `${base}/${plan.fileId}`;
    const fetched = await call(one, {
      method: "GET",
      headers: { authorization: `Bearer ${job.token}` },
    });
    assert.equal(fetched.status, 200);
    assert.equal(
      validateValue("http.output-plan.v1", fetched.json.data).valid,
      true,
    );
    assert.equal(
      (
        await call(`${base.replace(job.jobId, other.jobId)}/${plan.fileId}`, {
          method: "GET",
          headers: { authorization: `Bearer ${other.token}` },
        })
      ).status,
      403,
      "another job's file",
    );
    const signed = await call(
      `${one}/parts/sign`,
      workerPost(job.token, { expectedTransportEpoch: 1, partNumbers: [1] }),
    );
    assert.equal(signed.status, 200, signed.text);
    assert.equal(
      validateValue("http.parts-signed.v1", signed.json.data).valid,
      true,
    );
    const put = await directPut(signed.json.data.parts[0], bytes);
    const rec = await call(
      `${one}/parts/receipts`,
      workerPost(
        job.token,
        {
          expectedTransportEpoch: 1,
          receipts: [
            { partNumber: 1, etag: put.etag, sizeBytes: String(bytes.length) },
          ],
        },
        "PUT",
      ),
    );
    assert.equal(rec.status, 200, rec.text);
    assert.deepEqual(rec.json.data.journaled, [1]);
    // The capability does not open human routes, and humans cannot touch outputs.
    const asHuman = {
      ...workerPost(job.token, { expectedTransportEpoch: 1, partNumbers: [1] }),
    };
    assert.equal(
      (await call(`/api/v1/uploads/${plan.fileId}/parts/sign`, asHuman)).status,
      401,
    );
    assert.equal(
      (
        await call(
          `/api/v1/uploads/${plan.fileId}/parts/sign`,
          nativePost(cookies, { expectedTransportEpoch: 1, partNumbers: [1] }),
        )
      ).status,
      403,
    );
    // Authority ends with the attempt: deadline passed, then job finished.
    await owner.query(
      "ALTER TABLE jobs DISABLE TRIGGER jobs_orchestration_guard",
    );
    await owner.query(
      "UPDATE jobs SET start_deadline = now() - interval '2 seconds', execution_deadline = now() - interval '1 second' WHERE id = $1",
      [job.jobId],
    );
    assert.equal(
      (
        await call(
          `${one}/parts/sign`,
          workerPost(job.token, {
            expectedTransportEpoch: 1,
            partNumbers: [1],
          }),
        )
      ).status,
      401,
    );
    await owner.query(
      "UPDATE jobs SET execution_deadline = now() + interval '1 hour' WHERE id = $1",
      [job.jobId],
    );
    await owner.query(
      "ALTER TABLE jobs ENABLE TRIGGER jobs_orchestration_guard",
    );
    assert.equal(
      (
        await call(
          `${one}/parts/sign`,
          workerPost(job.token, {
            expectedTransportEpoch: 1,
            partNumbers: [1],
          }),
        )
      ).status,
      200,
    );
    await owner.query("ALTER TABLE jobs DISABLE TRIGGER USER");
    await owner.query(
      "UPDATE jobs SET state = 'failed', finished_at = now() WHERE id = $1",
      [job.jobId],
    );
    await owner.query("ALTER TABLE jobs ENABLE TRIGGER USER");
    assert.equal(
      (
        await call(
          `${one}/parts/sign`,
          workerPost(job.token, {
            expectedTransportEpoch: 1,
            partNumbers: [1],
          }),
        )
      ).status,
      401,
    );
    evidence.worker = { fileId: plan.fileId, parts: 1 };
  });

  test("provider outage is a private retryable 503 that issues no URL, then recovers", async () => {
    const jar = await signIn(users.collector.email);
    const recordingId = await register(jar);
    const bytes = randomBytes(100);
    const created = await call(
      "/api/v1/uploads",
      nativePost(jar, uploadBody(recordingId, bytes)),
    );
    const { fileId } = created.json.data;
    const pausedBody = uploadBody(recordingId, randomBytes(50), {
      role: "recorder_metadata",
    });
    execFileSync("docker", ["pause", s3.name]);
    let down;
    try {
      // ListParts-free sign path still presigns locally; the outage shows on
      // a fresh reservation (provider create) and on receipt corroboration.
      down = await call("/api/v1/uploads", nativePost(jar, pausedBody));
      const rec = await call(
        `/api/v1/uploads/${fileId}/parts/receipts`,
        nativePut(jar, {
          expectedTransportEpoch: 1,
          receipts: [{ partNumber: 1, etag: "abc", sizeBytes: "100" }],
        }),
      );
      assert.equal(rec.status, 503, rec.text);
      assert.equal(rec.json.error.retryable, true);
    } finally {
      execFileSync("docker", ["unpause", s3.name]);
    }
    assert.equal(down.status, 503, down.text);
    assert.doesNotMatch(down.text, /http:\/\/|X-Amz|secret/i);
    assert.equal(
      (
        await owner.query(
          "SELECT count(*)::int n FROM file_part_receipts WHERE file_id = $1",
          [fileId],
        )
      ).rows[0].n,
      0,
    );
    // After recovery the reservation is retried safely (the uncertain create is reconciled).
    let retry;
    for (let i = 0; i < 20; i++) {
      retry = await call("/api/v1/uploads", nativePost(jar, pausedBody));
      if (retry.status === 200) break;
      await sleep(500);
    }
    assert.equal(retry.status, 200, retry.text);
  });
});
