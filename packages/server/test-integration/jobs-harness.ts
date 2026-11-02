import { randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import {
  createProcessingJob,
  recordFileCompleted,
  registerRecording,
  reserveSourceFile,
  sealRecording,
} from "../src/catalog/catalog.js";
import { seedSha } from "../src/catalog/seed.js";
import type { JobsConfig } from "../src/jobs/config.js";
import type { JobsDeps } from "../src/jobs/service.js";
import {
  createActors,
  fixtureAdmission,
  freshDatabase,
  type Actors,
  type TestDb,
} from "./harness.js";

export const JOBS_CONFIG: JobsConfig = {
  executionBackend: "local",
  codeRevision: "test-rev-1",
  imageSpecSha256: "a".repeat(64),
  modelSha256: "b".repeat(64),
  configSha256: "c".repeat(64),
  limits: {
    maxOutputFiles: 512,
    maxOutputBytes: "68719476736",
    maxControlDocumentBytes: 1048576,
  },
  executionDeadlineSeconds: 3600,
  startDeadlineSeconds: 600,
  leaseSeconds: 120,
  readUrlSeconds: 900,
};

export type JobsTestDb = TestDb & { actors: Actors; signed: string[] };

/** Fresh database per scenario: the global admission slot is a singleton. */
export async function jobsDatabase(): Promise<JobsTestDb> {
  const db = await freshDatabase();
  return Object.assign(db, {
    actors: await createActors(db.owner),
    signed: [] as string[],
  });
}

export const depsFor = (db: JobsTestDb): JobsDeps => ({
  pool: db.app,
  config: JOBS_CONFIG,
  // Fixture bytes only: nothing is fetched; every signature is recorded.
  presignRead: async (key, ttl) => {
    db.signed.push(key);
    return `http://127.0.0.1:9/${key}?ttl=${ttl}`;
  },
});

/** A sealed, admitted recording with one QUEUED job (no admission slot yet). */
export async function queuedJob(db: Pick<TestDb, "app"> & { actors: Actors }) {
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
    await reserveSourceFile(db.app, {
      fileId,
      recordingId,
      ownerUserId: db.actors.collector,
      clientUploadId: randomUUID(),
      role,
      sizeBytes: "1000",
      sha256: seedSha(`${recordingId}:${role}`),
      required: true,
      partSizeBytes: "67108864",
      partCount: 1,
    });
    await recordFileCompleted(db.app, {
      fileId,
      expectedTransportEpoch: 1,
      observedSizeBytes: "1000",
    });
  }
  await sealRecording(db.app, {
    recordingId,
    ownerUserId: db.actors.collector,
    manifestFileId,
  });
  const jobId = randomUUID();
  await fixtureAdmission(db.app, recordingId, jobId);
  await createProcessingJob(db.app, {
    jobId,
    recordingId,
    profileRevision: "test-1",
  });
  return { recordingId, jobId };
}

export const nonce = () => randomBytes(32).toString("base64url");

export const owner = (n = 1) => `ctl-${n}-${randomBytes(6).toString("hex")}`;

export async function jobRow(db: JobsTestDb, jobId: string) {
  return (
    await db.owner.query(
      "SELECT state, execution_call_id, invocation_nonce, claimed_at, execution_deadline, start_deadline, controller_lease_owner FROM jobs WHERE id = $1",
      [jobId],
    )
  ).rows[0] as Record<string, unknown>;
}

export async function slotHolder(db: JobsTestDb) {
  return (
    await db.owner.query("SELECT job_id FROM dispatch_admission WHERE slot = 1")
  ).rows[0].job_id as string | null;
}
