// REAL SOURCE-COPY CONFIRMATION AND OWNER CLEANUP PROOF E2E (SA-73): the
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
import { freePort } from "../../../scripts/platform/free-port.mjs";
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { request } from "node:http";
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
const { CreateBucketCommand, PutObjectCommand, DeleteObjectCommand } =
  serverRequire("@aws-sdk/client-s3");
const dist = (p) => import(new URL(`dist/${p}`, `file://${serverDir}`).href);
const cat = await dist("catalog/catalog.js");
const { establishFixtureAdmission } = await dist("admission/fixtures.js");
const { issueControllerCapability } = await dist("jobs/credentials.js");
const { fixtureRunJob, fixtureCloseOutputs, fixtureAcceptResult } =
  await dist("jobs/fixtures.js");
const { seedSha } = await dist("catalog/seed.js");
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
    dbName = `cleanup_proof_e2e_${randomUUID().replaceAll("-", "")}`;
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
    S3_BUCKET: `sa73-e2e-${randomBytes(4).toString("hex")}`,
    S3_ACCESS_KEY_ID: s3.accessKeyId,
    S3_SECRET_ACCESS_KEY: s3.secretAccessKey,
    PROCESSING_PROFILE_REVISION: "sa73-e2e-1",
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
  if (process.env.SA73_E2E_EVIDENCE)
    process.stdout.write(`SA73_E2E_EVIDENCE ${JSON.stringify(evidence)}\n`);
});

/**
 * SYNTHETIC accepted-source state (explicitly NOT a hand-pipeline
 * qualification): a sealed recording with real, finite source bytes in storage,
 * moved to reviewable through the fixture acceptance boundary (owner credential),
 * so the production routes can be exercised against real sessions.
 */
async function acceptedRecording(ownerUserId = users.collector.id) {
  const recordingId = randomUUID();
  const clientRecordingId = randomUUID();
  await cat.registerRecording(app, {
    recordingId,
    ownerUserId,
    clientRecordingId,
    captureFormat: "stateaction.capture.v1",
    rgbProfile: "h264_mcap_v1",
    startedAt: new Date().toISOString(),
    device: { model: "emulator", osVersion: "16", appVersion: "test" },
  });
  let manifestFileId = "";
  const keys = {};
  const bodies = {};
  for (const role of ["source_manifest", "source_mcap", "recorder_metadata"]) {
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
    keys[role] = rows[0].object_key;
    bodies[role] = body;
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
  await fixtureRunJob(owner, jobId, { maxOutputFiles: 512 });
  const output = async (role) => {
    const id = randomUUID();
    await app.query(
      `INSERT INTO files (id, recording_id, job_id, purpose, role, size_bytes, sha256, object_key, part_size_bytes, part_count)
       VALUES ($1, $2, $3, 'output', $4, 100, $5, $6, 67108864, 1)`,
      [
        id,
        recordingId,
        jobId,
        role,
        seedSha(id),
        cat.outputObjectKey(jobId, id, 1, `${role}.bin`),
      ],
    );
    await cat.recordFileCompleted(app, {
      fileId: id,
      expectedTransportEpoch: 1,
      observedSizeBytes: "100",
    });
    return id;
  };
  const clips = [
    {
      clipId: randomUUID(),
      ordinal: 0,
      title: "clip 0",
      sourceStartNs: "0",
      sourceEndNs: "900",
      durationNs: "900",
      clockDomain: "test",
      raster: { width: 64, height: 48 },
      frameCount: 3,
      files: {
        rgbMp4: await output("clip_mp4"),
        handArraysNpz: await output("hand_arrays_npz"),
        handObservationsJson: await output("hand_observations_json"),
        frameMapJson: await output("frame_map_json"),
        thumbnailJpeg: await output("thumbnail_jpeg"),
        viewerRrd: await output("viewer_rrd"),
      },
    },
  ];
  const resultId = await output("result_manifest");
  await fixtureCloseOutputs(owner, { jobId, manifestFileId: resultId, clips });
  await app.query("UPDATE jobs SET state = 'result_pending' WHERE id = $1", [
    jobId,
  ]);
  await fixtureAcceptResult(owner, app, {
    jobId,
    manifestFileId: resultId,
    manifestSha256: seedSha(resultId),
    clips,
  });
  const { rows } = await owner.query(
    `SELECT r.status, s.request_sha256 AS seal, r.source_manifest_sha256 AS manifest
     FROM recordings r JOIN recording_seals s ON s.recording_id = r.id WHERE r.id = $1`,
    [recordingId],
  );
  assert.equal(rows[0].status, "reviewable");
  return {
    recordingId,
    clientRecordingId,
    seal: rows[0].seal,
    manifest: rows[0].manifest,
    keys,
    bodies,
  };
}

const SAME_ORIGIN = () => ({
  "content-type": "application/json",
  origin,
  "sec-fetch-site": "same-origin",
  "sec-fetch-mode": "cors",
  "x-stateaction-client": "web",
});
const confirmPath = (r) =>
  `/api/v1/recordings/${r.recordingId}/source-copy-confirmation`;
const proofPath = (r) => `/api/v1/recordings/${r.recordingId}/cleanup-proofs`;
const confirmBody = (r) => ({
  expectedSealSha256: r.seal,
  expectedSourceManifestSha256: r.manifest,
  expectedFileCount: 3,
});
const proofBody = (r) => ({
  sealSha256: r.seal,
  sourceManifestSha256: r.manifest,
  clientRecordingId: r.clientRecordingId,
});
const send = (path, jar, body, headers = {}) =>
  call(path, {
    method: "POST",
    jar,
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { ...SAME_ORIGIN(), ...headers },
  });
const rows = async (table, recordingId) =>
  (
    await owner.query(
      `SELECT count(*)::int AS n FROM ${table} WHERE recording_id = $1`,
      [recordingId],
    )
  ).rows[0].n;

describe("source copy confirmation and cleanup proof over the production Next routes", () => {
  let staff, collector, customer, outsider;
  before(async () => {
    [staff, collector, customer, outsider] = await Promise.all([
      signIn(users.staff.email),
      signIn(users.collector.email),
      signIn(users.customer.email),
      signIn(users.outsider.email),
    ]);
  });

  test("real sessions: staff confirms, role separation, wrong owner and anonymous are refused", async () => {
    const r = await acceptedRecording();
    // No session, bearer credentials and a missing client header never act.
    assert.equal(
      (await send(confirmPath(r), null, confirmBody(r))).status,
      401,
    );
    assert.equal(
      (
        await send(confirmPath(r), staff, confirmBody(r), {
          authorization: "Bearer x",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await send(confirmPath(r), staff, confirmBody(r), {
          "x-stateaction-client": "",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await send(confirmPath(r), staff, confirmBody(r), {
          origin: "https://evil.example",
        })
      ).status,
      403,
    );
    for (const jar of [collector, customer, outsider])
      assert.equal(
        (await send(confirmPath(r), jar, confirmBody(r))).status,
        403,
      );
    assert.equal(await rows("source_copy_confirmations", r.recordingId), 0);
    // The owner cannot get a proof before staff confirmed.
    const early = await send(proofPath(r), collector, proofBody(r));
    assert.equal(early.status, 409);
    assert.equal(early.json.error.code, "staff_confirmation_required");

    const ok = await send(confirmPath(r), staff, confirmBody(r));
    assert.equal(ok.status, 201, ok.text);
    assert.ok(
      validateValue("http.source-copy-confirmation.v1", ok.json.data).valid,
    );
    assert.match(ok.headers["cache-control"], /no-store/);
    assert.equal(ok.json.data.confirmedByUserId, users.staff.id);
    const replay = await send(confirmPath(r), staff, confirmBody(r));
    assert.equal(replay.status, 200);
    assert.equal(replay.json.data.confirmationId, ok.json.data.confirmationId);

    const proof = await send(proofPath(r), collector, proofBody(r));
    assert.equal(proof.status, 200, proof.text);
    assert.ok(validateValue("http.cleanup-proof.v1", proof.json.data).valid);
    assert.equal(proof.json.data.ownerUserId, users.collector.id);
    assert.equal(proof.json.data.verification, "rehash");
    assert.ok(
      Date.parse(proof.json.data.expiresAt) >
        Date.parse(proof.json.data.issuedAt),
    );
    // Not staff, not customer, not anonymous; a non-owner collector sees a plain 404.
    assert.equal((await send(proofPath(r), staff, proofBody(r))).status, 403);
    assert.equal(
      (await send(proofPath(r), customer, proofBody(r))).status,
      403,
    );
    assert.equal((await send(proofPath(r), null, proofBody(r))).status, 401);
    await owner.query(
      "INSERT INTO access (user_id, role) VALUES ($1, 'collector') ON CONFLICT DO NOTHING",
      [users.staff.id],
    );
    const foreign = await send(proofPath(r), staff, proofBody(r));
    const missing = await send(
      `/api/v1/recordings/${randomUUID()}/cleanup-proofs`,
      staff,
      proofBody(r),
    );
    assert.equal(foreign.status, 404);
    assert.deepEqual(foreign.json.error, missing.json.error);
    await owner.query(
      "DELETE FROM access WHERE user_id = $1 AND role = 'collector'",
      [users.staff.id],
    );
    evidence.proofIssued = true;
  });

  test("hostile and incomplete bodies get a stable envelope; no empty or partial success", async () => {
    const r = await acceptedRecording();
    const cases = [
      [
        "unknown owner field",
        { ...confirmBody(r), ownerUserId: users.collector.id },
        422,
      ],
      [
        "unknown staff field",
        { ...confirmBody(r), confirmedByUserId: users.staff.id },
        422,
      ],
      ["missing field", { expectedSealSha256: r.seal }, 422],
      ["wrong type", { ...confirmBody(r), expectedFileCount: "3" }, 422],
      ["array", [], 422],
      ["truncated JSON", '{"expectedSealSha256":"', 422],
      ["empty body", "", 422],
    ];
    for (const [name, body, status] of cases) {
      const res = await send(confirmPath(r), staff, body);
      assert.equal(res.status, status, name);
      assert.ok(
        res.json?.error?.code && res.json.requestId,
        `${name}: error envelope`,
      );
      assert.equal(res.json.data, undefined, name);
    }
    const oversize = await send(confirmPath(r), staff, " ".repeat(4096));
    assert.equal(oversize.status, 413);
    const wrong = await send(confirmPath(r), staff, {
      ...confirmBody(r),
      expectedSealSha256: "0".repeat(64),
    });
    assert.equal(wrong.status, 409);
    assert.equal(wrong.json.error.code, "inventory_changed");
    assert.equal(
      (
        await send(
          "/api/v1/recordings/not-a-uuid/cleanup-proofs",
          collector,
          proofBody(r),
        )
      ).status,
      404,
    );
    assert.equal(await rows("source_copy_confirmations", r.recordingId), 0);
  });

  test("tampered, truncated or missing cloud objects and revoked roles fail closed with no proof", async () => {
    const swap = async (key, body) =>
      storage.send(
        new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Body: body }),
      );
    // Staff confirmation refuses a bad copy.
    const bad = await acceptedRecording();
    await swap(
      bad.keys.source_mcap,
      Buffer.alloc(bad.bodies.source_mcap.length, 1),
    );
    const refused = await send(confirmPath(bad), staff, confirmBody(bad));
    assert.equal(refused.status, 409);
    assert.equal(refused.json.error.code, "source_hash_mismatch");
    assert.equal(await rows("source_copy_confirmations", bad.recordingId), 0);
    // A confirmed copy that later changes yields no proof.
    for (const [label, damage, code] of [
      [
        "replaced",
        (r) =>
          swap(
            r.keys.source_mcap,
            Buffer.alloc(r.bodies.source_mcap.length, 2),
          ),
        "source_hash_mismatch",
      ],
      [
        "truncated",
        (r) => swap(r.keys.recorder_metadata, Buffer.alloc(2)),
        "source_size_mismatch",
      ],
      [
        "deleted",
        (r) =>
          storage.send(
            new DeleteObjectCommand({
              Bucket: env.S3_BUCKET,
              Key: r.keys.source_manifest,
            }),
          ),
        "source_object_missing",
      ],
    ]) {
      const r = await acceptedRecording();
      assert.equal(
        (await send(confirmPath(r), staff, confirmBody(r))).status,
        201,
      );
      assert.equal(
        (await send(proofPath(r), collector, proofBody(r))).status,
        200,
        label,
      );
      await damage(r);
      const res = await send(proofPath(r), collector, proofBody(r));
      assert.equal(res.status, 409, label);
      assert.equal(res.json.error.code, code, label);
      assert.equal(
        await rows("source_cleanup_proofs", r.recordingId),
        1,
        `${label}: only the earlier proof`,
      );
    }
    // Revocation: collector role, then ingest permission.
    const r = await acceptedRecording();
    assert.equal(
      (await send(confirmPath(r), staff, confirmBody(r))).status,
      201,
    );
    await owner.query(
      "UPDATE access SET enabled = false WHERE user_id = $1 AND role = 'collector'",
      [users.collector.id],
    );
    assert.equal(
      (await send(proofPath(r), collector, proofBody(r))).status,
      403,
    );
    await owner.query(
      "UPDATE access SET enabled = true WHERE user_id = $1 AND role = 'collector'",
      [users.collector.id],
    );
    assert.equal(
      (await send(proofPath(r), collector, proofBody(r))).status,
      200,
    );
    await owner.query(
      "UPDATE ingest_permissions SET status = 'revoked', revoked_at = now(), revoked_by = 'e2e' WHERE owner_user_id = $1 AND status = 'active'",
      [users.collector.id],
    );
    const revoked = await send(proofPath(r), collector, proofBody(r));
    assert.equal(revoked.status, 409);
    assert.equal(revoked.json.error.code, "source_not_eligible");
    // Originals and rows are untouched by any of this.
    const kept = await owner.query(
      "SELECT count(*)::int AS n FROM files WHERE recording_id = $1 AND purpose = 'source'",
      [r.recordingId],
    );
    assert.equal(kept.rows[0].n, 3);
  });
});
