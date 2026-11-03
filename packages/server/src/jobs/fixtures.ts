import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";

type Db = Pick<pg.Pool, "query">;
const sha = (v: string) => createHash("sha256").update(v).digest("hex");

/**
 * EXPLICIT local-seed/test fixture step (owner or test credential). Walks one
 * queued job through the REAL database state machine - persisted inputs, the
 * global slot, absolute deadline, submission intent and a claimed physical
 * invocation - so direct state edits are never needed. Unlike production it
 * first ends and retires a FIXTURE holder through the real transitions and
 * evidence (see below) and refuses any other holder.
 * It performs no external effect and is never used by routes.
 */
export async function fixtureRunJob(
  db: Db,
  jobId: string,
  options: { deadlineSeconds?: number } = {},
): Promise<{ nonce: string; capabilityToken: string; bootstrapToken: string }> {
  const holder = await db.query<{
    job_id: string | null;
    state: string | null;
    backend: string | null;
    ref: string | null;
  }>(
    `SELECT a.job_id, j.state, j.execution_backend AS backend, j.execution_call_id AS ref
     FROM dispatch_admission a LEFT JOIN jobs j ON j.id = a.job_id WHERE a.slot = 1`,
  );
  const held = holder.rows[0];
  if (held?.job_id && held.job_id !== jobId) {
    // Only an explicitly identified FIXTURE holder (local backend, `fixture-`
    // execution reference) may be retired, and only through the real
    // transitions: it is ended (failed, or cancelled after a cancel request)
    // and its local child is recorded reaped, which completes both release
    // conditions. Any other holder is refused, so tests keep every invariant
    // active (a fixture job that must stay pending needs a fresh database).
    if (held.backend !== "local" || !held.ref?.startsWith("fixture-"))
      throw new Error(
        `Admission slot is held by non-fixture job ${held.job_id} (${held.state}); use a fresh database`,
      );
    if (!["succeeded", "failed", "cancelled"].includes(held.state ?? ""))
      await db.query(
        "UPDATE jobs SET state = $2, finished_at = now() WHERE id = $1",
        [
          held.job_id,
          held.state === "cancel_requested" ? "cancelled" : "failed",
        ],
      );
    await db.query(
      `INSERT INTO job_execution_evidence (job_id, kind, execution_ref, recorded_by)
       VALUES ($1, 'local_child_reaped', $2, 'fixture') ON CONFLICT DO NOTHING`,
      [held.job_id, held.ref],
    );
  }
  const job = (
    await db.query<{
      source_manifest_sha256: string;
      profile_revision: string;
      recording_id: string;
    }>(
      "SELECT source_manifest_sha256, profile_revision, recording_id FROM jobs WHERE id = $1",
      [jobId],
    )
  ).rows[0];
  if (!job) throw new Error("Fixture job not found");
  const task = {
    schemaVersion: 2,
    rgbProfile: "h264_mcap_v1",
    jobId,
    targetId: job.recording_id,
    profileRevision: job.profile_revision,
    kind: "process_recording",
    sourceManifestSha256: job.source_manifest_sha256,
  };
  await db.query(
    `INSERT INTO job_inputs (job_id, source_manifest_sha256, profile_revision, execution_backend,
       code_revision, image_spec_sha256, model_sha256, config_sha256, max_output_files,
       max_output_bytes, max_control_document_bytes, task_input, task_input_sha256)
     VALUES ($1, $2, $3, 'local', 'fixture', $4, $5, $6, 512, 68719476736, 1048576, $7, $8)
     ON CONFLICT (job_id) DO NOTHING`,
    [
      jobId,
      job.source_manifest_sha256,
      job.profile_revision,
      sha("image"),
      sha("model"),
      sha("config"),
      JSON.stringify(task),
      sha(JSON.stringify(task)),
    ],
  );
  await db.query(
    "UPDATE dispatch_admission SET job_id = $1, admitted_at = now() WHERE slot = 1 AND job_id IS NULL",
    [jobId],
  );
  const bootstrapToken = `sa_svc_${randomBytes(32).toString("base64url")}`;
  const capabilityToken = `sa_svc_${randomBytes(32).toString("base64url")}`;
  const nonce = randomBytes(32).toString("base64url");
  const deadline = options.deadlineSeconds ?? 3600;
  await db.query(
    `UPDATE jobs SET state = 'submitting', admitted_at = now(), dispatch_key = 'job:' || id::text,
       execution_backend = 'local', execution_deadline = now() + make_interval(secs => $2),
       submission_intent_at = now(), submission_intent_owner = 'fixture',
       bootstrap_token_sha256 = $3, start_deadline = now() + make_interval(secs => LEAST($2, 600))
     WHERE id = $1`,
    [jobId, deadline, sha(bootstrapToken)],
  );
  await db.query(
    `UPDATE jobs SET state = 'running', claimed_at = now(), invocation_nonce = $2,
       execution_call_id = $3, capability_token_sha256 = $4 WHERE id = $1`,
    [jobId, nonce, `fixture-${randomUUID()}`, sha(capabilityToken)],
  );
  await db.query("UPDATE recordings SET status = 'processing' WHERE id = $1", [
    job.recording_id,
  ]);
  return { nonce, capabilityToken, bootstrapToken };
}

/**
 * Fixture counterpart of the controller's terminal evidence: records that the
 * local fixture child of an already-finished (succeeded/failed/cancelled)
 * fixture job is reaped, which completes the second release condition and
 * frees the admission slot through the real trigger. Seeds call this after
 * accepting their synthetic result so a seeded database does not keep the
 * single slot occupied.
 */
export async function fixtureReapJob(db: Db, jobId: string): Promise<void> {
  await db.query(
    `INSERT INTO job_execution_evidence (job_id, kind, execution_ref, recorded_by)
     SELECT id, 'local_child_reaped', execution_call_id, 'fixture' FROM jobs
     WHERE id = $1 AND execution_backend = 'local' AND execution_call_id LIKE 'fixture-%'
     ON CONFLICT DO NOTHING`,
    [jobId],
  );
}
