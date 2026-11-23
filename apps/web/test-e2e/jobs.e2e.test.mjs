// REAL JOB ADMISSION/CLAIM E2E (SA-25 x SA-20 x SA-19 x SA-15 x SA-13): the
// production `next build` output served by `next start`, real Better Auth
// sessions and access rows, Postgres migrated by the published migrator
// (Next connects ONLY as the restricted `stateaction_app` role) and an S3
// endpoint for fixture bytes. With CATALOG_TEST_* / TRANSPORT_TEST_S3_* set it
// uses those SHARED BOUNDED fixtures (no Docker, no new services) and creates
// and drops its own database and bucket; otherwise it falls back to the same
// throwaway containers the other E2E files use. Controller/cron
// credentials are operator-issued with the owner credential. No external
// submission or processing runtime exists here: the "worker" is this test
// reading fixture bytes through the server-selected signed URLs. Not Google,
// native app, R2, Tailscale, Modal or hosted qualification.
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
import {
  waitForGroupExit,
  leaked,
} from "../../../scripts/platform/process-wait.mjs";

const webDir = fileURLToPath(new URL("..", import.meta.url));
const serverDir = fileURLToPath(
  new URL("../../../packages/server/", import.meta.url),
);
const serverRequire = createRequire(join(serverDir, "package.json"));
const pg = serverRequire("pg");
const { CreateBucketCommand, PutObjectCommand } =
  serverRequire("@aws-sdk/client-s3");
const dist = (p) => import(new URL(`dist/${p}`, `file://${serverDir}`).href);
const cat = await dist("catalog/catalog.js");
const { establishFixtureAdmission } = await dist("admission/fixtures.js");
const { issueControllerCapability } = await dist("jobs/credentials.js");
const { storageClient } = await dist("storage.js");

const nextBin = createRequire(join(webDir, "package.json")).resolve(
  "next/dist/bin/next",
);
const PASSWORD = "e2e-only " + randomBytes(9).toString("base64url");
const SESSION = "better-auth.session_token";
const sha = (b) => createHash("sha256").update(b).digest("hex");

let dbName,
  ownerUrl,
  appUrl,
  origin,
  env,
  next,
  owner,
  app,
  storage,
  users,
  s3,
  fallback;
let logs = "";
const evidence = {};

async function freePort() {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}
let ip = 0;
class Jar {
  cookies = new Map();
  ip = `198.51.100.${++ip}`;
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
  h["x-forwarded-for"] ??= jar?.ip ?? `198.51.100.${++ip}`;
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
const post = (token, body) => ({
  method: "POST",
  body: JSON.stringify(body ?? {}),
  headers: {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  },
});
const get = (token) => ({
  method: "GET",
  headers: token ? { authorization: `Bearer ${token}` } : {},
});
async function signIn(email) {
  const jar = new Jar();
  const res = await call("/api/auth/sign-in/email", {
    method: "POST",
    jar,
    body: JSON.stringify({ email, password: PASSWORD }),
    headers: {
      "content-type": "application/json",
      origin,
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "x-stateaction-client": "web",
    },
  });
  assert.equal(res.status, 200, `${email}: ${res.text}`);
  return jar;
}

before(async () => {
  // Ledger-owned shared fixtures (bounded loopback) or throwaway containers.
  const { startCatalogPostgres } = await import(
    "../../../packages/server/test-auth/postgres.mjs"
  );
  const { startSeaweedfs } = await import("./seaweedfs.mjs");
  const [started, store] = await Promise.all([
    startCatalogPostgres(),
    startSeaweedfs(),
  ]);
  fallback = { stop: () => Promise.all([started.stop(), store.stop()]) };
  ownerUrl = started.ownerUrl;
  appUrl = started.appUrl;
  dbName = new URL(appUrl).pathname.slice(1);
  s3 = store;
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  const endpoint = s3.endpoint;
  env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    APP_ENV: "local",
    // TEST-ONLY: trust the loopback harness peer for simulated client addresses (rejected on hosted).
    AUTH_TRUSTED_PROXIES: "127.0.0.1,::1",
    DATABASE_HOST: new URL(appUrl).hostname,
    DATABASE_PORT: new URL(appUrl).port,
    DATABASE_NAME: dbName,
    APP_DB_PASSWORD: decodeURIComponent(new URL(appUrl).password),
    BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
    AUTH_LOCAL_PASSWORD: "true",
    S3_ENDPOINT: endpoint,
    S3_REGION: "us-east-1",
    // External fixtures hand out a run-owned, already-created bucket.
    S3_BUCKET: s3.bucket ?? `sa25-e2e-${randomBytes(4).toString("hex")}`,
    S3_ACCESS_KEY_ID: s3.accessKeyId,
    S3_SECRET_ACCESS_KEY: s3.secretAccessKey,
    PROCESSING_PROFILE_REVISION: "sa25-e2e-1",
    SUPPORTED_RGB_PROFILES: "h264_mcap_v1",
    PROCESSING_EXECUTION_BACKEND: "local",
    PROCESSING_CODE_REVISION: "sa25-e2e",
    PROCESSING_IMAGE_SPEC_SHA256: sha("image"),
    PROCESSING_MODEL_SHA256: sha("model"),
    PROCESSING_CONFIG_SHA256: sha("config"),
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
        CATALOG_OWNER_URL: ownerUrl,
        AUTH_TEST_PASSWORD: PASSWORD,
      },
      encoding: "utf8",
    },
  );
  assert.equal(boot.status, 0, boot.stderr);
  users = JSON.parse(boot.stdout);
  owner = new pg.Pool({ connectionString: ownerUrl, max: 3 });
  app = new pg.Pool({ connectionString: appUrl, max: 6 });
  storage = storageClient(
    {
      endpoint,
      publicEndpoint: endpoint,
      region: env.S3_REGION,
      bucket: env.S3_BUCKET,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    },
    15000,
  );
  if (!s3.bucket)
    await storage.send(new CreateBucketCommand({ Bucket: env.S3_BUCKET }));
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
    if (i > 600 || next.exitCode !== null)
      throw new Error(`next start failed:\n${logs}`);
    await sleep(100);
  }
});

after(async () => {
  if (next && next.exitCode === null) {
    try {
      process.kill(-next.pid, "SIGTERM");
    } catch {}
    await waitForGroupExit(next.pid).catch(leaked);
  }
  storage?.destroy();
  await Promise.all([owner?.end(), app?.end()]);
  if (fallback) await fallback.stop();
  if (process.env.SA25_E2E_EVIDENCE)
    process.stdout.write(`SA25_E2E_EVIDENCE ${JSON.stringify(evidence)}\n`);
});

/** A sealed, admitted recording with one queued job and real fixture bytes in storage. */
async function queuedJob() {
  const ownerUserId = users.collector.id;
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
  const bytes = {};
  for (const role of ["source_manifest", "source_mcap", "recorder_metadata"]) {
    const fileId = randomUUID();
    if (role === "source_manifest") manifestFileId = fileId;
    const body = Buffer.from(`fixture:${role}:${recordingId}`);
    bytes[fileId] = body;
    await cat.reserveSourceFile(app, {
      fileId,
      recordingId,
      ownerUserId,
      clientUploadId: randomUUID(),
      role,
      sizeBytes: String(body.length),
      sha256: sha(body),
      required: true,
      partSizeBytes: "67108864",
      partCount: 1,
    });
    const { rows } = await owner.query(
      "SELECT object_key FROM files WHERE id = $1",
      [fileId],
    );
    await storage.send(
      new PutObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: rows[0].object_key,
        Body: body,
      }),
    );
    await cat.recordFileCompleted(app, {
      fileId,
      expectedTransportEpoch: 1,
      observedSizeBytes: String(body.length),
    });
  }
  await cat.sealRecording(app, { recordingId, ownerUserId, manifestFileId });
  const jobId = randomUUID();
  await establishFixtureAdmission(owner, { recordingId, firstJobId: jobId });
  await cat.createProcessingJob(app, {
    jobId,
    recordingId,
    profileRevision: "sa25-e2e",
  });
  return { jobId, recordingId, bytes };
}

describe("job admission and worker claims on Next.js with Better Auth, Postgres and object storage", () => {
  let cron, workflow, job;
  const base = (id) => `/internal/v1/jobs/${id}`;
  const act = (token, id, body) =>
    call(`${base(id)}/controller`, post(token, body));

  before(async () => {
    cron = (
      await issueControllerCapability(owner, {
        kind: "cron",
        scopes: ["jobs:repair"],
        label: "e2e cron",
        ttlSeconds: 3600,
      })
    ).token;
    workflow = (
      await issueControllerCapability(owner, {
        kind: "workflow",
        scopes: ["jobs:status", "jobs:reconcile"],
        label: "e2e workflow",
        ttlSeconds: 3600,
      })
    ).token;
    job = await queuedJob();
  });

  test("humans (owner, staff, customer) and anonymous callers cannot use any machine route", async () => {
    const jars = {
      collector: await signIn(users.collector.email),
      staff: await signIn(users.staff.email),
      customer: await signIn(users.customer.email),
    };
    const routes = [
      ["/internal/v1/jobs/reconcile", { method: "POST" }],
      [base(job.jobId), { method: "GET" }],
      [`${base(job.jobId)}/controller`, { method: "POST", body: "{}" }],
      [`${base(job.jobId)}/claim`, { method: "POST", body: "{}" }],
      [`${base(job.jobId)}/heartbeat`, { method: "POST", body: "{}" }],
      [`${base(job.jobId)}/inputs/${randomUUID()}/read`, { method: "POST" }],
    ];
    const denied = [];
    for (const [path, init] of routes)
      for (const [who, jar] of Object.entries({
        anonymous: undefined,
        ...jars,
      })) {
        const res = await call(path, {
          ...init,
          jar,
          headers: {
            "content-type": "application/json",
            "x-stateaction-client": "web",
          },
        });
        assert.equal(
          res.status,
          401,
          `${who} ${init.method} ${path}: ${res.text}`,
        );
        denied.push(`${who}:${path.replace(job.jobId, ":id")}:${res.status}`);
      }
    evidence.humanDenials = denied.length;
  });

  test("scopes are enforced: cron cannot read status or drive a job; workflow cannot admit", async () => {
    assert.equal((await call(base(job.jobId), get(cron))).status, 403);
    assert.equal(
      (
        await act(cron, job.jobId, {
          action: "claim_lease",
          runRef: "r",
          owner: "o",
        })
      ).status,
      403,
    );
    assert.equal(
      (await call("/internal/v1/jobs/reconcile", post(workflow))).status,
      403,
    );
  });

  test("repair cron admits one job through the single slot; a second request finds it busy", async () => {
    const second = await queuedJob();
    const res = await call("/internal/v1/jobs/reconcile", post(cron));
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.data.admission.state, "admitted");
    assert.equal(res.json.data.admission.jobId, job.jobId);
    assert.equal(res.json.data.admission.dispatchKey, `job:${job.jobId}`);
    assert.deepEqual(
      res.json.data.pendingDispatches.map((d) => d.jobId),
      [job.jobId],
    );
    const again = await call("/internal/v1/jobs/reconcile", post(cron));
    assert.equal(again.json.data.admission.state, "slot_busy");
    const status = await call(base(second.jobId), get(workflow));
    assert.equal(status.json.data.state, "queued");
    assert.equal(
      validateValue("jobs.job-status.v2", status.json.data).valid,
      true,
    );
  });

  test("controller lease, submission intent once, then exactly one physical claim reads fixture bytes", async () => {
    const owner1 = `ctl-${randomBytes(6).toString("hex")}`;
    const lease = await act(workflow, job.jobId, {
      action: "claim_lease",
      runRef: "run-e2e-1",
      owner: owner1,
    });
    assert.equal(lease.json.data.granted, true, lease.text);
    const stranger = await act(workflow, job.jobId, {
      action: "claim_lease",
      runRef: "run-e2e-1",
      owner: "ctl-other",
    });
    assert.equal(stranger.json.data.granted, false);
    const intent = await act(workflow, job.jobId, {
      action: "record_worker_submission",
      owner: owner1,
    });
    assert.equal(intent.json.data.state, "recorded", intent.text);
    const bootstrap = intent.json.data.bootstrapToken;
    const again = await act(workflow, job.jobId, {
      action: "record_worker_submission",
      owner: owner1,
    });
    assert.equal(again.json.data.state, "already_recorded");
    assert.equal(again.json.data.bootstrapToken, undefined);
    // The bootstrap cannot heartbeat or read before it wins a claim.
    assert.equal(
      (await call(`${base(job.jobId)}/heartbeat`, post(bootstrap, {}))).status,
      401,
    );

    const claimBody = (nonce, ref) => ({
      schemaVersion: 1,
      jobId: job.jobId,
      invocationNonce: nonce,
      executor: { kind: "local", localExecutionRef: ref },
    });
    const n1 = randomBytes(32).toString("base64url");
    const racers = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        call(
          `${base(job.jobId)}/claim`,
          post(
            bootstrap,
            claimBody(
              i === 0 ? n1 : randomBytes(32).toString("base64url"),
              `local-${i}`,
            ),
          ),
        ),
      ),
    );
    const wins = racers.filter((r) => r.status === 200);
    assert.equal(wins.length, 1, racers.map((r) => r.status).join());
    assert.ok(
      racers
        .filter((r) => r.status !== 200)
        .every((r) => r.status === 409 || r.status === 401),
    );
    const grant = wins[0].json.data;
    assert.equal(validateValue("jobs.claim-grant.v1", grant).valid, true);
    assertNoStore(wins[0]);
    // Server-selected signed URLs return the exact fixture bytes.
    for (const input of grant.inputs) {
      const res = await fetch(input.readUrl);
      assert.equal(res.status, 200);
      const body = Buffer.from(await res.arrayBuffer());
      assert.equal(sha(body), input.sha256);
      assert.deepEqual(body, job.bytes[input.fileId]);
    }
    const replay = await call(
      `${base(job.jobId)}/claim`,
      post(bootstrap, claimBody(grant.invocationNonce, "local-0")),
    );
    assert.ok([401, 409].includes(replay.status));

    const cap = grant.capability.token;
    const hb = await call(
      `${base(job.jobId)}/heartbeat`,
      post(cap, {
        schemaVersion: 1,
        jobId: job.jobId,
        invocationNonce: grant.invocationNonce,
        phase: "decoding",
        processedFrames: "5",
        totalFrames: null,
      }),
    );
    assert.equal(hb.status, 200, hb.text);
    assert.equal(hb.json.data.executionDeadline, grant.executionDeadline);
    const wrongNonce = await call(
      `${base(job.jobId)}/heartbeat`,
      post(cap, {
        schemaVersion: 1,
        jobId: job.jobId,
        invocationNonce: randomBytes(32).toString("base64url"),
        phase: "decoding",
      }),
    );
    assert.equal(wrongNonce.status, 403);
    const read = await call(
      `${base(job.jobId)}/inputs/${grant.inputs[0].fileId}/read`,
      post(cap),
    );
    assert.equal(read.status, 200, read.text);
    assert.equal((await fetch(read.json.data.readUrl)).status, 200);
    evidence.claim = {
      racers: racers.length,
      wins: wins.length,
      inputs: grant.inputs.length,
    };

    // A controller credential is not a worker capability and vice versa.
    assert.equal(
      (await call(`${base(job.jobId)}/heartbeat`, post(workflow, {}))).status,
      401,
    );
    assert.equal(
      (await act(cap, job.jobId, { action: "renew_lease", owner: owner1 }))
        .status,
      401,
    );

    // Revoking the owner's processing permission stops reads and heartbeats at once.
    const reg = await owner.query(
      "SELECT ingest_permission_id FROM recording_registrations WHERE recording_id = $1",
      [job.recordingId],
    );
    await owner.query(
      "UPDATE ingest_permissions SET status = 'revoked', revoked_by = 'e2e', revoked_at = now() WHERE id = $1",
      [reg.rows[0].ingest_permission_id],
    );
    assert.equal(
      (
        await call(
          `${base(job.jobId)}/inputs/${grant.inputs[0].fileId}/read`,
          post(cap),
        )
      ).status,
      403,
    );
    assert.equal(hb.status, 200);
    const after = await call(
      `${base(job.jobId)}/heartbeat`,
      post(cap, {
        schemaVersion: 1,
        jobId: job.jobId,
        invocationNonce: grant.invocationNonce,
        phase: "decoding",
      }),
    );
    assert.equal(after.status, 403);
    evidence.revocation = after.status;
  });
});

const assertNoStore = (res) =>
  assert.match(String(res.headers["cache-control"]), /no-store/);
