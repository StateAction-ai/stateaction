import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { getJobStatus } from "../src/jobs/service.js";
import { getDagRun } from "../src/jobs/stages.js";
import { seedLocalCatalog, SEED } from "../src/catalog/seed.js";
import { expectCode, freshDatabase } from "./harness.js";

test("cached imports require the owner and cannot carry live admission evidence", async () => {
  const db = await freshDatabase();
  try {
    await seedLocalCatalog(db.owner);
    const jobId = randomUUID();
    const insert = `INSERT INTO jobs (id, kind, recording_id, profile_revision, source_manifest_sha256)
      SELECT $1, 'cached_import', id, 'cached-import-v1', source_manifest_sha256
      FROM recordings WHERE id = $2`;
    await expectCode(db.app.query(insert, [jobId, SEED.recordingId]), "SAC05");
    await expectCode(
      db.app.query(
        "INSERT INTO cached_processing_imports (job_id) VALUES ($1)",
        [jobId],
      ),
      "42501",
    );
    await expectCode(
      db.owner.query(insert, [jobId, SEED.recordingId]),
      "SAC04",
    );
    const recordingId = randomUUID();
    const ownerId = "stateaction-cached-import-source";
    await db.owner.query(
      `INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, 'Cached import', 'cached-import@example.test', false)`,
      [ownerId],
    );
    await db.owner.query(
      "INSERT INTO access (user_id, role) VALUES ($1, 'collector')",
      [ownerId],
    );
    const recording = `INSERT INTO recordings
      (id, owner_user_id, client_recording_id, capture_format, rgb_profile, started_at, device,
       simulation, imported_from_cache)
      VALUES ($1,$2,$1,'stateaction.capture.v1','h264_mcap_simulation_v1',now(),'{}','{}',true)`;
    await expectCode(db.app.query(recording, [recordingId, ownerId]), "SAC05");
    await db.owner.query(recording, [recordingId, ownerId]);
    await expectCode(
      db.owner.query(
        "UPDATE recordings SET imported_from_cache = false WHERE id = $1",
        [recordingId],
      ),
      "SAC01",
    );
    await db.owner.query(
      `INSERT INTO files (
      id, recording_id, purpose, role, size_bytes, sha256, object_key, part_size_bytes, part_count,
      client_upload_id, request_digest)
      SELECT ids.file, $1::uuid, 'source', f.role, f.size_bytes, f.sha256,
             'recordings/' || $1 || '/sources/' || ids.file || '/e1/' || f.role,
             f.part_size_bytes, 1, ids.file, f.sha256
      FROM files f CROSS JOIN LATERAL (SELECT gen_random_uuid() AS file WHERE f.id IS NOT NULL) ids
      WHERE f.recording_id = $2 AND f.purpose = 'source'`,
      [recordingId, SEED.recordingId],
    );
    await db.owner.query(
      "UPDATE files SET state = 'verified', observed_size_bytes = size_bytes, completed_at = now() WHERE recording_id = $1",
      [recordingId],
    );
    await db.owner.query(
      `UPDATE recordings r SET status = 'sealed', source_manifest_file_id = f.id,
      source_manifest_sha256 = f.sha256 FROM files f WHERE r.id = $1 AND f.recording_id = r.id
      AND f.role = 'source_manifest'`,
      [recordingId],
    );
    await db.owner.query(insert, [jobId, recordingId]);
    await assert.rejects(getJobStatus({ pool: db.app }, jobId), {
      code: "not_found",
    });
    await assert.rejects(getDagRun({ pool: db.app }, jobId), {
      code: "not_found",
    });
    assert.equal(
      (
        await db.owner.query(
          "SELECT job_id FROM dispatch_admission WHERE slot = 1",
        )
      ).rows[0]?.job_id,
      null,
    );
    await expectCode(
      db.owner.query(
        `INSERT INTO job_inputs (
        job_id, source_manifest_sha256, profile_revision, execution_backend, code_revision,
        image_spec_sha256, model_sha256, config_sha256, max_output_files, max_output_bytes,
        max_control_document_bytes, task_input, task_input_sha256)
        SELECT $1, source_manifest_sha256, profile_revision, execution_backend, code_revision,
               image_spec_sha256, model_sha256, config_sha256, max_output_files, max_output_bytes,
               max_control_document_bytes, task_input, task_input_sha256
        FROM job_inputs WHERE job_id = $2`,
        [jobId, SEED.jobId],
      ),
      "SAC04",
    );
    await expectCode(
      db.owner.query(
        "UPDATE dispatch_admission SET job_id = $1 WHERE slot = 1",
        [jobId],
      ),
      "SAC04",
    );
    await expectCode(
      db.owner.query(
        "UPDATE jobs SET state = 'result_pending', execution_call_id = 'fake' WHERE id = $1",
        [jobId],
      ),
      "SAC04",
    );
    await db.owner.query(
      "UPDATE jobs SET state = 'result_pending' WHERE id = $1",
      [jobId],
    );
    await expectCode(
      db.owner.query(
        "UPDATE jobs SET state = 'succeeded', finished_at = now() WHERE id = $1",
        [jobId],
      ),
      "SAC04",
    );
    const live = (
      await db.app.query("SELECT kind, state FROM jobs WHERE id = $1", [
        SEED.jobId,
      ])
    ).rows[0];
    assert.deepEqual(live, { kind: "process_recording", state: "succeeded" });
  } finally {
    await db.close();
  }
});
