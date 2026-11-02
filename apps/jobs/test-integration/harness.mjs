// Real API + Postgres + object-store harness for SA-26 (adapted from the SA-25
// jobs e2e): the production `next build` output served by `next start` as the
// restricted app role, Postgres migrated by the published migrator, operator
// issued controller/cron credentials in 0600 files. One isolated database and
// bucket per world; everything is torn down in stop(). Shared bounded fixtures
// (CATALOG_TEST_* / TRANSPORT_TEST_S3_*) only: no Docker, no new services.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, request } from "node:http";
import { createRequire } from "node:module";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

export const jobsDir = fileURLToPath(new URL("..", import.meta.url));
const webDir = fileURLToPath(new URL("../../web/", import.meta.url));
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
export const sha = (b) => createHash("sha256").update(b).digest("hex");
const need = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} must come from the bounded fixtures env`);
  return v;
};
const withDb = (url, name) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};
export async function freePort() {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}
let ip = 0;
export function call(origin, path, { method = "GET", body, token } = {}) {
  const headers = { "x-forwarded-for": `198.51.100.${++ip % 250}` };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Promise((resolve, reject) => {
    const req = request(origin + path, { method, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        let json;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

/** A private world: database, bucket, Next API, credentials and a sealed recording per job. */
export async function startWorld() {
  const admin = new pg.Client({
    connectionString: need("CATALOG_TEST_ADMIN_URL"),
  });
  const dbName = `sa26_e2e_${randomUUID().replaceAll("-", "")}`;
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER migration_owner`);
  await admin.end();
  const ownerUrl = withDb(need("CATALOG_TEST_OWNER_URL"), dbName);
  const appUrl = withDb(need("CATALOG_TEST_APP_URL"), dbName);
  const s3 = {
    endpoint: need("TRANSPORT_TEST_S3_ENDPOINT"),
    accessKeyId: need("TRANSPORT_TEST_S3_ACCESS_KEY"),
    secretAccessKey: need("TRANSPORT_TEST_S3_SECRET_KEY"),
  };
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const password = "e2e-only " + randomBytes(9).toString("base64url");
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    APP_ENV: "local",
    DATABASE_HOST: new URL(appUrl).hostname,
    DATABASE_PORT: new URL(appUrl).port,
    DATABASE_NAME: dbName,
    APP_DB_PASSWORD: decodeURIComponent(new URL(appUrl).password),
    BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
    AUTH_LOCAL_PASSWORD: "true",
    S3_ENDPOINT: s3.endpoint,
    S3_REGION: "us-east-1",
    S3_BUCKET: `sa26-e2e-${randomBytes(4).toString("hex")}`,
    S3_ACCESS_KEY_ID: s3.accessKeyId,
    S3_SECRET_ACCESS_KEY: s3.secretAccessKey,
    PROCESSING_PROFILE_REVISION: "sa26-e2e-1",
    SUPPORTED_RGB_PROFILES: "h264_mcap_v1",
    PROCESSING_EXECUTION_BACKEND: "local",
    PROCESSING_CODE_REVISION: "sa26-e2e",
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
        AUTH_TEST_PASSWORD: password,
      },
      encoding: "utf8",
    },
  );
  if (boot.status !== 0) throw new Error(`bootstrap failed: ${boot.stderr}`);
  const users = JSON.parse(boot.stdout);
  const owner = new pg.Pool({
    connectionString: ownerUrl,
    max: 3,
    statement_timeout: 30000,
    lock_timeout: 15000,
  });
  const app = new pg.Pool({
    connectionString: appUrl,
    max: 6,
    statement_timeout: 30000,
    lock_timeout: 15000,
  });
  const storage = storageClient(
    {
      endpoint: s3.endpoint,
      publicEndpoint: s3.endpoint,
      region: env.S3_REGION,
      bucket: env.S3_BUCKET,
      accessKeyId: s3.accessKeyId,
      secretAccessKey: s3.secretAccessKey,
    },
    15000,
  );
  await storage.send(new CreateBucketCommand({ Bucket: env.S3_BUCKET }));
  let logs = "";
  const next = spawn(
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
      if ((await call(origin, "/login")).status === 200) break;
    } catch {}
    if (i > 120 || next.exitCode !== null)
      throw new Error(`next start failed:\n${logs.slice(-2000)}`);
    await sleep(500);
  }
  const secrets = mkdtempSync(join(tmpdir(), "sa26-cap-"));
  chmodSync(secrets, 0o700);
  const issue = async (kind, scopes, name) => {
    const { token } = await issueControllerCapability(owner, {
      kind,
      scopes,
      label: name,
      ttlSeconds: 3600,
    });
    const file = join(secrets, name);
    writeFileSync(file, token, { mode: 0o600 });
    return { token, file };
  };
  const workflow = await issue(
    "workflow",
    ["jobs:status", "jobs:reconcile"],
    "workflow",
  );
  const cron = await issue("cron", ["jobs:repair"], "cron");

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
    for (const role of [
      "source_manifest",
      "source_mcap",
      "recorder_metadata",
    ]) {
      const fileId = randomUUID();
      if (role === "source_manifest") manifestFileId = fileId;
      const body = Buffer.from(`fixture:${role}:${recordingId}`);
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
      profileRevision: "sa26-e2e",
    });
    return { jobId, recordingId };
  }
  /** The admission step SA-26's dispatcher would receive (cron credential, jobs:repair). */
  async function admit() {
    const res = await call(origin, "/internal/v1/jobs/reconcile", {
      method: "POST",
      body: {},
      token: cron.token,
    });
    if (res.status !== 200) throw new Error(`reconcile failed: ${res.text}`);
    return res.json.data;
  }
  const row = async (jobId) =>
    (
      await owner.query(
        `SELECT j.state, j.workflow_run_ref, j.execution_call_id, j.claimed_at, j.invocation_nonce,
              j.controller_lease_owner, j.last_heartbeat_at, j.execution_deadline,
              (SELECT job_id FROM dispatch_admission WHERE slot = 1) AS slot_holder,
              (SELECT kind || ':' || execution_ref FROM job_execution_evidence e WHERE e.job_id = j.id) AS evidence,
              (SELECT detail FROM job_execution_evidence e WHERE e.job_id = j.id) AS evidence_detail
       FROM jobs j WHERE j.id = $1`,
        [jobId],
      )
    ).rows[0];
  return {
    origin,
    env,
    owner,
    app,
    users,
    queuedJob,
    admit,
    row,
    workflow,
    cron,
    secretsDir: secrets,
    /** Operator-style lease expiry so a same-run retry need not wait 120 s. */
    expireLease: (jobId) =>
      owner.query(
        "UPDATE jobs SET controller_lease_expires_at = now() - interval '1 second' WHERE id = $1",
        [jobId],
      ),
    async stop() {
      try {
        process.kill(-next.pid, "SIGTERM");
      } catch {}
      await sleep(500);
      storage.destroy();
      await Promise.all([owner.end(), app.end()]);
      const a = new pg.Client({
        connectionString: need("CATALOG_TEST_ADMIN_URL"),
      });
      await a.connect();
      await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await a.end();
    },
  };
}
