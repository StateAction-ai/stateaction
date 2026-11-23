import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import { acceptProcessingResult, type ClipInput } from "../catalog/catalog.js";
import { APP_DB_ROLE } from "../migrations.js";

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
  options: { deadlineSeconds?: number; maxOutputFiles?: number } = {},
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
     VALUES ($1, $2, $3, 'local', 'fixture', $4, $5, $6, $9, 68719476736, 1048576, $7, $8)
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
      options.maxOutputFiles ?? 512,
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
       AND NOT EXISTS (SELECT 1 FROM job_execution_evidence e WHERE e.job_id = jobs.id)
     ON CONFLICT DO NOTHING`,
    [jobId],
  );
}

const CLIP_SLOT_NAMES: Record<keyof ClipInput["files"], string> = {
  rgbMp4: "rgb.mp4",
  handArraysNpz: "hand-arrays.npz",
  handObservationsJson: "hand-observations.json",
  frameMapJson: "frame-map.json",
  thumbnailJpeg: "thumbnail.jpg",
  viewerRrd: "viewer.rrd",
};

type FixtureResult = {
  jobId: string;
  manifestFileId: string;
  manifestSha256: string;
  clips: ClipInput[];
};

/**
 * FIXTURE BOUNDARY (owner credential only; never imported by a route, the
 * service or any application path). Both functions below write the synthetic
 * proof a seed/unit/query test needs into the REAL acceptance tables, in the
 * production order and under the unconditional database guards (closure while
 * running, then candidate, verification, exact terminal evidence). They refuse
 * the restricted application role and any job that is not an explicit fixture
 * job (local backend, `fixture-` execution reference), so they cannot
 * manufacture verification facts for a real worker's job. Synthetic here means
 * "fixture bytes; no object was read": real objects are verified only by the
 * acceptance service.
 */
async function assertFixtureOwner(owner: Db, jobId: string) {
  const who = await owner.query<{ role: string }>(
    "SELECT current_user::text AS role",
  );
  if (who.rows[0]?.role === APP_DB_ROLE)
    throw new Error("fixture acceptance needs the owner credential");
  const job = (
    await owner.query<{
      state: string;
      invocation_nonce: string | null;
      ok: boolean;
    }>(
      `SELECT state, invocation_nonce,
              (execution_backend = 'local' AND execution_call_id LIKE 'fixture-%') AS ok
       FROM jobs WHERE id = $1`,
      [jobId],
    )
  ).rows[0];
  if (!job?.ok) throw new Error("not an explicit fixture job");
  return job;
}

/** Step 1 (job still `running`): intended slots + the closed output inventory. */
export async function fixtureCloseOutputs(
  owner: Db,
  input: Pick<FixtureResult, "jobId" | "manifestFileId" | "clips"> & {
    /** Recording-level outputs (SA-98: segments.json, recording.mp4, ...) as [fileId, slot]. */
    extraSlots?: readonly (readonly [string, string])[];
  },
) {
  const job = await assertFixtureOwner(owner, input.jobId);
  const slots: Array<[string, string]> = [
    [input.manifestFileId, "result-manifest.json"],
  ];
  for (const clip of [...input.clips].sort((a, b) => a.ordinal - b.ordinal))
    for (const [key, name] of Object.entries(CLIP_SLOT_NAMES))
      slots.push([
        clip.files[key as keyof ClipInput["files"]],
        `clips/${String(clip.ordinal).padStart(3, "0")}/${name}`,
      ]);
  slots.push(
    ...(input.extraSlots ?? []).map(([f, s]) => [f, s] as [string, string]),
  );
  for (const [fileId, slot] of slots)
    await owner.query(
      `INSERT INTO job_output_slots (job_id, slot, file_id, request_digest)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [input.jobId, slot, fileId, sha(`fixture-slot:${slot}`)],
    );
  const stats = (
    await owner.query<{ files: number; bytes: string; clips: number }>(
      `SELECT count(*)::int AS files, coalesce(sum(f.size_bytes), 0)::text AS bytes,
              count(DISTINCT substr(s.slot, 7, 3)) FILTER (WHERE s.slot LIKE 'clips/%')::int AS clips
       FROM files f LEFT JOIN job_output_slots s ON s.file_id = f.id AND s.job_id = f.job_id
       WHERE f.job_id = $1 AND f.purpose = 'output'`,
      [input.jobId],
    )
  ).rows[0]!;
  await owner.query(
    `INSERT INTO job_output_closures
       (job_id, invocation_nonce, outcome, file_count, clip_count, total_bytes, manifest_file_id, inventory_sha256)
     VALUES ($1, $2, 'succeeded', $3, $4, $5, $6, $7) ON CONFLICT (job_id) DO NOTHING`,
    [
      input.jobId,
      job.invocation_nonce,
      stats.files,
      stats.clips,
      stats.bytes,
      input.manifestFileId,
      "0".repeat(64),
    ],
  );
}

/**
 * Step 2 (job `result_pending`): the candidate, its per-file verification rows
 * and the fixture child's terminal evidence, then the unchanged
 * `acceptProcessingResult`. The database guard checks all of it.
 */
export async function fixtureAcceptResult(
  owner: Db,
  acceptor: Parameters<typeof acceptProcessingResult>[0],
  input: FixtureResult,
) {
  const job = await assertFixtureOwner(owner, input.jobId);
  if (job.state === "result_pending") {
    const closure = (
      await owner.query<{ inventory_sha256: string; clip_count: number }>(
        "SELECT inventory_sha256, clip_count FROM job_output_closures WHERE job_id = $1",
        [input.jobId],
      )
    ).rows[0];
    if (!closure)
      throw new Error(
        "fixtureCloseOutputs must close the inventory while the job is running",
      );
    await owner.query(
      `INSERT INTO job_result_candidates
         (job_id, invocation_nonce, manifest_file_id, manifest_sha256, inventory_sha256,
          outcome, clip_count, error_code, summary)
       VALUES ($1, $2, $3, $4, $5, 'succeeded', $6, NULL, $7) ON CONFLICT (job_id) DO NOTHING`,
      [
        input.jobId,
        job.invocation_nonce,
        input.manifestFileId,
        input.manifestSha256,
        closure.inventory_sha256,
        closure.clip_count,
        JSON.stringify({
          outcome: "succeeded",
          clipCount: closure.clip_count,
          fixture: true,
        }),
      ],
    );
    await owner.query(
      `INSERT INTO job_output_verifications (file_id, job_id, inventory_sha256, size_bytes, sha256)
       SELECT f.id, f.job_id, $2, f.size_bytes, f.sha256 FROM files f
       WHERE f.job_id = $1 AND f.purpose = 'output' ON CONFLICT DO NOTHING`,
      [input.jobId, closure.inventory_sha256],
    );
    await owner.query(
      `UPDATE job_result_candidates SET status = 'verified', clip_plan = '[]'::jsonb, verified_checks = '[]'::jsonb, verified_at = now()
       WHERE job_id = $1 AND status = 'provisional'`,
      [input.jobId],
    );
    await owner.query(
      `INSERT INTO job_execution_evidence (job_id, kind, execution_ref, recorded_by)
       SELECT id, 'local_child_reaped', execution_call_id, 'fixture' FROM jobs
       WHERE id = $1 ON CONFLICT DO NOTHING`,
      [input.jobId],
    );
  }
  return acceptProcessingResult(acceptor, input);
}
