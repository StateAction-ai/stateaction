import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import {
  acceptProcessingResult,
  addClipsToDataset,
  appendReview,
  createDataset,
  createProcessingJob,
  registerRecording,
  renameDataset,
  reserveSourceFile,
} from "../src/catalog/catalog.js";
import { seedSha } from "../src/catalog/seed.js";
import {
  createActors,
  expectCode,
  freshDatabase,
  processedRecording,
  writeArtifact,
  type Actors,
  type Processed,
  type TestDb,
} from "./harness.js";

let db: TestDb;
let actors: Actors;
const evidence: Record<string, unknown> = {};
before(async () => {
  db = await freshDatabase();
  actors = await createActors(db.owner);
});
after(async () => {
  await writeArtifact("concurrency.json", evidence);
  await db.close();
});

const settle = async <T>(work: Promise<T>[]) => {
  const results = await Promise.allSettled(work);
  const ok = results
    .filter((r) => r.status === "fulfilled")
    .map((r) => (r as PromiseFulfilledResult<T>).value);
  const codes = results
    .filter((r) => r.status === "rejected")
    .map(
      (r) =>
        (r as PromiseRejectedResult).reason?.code ??
        String((r as PromiseRejectedResult).reason),
    );
  return { ok, codes };
};
async function accepted(clipCount: number): Promise<Processed> {
  const p = await processedRecording(db.app, actors, clipCount);
  await acceptProcessingResult(db.app, {
    jobId: p.jobId,
    manifestFileId: p.manifestFileId,
    manifestSha256: p.manifestSha256,
    clips: p.clips,
  });
  return p;
}
const review = (
  p: Processed,
  clipId: string,
  expectedRevision: number,
  decision: "approved" | "rejected",
) =>
  appendReview(db.app, {
    reviewId: randomUUID(),
    clipId,
    jobId: p.jobId,
    resultManifestSha256: p.manifestSha256,
    reviewerUserId: actors.staff,
    expectedRevision,
    decision,
    ...(decision === "approved" ? { taskLabel: "grasp" } : {}),
  });
const revision = async (datasetId: string) =>
  (
    await db.app.query<{ revision: number }>(
      "SELECT revision FROM datasets WHERE id = $1",
      [datasetId],
    )
  ).rows[0]!.revision;

test("racing dataset add and rejection never leaves a non-approved member", async () => {
  const rounds = 30;
  const p = await accepted(rounds);
  const datasetId = randomUUID();
  await createDataset(db.app, {
    datasetId,
    name: "Race",
    actorUserId: actors.staff,
  });
  for (const clip of p.clips) await review(p, clip.clipId, 0, "approved");
  const outcomes = { addWon: 0, rejectFirst: 0 };
  for (const [i, clip] of p.clips.entries()) {
    // Alternate which writer starts first so both commit orders occur.
    const expectedRevision = await revision(datasetId);
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const [add, reject] = await Promise.allSettled([
      (async () => {
        if (i % 2) await delay(5);
        return addClipsToDataset(db.app, {
          datasetId,
          clipIds: [clip.clipId],
          expectedRevision,
          actorUserId: actors.staff,
        });
      })(),
      (async () => {
        if (i % 2 === 0) await delay(5);
        return review(p, clip.clipId, 1, "rejected");
      })(),
    ]);
    assert.equal(reject.status, "fulfilled", "rejection always appends");
    if (add.status === "fulfilled") outcomes.addWon++;
    else {
      assert.equal(add.reason.code, "conflict");
      outcomes.rejectFirst++;
    }
  }
  const bad = await db.app.query(
    `SELECT dc.clip_id FROM dataset_clips dc
     WHERE catalog_latest_decision(dc.clip_id) IS DISTINCT FROM 'approved'`,
  );
  assert.equal(bad.rowCount, 0);
  assert.ok(
    outcomes.addWon > 0 && outcomes.rejectFirst > 0,
    `both orders exercised: ${JSON.stringify(outcomes)}`,
  );
  assert.equal(
    (
      await db.app.query(
        "SELECT count(*)::int AS n FROM dataset_clips WHERE dataset_id = $1",
        [datasetId],
      )
    ).rows[0].n,
    0,
  );
  evidence.addVersusReject = { rounds, ...outcomes, nonApprovedMembers: 0 };
});

test("a direct add blocked behind an uncommitted rejection fails after it commits", async () => {
  const p = await accepted(1);
  const clipId = p.clips[0]!.clipId;
  const datasetId = randomUUID();
  await createDataset(db.app, {
    datasetId,
    name: "Interleave",
    actorUserId: actors.staff,
  });
  await review(p, clipId, 0, "approved");
  const rejecter = new pg.Client({ connectionString: db.appUrl });
  const adder = new pg.Client({ connectionString: db.appUrl });
  await Promise.all([rejecter.connect(), adder.connect()]);
  try {
    await rejecter.query("BEGIN");
    await rejecter.query("SELECT catalog_lock_clip($1)", [clipId]);
    await rejecter.query(
      `INSERT INTO reviews (id, clip_id, job_id, result_manifest_sha256, revision, reviewer_user_id, decision)
       VALUES (gen_random_uuid(), $1, $2, $3, 2, $4, 'rejected')`,
      [clipId, p.jobId, p.manifestSha256, actors.staff],
    );
    await adder.query("BEGIN");
    // The adder already read "approved" before the rejection commits (stale eligibility).
    const stale = await adder.query("SELECT catalog_latest_decision($1) AS d", [
      clipId,
    ]);
    assert.equal(stale.rows[0].d, "approved");
    const insert = adder.query(
      "INSERT INTO dataset_clips (dataset_id, clip_id, added_by) VALUES ($1, $2, $3)",
      [datasetId, clipId, actors.staff],
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    const waiting = await db.owner.query(
      "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted",
    );
    assert.ok(waiting.rows[0].n >= 1, "the add waits on the clip lock");
    await rejecter.query("COMMIT");
    await expectCode(insert, "SAC02");
    await adder.query("ROLLBACK");
    evidence.blockedAddAfterReject = {
      waitedOnClipLock: true,
      result: "SAC02",
    };
  } finally {
    await Promise.all([rejecter.end(), adder.end()]);
  }
});

test("concurrent review appends with one expected revision admit exactly one", async () => {
  const p = await accepted(1);
  const clipId = p.clips[0]!.clipId;
  const { ok, codes } = await settle(
    Array.from({ length: 8 }, () => review(p, clipId, 0, "approved")),
  );
  assert.equal(ok.length, 1);
  assert.deepEqual([...new Set(codes)], ["conflict"]);
  const n = await db.app.query(
    "SELECT count(*)::int AS n FROM reviews WHERE clip_id = $1",
    [clipId],
  );
  assert.equal(n.rows[0].n, 1);
  evidence.duplicateReviewAppends = {
    attempts: 8,
    succeeded: ok.length,
    conflicts: codes.length,
  };
});

test("concurrent recording registration and upload reservation stay idempotent", async () => {
  const clientRecordingId = randomUUID();
  const reg = () =>
    registerRecording(db.app, {
      recordingId: randomUUID(),
      ownerUserId: actors.collector,
      clientRecordingId,
      captureFormat: "stateaction.capture.v1",
      rgbProfile: "h264_mcap_v1",
      startedAt: "2026-11-01T00:00:00.000Z",
      device: { model: "m", osVersion: "1", appVersion: "a" },
    });
  const regs = await settle(Array.from({ length: 8 }, reg));
  assert.equal(regs.codes.length, 0);
  assert.equal(new Set(regs.ok.map((r) => r.recordingId)).size, 1);
  assert.equal(regs.ok.filter((r) => r.created).length, 1);
  const recordingId = regs.ok[0]!.recordingId;
  const clientUploadId = randomUUID();
  const reserve = (sha: string) =>
    reserveSourceFile(db.app, {
      fileId: randomUUID(),
      recordingId,
      ownerUserId: actors.collector,
      clientUploadId,
      role: "source_mcap",
      sizeBytes: "10",
      sha256: sha,
      required: true,
      partSizeBytes: "67108864",
      partCount: 1,
    });
  const reservations = await settle(
    [0, 1, 2, 3, 4, 5, 6, 7].map((i) => reserve(seedSha(i % 2 ? "a" : "b"))),
  );
  const files = await db.app.query(
    "SELECT id FROM files WHERE recording_id = $1 AND client_upload_id = $2",
    [recordingId, clientUploadId],
  );
  assert.equal(files.rowCount, 1);
  assert.ok(reservations.ok.every((r) => r.fileId === files.rows[0].id));
  assert.equal(
    reservations.ok.length,
    4,
    "same-digest requests return the winner",
  );
  assert.deepEqual([...new Set(reservations.codes)], ["idempotency_conflict"]);
  evidence.idempotentRegistration = { attempts: 8, rows: 1 };
  evidence.reservationDigestRace = {
    attempts: 8,
    rows: 1,
    sameDigest: 4,
    conflicts: reservations.codes.length,
  };
});

test("concurrent retries create at most one live job per recording", async () => {
  const p = await accepted(1);
  const { ok, codes } = await settle(
    Array.from({ length: 6 }, () =>
      createProcessingJob(db.app, {
        jobId: randomUUID(),
        recordingId: p.recordingId,
        previousJobId: p.jobId,
        profileRevision: "retry",
      }),
    ),
  );
  assert.equal(ok.length, 1);
  assert.deepEqual([...new Set(codes)], ["conflict"]);
  const live = await db.app.query(
    "SELECT count(*)::int AS n FROM jobs WHERE recording_id = $1 AND state = 'queued'",
    [p.recordingId],
  );
  assert.equal(live.rows[0].n, 1);
  evidence.concurrentRetries = { attempts: 6, created: 1 };
});

test("overlapping bulk adds in opposite orders never deadlock", async () => {
  const p = await accepted(12);
  const ids = p.clips.map((c) => c.clipId);
  for (const id of ids) await review(p, id, 0, "approved");
  let attempts = 0;
  for (let round = 0; round < 10; round++) {
    const a = randomUUID();
    const b = randomUUID();
    await createDataset(db.app, {
      datasetId: a,
      name: `A${round}`,
      actorUserId: actors.staff,
    });
    await createDataset(db.app, {
      datasetId: b,
      name: `B${round}`,
      actorUserId: actors.staff,
    });
    const results = await settle([
      addClipsToDataset(db.app, {
        datasetId: a,
        clipIds: ids,
        expectedRevision: 1,
        actorUserId: actors.staff,
      }),
      addClipsToDataset(db.app, {
        datasetId: b,
        clipIds: [...ids].reverse(),
        expectedRevision: 1,
        actorUserId: actors.staff,
      }),
      appendReview(db.app, {
        reviewId: randomUUID(),
        clipId: ids[round]!,
        jobId: p.jobId,
        resultManifestSha256: p.manifestSha256,
        reviewerUserId: actors.staff,
        expectedRevision: 1,
        decision: "approved",
        taskLabel: "relabel",
        datasetSelection: {
          datasetIds: [a, b],
          expectedRevisions: { [a]: 1, [b]: 1 },
        },
      }),
    ]);
    attempts += 3;
    assert.ok(!results.codes.includes("40P01"), `deadlock in round ${round}`);
  }
  evidence.opposingBulkAdds = { attempts, deadlocks: 0 };
});

test("concurrent renames with one expected revision admit exactly one", async () => {
  const datasetId = randomUUID();
  await createDataset(db.app, {
    datasetId,
    name: "Original",
    actorUserId: actors.staff,
  });
  const { ok, codes } = await settle(
    Array.from({ length: 6 }, (_, i) =>
      renameDataset(db.app, {
        datasetId,
        name: `Name ${i}`,
        expectedRevision: 1,
        actorUserId: actors.staff,
      }),
    ),
  );
  assert.equal(ok.length, 1);
  assert.deepEqual([...new Set(codes)], ["conflict"]);
  assert.equal(await revision(datasetId), 2);
  evidence.concurrentRenames = { attempts: 6, succeeded: 1 };
});
