import { fixtureCloseOutputs, fixtureRunJob } from "../src/jobs/fixtures.js";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import pg from "pg";
import {
  cloneFromTemplate,
  contentKey,
  ensureTemplate,
  migrationKey,
  templateName,
} from "../../../scripts/platform/db-template.mjs";
import { migratedSpec } from "../test-auth/migrated-template.mjs";
import {
  createProcessingJob,
  outputObjectKey,
  recordFileCompleted,
  registerRecording,
  reserveSourceFile,
  sealRecording,
  type ClipInput,
} from "../src/catalog/catalog.js";
import { seedSha } from "../src/catalog/seed.js";
import { migrateDatabase } from "../src/migrations.js";
import { establishFixtureAdmission } from "../src/admission/fixtures.js";
import {
  type LedgerRun,
  databaseName,
  ledgerRun,
  marker,
  recordCreated,
} from "./fixture-ledger.js";

const env = (key: string) => {
  const value = process.env[key];
  if (!value)
    throw new Error(`${key} is set by scripts/catalog-integration.sh`);
  return value;
};
const withDb = (url: string, db: string) => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
};

export type TestDb = {
  name: string;
  ownerUrl: string;
  appUrl: string;
  owner: pg.Pool;
  app: pg.Pool;
  close(): Promise<void>;
};

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

function openTestDb(name: string): TestDb {
  const ownerUrl = withDb(env("CATALOG_TEST_OWNER_URL"), name);
  const appUrl = withDb(env("CATALOG_TEST_APP_URL"), name);
  // Bounded per database: the shared fixture PostgreSQL has max_connections=30 and
  // several test files run at once (SA-114). Owner SQL is sequential; the app pool
  // keeps the widest real concurrency case (10 simultaneous receipt journals) and idle
  // connections are released quickly instead of lingering for pg's 10 s default.
  const owner = new pg.Pool({
    connectionString: ownerUrl,
    max: 4,
    idleTimeoutMillis: 1000,
  });
  const app = new pg.Pool({
    connectionString: appUrl,
    max: 10,
    idleTimeoutMillis: 1000,
  });
  return {
    name,
    ownerUrl,
    appUrl,
    owner,
    app,
    async close() {
      const fixtureOwner = ownerPools.get(name);
      ownerPools.delete(name);
      await Promise.all([owner.end(), app.end(), fixtureOwner?.end()]);
    },
  };
}

function templateEnv(run: LedgerRun | null) {
  return {
    async connect(url: string) {
      const client = new pg.Client({
        connectionString: url,
        connectionTimeoutMillis: 10_000,
      });
      await client.connect();
      return client;
    },
    adminUrl: env("CATALOG_TEST_ADMIN_URL"),
    ownerUrl: env("CATALOG_TEST_OWNER_URL"),
    appUrl: env("CATALOG_TEST_APP_URL"),
    // Non-reapable ledger event naming the template and its key.
    note(e: {
      template: string;
      key: string;
      reused?: boolean;
      built?: boolean;
    }) {
      if (run)
        appendFileSync(
          join(run.dir, "ledger.jsonl"),
          `${JSON.stringify({ event: "template", kind: "template", name: e.template, runId: run.runId, ts: Date.now(), key: e.key, reused: e.reused, built: e.built })}\n`,
        );
    },
  };
}

/** Clone one run-owned database from a sealed, content-keyed template. */
async function cloneDatabase(
  spec: Record<string, unknown>,
): Promise<{ db: TestDb; meta: { user: unknown } }> {
  const run = ledgerRun();
  const name = databaseName(run);
  if (run) recordCreated(run, "database", name, "migration_owner");
  const out = await cloneFromTemplate(templateEnv(run), spec, {
    name,
    owner: "migration_owner",
    comment: run ? marker(run) : undefined,
  });
  return { db: openTestDb(name), meta: out.meta };
}

/**
 * Fresh database owned by the non-superuser migration owner. By default it is
 * cloned from the verified migrated template (migrations are not re-applied);
 * `migrate: false` still creates an empty database for the migrator tests.
 */
export async function freshDatabase(
  options: { migrate?: boolean } = {},
): Promise<TestDb> {
  if (options.migrate !== false)
    return (
      await cloneDatabase(
        migratedSpec({
          migrate: (ownerUrl: string) => migrateDatabase({ ownerUrl }),
          log: (m: string) => console.error(`[db-template] ${m}`),
        }),
      )
    ).db;
  const run = ledgerRun();
  const name = databaseName(run);
  if (run) recordCreated(run, "database", name, "migration_owner");
  const admin = new pg.Client({
    connectionString: env("CATALOG_TEST_ADMIN_URL"),
  });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name} OWNER migration_owner`);
    if (run)
      await admin.query(`COMMENT ON DATABASE ${name} IS '${marker(run)}'`);
  } finally {
    await admin.end();
  }
  return openTestDb(name);
}

/**
 * Database cloned from a seeded template. `seedPaths` (repo-relative) are the
 * seed code; with the migration key they form the template key, so editing the
 * seed or a migration rebuilds it. `seed` runs once per key on a staging copy
 * of the migrated template and returns JSON-safe metadata for every clone.
 */
export async function seededDatabase<T>(
  kind: string,
  seedPaths: string[],
  seed: (db: TestDb) => Promise<T>,
): Promise<{ db: TestDb; meta: T }> {
  const migrated = migratedSpec({
    migrate: (ownerUrl: string) => migrateDatabase({ ownerUrl }),
    log: (m: string) => console.error(`[db-template] ${m}`),
  });
  const key = contentKey(repoRoot, seedPaths) + migrationKey(repoRoot);
  const keyHash = createHash("sha256").update(key).digest("hex");
  const env_ = templateEnv(ledgerRun());
  const base = await ensureTemplate(env_, migrated);
  const out = await cloneDatabase({
    kind,
    key: keyHash,
    base: base.name,
    log: (m: string) => console.error(`[db-template] ${m}`),
    async build({ name }: { name: string }) {
      const staging = openTestDb(name);
      try {
        return await seed(staging);
      } finally {
        await staging.close();
      }
    },
  });
  return { db: out.db, meta: out.meta.user as T };
}
export { templateName };

export async function writeArtifact(name: string, value: unknown) {
  await writeFile(
    `${env("CATALOG_TEST_ARTIFACTS")}/${name}`,
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

const ownerPools = new Map<string, pg.Pool>();
/**
 * Owner-credential pool for the same throwaway database as `app` (explicit
 * operator/fixture writes such as ingest permission evidence).
 */
export function ownerPoolFor(app: pg.Pool): pg.Pool {
  const db = new URL(
    (
      app as unknown as { options: { connectionString: string } }
    ).options.connectionString,
  ).pathname.slice(1);
  let pool = ownerPools.get(db);
  if (!pool) {
    pool = new pg.Pool({
      connectionString: withDb(env("CATALOG_TEST_OWNER_URL"), db),
      max: 4,
      idleTimeoutMillis: 1000,
    });
    ownerPools.set(db, pool);
  }
  return pool;
}
export async function closeOwnerPools() {
  await Promise.all([...ownerPools.values()].map((p) => p.end()));
  ownerPools.clear();
}

/**
 * Explicit SA-13 fixture step: synthetic ingest evidence (owner credential)
 * so the fail-closed jobs trigger admits `jobId` as the first attempt.
 */
export async function fixtureAdmission(
  app: pg.Pool,
  recordingId: string,
  jobId: string,
) {
  await establishFixtureAdmission(ownerPoolFor(app), {
    recordingId,
    firstJobId: jobId,
  });
}

export type Actors = {
  collector: string;
  staff: string;
  customer: string;
  outsider: string;
};
/** Opaque, deliberately non-UUID auth IDs plus operator-managed roles. */
export async function createActors(owner: pg.Pool): Promise<Actors> {
  const suffix = randomUUID().slice(0, 8);
  const actors: Actors = {
    collector: `ba_${suffix}_collector`,
    staff: `ba_${suffix}_staff`,
    customer: `ba_${suffix}_customer`,
    outsider: `ba_${suffix}_outsider`,
  };
  const roles: Record<keyof Actors, string> = {
    collector: "collector",
    staff: "staff",
    customer: "customer",
    outsider: "customer",
  };
  for (const [key, id] of Object.entries(actors) as [keyof Actors, string][]) {
    await owner.query(
      `INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, $1, $2, true)`,
      [id, `${id}@example.test`],
    );
    await owner.query("INSERT INTO access (user_id, role) VALUES ($1, $2)", [
      id,
      roles[key],
    ]);
  }
  return actors;
}

export type Processed = {
  recordingId: string;
  jobId: string;
  manifestFileId: string;
  manifestSha256: string;
  clips: ClipInput[];
  outputFiles: string[];
};

/**
 * Registers, uploads (metadata only), seals and processes a recording up to a
 * pending result through the access layer as the restricted app role.
 */
export async function processedRecording(
  app: pg.Pool,
  actors: Actors,
  clipCount = 2,
  options: {
    open?: boolean;
    /**
     * Real source bytes: size and SHA-256 come from the body, and `stored` is
     * called with the catalog object key so a test can PUT the bytes.
     */
    sources?: {
      body(
        role: "source_manifest" | "source_mcap" | "recorder_metadata",
      ): Buffer;
      stored(file: {
        fileId: string;
        role: string;
        objectKey: string;
        body: Buffer;
      }): Promise<void>;
    };
  } = {},
): Promise<Processed> {
  const recordingId = randomUUID();
  await registerRecording(app, {
    recordingId,
    ownerUserId: actors.collector,
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
    const body = options.sources?.body(role);
    await reserveSourceFile(app, {
      fileId,
      recordingId,
      ownerUserId: actors.collector,
      clientUploadId: randomUUID(),
      role,
      sizeBytes: body ? String(body.length) : "1000",
      sha256: body
        ? createHash("sha256").update(body).digest("hex")
        : seedSha(`${recordingId}:${role}`),
      required: true,
      partSizeBytes: "67108864",
      partCount: 1,
    });
    await recordFileCompleted(app, {
      fileId,
      expectedTransportEpoch: 1,
      observedSizeBytes: body ? String(body.length) : "1000",
    });
    if (body && options.sources) {
      const key = await app.query<{ object_key: string }>(
        "SELECT object_key FROM files WHERE id = $1",
        [fileId],
      );
      await options.sources.stored({
        fileId,
        role,
        objectKey: key.rows[0]!.object_key,
        body,
      });
    }
  }
  await sealRecording(app, {
    recordingId,
    ownerUserId: actors.collector,
    manifestFileId,
  });
  const jobId = randomUUID();
  await fixtureAdmission(app, recordingId, jobId);
  await createProcessingJob(app, {
    jobId,
    recordingId,
    profileRevision: "test-1",
  });
  await fixtureRunJob(ownerPoolFor(app), jobId, {
    maxOutputFiles: options.open ? 2000 : 512,
  });
  const outputFiles: string[] = [];
  const output = async (role: string) => {
    const id = randomUUID();
    outputFiles.push(id);
    await app.query(
      `INSERT INTO files (id, recording_id, job_id, purpose, role, size_bytes, sha256, object_key, part_size_bytes, part_count)
       VALUES ($1, $2, $3, 'output', $4, 100, $5, $6, 67108864, 1)`,
      [
        id,
        recordingId,
        jobId,
        role,
        seedSha(id),
        outputObjectKey(jobId, id, 1, `${role}.bin`),
      ],
    );
    await recordFileCompleted(app, {
      fileId: id,
      expectedTransportEpoch: 1,
      observedSizeBytes: "100",
    });
    return id;
  };
  const clips: ClipInput[] = [];
  for (let ordinal = 0; ordinal < clipCount; ordinal++)
    clips.push({
      clipId: randomUUID(),
      ordinal,
      title: `clip ${ordinal}`,
      sourceStartNs: String(ordinal * 1000),
      sourceEndNs: String(ordinal * 1000 + 900),
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
    });
  const resultId = await output("result_manifest");
  if (options.open)
    // Bulk fixtures extend the inventory themselves, then close it (running)
    // and move to result_pending with fixtureCloseOutputs.
    return {
      recordingId,
      jobId,
      manifestFileId: resultId,
      manifestSha256: seedSha(resultId),
      clips,
      outputFiles,
    };
  // Production order: the inventory is closed while the job is still running.
  await fixtureCloseOutputs(ownerPoolFor(app), {
    jobId,
    manifestFileId: resultId,
    clips,
  });
  await app.query("UPDATE jobs SET state = 'result_pending' WHERE id = $1", [
    jobId,
  ]);
  return {
    recordingId,
    jobId,
    manifestFileId: resultId,
    manifestSha256: seedSha(resultId),
    clips,
    outputFiles,
  };
}

/** Rejects with the given SQLSTATE or catalog error code. */
export async function expectCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
  } catch (error) {
    const e = error as { code?: string; sqlstate?: string; message?: string };
    if (e.code === code || e.sqlstate === code) return e;
    throw new Error(
      `Expected ${code}, got ${e.code}/${e.sqlstate}: ${e.message}`,
    );
  }
  throw new Error(`Expected ${code}, but the operation succeeded`);
}
