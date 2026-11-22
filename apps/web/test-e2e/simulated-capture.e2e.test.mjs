// REAL SIMULATED-CAPTURE ADMISSION E2E (SA-71 x SA-19 x SA-15): the production
// `next build` output served by `next start` with real Better Auth sessions, a
// throwaway Postgres migrated by the published migrator (Next connects ONLY as
// the restricted `stateaction_app` role) and a throwaway SeaweedFS S3 holding
// the source manifest the server reads. Three Next processes share them:
//   - development: APP_ENV=local + ALLOW_SIMULATED_CAPTURE_INPUTS=true
//   - default:     APP_ENV=local, no flag (production-like default)
//   - hosted-spoof: APP_ENV=local + the flag + Render service markers
// Emulator/simulation evidence only; never hardware or provider qualification.
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
const dist = (p) => import(new URL(`dist/${p}`, `file://${serverDir}`).href);
const { recordSourceCompletion } = await dist("admission/recordings.js");
const { processRecordingTaskInputV2 } = await dist("admission/job-input.js");
const { s3ObjectReader } = await dist("admission/object-reader.js");
const { reserveSourceFile, sourceObjectKey } = await dist("catalog/catalog.js");
const { storageClient } = await dist("storage.js");

const nextBin = createRequire(join(webDir, "package.json")).resolve(
  "next/dist/bin/next",
);
const PASSWORD = "e2e-only " + randomBytes(9).toString("base64url");
const SESSION = "better-auth.session_token";
const SIM = "h264_mcap_simulation_v1";
const V2 = "application/vnd.stateaction.recording.v2+json";
const sha = (b) => createHash("sha256").update(b).digest("hex");

const simulation = {
  schema: "stateaction.simulation_provenance.v1",
  qualification: "simulation_only",
  mappedTimelineSemantics: "simulation_transport_only",
  productionQualified: false,
  provenance: {
    camera: { status: "known", label: "android-emulator-virtualscene" },
    encoder: { status: "unknown" },
    clock: { status: "known", label: "host-receipt-transport-only" },
  },
};
const artifactSimulation = {
  schema: simulation.schema,
  qualification: simulation.qualification,
  mapped_timeline_semantics: simulation.mappedTimelineSemantics,
  production_qualified: false,
  provenance: simulation.provenance,
};

let db, s3, users, baseEnv, owner, app, storage, deps;
const servers = {};
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

function call(server, path, { method = "GET", body, headers = {}, jar } = {}) {
  const h = { ...headers };
  if (jar?.cookies.size) h.cookie = jar.header();
  h["x-forwarded-for"] ??= jar?.ip ?? `198.51.100.${++ipCounter}`;
  return new Promise((resolve, reject) => {
    const req = request(server.origin + path, { method, headers: h }, (res) => {
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
const browserPost = (server, jar, body) => ({
  method: "POST",
  jar,
  body: JSON.stringify(body),
  headers: {
    "content-type": "application/json",
    origin: server.origin,
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
    "x-stateaction-client": "web",
  },
});
const nativePost = (jar, body, extra = {}) => ({
  method: "POST",
  jar,
  body: JSON.stringify(body),
  headers: {
    "content-type": "application/json",
    "x-stateaction-client": "android",
    ...extra,
  },
});

async function signIn(server, email) {
  const jar = new Jar();
  const res = await call(
    server,
    "/api/auth/sign-in/email",
    browserPost(server, jar, { email, password: PASSWORD }),
  );
  assert.equal(res.status, 200, `${email}: ${res.text}`);
  assert.ok(jar.cookies.get(SESSION));
  return jar;
}

async function startNext(name, extraEnv) {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const server = { origin, logs: "" };
  server.child = spawn(
    process.execPath,
    [nextBin, "start", "-p", String(port), "-H", "127.0.0.1"],
    {
      cwd: webDir,
      env: {
        ...baseEnv,
        BETTER_AUTH_URL: origin,
        ...extraEnv,
        NODE_ENV: "production",
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  server.child.stdout.on("data", (c) => (server.logs += c));
  server.child.stderr.on("data", (c) => (server.logs += c));
  for (let i = 0; ; i++) {
    try {
      if ((await call(server, "/login")).status === 200) break;
    } catch {}
    if (i > 120 || server.child.exitCode !== null)
      throw new Error(`next start ${name} failed:\n${server.logs}`);
    await sleep(500);
  }
  servers[name] = server;
  return server;
}
async function stopNext(name) {
  const server = servers[name];
  if (server?.child.exitCode === null) {
    try {
      process.kill(-server.child.pid, "SIGTERM");
    } catch {}
    await sleep(500);
  }
  delete servers[name];
}

const createV2 = (rgbProfile = SIM, clientRecordingId = randomUUID()) => ({
  schema: "stateaction.recording_create.v2",
  clientRecordingId,
  captureFormat: "stateaction.capture.v1",
  rgbProfile,
  ...(rgbProfile === SIM ? { simulation } : {}),
  startedAt: "2026-11-02T08:00:00.000000Z",
  device: {
    model: "sdk_gphone64_x86_64",
    osVersion: "15",
    appVersion: "0.1.0+1",
  },
});

before(async () => {
  [db, s3] = await Promise.all([startCatalogPostgres(), startSeaweedfs()]);
  baseEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    APP_ENV: "local",
    // TEST-ONLY: trust the loopback harness peer for simulated client addresses (rejected on hosted).
    AUTH_TRUSTED_PROXIES: "127.0.0.1,::1",
    DATABASE_HOST: new URL(db.appUrl).hostname,
    DATABASE_PORT: new URL(db.appUrl).port,
    DATABASE_NAME: new URL(db.appUrl).pathname.slice(1),
    APP_DB_PASSWORD: decodeURIComponent(new URL(db.appUrl).password),
    BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
    AUTH_LOCAL_PASSWORD: "true",
    S3_ENDPOINT: s3.endpoint,
    S3_REGION: "us-east-1",
    // External fixtures hand out a run-owned, already-created bucket.
    S3_BUCKET: s3.bucket ?? "stateaction-e2e",
    S3_ACCESS_KEY_ID: s3.accessKeyId,
    S3_SECRET_ACCESS_KEY: s3.secretAccessKey,
    PROCESSING_PROFILE_REVISION: "sa71-e2e-1",
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
        PATH: baseEnv.PATH,
        HOME: baseEnv.HOME,
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
    region: baseEnv.S3_REGION,
    bucket: baseEnv.S3_BUCKET,
    accessKeyId: s3.accessKeyId,
    secretAccessKey: s3.secretAccessKey,
  };
  storage = storageClient(storageConfig, 15000);
  if (!s3.bucket)
    await storage.send(new CreateBucketCommand({ Bucket: baseEnv.S3_BUCKET }));
  deps = {
    pool: app,
    reader: s3ObjectReader(storageConfig),
    config: {
      processingProfileRevision: baseEnv.PROCESSING_PROFILE_REVISION,
      supportedRgbProfiles: ["h264_mcap_v1", SIM],
      simulatedCaptureInputs: true,
    },
  };
  const { recordIngestPermission } = await dist("admission/permissions.js");
  const have = await owner.query(
    "SELECT 1 FROM ingest_permissions WHERE owner_user_id = $1 AND status = 'active'",
    [users.collector.id],
  );
  if (!have.rowCount)
    await recordIngestPermission(owner, {
      permissionRef: "sa71-e2e.r1",
      ownerUserId: users.collector.id,
      pilotScope: "sa71-e2e",
      coversCapture: true,
      coversProcessing: true,
      evidenceRef: "doc://pilot/sa71-e2e",
      recordedBy: "operator@e2e",
    });
});

after(async () => {
  for (const name of Object.keys(servers)) await stopNext(name);
  storage?.destroy();
  await Promise.all([owner?.end(), app?.end()]);
  await db?.stop();
  await s3?.stop();
  if (process.env.SA71_E2E_EVIDENCE)
    process.stdout.write(`SA71_E2E_EVIDENCE ${JSON.stringify(evidence)}\n`);
});

describe("default and hosted configurations refuse simulated input", () => {
  test("default server (no flag): simulated create is 403, hardware v1 is unchanged", async () => {
    const server = await startNext("default", {});
    try {
      const jar = await signIn(server, users.collector.email);
      const refused = await call(
        server,
        "/api/v1/recordings",
        nativePost(jar, createV2()),
      );
      assert.equal(refused.status, 403, refused.text);
      const hardware = await call(
        server,
        "/api/v1/recordings",
        nativePost(jar, {
          clientRecordingId: randomUUID(),
          captureFormat: "stateaction.capture.v1",
          rgbProfile: "h264_mcap_v1",
          startedAt: "2026-11-02T08:00:00Z",
          device: { model: "Pixel 9", osVersion: "16", appVersion: "0.1.0" },
        }),
      );
      assert.equal(hardware.status, 201, hardware.text);
      assert.match(hardware.headers["content-type"], /^application\/json/);
      assert.equal(
        validateValue("http.recording-registration.v1", hardware.json.data)
          .valid,
        true,
      );
      const rows = await owner.query(
        "SELECT count(*)::int AS n FROM recordings WHERE rgb_profile = $1",
        [SIM],
      );
      assert.equal(rows.rows[0].n, 0);
      evidence.defaultServer = {
        simulatedCreate: refused.status,
        hardwareCreate: hardware.status,
      };
    } finally {
      await stopNext("default");
    }
  });

  test("a Render-hosted spoof (APP_ENV=local + flag + service markers) is a configuration error", async () => {
    const server = await startNext("spoof", {
      ALLOW_SIMULATED_CAPTURE_INPUTS: "true",
      RENDER_SERVICE_ID: "srv-spoof",
    });
    try {
      // Central configuration refuses to load: the route answers 503 before any
      // authentication or data access.
      const res = await call(
        server,
        "/api/v1/recordings",
        nativePost(new Jar(), createV2()),
      );
      assert.equal(res.status, 503, res.text);
      assert.match(server.logs, /ALLOW_SIMULATED_CAPTURE_INPUTS is refused/);
      const rows = await owner.query(
        "SELECT count(*)::int AS n FROM recordings WHERE rgb_profile = $1",
        [SIM],
      );
      assert.equal(rows.rows[0].n, 0);
      evidence.hostedSpoof = { status: res.status };
    } finally {
      await stopNext("spoof");
    }
  });
});

describe("explicit development flag over the real Next route path", () => {
  test("create, read negotiation, seal, admission and job input keep the simulation marker", async () => {
    const server = await startNext("development", {
      ALLOW_SIMULATED_CAPTURE_INPUTS: "true",
    });
    try {
      const jar = await signIn(server, users.collector.email);
      const clientRecordingId = randomUUID();
      const created = await call(
        server,
        "/api/v1/recordings",
        nativePost(jar, createV2(SIM, clientRecordingId)),
      );
      assert.equal(created.status, 201, created.text);
      assert.equal(created.headers["content-type"], V2);
      assert.match(String(created.headers["cache-control"]), /no-store/);
      assert.equal(
        validateValue("http.success-envelope.v1", created.json).valid,
        true,
      );
      assert.equal(
        validateValue("http.recording-registration.v2", created.json.data)
          .valid,
        true,
      );
      const { recording, collectionPermissionRef } = created.json.data;
      assert.equal(recording.rgbProfile, SIM);
      assert.deepEqual(recording.simulation, simulation);
      const recordingId = recording.recordingId;
      const replay = await call(
        server,
        "/api/v1/recordings",
        nativePost(jar, createV2(SIM, clientRecordingId)),
      );
      assert.equal(replay.status, 200, replay.text);
      // No downgrade: the unchanged v1 read never describes a simulated recording.
      const plain = await call(server, `/api/v1/recordings/${recordingId}`, {
        jar,
      });
      assert.equal(plain.status, 406, plain.text);
      assert.equal(plain.json.error.code, "not_acceptable");
      const v2 = await call(server, `/api/v1/recordings/${recordingId}`, {
        jar,
        headers: { accept: V2 },
      });
      assert.equal(v2.status, 200);
      assert.equal(v2.headers["content-type"], V2);
      assert.equal(
        validateValue("http.recording.v2", v2.json.data).valid,
        true,
      );

      // Source files + v2 manifest with a ROS slash schema name and explicit unknowns.
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
          schema: "stateaction.recording_source.v2",
          recording_id: recordingId,
          client_recording_id: clientRecordingId,
          owner_user_id: users.collector.id,
          capture_format: "stateaction.capture.v1",
          rgb_profile: SIM,
          simulation: artifactSimulation,
          capture_config_sha256: sha("capture-config"),
          close_status: "closed_clean",
          files: files.map((f) => ({
            file_id: f.fileId,
            role: f.role,
            required: true,
            size_bytes: f.sizeBytes,
            sha256: f.sha256,
          })),
          clock_domains: ["android.elapsed_realtime"],
          channels: [
            {
              topic: "/camera/rgb",
              message_encoding: "protobuf",
              schema_name: "foxglove.CompressedVideo",
              clock_domain: "android.elapsed_realtime",
              message_count: "30",
            },
            {
              topic: "/pose",
              message_encoding: "cdr",
              schema_name: "geometry_msgs/msg/PoseStamped",
              clock_domain: "android.elapsed_realtime",
              message_count: "30",
            },
          ],
          counts: {
            video_frames: "30",
            dropped_video_frames: "0",
            motion_events: "30",
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
          ownerUserId: users.collector.id,
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
          Bucket: baseEnv.S3_BUCKET,
          Key: sourceObjectKey(recordingId, manifestId, 1, "source_manifest"),
          Body: manifest,
        }),
      );
      const complete = (role) => {
        const f = files.find((x) => x.role === role);
        return recordSourceCompletion(
          deps,
          { userId: users.collector.id },
          {
            recordingId,
            fileId: f.fileId,
            expectedTransportEpoch: 1,
            observedSizeBytes: f.sizeBytes,
          },
        );
      };
      for (const role of [
        "source_mcap",
        "recorder_metadata",
        "source_manifest",
      ])
        await complete(role);
      // The HTTP seal admits; a simulated seal answers in v2 even without Accept.
      const sealed = await call(
        server,
        `/api/v1/recordings/${recordingId}/seal`,
        browserPost(server, jar, {
          files: files.map((f) => ({ ...f, required: true })),
        }),
      );
      assert.equal(sealed.status, 200, sealed.text);
      assert.equal(sealed.headers["content-type"], V2);
      assert.equal(
        validateValue("http.recording.v2", sealed.json.data).valid,
        true,
      );
      assert.equal(sealed.json.data.status, "uploaded");
      assert.deepEqual(sealed.json.data.simulation, simulation);
      const jobs = (
        await owner.query("SELECT id FROM jobs WHERE recording_id = $1", [
          recordingId,
        ])
      ).rows;
      assert.equal(jobs.length, 1);
      const adm = (
        await owner.query(
          "SELECT rgb_profile, simulation FROM recording_admissions WHERE recording_id = $1",
          [recordingId],
        )
      ).rows[0];
      assert.equal(adm.rgb_profile, SIM);
      assert.deepEqual(adm.simulation, simulation);
      const input = await processRecordingTaskInputV2(app, jobs[0].id);
      assert.equal(validateValue("jobs.task-input.v2", input).valid, true);
      assert.equal(input.rgbProfile, SIM);
      assert.deepEqual(input.simulation, simulation);
      assert.deepEqual(input.simulation.provenance.encoder, {
        status: "unknown",
      });
      evidence.development = {
        create: created.status,
        plainGet: plain.status,
        v2Get: v2.status,
        seal: sealed.status,
        jobs: jobs.length,
        rgbProfile: input.rgbProfile,
      };
    } finally {
      await stopNext("development");
    }
  });
});
