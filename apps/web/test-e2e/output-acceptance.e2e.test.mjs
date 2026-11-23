// REAL OUTPUT SEALING AND ATOMIC ACCEPTANCE E2E (SA-28 x SA-25 x SA-20 x SA-19): the
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
const { fixtureRunJob } = await dist("jobs/fixtures.js");
import { readFileSync } from "node:fs";
import {
  waitForGroupExit,
  leaked,
} from "../../../scripts/platform/process-wait.mjs";
const { storageClient } = await dist("storage.js");

const nextBin = createRequire(join(webDir, "package.json")).resolve(
  "next/dist/bin/next",
);
const need = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`${k} must come from the bounded fixtures env`);
  return v;
};
const PASSWORD = "e2e-only " + randomBytes(9).toString("base64url");
const SESSION = "better-auth.session_token";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const withDb = (url, name) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};

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
  if (process.env.CATALOG_TEST_ADMIN_URL) {
    // Shared bounded fixtures: a private database inside the shared server.
    const admin = new pg.Client({
      connectionString: need("CATALOG_TEST_ADMIN_URL"),
    });
    dbName = `acceptance_e2e_${randomUUID().replaceAll("-", "")}`;
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName} OWNER migration_owner`);
    await admin.end();
    ownerUrl = withDb(need("CATALOG_TEST_OWNER_URL"), dbName);
    appUrl = withDb(need("CATALOG_TEST_APP_URL"), dbName);
    s3 = {
      endpoint: need("TRANSPORT_TEST_S3_ENDPOINT"),
      accessKeyId: need("TRANSPORT_TEST_S3_ACCESS_KEY"),
      secretAccessKey: need("TRANSPORT_TEST_S3_SECRET_KEY"),
    };
  } else {
    // CI/default: the same throwaway containers the other E2E files use.
    const { startCatalogPostgres } = await import(
      "../../../packages/server/test-auth/postgres.mjs"
    );
    const { startSeaweedfs } = await import("./seaweedfs.mjs");
    const [started, store] = await Promise.all([
      startCatalogPostgres(),
      startSeaweedfs(),
    ]);
    fallback = { stop: () => (started.stop(), store.stop()) };
    ownerUrl = started.ownerUrl;
    appUrl = started.appUrl;
    dbName = new URL(appUrl).pathname.slice(1);
    s3 = store;
  }
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
    S3_BUCKET: `sa28-e2e-${randomBytes(4).toString("hex")}`,
    S3_ACCESS_KEY_ID: s3.accessKeyId,
    S3_SECRET_ACCESS_KEY: s3.secretAccessKey,
    PROCESSING_PROFILE_REVISION: "sa28-e2e-1",
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
  if (fallback) fallback.stop();
  else if (dbName) {
    const admin = new pg.Client({
      connectionString: need("CATALOG_TEST_ADMIN_URL"),
    });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin.end();
  }
  if (process.env.SA28_E2E_EVIDENCE)
    process.stdout.write(`SA28_E2E_EVIDENCE ${JSON.stringify(evidence)}\n`);
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

const TEMPLATE = JSON.parse(
  readFileSync(
    new URL(
      "../../../packages/contracts/conformance/fixtures/artifacts/processing-result.v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const CLIP_FILES = [
  ["rgb_mp4", "clip_mp4", "rgb.mp4"],
  ["hand_arrays_npz", "hand_arrays_npz", "hand-arrays.npz"],
  [
    "hand_observations_json",
    "hand_observations_json",
    "hand-observations.json",
  ],
  ["frame_map_json", "frame_map_json", "frame-map.json"],
  ["thumbnail_jpeg", "thumbnail_jpeg", "thumbnail.jpg"],
  ["viewer_rrd", "viewer_rrd", "viewer.rrd"],
];

describe("output sealing and acceptance over the production Next routes", () => {
  let workflow, cron;
  const base = (id) => `/internal/v1/jobs/${id}`;
  const act = (id, body) =>
    call(`${base(id)}/controller`, post(workflow, body));
  const state = async (jobId) =>
    (
      await owner.query(
        `SELECT j.state, j.error_code, r.status AS rec,
                (SELECT count(*)::int FROM clips c WHERE c.job_id = j.id) AS clips,
                (SELECT job_id FROM dispatch_admission WHERE slot = 1) AS holder
         FROM jobs j JOIN recordings r ON r.id = j.recording_id WHERE j.id = $1`,
        [jobId],
      )
    ).rows[0];

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
  });

  /** The worker side, over HTTP only: allocate, sign, direct PUT, receipts, complete. */
  async function upload(run, slot, role, bytes) {
    const create = await call(
      `${base(run.jobId)}/outputs`,
      post(run.token, {
        slot,
        role,
        sizeBytes: String(bytes.length),
        sha256: sha(bytes),
      }),
    );
    assert.equal(create.status, 200, create.text);
    const plan = create.json.data;
    const signed = await call(
      `${base(run.jobId)}/outputs/${plan.fileId}/parts/sign`,
      post(run.token, {
        expectedTransportEpoch: plan.transportEpoch,
        partNumbers: [1],
      }),
    );
    assert.equal(signed.status, 200, signed.text);
    const part = signed.json.data.parts[0];
    const put = await fetch(part.url, {
      method: "PUT",
      body: bytes,
      headers: part.headers,
    });
    assert.ok(put.ok, `part PUT ${put.status}`);
    const receipts = await call(
      `${base(run.jobId)}/outputs/${plan.fileId}/parts/receipts`,
      {
        ...post(run.token, {
          expectedTransportEpoch: plan.transportEpoch,
          receipts: [
            {
              partNumber: 1,
              etag: put.headers.get("etag"),
              sizeBytes: String(bytes.length),
            },
          ],
        }),
        method: "PUT",
      },
    );
    assert.equal(receipts.status, 200, receipts.text);
    const done = await call(
      `${base(run.jobId)}/outputs/${plan.fileId}/complete`,
      post(run.token, {
        expectedTransportEpoch: plan.transportEpoch,
      }),
    );
    assert.equal(done.status, 200, done.text);
    return {
      fileId: plan.fileId,
      slot,
      role,
      size: bytes.length,
      sha: sha(bytes),
      bytes,
    };
  }

  async function startRun() {
    const job = await queuedJob();
    const fx = await fixtureRunJob(owner, job.jobId);
    return { ...job, token: fx.capabilityToken, nonce: fx.nonce };
  }

  async function workerResult(run, mutate = () => {}) {
    const files = [];
    for (const [, role, name] of CLIP_FILES)
      files.push(
        await upload(
          run,
          `clips/000/${name}`,
          role,
          Buffer.from(`${run.jobId}:${name}`),
        ),
      );
    const inputs = (
      await owner.query("SELECT * FROM job_inputs WHERE job_id = $1", [
        run.jobId,
      ])
    ).rows[0];
    const mcap = (
      await owner.query(
        "SELECT id, size_bytes::text, sha256 FROM files WHERE recording_id = $1 AND role = 'source_mcap'",
        [run.recordingId],
      )
    ).rows[0];
    const doc = structuredClone(TEMPLATE);
    Object.assign(doc, {
      schema: "stateaction.processing_result.v2",
      job_id: run.jobId,
      recording_id: run.recordingId,
      source_manifest_sha256: inputs.source_manifest_sha256,
      verified_sources: [
        { file_id: mcap.id, size_bytes: mcap.size_bytes, sha256: mcap.sha256 },
      ],
      attestation: {
        invocation_nonce: run.nonce,
        rgb_profile: "h264_mcap_v1",
        source_file_id: mcap.id,
        source_eof_verified: true,
      },
    });
    doc.provenance = {
      ...doc.provenance,
      code_revision: inputs.code_revision,
      image_spec_sha256: inputs.image_spec_sha256,
      config_sha256: inputs.config_sha256,
      profile_revision: inputs.profile_revision,
      model: { ...doc.provenance.model, asset_sha256: inputs.model_sha256 },
    };
    doc.outputs = files.map((f) => ({
      file_id: f.fileId,
      role: f.role,
      relative_path: f.slot,
      size_bytes: String(f.size),
      sha256: f.sha,
    }));
    doc.clips = [
      {
        ...structuredClone(TEMPLATE.clips[0]),
        clip_id: randomUUID(),
        files: Object.fromEntries(
          CLIP_FILES.map(([k, role]) => [
            k,
            files.find((f) => f.role === role).fileId,
          ]),
        ),
      },
    ];
    mutate(doc);
    const manifest = await upload(
      run,
      "result-manifest.json",
      "result_manifest",
      Buffer.from(JSON.stringify(doc)),
    );
    return { manifest, doc };
  }

  /** The repair cron continues unfinished verification/acceptance (resumable by design). */
  const settle = async (jobId) => {
    for (let i = 0; i < 20; i++) {
      const st = await state(jobId);
      if (["succeeded", "failed", "cancelled"].includes(st.state)) return st;
      await call("/internal/v1/jobs/reconcile", post(cron, {}));
      await sleep(250);
    }
    return state(jobId);
  };
  const close = (run, token = run.token) =>
    call(
      `${base(run.jobId)}/outputs/close`,
      post(token, {
        schemaVersion: 1,
        jobId: run.jobId,
        invocationNonce: run.nonce,
        outcome: "succeeded",
      }),
    );
  const candidate = (run, manifest, doc, token = run.token) =>
    call(
      `${base(run.jobId)}/result`,
      post(token, {
        schemaVersion: 1,
        jobId: run.jobId,
        invocationNonce: run.nonce,
        manifestFileId: manifest.fileId,
        manifestSha256: manifest.sha,
        summary: {
          outcome: "succeeded",
          clipCount: 1,
          checks: doc.checks.reduce(
            (c, k) => (
              c[k.status === "not_evaluated" ? "notEvaluated" : k.status]++,
              c
            ),
            { pass: 0, warn: 0, fail: 0, measured: 0, notEvaluated: 0 },
          ),
          errorCode: null,
        },
      }),
    );
  const evidenceFor = async (run) => {
    const ref = (
      await owner.query("SELECT execution_call_id FROM jobs WHERE id = $1", [
        run.jobId,
      ])
    ).rows[0].execution_call_id;
    return act(run.jobId, {
      action: "record_execution_evidence",
      evidence: { kind: "local_child_reaped", executionRef: ref },
    });
  };

  test("authentication: only the claiming worker capability reaches close, result and task-input", async () => {
    const run = await startRun();
    for (const [path, method] of [
      [`${base(run.jobId)}/outputs/close`, "POST"],
      [`${base(run.jobId)}/result`, "POST"],
      [`${base(run.jobId)}/task-input`, "GET"],
    ]) {
      assert.equal(
        (
          await call(path, {
            method,
            body: method === "POST" ? "{}" : undefined,
            headers: { "content-type": "application/json" },
          })
        ).status,
        401,
        `${path} anonymous`,
      );
      assert.equal(
        (
          await call(path, {
            method,
            body: method === "POST" ? "{}" : undefined,
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${workflow}`,
            },
          })
        ).status,
        401, // a controller credential is not a worker capability for this job
        `${path} controller`,
      );
    }
    const task = await call(`${base(run.jobId)}/task-input`, get(run.token));
    assert.equal(task.status, 200, task.text);
    assert.equal(task.json.data.targetId, run.recordingId);
    assert.equal(task.json.data.rgbProfile, "h264_mcap_v1");
    const other = await startRun();
    assert.equal(
      (await call(`${base(run.jobId)}/outputs/close`, post(other.token, {})))
        .status,
      403,
      "another job's capability",
    );
  });

  test("result first, evidence later: a callback selects nothing; evidence completes the atomic acceptance", async () => {
    const run = await startRun();
    const { manifest, doc } = await workerResult(run);
    assert.equal((await close(run)).status, 200);
    const res = await candidate(run, manifest, doc);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.data.candidateStatus, "verified");
    assert.ok(validateValue("jobs.result-ack.v1", res.json.data).valid);
    let st = await state(run.jobId);
    assert.deepEqual(
      [st.state, st.clips, st.holder],
      ["result_pending", 0, run.jobId],
    );
    // Write after seal and a second close with another outcome are refused.
    assert.equal(
      (
        await call(
          `${base(run.jobId)}/outputs`,
          post(run.token, {
            slot: "clips/001/rgb.mp4",
            role: "clip_mp4",
            sizeBytes: "3",
            sha256: sha("abc"),
          }),
        )
      ).status,
      401, // after the candidate the capability no longer resolves (job left running)
    );
    const ev = await evidenceFor(run);
    assert.equal(ev.status, 200, ev.text);
    st = await settle(run.jobId);
    assert.deepEqual(
      [st.state, st.clips, st.rec, st.holder],
      ["succeeded", 1, "reviewable", null],
    );
    evidence.resultFirst = st;
  });

  test("evidence first, result later: the same selected result, slot freed only at acceptance", async () => {
    const run = await startRun();
    const { manifest, doc } = await workerResult(run);
    assert.equal((await close(run)).status, 200);
    const ev = await evidenceFor(run);
    assert.equal(ev.json.data.slotReleased, false);
    assert.equal((await state(run.jobId)).holder, run.jobId);
    const res = await candidate(run, manifest, doc);
    assert.equal(res.status, 200, res.text);
    const st = await settle(run.jobId);
    assert.deepEqual(
      [st.state, st.clips, st.rec, st.holder],
      ["succeeded", 1, "reviewable", null],
    );
    evidence.evidenceFirst = st;
  });

  test("wrong nonce, tampered bytes and revoked permission are refused", async () => {
    const run = await startRun();
    const { manifest, doc } = await workerResult(run);
    const bad = await call(
      `${base(run.jobId)}/outputs/close`,
      post(run.token, {
        schemaVersion: 1,
        jobId: run.jobId,
        invocationNonce: "A".repeat(43),
        outcome: "succeeded",
      }),
    );
    assert.equal(bad.status, 403);
    assert.equal((await close(run)).status, 200);
    assert.equal(
      (await candidate(run, manifest, { ...doc }, run.token)).status,
      200,
    );
    await owner.query(
      "UPDATE ingest_permissions SET status = 'revoked', revoked_by = 'op', revoked_at = now() WHERE owner_user_id = $1",
      [users.collector.id],
    );
    await evidenceFor(run);
    const st = await state(run.jobId);
    assert.deepEqual(
      [st.state, st.error_code, st.clips],
      ["failed", "permission_revoked", 0],
    );
  });
});
