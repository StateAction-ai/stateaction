// REAL RECORDING-ADMISSION E2E (SA-19 x SA-15 x SA-13 x SA-14): the
// production `next build` output served by `next start`, real Better Auth
// sessions/cookies and catalog access rows, a throwaway Postgres migrated by
// the published migrator (Next connects ONLY as the restricted
// `stateaction_app` role) and a throwaway SeaweedFS S3 holding the source
// manifest the server reads with its bounded storage reader. Operator actions
// (permission evidence, role changes) use the migration owner credential.
// Source-file reservation and final completion call the SA-13 catalog and the
// SA-19 completion helper directly: the SA-20/21 multipart routes come later,
// and no MCAP/media bytes go through the API. Not Google, native app, R2,
// Tailscale or hosted qualification.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, request } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { validateValue } from "@stateaction/contracts";
import { startCatalogPostgres } from "../../../packages/server/test-auth/postgres.mjs";
import { startSeaweedfs } from "./seaweedfs.mjs";

const webDir = fileURLToPath(new URL("..", import.meta.url));
const serverDir = fileURLToPath(
  new URL("../../../packages/server/", import.meta.url),
);
const serverRequire = createRequire(join(serverDir, "package.json"));
const pg = serverRequire("pg");
const { CreateBucketCommand, PutObjectCommand } =
  serverRequire("@aws-sdk/client-s3");
// Built server modules (no `server-only` entry point): the same code the
// routes run, used here only for operator and future-transport steps.
const dist = (p) => import(new URL(`dist/${p}`, `file://${serverDir}`).href);
const { recordSourceCompletion } = await dist("admission/recordings.js");
const { s3ObjectReader } = await dist("admission/object-reader.js");
const { recordIngestPermission, revokeIngestPermission } = await dist(
  "admission/permissions.js",
);
const { reserveSourceFile, sourceObjectKey } = await dist("catalog/catalog.js");
const { hashCredentialPassword } = await dist("catalog/password.js");
const { storageClient } = await dist("storage.js");

const nextBin = createRequire(join(webDir, "package.json")).resolve(
  "next/dist/bin/next",
);
const PASSWORD = "e2e-only " + randomBytes(9).toString("base64url");
const SESSION = "better-auth.session_token";
const MiB = 1048576;
const sha = (b) => createHash("sha256").update(b).digest("hex");

let db, s3, next, origin, users, env, owner, app, storage, deps;
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

function assertNoStore(res, what) {
  assert.match(String(res.headers["cache-control"]), /no-store/, what);
  assert.doesNotMatch(String(res.headers["cache-control"]), /public/, what);
}

const createBody = (clientRecordingId = randomUUID()) => ({
  clientRecordingId,
  captureFormat: "stateaction.capture.v1",
  rgbProfile: "h264_mcap_v1",
  startedAt: "2026-11-01T12:00:00Z",
  device: { model: "Pixel 9", osVersion: "16", appVersion: "0.1.0" },
});

const activeRef = async (userId) =>
  (
    await owner.query(
      "SELECT permission_ref FROM ingest_permissions WHERE owner_user_id = $1 AND status = 'active'",
      [userId],
    )
  ).rows[0]?.permission_ref;

/**
 * Registers over HTTP, then reserves the source inventory through the SA-13
 * catalog (SA-20 transport stand-in) and stores the exact manifest bytes in
 * S3. The manifest copies the server-returned collectionPermissionRef.
 */
async function prepared(jar, userId, { oversizeStored = false } = {}) {
  const clientRecordingId = randomUUID();
  const created = await call(
    "/api/v1/recordings",
    nativePost(jar, createBody(clientRecordingId)),
  );
  assert.equal(created.status, 201, created.text);
  const { recording, collectionPermissionRef } = created.json.data;
  const recordingId = recording.recordingId;
  const files = [];
  for (const role of ["source_mcap", "recorder_metadata"]) {
    const fileId = randomUUID();
    const body = Buffer.from(`${role}:${fileId}`);
    files.push({
      fileId,
      role,
      sizeBytes: String(body.byteLength),
      sha256: sha(body),
    });
  }
  const manifest = Buffer.from(
    JSON.stringify({
      schema: "stateaction.recording_source.v1",
      recording_id: recordingId,
      client_recording_id: clientRecordingId,
      owner_user_id: userId,
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
      clock_domains: ["android.elapsed_realtime", "android.sensor_event"],
      channels: [
        {
          topic: "/camera/rgb",
          message_encoding: "protobuf",
          schema_name: "foxglove.CompressedVideo",
          clock_domain: "android.elapsed_realtime",
          message_count: "30",
        },
        {
          topic: "/imu",
          message_encoding: "protobuf",
          schema_name: "stateaction.Imu",
          clock_domain: "android.sensor_event",
          message_count: "200",
        },
      ],
      counts: {
        video_frames: "30",
        dropped_video_frames: "0",
        motion_events: "200",
      },
      collection_permission_ref: collectionPermissionRef,
      source_verification: "pending",
    }),
  );
  const manifestId = randomUUID();
  files.push({
    fileId: manifestId,
    role: "source_manifest",
    sizeBytes: String(manifest.byteLength),
    sha256: sha(manifest),
  });
  for (const f of files)
    await reserveSourceFile(app, {
      fileId: f.fileId,
      recordingId,
      ownerUserId: userId,
      clientUploadId: randomUUID(),
      role: f.role,
      sizeBytes: f.sizeBytes,
      sha256: f.sha256,
      required: true,
      partSizeBytes: "67108864",
      partCount: 1,
    });
  await storage.send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: sourceObjectKey(recordingId, manifestId, 1, "source_manifest"),
      Body: oversizeStored ? randomBytes(MiB + 1) : manifest,
    }),
  );
  const seal = {
    files: files.map((f) => ({ ...f, required: true })),
  };
  const complete = (role) => {
    const f = files.find((x) => x.role === role);
    return recordSourceCompletion(
      deps,
      { userId },
      {
        recordingId,
        fileId: f.fileId,
        expectedTransportEpoch: 1,
        observedSizeBytes: f.sizeBytes,
      },
    );
  };
  return {
    recordingId,
    clientRecordingId,
    collectionPermissionRef,
    seal,
    complete,
  };
}

const jobsOf = async (recordingId) =>
  (
    await owner.query(
      "SELECT id, state, source_manifest_sha256 FROM jobs WHERE recording_id = $1",
      [recordingId],
    )
  ).rows;

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
    // External fixtures hand out a run-owned, already-created bucket.
    S3_BUCKET: s3.bucket ?? "stateaction-e2e",
    S3_ACCESS_KEY_ID: s3.accessKeyId,
    S3_SECRET_ACCESS_KEY: s3.secretAccessKey,
    PROCESSING_PROFILE_REVISION: "sa19-e2e-1",
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
  if (!s3.bucket)
    await storage.send(new CreateBucketCommand({ Bucket: env.S3_BUCKET }));
  deps = {
    pool: app,
    reader: s3ObjectReader(storageConfig),
    config: {
      processingProfileRevision: env.PROCESSING_PROFILE_REVISION,
      supportedRgbProfiles: ["h264_mcap_v1"],
    },
  };
  // A second collector (operator action, owner credential) with its own
  // recorded permission evidence, for owner isolation and role revocation.
  users.collector2 = {
    id: "sa19-collector-2",
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
    "INSERT INTO access (user_id, role, enabled, granted_by) VALUES ($1, 'collector', true, 'sa19-e2e-operator')",
    [users.collector2.id],
  );
  await recordIngestPermission(owner, {
    permissionRef: "sa19-e2e-c2.r1",
    ownerUserId: users.collector2.id,
    pilotScope: "sa19-e2e",
    coversCapture: true,
    coversProcessing: true,
    evidenceRef: "doc://pilot/sa19-e2e",
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
  await db?.stop();
  await s3?.stop();
  if (process.env.SA19_E2E_EVIDENCE)
    process.stdout.write(`SA19_E2E_EVIDENCE ${JSON.stringify(evidence)}\n`);
});

describe("recording routes on Next.js with Better Auth, catalog and S3", () => {
  test("anonymous, bearer, cross-site and header-less requests are refused privately", async () => {
    const registrations = async () =>
      (
        await owner.query(
          "SELECT count(*)::int AS n FROM recording_registrations",
        )
      ).rows[0].n;
    const baseline = await registrations(); // the local seed's fixture row
    const anon = await call(
      "/api/v1/recordings",
      nativePost(null, createBody()),
    );
    assert.equal(anon.status, 401);
    assertNoStore(anon, "anonymous create");
    assert.equal(anon.json.error.code, "unauthenticated");
    const jar = await signIn(users.collector.email);
    const bearer = await call("/api/v1/recordings", {
      ...nativePost(jar, createBody()),
      headers: {
        ...nativePost(jar, createBody()).headers,
        authorization: "Bearer stolen",
      },
    });
    assert.equal(bearer.status, 401, "no bearer fallback on a human route");
    const crossSite = await call(
      "/api/v1/recordings",
      browserPost(jar, createBody(), { "sec-fetch-site": "cross-site" }),
    );
    assert.equal(crossSite.status, 403);
    const foreignOrigin = await call(
      "/api/v1/recordings",
      browserPost(jar, createBody(), { origin: "https://evil.example" }),
    );
    assert.equal(foreignOrigin.status, 403);
    const noHeader = await call("/api/v1/recordings", {
      method: "POST",
      jar,
      body: JSON.stringify(createBody()),
      headers: { "content-type": "application/json" },
    });
    assert.equal(noHeader.status, 403);
    const anonGet = await call(`/api/v1/recordings/${randomUUID()}`);
    assert.equal(anonGet.status, 401);
    assertNoStore(anonGet, "anonymous get");
    const staff = await signIn(users.staff.email);
    const staffCreate = await call(
      "/api/v1/recordings",
      browserPost(staff, createBody()),
    );
    assert.equal(staffCreate.status, 403, "collector role required");
    assert.equal(
      await registrations(),
      baseline,
      "no refused request registered anything",
    );
  });

  test("collector create: contract response, exact replay 200, changed request 409", async () => {
    const jar = await signIn(users.collector.email);
    const body = createBody();
    const created = await call("/api/v1/recordings", browserPost(jar, body));
    assert.equal(created.status, 201, created.text);
    assertNoStore(created, "create");
    assert.equal(
      validateValue("http.success-envelope.v1", created.json).valid,
      true,
    );
    assert.equal(
      validateValue("http.recording-registration.v1", created.json.data).valid,
      true,
    );
    const { recording, collectionPermissionRef } = created.json.data;
    assert.equal(recording.ownerUserId, users.collector.id);
    assert.equal(recording.status, "registered");
    assert.equal(collectionPermissionRef, await activeRef(users.collector.id));
    // Identical replay, different whitespace/key order, native client.
    const pretty = JSON.stringify(
      {
        device: body.device,
        startedAt: body.startedAt,
        rgbProfile: body.rgbProfile,
        captureFormat: body.captureFormat,
        clientRecordingId: body.clientRecordingId,
      },
      null,
      2,
    );
    const replay = await call("/api/v1/recordings", {
      ...nativePost(jar, {}),
      body: pretty,
    });
    assert.equal(replay.status, 200, replay.text);
    assert.equal(replay.json.data.recording.recordingId, recording.recordingId);
    const changed = await call(
      "/api/v1/recordings",
      nativePost(jar, {
        ...body,
        device: { ...body.device, appVersion: "0.1.1" },
      }),
    );
    assert.equal(changed.status, 409);
    assert.equal(changed.json.error.code, "idempotency_conflict");
    const spelled = await call(
      "/api/v1/recordings",
      nativePost(jar, { ...body, startedAt: "2026-11-01T12:00:00.000Z" }),
    );
    assert.equal(spelled.status, 409, "the digest is over the request value");
    // The client cannot inject owner or permission authority.
    const smuggled = await call(
      "/api/v1/recordings",
      nativePost(jar, { ...createBody(), ownerUserId: users.collector2.id }),
    );
    assert.equal(smuggled.status, 422);
    const fetched = await call(`/api/v1/recordings/${recording.recordingId}`, {
      jar,
    });
    assert.equal(fetched.status, 200);
    assertNoStore(fetched, "get");
    assert.equal(
      validateValue("http.recording.v1", fetched.json.data).valid,
      true,
    );
    evidence.create = {
      status: created.status,
      replay: replay.status,
      changed: changed.status,
    };
  });

  test("another collector cannot read, seal or complete someone else's recording", async () => {
    const mine = await signIn(users.collector.email);
    const other = await signIn(users.collector2.email);
    const s = await prepared(mine, users.collector.id);
    const read = await call(`/api/v1/recordings/${s.recordingId}`, {
      jar: other,
    });
    assert.equal(read.status, 404, "absent and foreign are indistinguishable");
    const seal = await call(
      `/api/v1/recordings/${s.recordingId}/seal`,
      nativePost(other, s.seal),
    );
    assert.equal(seal.status, 404);
    await assert.rejects(
      recordSourceCompletion(
        deps,
        { userId: users.collector2.id },
        {
          recordingId: s.recordingId,
          fileId: s.seal.files[0].fileId,
          expectedTransportEpoch: 1,
          observedSizeBytes: s.seal.files[0].sizeBytes,
        },
      ),
      (e) => e.code === "not_found",
    );
    // The same client ID under another owner is an independent recording.
    const sameClientId = await call(
      "/api/v1/recordings",
      nativePost(other, createBody(s.clientRecordingId)),
    );
    assert.equal(sameClientId.status, 201);
    assert.notEqual(
      sameClientId.json.data.recording.recordingId,
      s.recordingId,
    );
    assert.equal(
      sameClientId.json.data.collectionPermissionRef,
      "sa19-e2e-c2.r1",
    );
  });

  test("seal first, then completions: one job only after every required file; replays are identical", async () => {
    const jar = await signIn(users.collector.email);
    const s = await prepared(jar, users.collector.id);
    const sealed = await call(
      `/api/v1/recordings/${s.recordingId}/seal`,
      browserPost(jar, s.seal),
    );
    assert.equal(sealed.status, 200, sealed.text);
    assert.equal(
      validateValue("http.recording.v1", sealed.json.data).valid,
      true,
    );
    assert.equal(sealed.json.data.status, "sealed");
    const reordered = await call(
      `/api/v1/recordings/${s.recordingId}/seal`,
      nativePost(jar, { files: [...s.seal.files].reverse() }),
    );
    assert.equal(reordered.status, 200, "order is not meaningful");
    const changed = await call(
      `/api/v1/recordings/${s.recordingId}/seal`,
      nativePost(jar, {
        files: s.seal.files.map((f, i) =>
          i ? f : { ...f, sizeBytes: String(Number(f.sizeBytes) + 1) },
        ),
      }),
    );
    assert.equal(changed.status, 409);
    assert.equal(changed.json.error.code, "idempotency_conflict");
    assert.equal(
      (await s.complete("source_mcap")).admission.state,
      "awaiting_uploads",
    );
    assert.equal(
      (await s.complete("recorder_metadata")).admission.state,
      "awaiting_uploads",
    );
    assert.equal((await jobsOf(s.recordingId)).length, 0);
    const last = await s.complete("source_manifest");
    assert.equal(last.admission.state, "admitted");
    const replay = await s.complete("source_manifest");
    assert.equal(replay.replayed, true);
    const sealReplay = await call(
      `/api/v1/recordings/${s.recordingId}/seal`,
      nativePost(jar, s.seal),
    );
    assert.equal(sealReplay.status, 200);
    const jobs = await jobsOf(s.recordingId);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].state, "queued");
    assert.equal(jobs[0].id, last.admission.jobId);
    const fetched = await call(`/api/v1/recordings/${s.recordingId}`, { jar });
    assert.equal(fetched.json.data.status, "uploaded");
    evidence.sealFirst = { recordingId: s.recordingId, jobs: jobs.length };
  });

  test("completions first, then the HTTP seal admits in the same transaction", async () => {
    const jar = await signIn(users.collector.email);
    const s = await prepared(jar, users.collector.id);
    for (const role of ["source_manifest", "source_mcap", "recorder_metadata"])
      assert.equal((await s.complete(role)).admission.state, "awaiting_seal");
    // Concurrent identical seals: one job.
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        call(
          `/api/v1/recordings/${s.recordingId}/seal`,
          nativePost(jar, s.seal),
        ),
      ),
    );
    assert.deepEqual(
      results.map((r) => r.status),
      [200, 200, 200, 200],
    );
    assert.ok(results.every((r) => r.json.data.status === "uploaded"));
    assert.equal((await jobsOf(s.recordingId)).length, 1);
    evidence.completionFirst = {
      recordingId: s.recordingId,
      concurrentSeals: 4,
      jobs: 1,
    };
  });

  test("an oversized stored manifest is refused by the bounded reader and never admits", async () => {
    const jar = await signIn(users.collector.email);
    const s = await prepared(jar, users.collector.id, { oversizeStored: true });
    await call(
      `/api/v1/recordings/${s.recordingId}/seal`,
      nativePost(jar, s.seal),
    );
    await s.complete("source_mcap");
    await s.complete("recorder_metadata");
    const out = await s.complete("source_manifest");
    assert.deepEqual(out.admission, {
      state: "manifest_unverified",
      code: "manifest_too_large",
    });
    assert.equal((await jobsOf(s.recordingId)).length, 0);
    const fetched = await call(`/api/v1/recordings/${s.recordingId}`, { jar });
    assert.equal(fetched.json.data.status, "sealed");
  });

  test("revoked permission blocks registration and admission; renewal is a new ref", async () => {
    const jar = await signIn(users.collector.email);
    const pending = await prepared(jar, users.collector.id);
    await call(
      `/api/v1/recordings/${pending.recordingId}/seal`,
      nativePost(jar, pending.seal),
    );
    await pending.complete("source_mcap");
    await pending.complete("recorder_metadata");
    const ref = await activeRef(users.collector.id);
    await revokeIngestPermission(owner, {
      permissionRef: ref,
      revokedBy: "operator@e2e",
      reason: "e2e",
    });
    const blocked = await call(
      "/api/v1/recordings",
      nativePost(jar, createBody()),
    );
    assert.equal(blocked.status, 403);
    const admission = await pending.complete("source_manifest");
    assert.equal(admission.admission.state, "blocked_permission");
    assert.equal((await jobsOf(pending.recordingId)).length, 0);
    await recordIngestPermission(owner, {
      permissionRef: "sa19-e2e-c1.r2",
      ownerUserId: users.collector.id,
      pilotScope: "sa19-e2e",
      coversCapture: true,
      coversProcessing: true,
      evidenceRef: "doc://pilot/sa19-e2e-renewal",
      recordedBy: "operator@e2e",
    });
    // The pending recording stays bound to its revoked approval.
    assert.equal(
      (
        await recordSourceCompletion(
          deps,
          { userId: users.collector.id },
          {
            recordingId: pending.recordingId,
            fileId: pending.seal.files.find((f) => f.role === "source_manifest")
              .fileId,
            expectedTransportEpoch: 1,
            observedSizeBytes: pending.seal.files.find(
              (f) => f.role === "source_manifest",
            ).sizeBytes,
          },
        )
      ).admission.state,
      "blocked_permission",
    );
    const renewed = await call(
      "/api/v1/recordings",
      nativePost(jar, createBody()),
    );
    assert.equal(renewed.status, 201);
    assert.equal(renewed.json.data.collectionPermissionRef, "sa19-e2e-c1.r2");
    evidence.permission = {
      revokedCreate: blocked.status,
      admission: admission.admission.state,
    };
  });

  test("role revocation applies to the next request on an existing session", async () => {
    const jar = await signIn(users.collector2.email);
    const ok = await call("/api/v1/recordings", nativePost(jar, createBody()));
    assert.equal(ok.status, 201);
    const id = ok.json.data.recording.recordingId;
    await owner.query(
      "UPDATE access SET enabled = false WHERE user_id = $1 AND role = 'collector'",
      [users.collector2.id],
    );
    const create = await call(
      "/api/v1/recordings",
      nativePost(jar, createBody()),
    );
    assert.equal(create.status, 403);
    const read = await call(`/api/v1/recordings/${id}`, { jar });
    assert.equal(read.status, 403);
    assert.ok(jar.cookies.get(SESSION), "the session itself is still valid");
    await owner.query(
      "UPDATE access SET enabled = true WHERE user_id = $1 AND role = 'collector'",
      [users.collector2.id],
    );
    assert.equal((await call(`/api/v1/recordings/${id}`, { jar })).status, 200);
    evidence.roleRevocation = { create: create.status, read: read.status };
  });

  test("route responses forward Better Auth's refreshed session cookie", async () => {
    const jar = await signIn(users.collector2.email);
    const token = decodeURIComponent(jar.cookies.get(SESSION)).split(".")[0];
    await owner.query(
      `UPDATE session SET "expiresAt" = now() + interval '5 days' WHERE token = $1`,
      [token],
    );
    const res = await call("/api/v1/recordings", nativePost(jar, createBody()));
    assert.equal(res.status, 201);
    const cookie = [res.headers["set-cookie"] ?? []]
      .flat()
      .find((c) => c.startsWith(`${SESSION}=`));
    assert.ok(cookie, "refreshed cookie forwarded on the recording route");
    const expiry = (
      await owner.query(`SELECT "expiresAt" FROM session WHERE token = $1`, [
        token,
      ])
    ).rows[0].expiresAt;
    assert.ok(expiry.getTime() > Date.now() + 6 * 86400e3, "row extended");
  });

  test("no configuration, credential or database detail leaks into responses", async () => {
    const jar = await signIn(users.collector.email);
    const bad = await call("/api/v1/recordings/not-a-uuid", { jar });
    assert.equal(bad.status, 404);
    for (const secret of [
      env.S3_SECRET_ACCESS_KEY,
      env.APP_DB_PASSWORD,
      env.BETTER_AUTH_SECRET,
    ])
      assert.ok(!bad.text.includes(secret));
    assert.doesNotMatch(logs, new RegExp(env.S3_SECRET_ACCESS_KEY));
  });
});
