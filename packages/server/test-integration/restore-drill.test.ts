import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import pg from "pg";
import {
  createProcessingJob,
  recordFileCompleted,
  registerRecording,
  reserveSourceFile,
  sealRecording,
} from "../src/catalog/catalog.js";
import { s3ObjectHasher } from "../src/acceptance/storage.js";
import {
  advanceResult,
  closeOutputs,
  submitCandidate,
} from "../src/acceptance/service.js";
import { fixtureRunJob } from "../src/jobs/fixtures.js";
import {
  admitNextJob,
  claimControllerLease,
  recordExecutionEvidence,
  recordWorkerSubmissionIntent,
  requestJobCancel,
  type JobsDeps,
} from "../src/jobs/service.js";
import {
  flagUncertain,
  operatorGuidance,
  recoverySnapshot,
  retryJob,
} from "../src/jobs/recovery.js";
import { loadMigrations } from "../src/migrations.js";
import {
  readSnapshot,
  verifyRestoredCatalog,
  DEFAULT_LIMITS,
  RestoreVerifyError,
  type ExpectedGrants,
  type RestoreReport,
} from "../src/recovery/index.js";
import { TransportError } from "../src/transport/errors.js";
import {
  acceptanceDatabase,
  acceptanceDeps,
  candidateBody,
  manifestFor,
  uploadClip,
  uploadOutput,
  type AcceptanceDb,
  type RunningJob,
} from "./acceptance-harness.js";
import {
  databaseName,
  ledgerRun,
  marker,
  recordCreated,
} from "./fixture-ledger.js";
import { fixtureAdmission, writeArtifact } from "./harness.js";
import { JOBS_CONFIG, depsFor } from "./jobs-harness.js";
import { BUCKET, realS3, s3Config } from "./transport-harness.js";

/**
 * SA-46 LOCAL restore drill: real pg_dump/pg_restore of a synthetic catalog
 * into a NEW database on the bounded loopback Postgres, with finite full
 * SHA-256 reads of the synthetic objects in the bounded loopback SeaweedFS.
 * It writes only databases, objects and a bucket this run creates, and drops
 * exactly those at the end. It is NOT a managed Render/R2 restore and
 * establishes no backup availability, PITR window, provider state or real
 * restore time. Every artifact is labelled accordingly.
 */
const LABEL = "local-simulation-not-managed-restore";
const ROOTFS =
  process.env.SA46_PG_ROOTFS ??
  "/home/wearaway/orca/workspaces/robotics-data-collection/sa-70-resource-guards/artifacts/bounded-fixtures/postgres-rootfs";
const env = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is provided by the drill runner`);
  return value;
};
const withDb = (url: string, db: string) => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
};
const sha = (b: Buffer | string) =>
  createHash("sha256").update(b).digest("hex");
const evidence: Record<string, unknown> = { label: LABEL };
const created = { databases: [] as string[], keys: new Set<string>() };
let dumpDir: string | undefined;
let sourceDb: AcceptanceDb | undefined;
const clients: pg.Client[] = [];
const track = (c: pg.Client): pg.Client => {
  clients.push(c);
  return c;
};

const boundedClient = (connectionString: string) =>
  new pg.Client({
    connectionString,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
    lock_timeout: 2000,
    query_timeout: 20000,
  });

after(async () => {
  // A failed assertion must not leave connections that keep the process alive.
  await Promise.all(clients.map((c) => c.end().catch(() => undefined)));
  // Remove exactly what this run created: keys named by this run's own catalog
  // rows or explicit puts. No listing-based deletion; a bucket that still holds
  // anything untracked is retained and reported.
  try {
    if (sourceDb) {
      const rows = await sourceDb.owner.query<{ object_key: string }>(
        "SELECT object_key FROM files ORDER BY id LIMIT 10000",
      );
      for (const r of rows.rows) created.keys.add(r.object_key);
    }
  } catch {
    evidence.cleanup = "could not enumerate created file rows";
  }
  try {
    const client = realS3();
    for (const key of created.keys)
      await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
    const left = await client.send(
      new ListObjectsV2Command({ Bucket: BUCKET, MaxKeys: 1 }),
    );
    if ((left.KeyCount ?? 0) === 0)
      await client.send(new DeleteBucketCommand({ Bucket: BUCKET }));
    else
      evidence.cleanup =
        "untracked objects remain; bucket retained and reported incomplete";
  } catch {
    evidence.cleanup = "object cleanup incomplete";
  }
  await sourceDb?.close().catch(() => undefined);
  // The bounded runner verifies ownership and reaps databases from its ledger.
  if (!ledgerRun()) {
    const admin = boundedClient(env("CATALOG_TEST_ADMIN_URL"));
    await admin.connect();
    try {
      for (const name of created.databases) {
        assert.match(name, /^catalog_[0-9a-f]{32}$/);
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      }
    } finally {
      await admin.end();
    }
  }
  if (dumpDir) rmSync(dumpDir, { recursive: true, force: true });
  await writeArtifact("restore-drill.json", evidence);
});

async function put(key: string, body: Buffer) {
  await realS3().send(
    new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body }),
  );
  created.keys.add(key);
}

/** Sealed recording whose source files carry REAL stored bytes (optionally damaged). */
async function realRecording(
  db: AcceptanceDb,
  damage: { lostMcap?: boolean; corruptMetadata?: boolean } = {},
) {
  const recordingId = randomUUID();
  await registerRecording(db.app, {
    recordingId,
    ownerUserId: db.actors.collector,
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
  ] as const) {
    const fileId = randomUUID();
    if (role === "source_manifest") manifestFileId = fileId;
    const body = Buffer.from(`${role}:${recordingId}:${randomUUID()}`);
    await reserveSourceFile(db.app, {
      fileId,
      recordingId,
      ownerUserId: db.actors.collector,
      clientUploadId: randomUUID(),
      role,
      sizeBytes: String(body.length),
      sha256: sha(body),
      required: true,
      partSizeBytes: "67108864",
      partCount: 1,
    });
    const key = (
      await db.owner.query("SELECT object_key FROM files WHERE id = $1", [
        fileId,
      ])
    ).rows[0].object_key as string;
    if (role === "source_mcap" && damage.lostMcap) {
      // Declared and "completed" in the catalog, but the payload never existed: a lost object.
    } else if (role === "recorder_metadata" && damage.corruptMetadata) {
      const other = Buffer.from(body);
      other[0] = other[0]! ^ 0xff; // same length, different bytes
      await put(key, other);
    } else await put(key, body);
    await recordFileCompleted(db.app, {
      fileId,
      expectedTransportEpoch: 1,
      observedSizeBytes: String(body.length),
    });
  }
  await sealRecording(db.app, {
    recordingId,
    ownerUserId: db.actors.collector,
    manifestFileId,
  });
  return { recordingId };
}

async function realQueuedJob(db: AcceptanceDb) {
  const { recordingId } = await realRecording(db);
  const jobId = randomUUID();
  await fixtureAdmission(db.app, recordingId, jobId);
  await createProcessingJob(db.app, {
    jobId,
    recordingId,
    profileRevision: "test-1",
  });
  return { recordingId, jobId };
}

function pgEnv(url: URL) {
  return {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    PGHOST: url.hostname,
    PGPORT: url.port,
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: url.pathname.slice(1),
    PGCONNECT_TIMEOUT: "5",
    PGOPTIONS: "-c statement_timeout=30000 -c lock_timeout=5000",
  };
}
/** Private PG17 client utilities in a bwrap rootfs; credentials via env, never argv. */
function runPg(url: URL, dir: string, args: string[]) {
  const r = spawnSync(
    "bwrap",
    [
      "--unshare-user",
      "--unshare-pid",
      "--die-with-parent",
      "--ro-bind",
      ROOTFS,
      "/",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      "--bind",
      dir,
      "/tmp/transfer",
      "--",
      ...args,
    ],
    {
      env: pgEnv(url),
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    },
  );
  // The utility's own output may name hosts/roles: judge by status only, never print it.
  assert.equal(r.status, 0, `${args[0]} failed (status ${r.status})`);
}

async function fingerprint(pool: pg.Pool | pg.Client) {
  const tables = (
    await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    )
  ).rows.map((r) => r.tablename);
  const out: Record<string, string> = {};
  for (const t of tables) {
    assert.match(t, /^[a-z_][a-z_0-9]*$/);
    const r = await pool.query<{ n: string; h: string | null }>(
      `SELECT count(*)::text AS n,
              md5(string_agg(to_jsonb(x)::text, ',' ORDER BY to_jsonb(x)::text)) AS h FROM "${t}" x`,
    );
    out[t] = `${r.rows[0]!.n}:${r.rows[0]!.h ?? ""}`;
  }
  return out;
}

const due = (deps: JobsDeps): JobsDeps => ({
  ...deps,
  config: {
    ...deps.config,
    repair: { dispatchWindowSeconds: 0, leaseGraceSeconds: 0 },
  },
});
const reason = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: unknown) => (e instanceof TransportError ? `${e.code}` : String(e)),
  );

test(
  "restore a synthetic catalog into a new database: objects verified, stale access and uncertain work stay blocked",
  { timeout: 120_000 },
  async () => {
    const phases: Record<string, number> = {};
    const timed = async <T>(
      name: string,
      work: () => Promise<T>,
    ): Promise<T> => {
      const t = performance.now();
      try {
        return await work();
      } finally {
        phases[name] = Math.round(performance.now() - t);
      }
    };
    const admin = track(boundedClient(env("CATALOG_TEST_ADMIN_URL")));
    await admin.connect();
    const databases = async () =>
      (
        await admin.query<{ datname: string }>(
          "SELECT datname FROM pg_database ORDER BY 1",
        )
      ).rows.map((r) => r.datname);
    const dbsBefore = await databases();

    // ---------------------------------------------------------------- SOURCE
    const db = await acceptanceDatabase();
    sourceDb = db;
    created.databases.push(db.name);
    const jobsDb = Object.assign(db, { signed: [] as string[] });
    const deps = depsFor(jobsDb);
    const { transport, accept } = await acceptanceDeps(db);

    // Accepted output over REAL stored source + output objects.
    const queued = await realQueuedJob(db);
    const { nonce } = await fixtureRunJob(db.owner, queued.jobId, {});
    const ok: RunningJob = {
      jobId: queued.jobId,
      recordingId: queued.recordingId,
      nonce,
      authority: { kind: "job", jobId: queued.jobId },
    };
    const clips = [await uploadClip(transport, ok, 0)];
    const bytes = await manifestFor(db, ok, clips, () => {});
    const doc = JSON.parse(bytes.toString()) as Record<string, any>;
    const manifest = await uploadOutput(
      transport,
      ok,
      "result-manifest.json",
      "result_manifest",
      bytes,
    );
    await closeOutputs(accept, {
      jobId: ok.jobId,
      invocationNonce: ok.nonce,
      outcome: "succeeded",
    });
    await submitCandidate(accept, candidateBody(ok, manifest, doc));
    await advanceResult(accept, ok.jobId);
    const ref = (
      await db.owner.query("SELECT execution_call_id FROM jobs WHERE id = $1", [
        ok.jobId,
      ])
    ).rows[0].execution_call_id as string;
    await recordExecutionEvidence(
      { pool: db.app },
      {
        jobId: ok.jobId,
        recordedBy: "restore-drill",
        evidence: { kind: "local_child_reaped", executionRef: ref },
      },
    );
    await advanceResult(accept, ok.jobId);
    assert.equal(
      (
        await db.owner.query(
          "SELECT status FROM job_result_candidates WHERE job_id = $1",
          [ok.jobId],
        )
      ).rows[0].status,
      "accepted",
    );

    // A recording whose payloads are partly lost/corrupted in object storage.
    await realRecording(db, { lostMcap: true, corruptMetadata: true });

    // Uncertain work: spawn intent recorded, lease lapsed -> submit_unknown, slot held.
    const unsure = await realQueuedJob(db);
    assert.equal((await admitNextJob(deps)).state, "admitted");
    const ctl = `ctl-${randomUUID().slice(0, 8)}`;
    await claimControllerLease(deps, {
      jobId: unsure.jobId,
      runRef: "run-drill",
      owner: ctl,
    });
    await recordWorkerSubmissionIntent(deps, {
      jobId: unsure.jobId,
      owner: ctl,
    });
    await db.owner.query(
      "UPDATE jobs SET controller_lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [unsure.jobId],
    );
    assert.deepEqual((await flagUncertain(due(deps), { limit: 5 })).unknown, [
      unsure.jobId,
    ]);

    // A session that exists at backup time.
    await db.owner.query(
      `INSERT INTO "session" (id, "expiresAt", token, "updatedAt", "userId")
     VALUES ($1, now() + interval '7 days', $2, now(), $3)`,
      [randomUUID(), randomUUID(), db.actors.collector],
    );

    // ----------------------------------------------------------------- BACKUP
    dumpDir = mkdtempSync(join(tmpdir(), "sa46-drill-"));
    const sourceUrl = new URL(db.ownerUrl);
    const snapClient = track(boundedClient(db.ownerUrl));
    await snapClient.connect();
    await timed("dumpMs", async () => {
      await snapClient.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const snapshotId = (
        await snapClient.query("SELECT pg_export_snapshot() AS id")
      ).rows[0].id as string;
      assert.match(snapshotId, /^[0-9A-F-]+$/);
      runPg(sourceUrl, dumpDir!, [
        "/usr/local/bin/pg_dump",
        "--format=custom",
        "--no-owner",
        `--snapshot=${snapshotId}`,
        "--file=/tmp/transfer/catalog.dump",
      ]);
      await snapClient.query("COMMIT");
    });
    await snapClient.end();
    const dumpBytes = statSync(join(dumpDir, "catalog.dump")).size;
    assert.ok(dumpBytes > 0 && dumpBytes < 128 * 1024 * 1024);

    // -------------------------------------- POST-BACKUP CHANGES (the RPO gap)
    const staleGrant = `access:${db.actors.outsider}:customer`;
    await db.owner.query(
      "UPDATE access SET enabled = false WHERE user_id = $1",
      [db.actors.outsider],
    );
    const lateUser = `ba_late_${randomUUID().slice(0, 8)}`;
    await db.owner.query(
      `INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, $1, $2, true)`,
      [lateUser, `${lateUser}@example.test`],
    );
    await db.owner.query(
      "INSERT INTO access (user_id, role) VALUES ($1, 'staff')",
      [lateUser],
    );
    const lateGrant = `access:${lateUser}:staff`;
    const sourceAfterChange = await fingerprint(db.owner);

    // ---------------------------------------------------------------- RESTORE
    const run = ledgerRun();
    const restoredName = databaseName(run);
    assert.equal(
      (
        await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [
          restoredName,
        ])
      ).rowCount,
      0,
    );
    await timed("createDatabaseMs", async () => {
      created.databases.push(restoredName);
      if (run) recordCreated(run, "database", restoredName, "migration_owner");
      await admin.query(
        `CREATE DATABASE ${restoredName} OWNER migration_owner`,
      );
      if (run)
        await admin.query(
          `COMMENT ON DATABASE ${restoredName} IS '${marker(run)}'`,
        );
    });
    const restoredOwnerUrl = withDb(
      env("CATALOG_TEST_OWNER_URL"),
      restoredName,
    );
    const restoredAppUrl = withDb(env("CATALOG_TEST_APP_URL"), restoredName);
    await timed("restoreMs", async () =>
      runPg(new URL(restoredOwnerUrl), dumpDir!, [
        "/usr/local/bin/pg_restore",
        "--no-owner",
        "--single-transaction",
        "--exit-on-error",
        `--dbname=${restoredName}`,
        "/tmp/transfer/catalog.dump",
      ]),
    );
    const restored = track(boundedClient(restoredOwnerUrl));
    await restored.connect();

    // ----------------------------------------------------------------- VERIFY
    const hasher = s3ObjectHasher(s3Config());
    const expectedMigrations = (await loadMigrations()).map((m) => ({
      version: m.version,
      sha256: m.sha256,
    }));
    const sourceNow = track(boundedClient(db.ownerUrl));
    await sourceNow.connect();
    const sourceFacts = await readSnapshot(sourceNow, DEFAULT_LIMITS);
    await sourceNow.end();
    // Stands for the out-of-band record of who is authorised NOW (operator input, offline).
    const expectedGrants: ExpectedGrants = {
      schema: "stateaction.restore_expected_grants.v1",
      provenance: "operator_supplied_offline_not_authoritative",
      active: sourceFacts.grants,
    };
    assert.ok(expectedGrants.active.includes(lateGrant));
    assert.ok(!expectedGrants.active.includes(staleGrant));

    const listObjects = () =>
      realS3().send(new ListObjectsV2Command({ Bucket: BUCKET }));
    const objectsBeforeVerify = await listObjects();
    assert.equal(objectsBeforeVerify.IsTruncated, false);
    const restoredBeforeVerify = await fingerprint(restored);
    const report: RestoreReport = await timed("verifyMs", () =>
      verifyRestoredCatalog({
        client: restored,
        hasher,
        expectedMigrations,
        expectedGrants,
      }),
    );
    assert.deepEqual(await fingerprint(restored), restoredBeforeVerify);
    assert.deepEqual(
      (await listObjects()).Contents,
      objectsBeforeVerify.Contents,
    );
    assert.equal(report.migrations.status, "match");
    assert.deepEqual(report.constraints.unexpected, []);
    assert.deepEqual(sourceFacts.unvalidated, [
      "public.jobs.jobs_admission_complete:c",
      "public.jobs.jobs_claim_complete:c",
    ]);
    assert.equal(report.constraints.unvalidated, 2);
    assert.ok(!report.blockers.includes("unexpected_unvalidated_constraints"));
    assert.deepEqual(report.referenceIssues, []);
    assert.equal(report.objects.complete, true);
    assert.equal(
      report.objects.counts.missing,
      1,
      "the lost payload is reported, never recovered",
    );
    assert.equal(report.objects.counts.sha_mismatch, 1);
    assert.equal(report.objects.counts.unread, 0);
    assert.ok(
      report.objects.counts.match >= 9,
      "sources of both jobs and accepted outputs hash-match",
    );
    assert.equal(
      report.objects.bytesHashed,
      report.objects.files
        .filter((f) => f.status === "match" || f.status === "sha_mismatch")
        .reduce((n, f) => n + f.sizeBytes, 0),
    );
    assert.deepEqual(
      report.unreconciled.nonTerminalJobs.map((j) => j.jobId),
      [unsure.jobId],
    );
    assert.equal(report.unreconciled.slotHolder?.jobId, unsure.jobId);
    assert.equal(report.unreconciled.slotHolder?.hasExecutionEvidence, false);
    assert.equal(report.unreconciled.sessions.total, 1);
    assert.deepEqual(report.unreconciled.staleActiveGrants, [staleGrant]);
    assert.deepEqual(report.unreconciled.allowlistedButAbsent, [lateGrant]);
    for (const b of [
      "objects_missing",
      "objects_sha_mismatch",
      "non_terminal_jobs_unreconciled",
      "dispatch_slot_held",
      "sessions_present_on_restored_copy",
      "active_grants_not_in_operator_allowlist",
    ])
      assert.ok(report.blockers.includes(b), b);
    assert.equal(report.readyToReenable, false);
    assert.equal(report.manualGatesOpen.length, 5);
    assert.ok(!JSON.stringify(report).includes(env("CATALOG_TEST_OWNER_URL")));
    assert.ok(
      !JSON.stringify(report).includes("recordings/"),
      "object keys never enter the report",
    );

    // Without an allowlist every active grant is unreconciled.
    const noList = await verifyRestoredCatalog({
      client: restored,
      hasher,
      expectedMigrations,
    });
    assert.ok(
      noList.blockers.includes("active_grants_unreconciled_no_allowlist"),
    );
    assert.equal(noList.unreconciled.grantsAllowlist, "not_supplied");

    // Finite bounds fail closed rather than truncating or hanging.
    await assert.rejects(
      verifyRestoredCatalog({
        client: restored,
        hasher,
        expectedMigrations,
        limits: { maxFiles: 1 },
      }),
      (e: unknown) =>
        e instanceof RestoreVerifyError && e.code === "too_many_files",
    );
    await assert.rejects(
      verifyRestoredCatalog({
        client: restored,
        hasher,
        expectedMigrations,
        limits: { maxTotalBytes: 1 },
      }),
      (e: unknown) =>
        e instanceof RestoreVerifyError && e.code === "too_many_bytes",
    );
    let tick = 0;
    const clock = verifyRestoredCatalog({
      client: restored,
      hasher,
      expectedMigrations,
      limits: { totalWallMs: 1000 },
      now: () => (tick++ < 2 ? 0 : 5000), // wall budget is exhausted after the first object
    });
    const lateReport = await clock;
    assert.equal(lateReport.objects.complete, false);
    assert.ok(lateReport.objects.counts.not_checked > 0);
    assert.ok(lateReport.blockers.includes("object_verification_incomplete"));
    const flaky = await verifyRestoredCatalog({
      client: restored,
      hasher: {
        hash: async () => {
          throw new Error("store unavailable");
        },
      },
      expectedMigrations,
    });
    assert.equal(
      flaky.objects.counts.match,
      0,
      "an unavailable store never reads as verified",
    );
    assert.ok(flaky.blockers.includes("objects_unread"));

    // A hasher that claims the right digest for a short body never yields a match.
    const shortBody = await verifyRestoredCatalog({
      client: restored,
      hasher: {
        hash: async (key, size, timeoutMs) => {
          const got = await hasher.hash(key, size, timeoutMs);
          return { bytes: got.bytes - 1, sha256: got.sha256 };
        },
      },
      expectedMigrations,
    });
    assert.equal(shortBody.objects.counts.match, 0);
    assert.ok(shortBody.objects.counts.size_mismatch > 0);

    // Restored role attributes/grants stay least-privilege.
    const priv = await restored.query<{
      del: boolean;
      sel: boolean;
      sup: boolean;
    }>(
      `SELECT has_table_privilege('stateaction_app', 'public.jobs', 'DELETE') AS del,
            has_table_privilege('stateaction_app', 'public.jobs', 'SELECT') AS sel,
            (SELECT rolsuper OR rolcreaterole OR rolbypassrls FROM pg_roles WHERE rolname = 'stateaction_app') AS sup`,
    );
    assert.deepEqual(priv.rows[0], { del: false, sel: true, sup: false });

    // Any other NOT VALID constraint (even one reusing a known name on another table) blocks.
    await restored.query(
      "ALTER TABLE clips ADD CONSTRAINT sa46_unknown_nv CHECK (frame_count > 0) NOT VALID",
    );
    await restored.query(
      "ALTER TABLE files ADD CONSTRAINT jobs_claim_complete CHECK (size_bytes > 0) NOT VALID",
    );
    const ddl = await verifyRestoredCatalog({
      client: restored,
      hasher: { hash: async () => ({ bytes: 0, sha256: "0".repeat(64) }) },
      expectedMigrations,
      limits: { maxFiles: 100_000 },
    });
    assert.deepEqual(ddl.constraints.unexpected, [
      "public.clips.sa46_unknown_nv:c",
      "public.files.jobs_claim_complete:c",
    ]);
    assert.ok(ddl.blockers.includes("unexpected_unvalidated_constraints"));
    await restored.query("ALTER TABLE clips DROP CONSTRAINT sa46_unknown_nv");
    await restored.query(
      "ALTER TABLE files DROP CONSTRAINT jobs_claim_complete",
    );

    // ------------------- QUARANTINE (documented owner step) + guarded refusals
    await restored.query(`DELETE FROM "session"`);
    await restored.query(`DELETE FROM verification`);
    const afterQuarantine = await verifyRestoredCatalog({
      client: restored,
      hasher,
      expectedMigrations,
      expectedGrants,
    });
    assert.equal(afterQuarantine.unreconciled.sessions.total, 0);
    assert.ok(
      !afterQuarantine.blockers.includes("sessions_present_on_restored_copy"),
    );
    assert.equal(
      afterQuarantine.readyToReenable,
      false,
      "other gates are still open",
    );

    const restoredApp = new pg.Pool({
      connectionString: restoredAppUrl,
      max: 2,
    });
    try {
      const rdeps: JobsDeps = {
        pool: restoredApp,
        config: JOBS_CONFIG,
        presignRead: async () => "http://127.0.0.1:9/unused",
      };
      assert.equal(
        operatorGuidance(await recoverySnapshot(restoredApp, unsure.jobId))
          .code,
        "unknown_spawn",
      );
      assert.equal(
        await reason(
          retryJob(rdeps, {
            jobId: unsure.jobId,
            expectedState: "submit_unknown",
          }),
        ),
        "conflict",
      );
      // Cancel may only REQUEST cancellation; it is not proof the worker stopped.
      const cancel = await requestJobCancel(rdeps, unsure.jobId, {
        expectedState: "submit_unknown",
        requireCurrent: true,
      });
      assert.equal(cancel.state, "cancel_requested");
      assert.equal(
        await reason(
          retryJob(rdeps, {
            jobId: unsure.jobId,
            expectedState: "cancel_requested",
          }),
        ),
        "conflict",
      );
      const slot = (
        await restored.query(
          "SELECT job_id FROM dispatch_admission WHERE slot = 1",
        )
      ).rows[0].job_id;
      assert.equal(
        slot,
        unsure.jobId,
        "the slot is not freed without termination evidence",
      );
      assert.equal(
        (
          await restored.query(
            "SELECT 1 FROM job_execution_evidence WHERE job_id = $1",
            [unsure.jobId],
          )
        ).rowCount,
        0,
      );
    } finally {
      await restoredApp.end();
    }

    // CLI: refuses the live database identity; verifies the restored copy.
    const cliEnv = {
      PATH: process.env.PATH ?? "",
      APP_ENV: "local",
      S3_ENDPOINT: env("TRANSPORT_TEST_S3_ENDPOINT"),
      S3_REGION: "us-east-1",
      S3_BUCKET: BUCKET,
      S3_ACCESS_KEY_ID: env("TRANSPORT_TEST_S3_ACCESS_KEY"),
      S3_SECRET_ACCESS_KEY: env("TRANSPORT_TEST_S3_SECRET_KEY"),
    };
    const cli = (extra: Record<string, string>) =>
      spawnSync(
        "node",
        [
          "--conditions=react-server",
          "--import",
          "tsx",
          "src/restore-check-cli.ts",
        ],
        {
          env: { ...cliEnv, ...extra },
          encoding: "utf8",
          timeout: 120_000,
          maxBuffer: 4 * 1024 * 1024,
        },
      );
    const live = cli({
      RESTORE_CHECK_DATABASE_URL: db.ownerUrl,
      DATABASE_URL: db.appUrl,
    });
    assert.notEqual(live.status, 0);
    assert.match(live.stderr, /refusing to verify a live database identity/);
    // Component-form live identity is compared too.
    const dbUrl = new URL(db.ownerUrl);
    const component = cli({
      RESTORE_CHECK_DATABASE_URL: db.ownerUrl,
      DATABASE_HOST: dbUrl.hostname,
      DATABASE_PORT: dbUrl.port,
      DATABASE_NAME: dbUrl.pathname.slice(1),
    });
    assert.notEqual(component.status, 0);
    assert.match(
      component.stderr,
      /refusing to verify a live database identity/,
    );
    // Credential-like bad input never echoes: invalid URL, non-loopback, unreachable.
    const secret = "pw-Sup3rSecret-canary";
    for (const bad of [
      `postgresql://u:${secret}@bad host/db`,
      `postgresql://u:${secret}@db.example.invalid:5432/x`,
      `postgresql://u:${secret}@127.0.0.1:1/x`,
    ]) {
      const r = cli({ RESTORE_CHECK_DATABASE_URL: bad });
      assert.notEqual(r.status, 0, "bad target must fail");
      assert.ok(!(r.stdout + r.stderr).includes(secret), "credential echoed");
      assert.ok(
        !(r.stdout + r.stderr).includes("example.invalid"),
        "host echoed",
      );
      assert.match(r.stderr, /restore-check failed: [^\n]+/);
    }
    const viaCli = cli({ RESTORE_CHECK_DATABASE_URL: restoredOwnerUrl });
    assert.equal(viaCli.status, 0, "restore-check CLI failed");
    const cliReport = JSON.parse(viaCli.stdout) as RestoreReport;
    assert.equal(cliReport.readyToReenable, false);
    assert.equal(
      (cliReport as unknown as { isolation: { status: string } }).isolation
        .status,
      "unverified_no_live_identity_visible",
    );
    assert.equal(cliReport.objects.counts.missing, 1);
    assert.equal(cliReport.objects.counts.sha_mismatch, 1);

    // ---------------------------------------- SOURCE NEVER MUTATED BY RESTORE
    assert.deepEqual(await fingerprint(db.owner), sourceAfterChange);
    const dbsAfter = await databases();
    for (const name of dbsBefore)
      assert.ok(dbsAfter.includes(name), `${name} still exists`);
    await restored.end();
    await admin.end();

    evidence.drill = {
      phasesMs: phases,
      dumpBytes,
      serverVersion: (await db.owner.query("SHOW server_version")).rows[0]
        .server_version,
      objects: report.objects.counts,
      bytesHashed: report.objects.bytesHashed,
      blockers: report.blockers,
      manualGatesOpen: report.manualGatesOpen,
      staleActiveGrantsDetected: report.unreconciled.staleActiveGrants.length,
      gapRowsAbsentFromRestore: report.unreconciled.allowlistedButAbsent.length,
      sourceFingerprintUnchangedByRestore: true,
      restoredFingerprintUnchangedByVerifier: true,
      objectsUnchangedByVerifier: true,
      databasesCreated: created.databases.length,
      objectsCreated: created.keys.size,
      cannotEstablish: [
        "managed backup existence, retention or PITR window",
        "real restore time, size or RTO on the managed plan",
        "Render Postgres version/role/extension behaviour and network isolation",
        "R2 checksum, versioning or lifecycle semantics (SeaweedFS differs)",
        "Render workflow / Modal provider job state",
        "real Better Auth session invalidation on hosted hostnames",
        "recovery of deleted object payloads (a database restore cannot)",
      ],
    };
  },
);
