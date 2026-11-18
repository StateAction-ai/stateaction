import { fixtureCloseOutputs, fixtureRunJob } from "../src/jobs/fixtures.js";
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import pg from "pg";
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

/** Fresh database owned by the non-superuser migration owner. */
export async function freshDatabase(
  options: { migrate?: boolean } = {},
): Promise<TestDb> {
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
  const ownerUrl = withDb(env("CATALOG_TEST_OWNER_URL"), name);
  const appUrl = withDb(env("CATALOG_TEST_APP_URL"), name);
  if (options.migrate !== false) await migrateDatabase({ ownerUrl });
  const owner = new pg.Pool({ connectionString: ownerUrl, max: 12 });
  const app = new pg.Pool({ connectionString: appUrl, max: 12 });
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
