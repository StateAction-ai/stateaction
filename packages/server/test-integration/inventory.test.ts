// Seal freezes the live source inventory (review findings N1/N2): declared
// source files cannot be retired after seal, a cancel racing a seal
// serializes on the recording row in both orders, and a seal pointer always
// leaves the upload states. Every probe runs as the restricted app role.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import pg from "pg";
import {
  createProcessingJob,
  recordFileCompleted,
  registerRecording,
  reserveSourceFile,
  sealRecording,
} from "../src/catalog/catalog.js";
import { seedSha } from "../src/catalog/seed.js";
import {
  createActors,
  expectCode,
  freshDatabase,
  writeArtifact,
  type Actors,
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
  await writeArtifact("inventory.json", evidence);
  await db.close();
});

type SourceRole =
  | "source_manifest"
  | "source_mcap"
  | "recorder_metadata"
  | "calibration";

async function newRecording() {
  const { recordingId } = await registerRecording(db.app, {
    recordingId: randomUUID(),
    ownerUserId: actors.collector,
    clientRecordingId: randomUUID(),
    captureFormat: "stateaction.capture.v1",
    rgbProfile: "h264_mcap_v1",
    startedAt: new Date().toISOString(),
    device: { model: "emulator", osVersion: "16", appVersion: "test" },
  });
  return recordingId;
}
async function reserve(recordingId: string, role: SourceRole, required = true) {
  const fileId = randomUUID();
  await reserveSourceFile(db.app, {
    fileId,
    recordingId,
    ownerUserId: actors.collector,
    clientUploadId: randomUUID(),
    role,
    sizeBytes: "10",
    sha256: seedSha(fileId),
    required,
    partSizeBytes: "67108864",
    partCount: 1,
  });
  return fileId;
}
const complete = (fileId: string, epoch = 1) =>
  recordFileCompleted(db.app, {
    fileId,
    expectedTransportEpoch: epoch,
    observedSizeBytes: "10",
  });
const setState = (
  fileId: string,
  state: string,
  pool: pg.Pool | pg.Client = db.app,
) => pool.query("UPDATE files SET state = $2 WHERE id = $1", [fileId, state]);
const seal = (recordingId: string, manifestFileId: string) =>
  sealRecording(db.app, {
    recordingId,
    ownerUserId: actors.collector,
    manifestFileId,
  });
const SEAL_SQL = `UPDATE recordings r SET status = 'sealed', source_manifest_file_id = f.id, source_manifest_sha256 = f.sha256
  FROM files f WHERE r.id = $1 AND f.recording_id = r.id AND f.role = 'source_manifest'
    AND f.state NOT IN ('cancelled', 'failed', 'expired')`;
const liveJobs = async (recordingId: string) =>
  (
    await db.owner.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM jobs WHERE recording_id = $1",
      [recordingId],
    )
  ).rows[0]!.n;
const fileStates = async (recordingId: string) =>
  (
    await db.owner.query<{
      id: string;
      role: string;
      state: string;
      transport_epoch: number;
    }>(
      "SELECT id, role, state, transport_epoch FROM files WHERE recording_id = $1 ORDER BY role, id",
      [recordingId],
    )
  ).rows;
const recordingRow = async (recordingId: string) =>
  (
    await db.owner.query<{
      status: string;
      sealed: boolean;
      inventory_ok: boolean;
    }>(
      `SELECT status, source_manifest_file_id IS NOT NULL AS sealed,
              public.catalog_source_inventory_ok(id, false) AS inventory_ok
       FROM recordings WHERE id = $1`,
      [recordingId],
    )
  ).rows[0]!;
const job = (recordingId: string) =>
  createProcessingJob(db.app, {
    jobId: randomUUID(),
    recordingId,
    profileRevision: "test-1",
  });
const rawJob = (recordingId: string) =>
  db.app.query(
    `INSERT INTO jobs (id, kind, recording_id, source_manifest_sha256, profile_revision)
     SELECT gen_random_uuid(), 'process_recording', id, source_manifest_sha256, 'raw'
     FROM recordings WHERE id = $1`,
    [recordingId],
  );

describe("sealed source inventory is frozen (N1)", () => {
  test("post-seal cancel/fail/expire of declared files is rejected; no job omits them; transport restart still recovers", async () => {
    const rec = await newRecording();
    const manifest = await reserve(rec, "source_manifest");
    // Legitimate pre-seal replacement: a retired MCAP and metadata stay
    // excluded from the live inventory and never block admission.
    const oldMcap = await reserve(rec, "source_mcap");
    await setState(oldMcap, "cancelled");
    const mcap = await reserve(rec, "source_mcap");
    const retiredMeta = await reserve(rec, "recorder_metadata");
    await setState(retiredMeta, "failed");
    const expiredCal = await reserve(rec, "calibration");
    await setState(expiredCal, "expired");
    const meta1 = await reserve(rec, "recorder_metadata");
    const meta2 = await reserve(rec, "recorder_metadata");
    const calibration = await reserve(rec, "calibration");
    const optional = await reserve(rec, "calibration", false);
    assert.deepEqual(await seal(rec, manifest), { replayed: false });
    await complete(manifest);
    await complete(mcap);
    await complete(meta1);

    const denied: string[] = [];
    for (const fileId of [meta2, calibration, optional, mcap, manifest])
      for (const state of ["cancelled", "failed", "expired"]) {
        await expectCode(setState(fileId, state), "SAC04");
        denied.push(state);
      }
    // A multi-row retirement is rejected as a whole.
    await expectCode(
      db.app.query(
        "UPDATE files SET state = 'cancelled' WHERE recording_id = $1 AND state IN ('reserved', 'uploading')",
        [rec],
      ),
      "SAC04",
    );
    // The required metadata and calibration still block admission (helper and raw SQL).
    await expectCode(job(rec), "conflict");
    await expectCode(rawJob(rec), "SAC04");
    assert.equal(
      await liveJobs(rec),
      0,
      "no job admitted without declared files",
    );

    // Post-seal transport abort/restart: next epoch, new key and upload, file stays live.
    await db.app.query(
      `UPDATE files SET transport_epoch = 2, object_key = $2, provider_upload_id = $3, state = 'uploading'
       WHERE id = $1`,
      [
        meta2,
        `recordings/${rec}/sources/${meta2}/e2/meta.json`,
        `mpu-${randomUUID()}`,
      ],
    );
    await complete(meta2, 2);
    await expectCode(job(rec), "conflict");
    await complete(calibration);
    // Optional files never gate admission, but stay declared.
    await job(rec);
    assert.equal(await liveJobs(rec), 1);

    const states = await fileStates(rec);
    const byId = new Map(states.map((r) => [r.id, r]));
    assert.equal(byId.get(oldMcap)!.state, "cancelled");
    assert.equal(byId.get(retiredMeta)!.state, "failed");
    assert.equal(byId.get(expiredCal)!.state, "expired");
    assert.equal(byId.get(meta2)!.transport_epoch, 2);
    assert.equal(byId.get(optional)!.state, "reserved");
    for (const id of [manifest, mcap, meta1, meta2, calibration])
      assert.equal(byId.get(id)!.state, "completed");
    evidence.postSealRetirement = {
      deniedTransitions: denied.length,
      preSealRetiredExcluded: [oldMcap, retiredMeta, expiredCal].length,
      restartedEpoch: byId.get(meta2)!.transport_epoch,
      jobs: await liveJobs(rec),
    };
  });

  test("pre-seal retirement leaves the live inventory; seal and admission ignore retired rows", async () => {
    const rec = await newRecording();
    const manifest = await reserve(rec, "source_manifest");
    const mcap = await reserve(rec, "source_mcap");
    const onlyMeta = await reserve(rec, "recorder_metadata");
    await setState(onlyMeta, "cancelled");
    // Retired rows do not count: the inventory lacks recorder_metadata.
    await expectCode(seal(rec, manifest), "conflict");
    assert.equal((await recordingRow(rec)).sealed, false);
    const replacement = await reserve(rec, "recorder_metadata");
    await seal(rec, manifest);
    for (const id of [manifest, mcap, replacement]) await complete(id);
    await job(rec);
    assert.equal(await liveJobs(rec), 1);
    evidence.preSealReplacement = await recordingRow(rec);
  });
});

describe("seal pointer leaves upload states (N2)", () => {
  test("a new seal pointer with registered/uploading status is denied; the atomic seal helper is valid", async () => {
    const rec = await newRecording();
    const manifest = await reserve(rec, "source_manifest");
    await reserve(rec, "source_mcap");
    await reserve(rec, "recorder_metadata");
    for (const status of ["registered", "uploading"]) {
      await expectCode(
        db.app.query(
          `UPDATE recordings r SET status = $2, source_manifest_file_id = f.id, source_manifest_sha256 = f.sha256
           FROM files f WHERE r.id = $1 AND f.id = $3`,
          [rec, status, manifest],
        ),
        "SAC04",
      );
      // Leaving status untouched in the sealing statement is the same violation.
      await db.app.query("UPDATE recordings SET status = $2 WHERE id = $1", [
        rec,
        status,
      ]);
      await expectCode(
        db.app.query(
          `UPDATE recordings r SET source_manifest_file_id = f.id, source_manifest_sha256 = f.sha256
           FROM files f WHERE r.id = $1 AND f.id = $2`,
          [rec, manifest],
        ),
        "SAC04",
      );
    }
    assert.equal((await recordingRow(rec)).sealed, false);
    assert.deepEqual(await seal(rec, manifest), { replayed: false });
    const row = await recordingRow(rec);
    assert.equal(row.status, "sealed");
    // The row CHECK is the backstop below the trigger.
    const check = await db.owner.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid = 'recordings'::regclass AND contype = 'c'
         AND pg_get_constraintdef(oid) LIKE '%source_manifest_file_id IS NULL%status%'`,
    );
    assert.equal(check.rows.length, 1, "pointer/status CHECK exists");
    evidence.sealPointerStatus = {
      deniedStatuses: ["registered", "uploading"],
      sealed: row.status,
    };
  });
});

describe("retirement versus seal race (N1)", () => {
  test("cancel-first and seal-first both commit a consistent state", async () => {
    const results: Record<string, unknown> = {};
    for (const order of ["cancelFirst", "sealFirst"] as const) {
      const rec = await newRecording();
      await reserve(rec, "source_manifest");
      await reserve(rec, "source_mcap");
      const meta = await reserve(rec, "recorder_metadata");
      const holder = new pg.Client({ connectionString: db.appUrl });
      await holder.connect();
      let waitedMs = 0;
      let outcome = "";
      try {
        await holder.query("BEGIN");
        if (order === "cancelFirst") {
          // Uncommitted cancel of the only recorder_metadata, then a seal.
          await setState(meta, "cancelled", holder);
          const t0 = Date.now();
          const late = expectCode(db.app.query(SEAL_SQL, [rec]), "SAC04").then(
            () => {
              waitedMs = Date.now() - t0;
            },
          );
          await new Promise((r) => setTimeout(r, 400));
          await holder.query("COMMIT");
          await late;
          outcome = "seal rejected after cancel committed";
        } else {
          // Uncommitted seal, then a cancel of a declared file.
          const sealed = await holder.query(SEAL_SQL, [rec]);
          assert.equal(sealed.rowCount, 1);
          const t0 = Date.now();
          const late = expectCode(setState(meta, "cancelled"), "SAC04").then(
            () => {
              waitedMs = Date.now() - t0;
            },
          );
          await new Promise((r) => setTimeout(r, 400));
          await holder.query("COMMIT");
          await late;
          outcome = "cancel rejected after seal committed";
        }
      } finally {
        await holder.end();
      }
      assert.ok(
        waitedMs >= 300,
        `${order}: the late statement waited (${waitedMs}ms)`,
      );
      const row = await recordingRow(rec);
      const metaState = (await fileStates(rec)).find(
        (r) => r.id === meta,
      )!.state;
      if (order === "cancelFirst") {
        assert.equal(row.sealed, false);
        assert.equal(metaState, "cancelled");
      } else {
        assert.equal(row.sealed, true);
        assert.equal(metaState, "reserved");
      }
      // Invariant in every committed state: a seal implies a complete live inventory.
      assert.ok(
        !row.sealed || row.inventory_ok,
        `${order}: sealed implies inventory_ok`,
      );
      results[order] = { outcome, waitedMs, ...row, metaState };
    }
    evidence.retireVersusSeal = results;
  });
});
