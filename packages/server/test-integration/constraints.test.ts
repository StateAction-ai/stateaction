import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import pg from "pg";
import {
  acceptProcessingResult,
  addClipsToDataset,
  appendReview,
  createDataset,
  createProcessingJob,
  listDatasetClips,
  listDatasets,
  listInternalClips,
  registerRecording,
  renameDataset,
  reserveSourceFile,
  sealRecording,
  setDatasetAccess,
} from "../src/catalog/catalog.js";
import { verifyCredentialPassword } from "../src/catalog/password.js";
import { SEED, seedLocalCatalog, seedSha } from "../src/catalog/seed.js";
import {
  createActors,
  expectCode,
  freshDatabase,
  processedRecording,
  writeArtifact,
  type Actors,
  type TestDb,
} from "./harness.js";

let db: TestDb;
let actors: Actors;
before(async () => {
  db = await freshDatabase();
  actors = await createActors(db.owner);
});
after(() => db.close());

const approve = (
  pool: TestDb["app"],
  p: { jobId: string; manifestSha256: string },
  clipId: string,
  expectedRevision = 0,
  extra: Partial<Parameters<typeof appendReview>[1]> = {},
) =>
  appendReview(pool, {
    reviewId: randomUUID(),
    clipId,
    jobId: p.jobId,
    resultManifestSha256: p.manifestSha256,
    reviewerUserId: actors.staff,
    expectedRevision,
    decision: "approved",
    taskLabel: "grasp",
    ...extra,
  });

describe("local seed", () => {
  test("collector/staff/customer identities with pending, rejected, approved, shared and private clips", async () => {
    const seedDb = await freshDatabase();
    try {
      const report = await seedLocalCatalog(seedDb.owner, {
        password: "local-seed-password",
      });
      assert.deepEqual(report, { seeded: true, credentialAccounts: true });
      assert.deepEqual(await seedLocalCatalog(seedDb.owner), {
        seeded: false,
        credentialAccounts: false,
      });
      const roles = await seedDb.owner.query(
        `SELECT u.email, a.role FROM "user" u JOIN access a ON a.user_id = u.id ORDER BY u.email`,
      );
      assert.deepEqual(roles.rows.map((r) => r.role).sort(), [
        "collector",
        "customer",
        "customer",
        "staff",
      ]);
      const account = await seedDb.owner.query<{ password: string }>(
        `SELECT password FROM account WHERE "userId" = $1 AND "providerId" = 'credential'`,
        [SEED.users.staff.id],
      );
      assert.ok(
        await verifyCredentialPassword(
          account.rows[0]!.password,
          "local-seed-password",
        ),
      );
      const all = await listInternalClips(seedDb.app, {
        viewerUserId: SEED.users.staff.id,
      });
      const status = Object.fromEntries(
        all.clips.map((c) => [c.clipId, c.reviewStatus]),
      );
      assert.deepEqual(status, {
        [SEED.clips.pending]: "pending",
        [SEED.clips.rejected]: "rejected",
        [SEED.clips.shared]: "approved",
        [SEED.clips.private]: "approved",
        [SEED.clips.both]: "approved",
      });
      const visible = async (user: string, dataset: string) =>
        (
          await listDatasetClips(seedDb.app, {
            viewerUserId: user,
            datasetId: dataset,
          })
        ).clips
          .map((c) => c.clipId)
          .sort();
      const { shared, internal } = SEED.datasets;
      assert.deepEqual(
        await visible(SEED.users.customer.id, shared.id),
        [SEED.clips.shared, SEED.clips.both].sort(),
      );
      assert.deepEqual(await visible(SEED.users.customer.id, internal.id), []);
      assert.deepEqual(await visible(SEED.users.outsider.id, shared.id), []);
      assert.deepEqual(await visible(SEED.users.collector.id, shared.id), []);
      assert.deepEqual(
        await visible(SEED.users.staff.id, internal.id),
        [SEED.clips.private, SEED.clips.both].sort(),
      );
      const customerDatasets = await listDatasets(seedDb.app, {
        viewerUserId: SEED.users.customer.id,
      });
      assert.deepEqual(
        customerDatasets.datasets.map((d) => [
          d.datasetId,
          d.clipCount,
          d.durationNs,
        ]),
        [[shared.id, 2, "16000000000"]],
      );
      const staffDatasets = await listDatasets(seedDb.app, {
        viewerUserId: SEED.users.staff.id,
      });
      assert.equal(staffDatasets.datasets.length, 2);
      const first = await listDatasets(seedDb.app, {
        viewerUserId: SEED.users.staff.id,
        limit: 1,
      });
      const second = await listDatasets(seedDb.app, {
        viewerUserId: SEED.users.staff.id,
        limit: 1,
        cursor: first.nextCursor!,
      });
      assert.deepEqual(
        [...first.datasets, ...second.datasets].map((d) => d.datasetId),
        staffDatasets.datasets.map((d) => d.datasetId),
      );
      assert.equal(second.nextCursor, null);
      await writeArtifact("seed-summary.json", {
        report,
        clips: all.clips,
        customerDatasets,
        staffDatasets,
      });
    } finally {
      await seedDb.close();
    }
  });
});

describe("identity and logical uniqueness", () => {
  test("owner/client recording identity is idempotent and immutable", async () => {
    const input = {
      recordingId: randomUUID(),
      ownerUserId: actors.collector,
      clientRecordingId: randomUUID(),
      captureFormat: "stateaction.capture.v1" as const,
      rgbProfile: "h264_mcap_v1" as const,
      startedAt: "2026-11-01T10:00:00.000Z",
      device: { model: "m", osVersion: "1", appVersion: "a" },
    };
    const first = await registerRecording(db.app, input);
    const replay = await registerRecording(db.app, {
      ...input,
      recordingId: randomUUID(),
    });
    assert.deepEqual(replay, {
      recordingId: first.recordingId,
      created: false,
    });
    await expectCode(
      registerRecording(db.app, {
        ...input,
        device: { ...input.device, model: "other" },
      }),
      "idempotency_conflict",
    );
    // Another owner may reuse the same client ID.
    const other = await registerRecording(db.app, {
      ...input,
      recordingId: randomUUID(),
      ownerUserId: actors.staff,
    }).catch((e) => e);
    assert.equal(other.code, "forbidden", "only collectors own recordings");
    await expectCode(
      db.owner.query("UPDATE recordings SET owner_user_id = $2 WHERE id = $1", [
        first.recordingId,
        actors.staff,
      ]),
      "SAC01",
    );
    await expectCode(
      db.owner.query(
        "UPDATE recordings SET client_recording_id = gen_random_uuid() WHERE id = $1",
        [first.recordingId],
      ),
      "SAC01",
    );
  });

  test("logical source files are unique per clientUploadId with a request digest", async () => {
    const { recordingId } = await registerRecording(db.app, {
      recordingId: randomUUID(),
      ownerUserId: actors.collector,
      clientRecordingId: randomUUID(),
      captureFormat: "stateaction.capture.v1",
      rgbProfile: "h264_mcap_v1",
      startedAt: new Date().toISOString(),
      device: { model: "m", osVersion: "1", appVersion: "a" },
    });
    const input = {
      fileId: randomUUID(),
      recordingId,
      ownerUserId: actors.collector,
      clientUploadId: randomUUID(),
      role: "source_mcap" as const,
      sizeBytes: "5000",
      sha256: seedSha("x"),
      required: true,
      partSizeBytes: "67108864",
      partCount: 1,
    };
    const first = await reserveSourceFile(db.app, input);
    assert.deepEqual(
      await reserveSourceFile(db.app, { ...input, fileId: randomUUID() }),
      { fileId: first.fileId, created: false },
    );
    await expectCode(
      reserveSourceFile(db.app, { ...input, sha256: seedSha("y") }),
      "idempotency_conflict",
    );
    await expectCode(
      reserveSourceFile(db.app, {
        ...input,
        ownerUserId: actors.staff,
        clientUploadId: randomUUID(),
      }),
      "not_found",
    );
    // v1: one live MCAP (always required) and one live manifest per recording.
    await expectCode(
      reserveSourceFile(db.app, {
        ...input,
        fileId: randomUUID(),
        clientUploadId: randomUUID(),
        sha256: seedSha("second"),
      }),
      "conflict",
    );
    await expectCode(
      reserveSourceFile(db.app, {
        ...input,
        fileId: randomUUID(),
        clientUploadId: randomUUID(),
        role: "source_manifest",
        required: false,
      }),
      "invalid_request",
    );
    await expectCode(
      sealRecording(db.app, {
        recordingId,
        ownerUserId: actors.collector,
        manifestFileId: first.fileId,
      }),
      "conflict",
    );
    // Keys embed file ID and epoch; a key from another file is rejected.
    await expectCode(
      db.app.query(
        `INSERT INTO files (id, recording_id, purpose, role, client_upload_id, request_digest, size_bytes, sha256, object_key, part_size_bytes, part_count)
         VALUES (gen_random_uuid(), $1, 'source', 'calibration', gen_random_uuid(), $2, 10, $2, $3, 10, 1)`,
        [
          recordingId,
          seedSha("z"),
          `recordings/${recordingId}/sources/${first.fileId}/e1/calibration`,
        ],
      ),
      "23514",
    );
    // Transport restart needs the next epoch, a new key and a new provider upload.
    await db.app.query(
      "UPDATE files SET state = 'uploading', provider_upload_id = 'mpu-1' WHERE id = $1",
      [first.fileId],
    );
    await expectCode(
      db.app.query(
        "UPDATE files SET transport_epoch = 3, object_key = $2, provider_upload_id = 'mpu-2' WHERE id = $1",
        [
          first.fileId,
          `recordings/${recordingId}/sources/${first.fileId}/e3/source_mcap`,
        ],
      ),
      "SAC03",
    );
    await expectCode(
      db.app.query("UPDATE files SET object_key = $2 WHERE id = $1", [
        first.fileId,
        `recordings/${recordingId}/sources/${first.fileId}/e1/other`,
      ]),
      "SAC03",
    );
    await db.app.query(
      "UPDATE files SET transport_epoch = 2, object_key = $2, provider_upload_id = 'mpu-2' WHERE id = $1",
      [
        first.fileId,
        `recordings/${recordingId}/sources/${first.fileId}/e2/source_mcap`,
      ],
    );
    await db.app.query(
      "UPDATE files SET state = 'completed', observed_size_bytes = 5000, completed_at = now() WHERE id = $1",
      [first.fileId],
    );
    // Completed transport is closed: no reopen, no new key, identity frozen.
    await expectCode(
      db.app.query("UPDATE files SET state = 'uploading' WHERE id = $1", [
        first.fileId,
      ]),
      "SAC01",
    );
    await expectCode(
      db.app.query(
        "UPDATE files SET transport_epoch = 3, object_key = $2, provider_upload_id = 'mpu-3' WHERE id = $1",
        [
          first.fileId,
          `recordings/${recordingId}/sources/${first.fileId}/e3/source_mcap`,
        ],
      ),
      "SAC01",
    );
    await expectCode(
      db.owner.query("UPDATE files SET sha256 = $2 WHERE id = $1", [
        first.fileId,
        seedSha("q"),
      ]),
      "SAC01",
    );
    await db.app.query("UPDATE files SET state = 'verified' WHERE id = $1", [
      first.fileId,
    ]);
  });

  test("source manifest pointer is a completed source_manifest of the same recording with its exact digest", async () => {
    const a = await processedRecording(db.app, actors, 1);
    const b = await processedRecording(db.app, actors, 1);
    const manifestOf = async (recordingId: string) =>
      (
        await db.owner.query<{ id: string; sha256: string }>(
          "SELECT id, sha256 FROM files WHERE recording_id = $1 AND role = 'source_manifest'",
          [recordingId],
        )
      ).rows[0]!;
    const ma = await manifestOf(a.recordingId);
    const mb = await manifestOf(b.recordingId);
    const pinned = await db.owner.query(
      "SELECT source_manifest_file_id, source_manifest_sha256 FROM recordings WHERE id = $1",
      [a.recordingId],
    );
    assert.deepEqual(pinned.rows[0], {
      source_manifest_file_id: ma.id,
      source_manifest_sha256: ma.sha256,
    });
    const job = await db.owner.query(
      "SELECT source_manifest_sha256 FROM jobs WHERE id = $1",
      [a.jobId],
    );
    assert.equal(job.rows[0].source_manifest_sha256, ma.sha256);
    // Immutable once sealed, even for the owner.
    await expectCode(
      db.owner.query(
        "UPDATE recordings SET source_manifest_file_id = $2, source_manifest_sha256 = $3 WHERE id = $1",
        [a.recordingId, mb.id, mb.sha256],
      ),
      "SAC01",
    );
    // A fresh recording cannot point at another recording's manifest or a wrong digest.
    const { recordingId } = await registerRecording(db.app, {
      recordingId: randomUUID(),
      ownerUserId: actors.collector,
      clientRecordingId: randomUUID(),
      captureFormat: "stateaction.capture.v1",
      rgbProfile: "h264_mcap_v1",
      startedAt: new Date().toISOString(),
      device: { model: "m", osVersion: "1", appVersion: "a" },
    });
    // Without its own v1 inventory the seal trigger refuses first.
    await expectCode(
      db.app.query(
        "UPDATE recordings SET source_manifest_file_id = $2, source_manifest_sha256 = $3, status = 'sealed' WHERE id = $1",
        [recordingId, ma.id, ma.sha256],
      ),
      "SAC04",
    );
    let own = "";
    for (const role of [
      "source_manifest",
      "source_mcap",
      "recorder_metadata",
    ] as const) {
      const fileId = randomUUID();
      if (role === "source_manifest") own = fileId;
      await reserveSourceFile(db.app, {
        fileId,
        recordingId,
        ownerUserId: actors.collector,
        clientUploadId: randomUUID(),
        role,
        sizeBytes: "10",
        sha256: seedSha(fileId),
        required: true,
        partSizeBytes: "67108864",
        partCount: 1,
      });
    }
    // With a valid inventory, the composite FK still rejects another recording's manifest and a wrong digest.
    await expectCode(
      db.app.query(
        "UPDATE recordings SET source_manifest_file_id = $2, source_manifest_sha256 = $3, status = 'sealed' WHERE id = $1",
        [recordingId, ma.id, ma.sha256],
      ),
      "23503",
    );
    await expectCode(
      db.app.query(
        "UPDATE recordings SET source_manifest_file_id = $2, source_manifest_sha256 = $3, status = 'sealed' WHERE id = $1",
        [recordingId, own, seedSha("wrong")],
      ),
      "23503",
    );
    const mcap = (
      await db.owner.query<{ id: string; sha256: string }>(
        "SELECT id, sha256 FROM files WHERE recording_id = $1 AND role = 'source_mcap'",
        [a.recordingId],
      )
    ).rows[0]!;
    await expectCode(
      db.owner.query(
        "UPDATE recordings SET source_manifest_file_id = NULL, source_manifest_sha256 = NULL WHERE id = $1",
        [a.recordingId],
      ),
      "SAC01",
    );
    void mcap;
    // A seal is final: no return to upload states, even for the owner.
    await expectCode(
      db.app.query(
        "UPDATE recordings SET status = 'registered' WHERE id = $1",
        [a.recordingId],
      ),
      "SAC04",
    );
    await expectCode(
      db.owner.query(
        "UPDATE recordings SET status = 'uploading' WHERE id = $1",
        [a.recordingId],
      ),
      "SAC04",
    );
    // Sealed recordings accept no more source files.
    await expectCode(
      reserveSourceFile(db.app, {
        fileId: randomUUID(),
        recordingId: a.recordingId,
        ownerUserId: actors.collector,
        clientUploadId: randomUUID(),
        role: "calibration",
        sizeBytes: "10",
        sha256: seedSha("late"),
        required: false,
        partSizeBytes: "67108864",
        partCount: 1,
      }),
      "SAC04",
    );
  });

  test("jobs: one live attempt, pinned input, same-recording retries, frozen when finished", async () => {
    const p = await processedRecording(db.app, actors, 1);
    await expectCode(
      createProcessingJob(db.app, {
        jobId: randomUUID(),
        recordingId: p.recordingId,
        previousJobId: p.jobId,
        profileRevision: "x",
      }),
      "23505",
    );
    await expectCode(
      db.app.query(
        "UPDATE jobs SET source_manifest_sha256 = $2 WHERE id = $1",
        [p.jobId, seedSha("other")],
      ),
      "42501",
    );
    await expectCode(
      db.owner.query(
        "UPDATE jobs SET source_manifest_sha256 = $2 WHERE id = $1",
        [p.jobId, seedSha("other")],
      ),
      "SAC01",
    );
    await expectCode(
      db.app.query(
        "INSERT INTO jobs (id, kind, recording_id, source_manifest_sha256, profile_revision) VALUES (gen_random_uuid(), 'export_release', $1, $2, 'x')",
        [p.recordingId, seedSha("x")],
      ),
      "23514",
    );
    await acceptProcessingResult(db.app, {
      jobId: p.jobId,
      manifestFileId: p.manifestFileId,
      manifestSha256: p.manifestSha256,
      clips: p.clips,
    });
    await expectCode(
      db.app.query("UPDATE jobs SET state = 'running' WHERE id = $1", [
        p.jobId,
      ]),
      "SAC01",
    );
    // Retries stay within the same recording.
    const other = await processedRecording(db.app, actors, 1);
    await expectCode(
      db.app.query(
        `INSERT INTO jobs (id, kind, recording_id, previous_job_id, source_manifest_sha256, profile_revision)
         SELECT gen_random_uuid(), 'process_recording', $1, $2, source_manifest_sha256, 'x' FROM recordings WHERE id = $1`,
        [p.recordingId, other.jobId],
      ),
      "23503",
    );
    // A retry after success is a new row pointing at the previous attempt.
    const retry = randomUUID();
    await createProcessingJob(db.app, {
      jobId: retry,
      recordingId: p.recordingId,
      previousJobId: p.jobId,
      profileRevision: "test-2",
    });
    await expectCode(
      createProcessingJob(db.app, {
        jobId: randomUUID(),
        recordingId: p.recordingId,
        previousJobId: p.jobId,
        profileRevision: "test-3",
      }),
      "conflict",
    );
  });
});

describe("immutable clips and their file references", () => {
  test("clips reference completed same-job outputs of the matching role; replay cannot repoint", async () => {
    const p = await processedRecording(db.app, actors, 2);
    const q = await processedRecording(db.app, actors, 1);
    const clip = p.clips[0]!;
    const accept = (clips: typeof p.clips) =>
      acceptProcessingResult(db.app, {
        jobId: p.jobId,
        manifestFileId: p.manifestFileId,
        manifestSha256: p.manifestSha256,
        clips,
      });
    // Another job's file.
    await expectCode(
      accept([
        {
          ...clip,
          files: { ...clip.files, viewerRrd: q.clips[0]!.files.viewerRrd },
        },
      ]),
      "invalid_request",
    );
    // Wrong role in a slot.
    await expectCode(
      accept([
        {
          ...clip,
          files: {
            ...clip.files,
            viewerRrd: clip.files.thumbnailJpeg,
            thumbnailJpeg: clip.files.viewerRrd,
          },
        },
      ]),
      "conflict",
    );
    // Not yet completed output.
    const pending = randomUUID();
    await db.app.query(
      `INSERT INTO files (id, recording_id, job_id, purpose, role, size_bytes, sha256, object_key, part_size_bytes, part_count)
       VALUES ($1, $2, $3, 'output', 'viewer_rrd', 100, $4, $5, 67108864, 1)`,
      [
        pending,
        p.recordingId,
        p.jobId,
        seedSha(pending),
        `jobs/${p.jobId}/outputs/${pending}/e1/viewer.rrd`,
      ],
    );
    await expectCode(
      accept([{ ...clip, files: { ...clip.files, viewerRrd: pending } }]),
      "conflict",
    );
    const accepted = await accept(p.clips);
    assert.deepEqual(accepted, {
      clipIds: p.clips.map((c) => c.clipId),
      replayed: false,
    });
    assert.deepEqual(await accept(p.clips), {
      clipIds: p.clips.map((c) => c.clipId),
      replayed: true,
    });
    await expectCode(
      accept(p.clips.map((c) => ({ ...c, clipId: randomUUID() }))),
      "conflict",
    );
    await expectCode(
      acceptProcessingResult(db.app, {
        jobId: p.jobId,
        manifestFileId: p.manifestFileId,
        manifestSha256: seedSha("other"),
        clips: p.clips,
      }),
      "conflict",
    );
    // Outputs are closed after success, and clips are immutable for every role.
    const late = randomUUID();
    await expectCode(
      db.app.query(
        `INSERT INTO files (id, recording_id, job_id, purpose, role, size_bytes, sha256, object_key, part_size_bytes, part_count)
         VALUES ($1, $2, $3, 'output', 'viewer_rrd', 100, $4, $5, 67108864, 1)`,
        [
          late,
          p.recordingId,
          p.jobId,
          seedSha("late"),
          `jobs/${p.jobId}/outputs/${late}/e1/late.rrd`,
        ],
      ),
      "SAC04",
    );
    await expectCode(
      db.owner.query("UPDATE clips SET title = 'renamed' WHERE id = $1", [
        clip.clipId,
      ]),
      "SAC01",
    );
    await expectCode(
      db.owner.query("DELETE FROM clips WHERE id = $1", [clip.clipId]),
      "SAC01",
    );
    await expectCode(
      db.owner.query("UPDATE clips SET viewer_rrd_file_id = $2 WHERE id = $1", [
        clip.clipId,
        pending,
      ]),
      "SAC01",
    );
  });
});

describe("append-only reviews and approved-only datasets", () => {
  test("reviews append exact revisions for the exact result and are never edited", async () => {
    const p = await processedRecording(db.app, actors, 1);
    await acceptProcessingResult(db.app, {
      jobId: p.jobId,
      manifestFileId: p.manifestFileId,
      manifestSha256: p.manifestSha256,
      clips: p.clips,
    });
    const clipId = p.clips[0]!.clipId;
    await expectCode(
      approve(db.app, { ...p, manifestSha256: seedSha("stale") }, clipId),
      "invalid_request",
    );
    await expectCode(
      approve(db.app, p, clipId, 0, { reviewerUserId: actors.customer }),
      "forbidden",
    );
    await expectCode(
      approve(db.app, p, clipId, 0, { taskLabel: " " }),
      "invalid_request",
    );
    assert.equal((await approve(db.app, p, clipId)).revision, 1);
    await expectCode(approve(db.app, p, clipId, 0), "conflict");
    assert.equal(
      (
        await approve(db.app, p, clipId, 1, {
          decision: "rejected",
          taskLabel: undefined,
        })
      ).revision,
      2,
    );
    // The trigger rejects gaps even when the caller bypasses the access layer.
    await expectCode(
      db.app.query(
        `INSERT INTO reviews (id, clip_id, job_id, result_manifest_sha256, revision, reviewer_user_id, decision, task_label)
         VALUES (gen_random_uuid(), $1, $2, $3, 5, $4, 'approved', 'x')`,
        [clipId, p.jobId, p.manifestSha256, actors.staff],
      ),
      "SAC03",
    );
    await expectCode(
      db.owner.query(
        "UPDATE reviews SET decision = 'approved' WHERE clip_id = $1",
        [clipId],
      ),
      "SAC01",
    );
    await expectCode(
      db.owner.query("DELETE FROM reviews WHERE clip_id = $1", [clipId]),
      "SAC01",
    );
    const history = await db.app.query(
      "SELECT revision, decision FROM reviews WHERE clip_id = $1 ORDER BY revision",
      [clipId],
    );
    assert.deepEqual(history.rows, [
      { revision: 1, decision: "approved" },
      { revision: 2, decision: "rejected" },
    ]);
  });

  test("many-to-many membership is approved-only; rejection removes all memberships; reapproval restores nothing", async () => {
    const p = await processedRecording(db.app, actors, 3);
    await acceptProcessingResult(db.app, {
      jobId: p.jobId,
      manifestFileId: p.manifestFileId,
      manifestSha256: p.manifestSha256,
      clips: p.clips,
    });
    const [c1, c2, c3] = p.clips.map((c) => c.clipId) as [
      string,
      string,
      string,
    ];
    const d1 = randomUUID();
    const d2 = randomUUID();
    await createDataset(db.app, {
      datasetId: d1,
      name: "Kitchen",
      actorUserId: actors.staff,
    });
    await createDataset(db.app, {
      datasetId: d2,
      name: "Drawers",
      actorUserId: actors.staff,
    });
    await expectCode(
      createDataset(db.app, {
        datasetId: randomUUID(),
        name: "x",
        actorUserId: actors.customer,
      }),
      "forbidden",
    );
    await approve(db.app, p, c1);
    // Pending clip in a batch: whole batch fails, revision unchanged.
    await expectCode(
      addClipsToDataset(db.app, {
        datasetId: d1,
        clipIds: [c1, c2],
        expectedRevision: 1,
        actorUserId: actors.staff,
      }),
      "conflict",
    );
    await expectCode(
      db.app.query(
        "INSERT INTO dataset_clips (dataset_id, clip_id, added_by) VALUES ($1, $2, $3)",
        [d1, c2, actors.staff],
      ),
      "SAC02",
    );
    await approve(db.app, p, c3, 0, {
      decision: "rejected",
      taskLabel: undefined,
    });
    await expectCode(
      db.app.query(
        "INSERT INTO dataset_clips (dataset_id, clip_id, added_by) VALUES ($1, $2, $3)",
        [d1, c3, actors.staff],
      ),
      "SAC02",
    );
    assert.equal(
      (await db.app.query("SELECT revision FROM datasets WHERE id = $1", [d1]))
        .rows[0].revision,
      1,
    );
    assert.deepEqual(
      await addClipsToDataset(db.app, {
        datasetId: d1,
        clipIds: [c1],
        expectedRevision: 1,
        actorUserId: actors.staff,
      }),
      { added: 1, revision: 2 },
    );
    await expectCode(
      addClipsToDataset(db.app, {
        datasetId: d2,
        clipIds: [c1],
        expectedRevision: 7,
        actorUserId: actors.staff,
      }),
      "conflict",
    );
    // Approval with a complete selection moves the clip from d1 to {d2}.
    await expectCode(
      approve(db.app, p, c1, 1, {
        datasetSelection: { datasetIds: [d2], expectedRevisions: { [d1]: 2 } },
      }),
      "conflict",
    );
    const moved = await approve(db.app, p, c1, 1, {
      datasetSelection: {
        datasetIds: [d1, d2],
        expectedRevisions: { [d1]: 2, [d2]: 1 },
      },
    });
    assert.deepEqual(moved, { revision: 2, added: [d2], removed: [] });
    // Rejection removes every membership and advances both revisions.
    const rejected = await approve(db.app, p, c1, 2, {
      decision: "rejected",
      taskLabel: undefined,
    });
    assert.deepEqual(rejected.removed.sort(), [d1, d2].sort());
    const revs = await db.app.query(
      "SELECT id, revision FROM datasets WHERE id = ANY($1) ORDER BY revision",
      [[d1, d2]],
    );
    assert.deepEqual(
      revs.rows.map((r) => [r.id, r.revision]).sort(),
      [
        [d1, 3],
        [d2, 3],
      ].sort(),
    );
    assert.equal(
      (
        await db.app.query(
          "SELECT count(*)::int AS n FROM dataset_clips WHERE clip_id = $1",
          [c1],
        )
      ).rows[0].n,
      0,
    );
    // Reapproval without a selection restores nothing; an explicit empty selection is valid.
    assert.deepEqual(await approve(db.app, p, c1, 3), {
      revision: 4,
      added: [],
      removed: [],
    });
    assert.equal(
      (
        await db.app.query(
          "SELECT count(*)::int AS n FROM dataset_clips WHERE clip_id = $1",
          [c1],
        )
      ).rows[0].n,
      0,
    );
    // A non-approved review cannot leave memberships behind.
    await addClipsToDataset(db.app, {
      datasetId: d1,
      clipIds: [c1],
      expectedRevision: 3,
      actorUserId: actors.staff,
    });
    await expectCode(
      db.app.query(
        `INSERT INTO reviews (id, clip_id, job_id, result_manifest_sha256, revision, reviewer_user_id, decision)
         VALUES (gen_random_uuid(), $1, $2, $3, 5, $4, 'rejected')`,
        [c1, p.jobId, p.manifestSha256, actors.staff],
      ),
      "SAC02",
    );
    assert.deepEqual(
      await approve(db.app, p, c1, 4, {
        datasetSelection: { datasetIds: [], expectedRevisions: { [d1]: 4 } },
      }),
      { revision: 5, added: [], removed: [d1] },
    );
    // Dataset revisions always advance by exactly one.
    await expectCode(
      db.app.query("UPDATE datasets SET name = 'x' WHERE id = $1", [d1]),
      "SAC03",
    );
    assert.deepEqual(
      await renameDataset(db.app, {
        datasetId: d1,
        name: "Kitchen v2",
        expectedRevision: 5,
        actorUserId: actors.staff,
      }),
      { revision: 6 },
    );
    await expectCode(
      renameDataset(db.app, {
        datasetId: d1,
        name: "stale",
        expectedRevision: 5,
        actorUserId: actors.staff,
      }),
      "conflict",
    );
  });

  test("customer access needs an enabled customer role, a live grant and a latest approved review", async () => {
    const p = await processedRecording(db.app, actors, 1);
    await acceptProcessingResult(db.app, {
      jobId: p.jobId,
      manifestFileId: p.manifestFileId,
      manifestSha256: p.manifestSha256,
      clips: p.clips,
    });
    const clipId = p.clips[0]!.clipId;
    const d = randomUUID();
    await createDataset(db.app, {
      datasetId: d,
      name: "Delivery",
      actorUserId: actors.staff,
    });
    await approve(db.app, p, clipId, 0, {
      datasetSelection: { datasetIds: [d], expectedRevisions: { [d]: 1 } },
    });
    const sees = async (user: string) =>
      (await listDatasetClips(db.app, { viewerUserId: user, datasetId: d }))
        .clips.length;
    assert.equal(await sees(actors.customer), 0, "no grant yet");
    await expectCode(
      setDatasetAccess(db.app, {
        datasetId: d,
        userId: actors.customer,
        enabled: true,
        actorUserId: actors.customer,
        permissionEvidenceRef: "x",
      }),
      "forbidden",
    );
    await expectCode(
      setDatasetAccess(db.app, {
        datasetId: d,
        userId: actors.collector,
        enabled: true,
        actorUserId: actors.staff,
        permissionEvidenceRef: "x",
      }),
      "forbidden",
    );
    await setDatasetAccess(db.app, {
      datasetId: d,
      userId: actors.customer,
      enabled: true,
      actorUserId: actors.staff,
      permissionEvidenceRef: "pilot:1",
    });
    assert.equal(await sees(actors.customer), 1);
    assert.equal(await sees(actors.outsider), 0);
    await db.owner.query(
      "UPDATE access SET enabled = false WHERE user_id = $1 AND role = 'customer'",
      [actors.customer],
    );
    assert.equal(await sees(actors.customer), 0, "disabled role");
    await db.owner.query(
      "UPDATE access SET enabled = true WHERE user_id = $1 AND role = 'customer'",
      [actors.customer],
    );
    await setDatasetAccess(db.app, {
      datasetId: d,
      userId: actors.customer,
      enabled: false,
      actorUserId: actors.staff,
      permissionEvidenceRef: "pilot:1",
    });
    assert.equal(await sees(actors.customer), 0, "revoked grant");
    await setDatasetAccess(db.app, {
      datasetId: d,
      userId: actors.customer,
      enabled: true,
      actorUserId: actors.staff,
      permissionEvidenceRef: "pilot:2",
    });
    await approve(db.app, p, clipId, 1, {
      decision: "rejected",
      taskLabel: undefined,
    });
    assert.equal(await sees(actors.customer), 0, "latest review rejected");
    // Bounded pagination parameters.
    await expectCode(
      listDatasetClips(db.app, {
        viewerUserId: actors.staff,
        datasetId: d,
        limit: 101,
      }),
      "invalid_request",
    );
    await expectCode(
      listDatasetClips(db.app, {
        viewerUserId: actors.staff,
        datasetId: d,
        cursor: "garbage",
      }),
      "invalid_request",
    );
    await expectCode(
      listInternalClips(db.app, { viewerUserId: actors.customer }),
      "forbidden",
    );
  });
});

describe("session TEMP objects cannot shadow catalog relations", () => {
  test("the app role cannot create TEMP tables, and even with TEMP re-granted, shadows do not bypass triggers or the grant routine", async () => {
    const p = await processedRecording(db.app, actors, 2);
    await acceptProcessingResult(db.app, {
      jobId: p.jobId,
      manifestFileId: p.manifestFileId,
      manifestSha256: p.manifestSha256,
      clips: p.clips,
    });
    const [pendingClip, otherClip] = p.clips.map((c) => c.clipId) as [
      string,
      string,
    ];
    const d = randomUUID();
    await createDataset(db.app, {
      datasetId: d,
      name: "Shadow target",
      actorUserId: actors.staff,
    });
    const app = new pg.Client({ connectionString: db.appUrl });
    await app.connect();
    try {
      await expectCode(
        app.query(
          "CREATE TEMP TABLE reviews (clip_id uuid, revision int, decision text)",
        ),
        "42501",
      );
      // Simulate a misconfigured grant; function search_path must still win.
      await db.owner.query(
        `GRANT TEMPORARY ON DATABASE ${db.name} TO stateaction_app`,
      );
      const shadow = new pg.Client({ connectionString: db.appUrl });
      await shadow.connect();
      try {
        await shadow.query(
          "CREATE TEMP TABLE reviews (clip_id uuid, revision int, decision text, task_label text)",
        );
        await shadow.query(
          "INSERT INTO pg_temp.reviews VALUES ($1, 1, 'approved', 'fake')",
          [pendingClip],
        );
        await shadow.query(
          "CREATE TEMP TABLE access (user_id text, role text, enabled boolean)",
        );
        await shadow.query(
          "INSERT INTO pg_temp.access VALUES ($1, 'staff', true), ($2, 'staff', true)",
          [actors.customer, actors.collector],
        );
        await expectCode(
          shadow.query(
            "INSERT INTO public.dataset_clips (dataset_id, clip_id, added_by) VALUES ($1, $2, $3)",
            [d, pendingClip, actors.staff],
          ),
          "SAC02",
        );
        await expectCode(
          shadow.query(
            `INSERT INTO public.reviews (id, clip_id, job_id, result_manifest_sha256, revision, reviewer_user_id, decision, task_label)
             VALUES (gen_random_uuid(), $1, $2, $3, 1, $4, 'approved', 'x')`,
            [otherClip, p.jobId, p.manifestSha256, actors.customer],
          ),
          "SAC05",
        );
        await expectCode(
          shadow.query(
            "SELECT public.catalog_set_dataset_access($1, $2, true, $3, 'x')",
            [d, actors.customer, actors.collector],
          ),
          "SAC05",
        );
        await expectCode(
          shadow.query(
            "INSERT INTO public.dataset_clips (dataset_id, clip_id, added_by) VALUES ($1, $2, $3)",
            [d, otherClip, actors.customer],
          ),
          "SAC05",
        );
      } finally {
        await shadow.end();
      }
      const members = await db.owner.query(
        "SELECT count(*)::int AS n FROM dataset_clips WHERE dataset_id = $1",
        [d],
      );
      assert.equal(members.rows[0].n, 0);
      const grants = await db.owner.query(
        "SELECT count(*)::int AS n FROM dataset_access WHERE dataset_id = $1",
        [d],
      );
      assert.equal(grants.rows[0].n, 0);
    } finally {
      await db.owner.query(
        "SELECT stateaction_grant_app_role('stateaction_app')",
      );
      await app.end();
    }
    const again = new pg.Client({ connectionString: db.appUrl });
    await again.connect();
    try {
      await expectCode(again.query("CREATE TEMP TABLE x (id int)"), "42501");
    } finally {
      await again.end();
    }
  });
});
