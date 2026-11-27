// Real API + Postgres + object-store harness for SA-26 (adapted from the SA-25
// jobs e2e): the production `next build` output served by `next start` as the
// restricted app role, Postgres migrated by the published migrator, operator
// issued controller/cron credentials in 0600 files. One isolated database and
// bucket per world, both created and removed by exact ledger entry through the
// shared run-ledger fixture helpers (startCatalogPostgres / startSeaweedfs);
// everything is torn down in stop(). Bounded fixtures only: no Docker, no new
// services, no unledgered CREATE DATABASE or bucket, no broad cleanup.
import { freePort } from "../../../scripts/platform/free-port.mjs";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { request } from "node:http";
import { createRequire } from "node:module";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { startCatalogPostgres } from "../../../packages/server/test-auth/postgres.mjs";
import { startSeaweedfs } from "../../../apps/web/test-e2e/seaweedfs.mjs";
import {
  waitForGroupExit,
  leaked,
} from "../../../scripts/platform/process-wait.mjs";

const webDir = fileURLToPath(new URL("../../../apps/web/", import.meta.url));
const serverDir = fileURLToPath(
  new URL("../../../packages/server/", import.meta.url),
);
const serverRequire = createRequire(join(serverDir, "package.json"));
const pg = serverRequire("pg");
const { DeleteObjectCommand, PutObjectCommand } =
  serverRequire("@aws-sdk/client-s3");
const dist = (p) => import(new URL(`dist/${p}`, `file://${serverDir}`).href);
const cat = await dist("catalog/catalog.js");
const { establishFixtureAdmission } = await dist("admission/fixtures.js");
const recordings = await dist("admission/recordings.js");
const { STATEACTION_MOBILE_CHANNELS } = await dist(
  "admission/capture-profiles.js",
);
const { s3ObjectReader } = await dist("admission/object-reader.js");
const { admitNextJob } = await dist("jobs/service.js");
const { processRecordingTaskInputV2 } = await dist("admission/job-input.js");
const { requestSha256 } = await import(
  new URL(`file://${serverRequire.resolve("@stateaction/contracts")}`).href
);
const { jobsConfigFromEnv } = await dist("jobs/config.js");
const { issueControllerCapability } = await dist("jobs/credentials.js");
const { storageClient } = await dist("storage.js");
const nextBin = createRequire(join(webDir, "package.json")).resolve(
  "next/dist/bin/next",
);
export { freePort };
export const sha = (b) => createHash("sha256").update(b).digest("hex");
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
export async function startWorld(extraEnv = {}, onTeardown = () => {}) {
  if (!process.env.STATEACTION_LOCAL_FIXTURES)
    throw new Error(
      "STATEACTION_LOCAL_FIXTURES (bounded external fixtures) is required; Docker is never used",
    );
  const db = await startCatalogPostgres();
  let s3;
  try {
    s3 = await startSeaweedfs();
  } catch (error) {
    await db.stop();
    throw error;
  }
  const world = { next: undefined, pools: [], storage: undefined, dir: "" };
  const teardown = async () => {
    onTeardown("web");
    if (world.next && world.next.exitCode === null) {
      try {
        process.kill(-world.next.pid, "SIGTERM");
      } catch {}
      await waitForGroupExit(world.next.pid).catch(leaked);
    }
    onTeardown("connection pools");
    world.storage?.destroy();
    await Promise.allSettled(world.pools.map((p) => p.end()));
    if (world.dir) rmSync(world.dir, { recursive: true, force: true });
    // Exact ledger entries only (database, then bucket).
    onTeardown("database");
    await db.stop();
    onTeardown("bucket");
    await s3.stop();
    onTeardown("complete");
  };
  try {
    return await buildWorld(db, s3, world, teardown, extraEnv);
  } catch (error) {
    await teardown();
    throw error;
  }
}

async function buildWorld(db, s3, world, teardown, extraEnv) {
  const dbName = db.name;
  const ownerUrl = db.ownerUrl;
  const appUrl = db.appUrl;
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const password = "e2e-only " + randomBytes(9).toString("base64url");
  const env = {
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
    S3_ENDPOINT: s3.endpoint,
    S3_REGION: "us-east-1",
    S3_BUCKET: s3.bucket,
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
    ...extraEnv,
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
  world.pools.push(owner);
  const app = new pg.Pool({
    connectionString: appUrl,
    max: 6,
    statement_timeout: 30000,
    lock_timeout: 15000,
  });
  world.pools.push(app);
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
  world.storage = storage;
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
  world.next = next;
  next.stdout.on("data", (c) => (logs += c));
  next.stderr.on("data", (c) => (logs += c));
  for (let i = 0; ; i++) {
    try {
      if ((await call(origin, "/login")).status === 200) break;
    } catch {}
    if (i > 600 || next.exitCode !== null)
      throw new Error(`next start failed:\n${logs.slice(-2000)}`);
    await sleep(100);
  }
  const secrets = mkdtempSync(join(tmpdir(), "sa26-cap-"));
  chmodSync(secrets, 0o700);
  world.dir = secrets;
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

  async function heldGraphRecording(mcap, sourceFacts) {
    const principal = { userId: users.collector.id };
    const clientRecordingId = randomUUID();
    const deps = {
      pool: app,
      reader: s3ObjectReader({ bucket: env.S3_BUCKET }, { client: storage }),
      config: recordings.admissionConfigFromEnv(env),
    };
    const { recording, collectionPermissionRef } =
      await recordings.registerRecording(deps, principal, {
        clientRecordingId,
        captureFormat: "stateaction.capture.v1",
        rgbProfile: "h264_mcap_v1",
        startedAt: new Date().toISOString(),
        device: {
          model: "Pinned synthetic capture",
          osVersion: "16",
          appVersion: "test",
        },
      });
    const recordingId = recording.recordingId;
    const files = [
      ["source_mcap", mcap],
      ["recorder_metadata", Buffer.from('{"fixture":true}')],
    ].map(([role, body]) => ({
      fileId: randomUUID(),
      role,
      body,
      sizeBytes: String(body.length),
      sha256: sha(body),
      required: true,
    }));
    const manifest = Buffer.from(
      JSON.stringify({
        schema: "stateaction.recording_source.v2",
        recording_id: recordingId,
        client_recording_id: clientRecordingId,
        owner_user_id: principal.userId,
        capture_format: "stateaction.capture.v1",
        rgb_profile: "h264_mcap_v1",
        capture_config_sha256: sha("fixture-capture"),
        close_status: "closed_clean",
        files: files.map((file) => ({
          file_id: file.fileId,
          role: file.role,
          required: file.required,
          size_bytes: file.sizeBytes,
          sha256: file.sha256,
        })),
        clock_domains: ["unix", sourceFacts.clockDomain],
        channels: STATEACTION_MOBILE_CHANNELS.map(
          ([topic, schema_name, message_encoding]) => ({
            topic,
            schema_name,
            message_encoding,
            clock_domain: "unix",
            message_count:
              topic === "/camera/rgb/video" ? String(sourceFacts.frames) : "1",
          }),
        ),
        counts: {
          video_frames: String(sourceFacts.frames),
          dropped_video_frames: "0",
          motion_events: "0",
        },
        collection_permission_ref: collectionPermissionRef,
        source_verification: "pending",
      }),
    );
    const sourceManifestSha256 = sha(manifest);
    files.push({
      fileId: randomUUID(),
      role: "source_manifest",
      body: manifest,
      sizeBytes: String(manifest.length),
      sha256: sourceManifestSha256,
      required: true,
    });
    for (const { body, ...file } of files) {
      await cat.reserveSourceFile(app, {
        ...file,
        recordingId,
        ownerUserId: principal.userId,
        clientUploadId: randomUUID(),
        partSizeBytes: "67108864",
        partCount: 1,
      });
      const {
        rows: [slot],
      } = await owner.query("SELECT object_key FROM files WHERE id = $1", [
        file.fileId,
      ]);
      await storage.send(
        new PutObjectCommand({
          Bucket: env.S3_BUCKET,
          Key: slot.object_key,
          Body: body,
        }),
      );
    }
    await recordings.sealRecordingInventory(deps, principal, recordingId, {
      files: files.map(({ body, ...file }) => file),
    });
    let admission;
    for (const file of files) {
      ({ admission } = await recordings.recordSourceCompletion(
        deps,
        principal,
        {
          recordingId,
          fileId: file.fileId,
          expectedTransportEpoch: 1,
          observedSizeBytes: file.sizeBytes,
        },
      ));
    }
    return { recordingId, admission, sourceManifestSha256 };
  }

  async function staffBrowser() {
    const headers = {
      origin,
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      "sec-fetch-mode": "cors",
      "x-stateaction-client": "web",
    };
    const login = await fetch(origin + "/api/auth/sign-in/email", {
      method: "POST",
      headers,
      body: JSON.stringify({ email: users.staff.email, password }),
    });
    if (!login.ok) throw new Error("Staff fixture sign-in refused");
    const cookies = login.headers
      .getSetCookie()
      .map((value) => value.split(";")[0]);
    const request = (path, body) =>
      fetch(origin + path, {
        headers: { ...headers, cookie: cookies.join("; ") },
        ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
      });
    return Object.assign(request, { cookies });
  }

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
  /** Run admission through the API with the repair-scoped credential. */
  async function admit() {
    const res = await call(origin, "/internal/v1/jobs/reconcile", {
      method: "POST",
      body: {},
      token: cron.token,
    });
    if (res.status !== 200) {
      const state = /code: '([0-9A-Z]{5})'/.exec(logs)?.[1];
      throw new Error(
        `reconcile failed: ${res.text}${state ? " (SQLSTATE " + state + ")" : ""}`,
      );
    }
    return res.json.data;
  }
  /**
   * Fixture admission with a SHORT initial immutable deadline: the real library
   * admission seam (as the restricted-PG tests use) with only the deadline
   * config substituted. The deadline is never rewritten afterwards.
   */
  async function admitWithDeadline(seconds) {
    const cfg = {
      ...jobsConfigFromEnv(env),
      executionDeadlineSeconds: seconds,
    };
    return admitNextJob({ pool: app, config: cfg, presignRead: undefined });
  }
  /**
   * SA-91: admission of a recipe job through the real library seam (v3 task input with the
   * inline recipe), as the restricted-PG stage-run tests do. The recipe is written once here.
   */
  async function admitWithRecipe(recipe) {
    return admitNextJob({
      pool: app,
      config: jobsConfigFromEnv(env),
      presignRead: undefined,
      taskInput: async (q, job) => ({
        ...(await processRecordingTaskInputV2(q, job.jobId)),
        schemaVersion: 3,
        recipe,
        recipeSha256: requestSha256(recipe),
      }),
    });
  }
  /** SA-91: the recorded stage runs, claims and stage proofs of one job. */
  const stageRows = async (jobId) =>
    (
      await owner.query(
        `SELECT r.stage, r.state, r.module, r.call_id, r.error_code,
                c.call_id AS claimed_call, c.claimed_at,
                (SELECT e.execution_ref FROM job_stage_evidence e
                 WHERE e.job_id = r.job_id AND e.stage = r.stage) AS proof
         FROM job_stage_runs r
         LEFT JOIN job_stage_claims c ON c.job_id = r.job_id AND c.stage = r.stage
         WHERE r.job_id = $1 ORDER BY job_stage_ord(r.stage)`,
        [jobId],
      )
    ).rows;
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
  const removeRetainedFixtureOutput = async (jobId, nodeId) => {
    const {
      rows: [file],
    } = await owner.query(
      `SELECT f.object_key FROM job_recipe_node_outputs o JOIN files f ON f.id = o.file_id
       WHERE o.job_id = $1 AND o.node_id = $2 ORDER BY o.port, o.file_id LIMIT 1`,
      [jobId, nodeId],
    );
    if (!file)
      throw new Error("The isolated retained fixture output is missing");
    await storage.send(
      new DeleteObjectCommand({
        Bucket: s3.bucket,
        Key: file.object_key,
      }),
    );
  };
  return {
    origin,
    env,
    owner,
    app,
    users,
    queuedJob,
    heldGraphRecording,
    staffBrowser,
    dispatchDiagnostics: () =>
      Array.from(logs.matchAll(/\[jobs\] repair (\{[^\n]+\})/g), (item) =>
        JSON.parse(item[1]),
      ).map(({ dispatchAvailable, started, ambiguous }) => ({
        dispatchAvailable,
        started,
        ambiguous,
      })),
    sqlDiagnostics: () => [
      ...Array.from(logs.matchAll(/code: '([0-9A-Z]{5})'/g), (item) => item[1]),
      ...Array.from(
        logs.matchAll(/column reference "([a-z_]+)" is ambiguous/g),
        (item) => item[1],
      ),
      ...Array.from(
        logs.matchAll(/PL\/pgSQL function ([a-z_]+)\([a-z, ]+\) line [0-9]+/g),
        (item) => item[1],
      ),
    ],
    admit,
    admitWithDeadline,
    admitWithRecipe,
    stageRows,
    row,
    removeRetainedFixtureOutput,
    workflow,
    cron,
    secretsDir: secrets,
    /** Operator-style lease expiry so a same-run retry need not wait 120 s. */
    expireLease: (jobId) =>
      owner.query(
        "UPDATE jobs SET controller_lease_expires_at = now() - interval '1 second' WHERE id = $1",
        [jobId],
      ),
    /** Lease lapsed beyond the repair lease grace (default 60 s) without waiting for it. */
    lapseLease: (jobId) =>
      owner.query(
        "UPDATE jobs SET controller_lease_expires_at = now() - interval '10 minutes' WHERE id = $1",
        [jobId],
      ),
    stop: teardown,
  };
}
