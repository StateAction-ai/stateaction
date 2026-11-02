import { createHash } from "node:crypto";
import type pg from "pg";
import {
  acceptProcessingResult,
  addClipsToDataset,
  appendReview,
  createDataset,
  createProcessingJob,
  outputObjectKey,
  recordFileCompleted,
  registerRecording,
  reserveSourceFile,
  sealRecording,
  setDatasetAccess,
  type ClipInput,
} from "./catalog.js";
import { hashCredentialPassword } from "./password.js";

/**
 * Deterministic local seed. Catalog rows only: no media objects are written,
 * so seeded file references are metadata fixtures, not downloadable bytes.
 * Domain writes go through the access layer; pilot roles are operator rows.
 */
export const SEED = {
  users: {
    collector: {
      id: "seed-collector-1",
      email: "collector@stateaction.local",
      name: "Seed Collector",
      role: "collector",
    },
    staff: {
      id: "seed-staff-1",
      email: "staff@stateaction.local",
      name: "Seed Staff",
      role: "staff",
    },
    customer: {
      id: "seed-customer-1",
      email: "customer@stateaction.local",
      name: "Seed Customer",
      role: "customer",
    },
    outsider: {
      id: "seed-customer-2",
      email: "customer2@stateaction.local",
      name: "Ungranted Customer",
      role: "customer",
    },
  },
  recordingId: "00000000-0000-4000-8000-00000000a001",
  jobId: "00000000-0000-4000-8000-00000000b001",
  datasets: {
    shared: {
      id: "00000000-0000-4000-8000-00000000d001",
      name: "Shared pick-and-place",
    },
    internal: {
      id: "00000000-0000-4000-8000-00000000d002",
      name: "Internal holdout",
    },
  },
  clips: {
    pending: "00000000-0000-4000-8000-00000000c001",
    rejected: "00000000-0000-4000-8000-00000000c002",
    shared: "00000000-0000-4000-8000-00000000c003",
    private: "00000000-0000-4000-8000-00000000c004",
    both: "00000000-0000-4000-8000-00000000c005",
  },
} as const;

export const seedSha = (label: string) =>
  createHash("sha256").update(`stateaction-seed:${label}`).digest("hex");
const seedUuid = (prefix: string, n: number) =>
  `00000000-0000-4000-8000-${prefix}${n.toString(16).padStart(12 - prefix.length, "0")}`;

export type SeedReport = { seeded: boolean; credentialAccounts: boolean };

/** Owner connection required for operator-managed access rows. */
export async function seedLocalCatalog(
  owner: pg.Pool,
  options: { password?: string } = {},
): Promise<SeedReport> {
  const exists = await owner.query('SELECT 1 FROM "user" WHERE id = $1', [
    SEED.users.staff.id,
  ]);
  if (exists.rowCount) {
    const complete = await owner.query(
      "SELECT 1 FROM dataset_access WHERE dataset_id = $1 AND user_id = $2",
      [SEED.datasets.shared.id, SEED.users.customer.id],
    );
    if (!complete.rowCount)
      throw new Error(
        "Partial local seed found; recreate the local database volume",
      );
    return { seeded: false, credentialAccounts: false };
  }
  const users = Object.values(SEED.users);
  for (const u of users) {
    await owner.query(
      `INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, $2, $3, true)`,
      [u.id, u.name, u.email],
    );
    await owner.query(
      "INSERT INTO access (user_id, role, enabled, granted_by) VALUES ($1, $2, true, 'local-seed')",
      [u.id, u.role],
    );
    if (options.password)
      await owner.query(
        `INSERT INTO account (id, "accountId", "providerId", "userId", password, "updatedAt")
         VALUES ($1, $2, 'credential', $2, $3, now())`,
        [
          `${u.id}-credential`,
          u.id,
          await hashCredentialPassword(options.password),
        ],
      );
  }
  const staff = SEED.users.staff.id;
  const collector = SEED.users.collector.id;
  const { recordingId, jobId } = SEED;
  await registerRecording(owner, {
    recordingId,
    ownerUserId: collector,
    clientRecordingId: seedUuid("e", 1),
    captureFormat: "stateaction.capture.v1",
    rgbProfile: "h264_mcap_v1",
    startedAt: "2026-11-01T12:00:00.000Z",
    device: {
      model: "Pixel (seed)",
      osVersion: "16",
      appVersion: "0.0.0-seed",
    },
  });
  const sources = [
    ["source_manifest", 1, "4096"],
    ["source_mcap", 2, "268435456"],
    ["recorder_metadata", 3, "2048"],
    ["calibration", 4, "1024"],
  ] as const;
  for (const [role, n, size] of sources) {
    const fileId = seedUuid("f", n);
    await reserveSourceFile(owner, {
      fileId,
      recordingId,
      ownerUserId: collector,
      clientUploadId: seedUuid("1", n),
      role,
      sizeBytes: size,
      sha256: seedSha(role),
      required: true,
      partSizeBytes: "67108864",
      partCount: Math.max(1, Math.ceil(Number(size) / 67108864)),
    });
    await recordFileCompleted(owner, {
      fileId,
      expectedTransportEpoch: 1,
      observedSizeBytes: size,
    });
  }
  await sealRecording(owner, {
    recordingId,
    ownerUserId: collector,
    manifestFileId: seedUuid("f", 1),
  });
  await createProcessingJob(owner, {
    jobId,
    recordingId,
    profileRevision: "seed-profile-1",
  });
  // Executor/claim transitions belong to the job protocol ticket; the seed
  // advances the fixture directly with the owner credential.
  await owner.query("UPDATE jobs SET state = 'running' WHERE id = $1", [jobId]);
  const outputs: Record<string, string> = {};
  const output = async (
    key: string,
    role: string,
    path: string,
    size: number,
  ) => {
    const id = seedUuid("2", Object.keys(outputs).length + 1);
    outputs[key] = id;
    await owner.query(
      `INSERT INTO files (id, recording_id, job_id, purpose, role, size_bytes, sha256, object_key, part_size_bytes, part_count)
       VALUES ($1, $2, $3, 'output', $4, $5, $6, $7, 67108864, 1)`,
      [
        id,
        recordingId,
        jobId,
        role,
        size,
        seedSha(key),
        outputObjectKey(jobId, id, 1, path),
      ],
    );
    await recordFileCompleted(owner, {
      fileId: id,
      expectedTransportEpoch: 1,
      observedSizeBytes: String(size),
    });
  };
  const clipKeys = Object.keys(SEED.clips) as (keyof typeof SEED.clips)[];
  const clips: ClipInput[] = [];
  for (const [ordinal, key] of clipKeys.entries()) {
    const slot = (s: string) => `${key}-${s}`;
    await output(slot("mp4"), "clip_mp4", `clips/${ordinal}/rgb.mp4`, 4000000);
    await output(
      slot("npz"),
      "hand_arrays_npz",
      `clips/${ordinal}/hands.npz`,
      200000,
    );
    await output(
      slot("obs"),
      "hand_observations_json",
      `clips/${ordinal}/hands.json`,
      50000,
    );
    await output(
      slot("map"),
      "frame_map_json",
      `clips/${ordinal}/frame_map.json`,
      20000,
    );
    await output(
      slot("jpg"),
      "thumbnail_jpeg",
      `clips/${ordinal}/thumb.jpg`,
      30000,
    );
    await output(
      slot("rrd"),
      "viewer_rrd",
      `clips/${ordinal}/viewer.rrd`,
      3000000,
    );
    const start = BigInt(ordinal) * 10_000_000_000n;
    clips.push({
      clipId: SEED.clips[key],
      ordinal,
      title: `Seed clip ${ordinal + 1} (${key})`,
      sourceStartNs: start.toString(),
      sourceEndNs: (start + 8_000_000_000n).toString(),
      durationNs: "8000000000",
      clockDomain: "android.sensor_elapsed_realtime",
      raster: { width: 1920, height: 1080 },
      frameCount: 240,
      files: {
        rgbMp4: outputs[slot("mp4")]!,
        handArraysNpz: outputs[slot("npz")]!,
        handObservationsJson: outputs[slot("obs")]!,
        frameMapJson: outputs[slot("map")]!,
        thumbnailJpeg: outputs[slot("jpg")]!,
        viewerRrd: outputs[slot("rrd")]!,
      },
    });
  }
  await output("result", "result_manifest", "result.json", 8000);
  await owner.query("UPDATE jobs SET state = 'result_pending' WHERE id = $1", [
    jobId,
  ]);
  await acceptProcessingResult(owner, {
    jobId,
    manifestFileId: outputs.result!,
    manifestSha256: seedSha("result"),
    clips,
  });
  const { shared, internal } = SEED.datasets;
  await createDataset(owner, {
    datasetId: shared.id,
    name: shared.name,
    actorUserId: staff,
  });
  await createDataset(owner, {
    datasetId: internal.id,
    name: internal.name,
    actorUserId: staff,
  });
  const review = (
    clipId: string,
    n: number,
    decision: "approved" | "rejected",
    label?: string,
  ) =>
    appendReview(owner, {
      reviewId: seedUuid("3", n),
      clipId,
      jobId,
      resultManifestSha256: seedSha("result"),
      reviewerUserId: staff,
      expectedRevision: 0,
      decision,
      ...(label ? { taskLabel: label } : {}),
    });
  await review(SEED.clips.rejected, 1, "rejected");
  await review(SEED.clips.shared, 2, "approved", "pick up cup");
  await review(SEED.clips.private, 3, "approved", "open drawer");
  await review(SEED.clips.both, 4, "approved", "pour water");
  await addClipsToDataset(owner, {
    datasetId: shared.id,
    clipIds: [SEED.clips.shared, SEED.clips.both],
    expectedRevision: 1,
    actorUserId: staff,
  });
  await addClipsToDataset(owner, {
    datasetId: internal.id,
    clipIds: [SEED.clips.private, SEED.clips.both],
    expectedRevision: 1,
    actorUserId: staff,
  });
  await setDatasetAccess(owner, {
    datasetId: shared.id,
    userId: SEED.users.customer.id,
    enabled: true,
    actorUserId: staff,
    permissionEvidenceRef: "local-seed:pilot-agreement",
  });
  return { seeded: true, credentialAccounts: Boolean(options.password) };
}
