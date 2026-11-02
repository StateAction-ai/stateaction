import type pg from "pg";
import {
  canonicalJson,
  sha256Hex,
  validateBytes,
} from "@stateaction/contracts";
import {
  ObjectTooLargeError,
  type ObjectReader,
} from "../admission/recordings.js";
import { inTransaction } from "../catalog/catalog.js";
import { CatalogError } from "../catalog/errors.js";
import { JOB_CURRENT_SQL, JOB_OUTPUT_OPEN_SQL } from "../jobs/current.js";
import { TransportError } from "../transport/errors.js";
import type { AcceptanceConfig } from "./config.js";
import {
  checkManifest,
  type InventoryFile,
  type ManifestFacts,
  type SourceFile,
} from "./manifest.js";
import { ObjectHashError, type ObjectHasher } from "./storage.js";

type Tx = pg.PoolClient;

export type AcceptanceDeps = {
  pool: pg.Pool;
  /** Bounded reader for the result manifest only (a control document). */
  reader: ObjectReader;
  /** Streaming SHA-256 of catalog-selected output objects. */
  hasher: ObjectHasher;
  config: AcceptanceConfig;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NONCE = /^[A-Za-z0-9_-]{43}$/;
const MANIFEST_CONTRACT = "artifacts.processing-result.v2";
const SHA_ZERO = "0".repeat(64);
const MANIFEST_MAX_BYTES = 1048576;

const invalid = (m: string) => new TransportError("invalid_request", m);
const conflict = (m: string) => new TransportError("conflict", m);
const forbidden = (m = "Job is not current") =>
  new TransportError("forbidden", m);
const iso = (d: Date) => d.toISOString();

function uuid(value: string, field: string): string {
  if (!UUID.test(value)) throw invalid(`${field} must be a UUID`);
  return value;
}
function nonceOf(value: string): string {
  if (!NONCE.test(value)) throw invalid("invocationNonce is malformed");
  return value;
}

async function run<T>(pool: pg.Pool, work: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await inTransaction(pool, work);
  } catch (error) {
    if (error instanceof CatalogError)
      throw new TransportError(
        error.code === "idempotency_conflict" ? "conflict" : error.code,
        error.message,
        { cause: error },
      );
    throw error;
  }
}

// ------------------------------------------------------------ close inventory

export type OutputClosure = {
  schemaVersion: 1;
  jobId: string;
  outcome: "succeeded" | "failed";
  fileCount: number;
  clipCount: number;
  totalBytes: string;
  manifestFileId: string;
  inventorySha256: string;
  closedAt: string;
};

type ClosureRow = {
  job_id: string;
  invocation_nonce: string;
  outcome: "succeeded" | "failed";
  file_count: number;
  clip_count: number;
  total_bytes: string;
  manifest_file_id: string;
  inventory_sha256: string;
  closed_at: Date;
};

const CLOSURE_COLUMNS = `job_id, invocation_nonce, outcome, file_count, clip_count, total_bytes::text,
  manifest_file_id, inventory_sha256, closed_at`;

function closureView(row: ClosureRow): OutputClosure {
  return {
    schemaVersion: 1,
    jobId: row.job_id,
    outcome: row.outcome,
    fileCount: row.file_count,
    clipCount: row.clip_count,
    totalBytes: row.total_bytes,
    manifestFileId: row.manifest_file_id,
    inventorySha256: row.inventory_sha256,
    closedAt: iso(row.closed_at),
  };
}

/**
 * Seals the job's output inventory exactly once. The caller supplies no file
 * list: the server closes precisely the files it reserved for this job, and
 * only if every one is completed and the inventory obeys the slot, role and
 * cap policy (enforced by the database trigger as well). Afterwards no output
 * may be allocated, written, restarted or cancelled. Idempotent for the same
 * claim and outcome.
 */
export async function closeOutputs(
  deps: Pick<AcceptanceDeps, "pool">,
  input: {
    jobId: string;
    invocationNonce: string;
    outcome: "succeeded" | "failed";
  },
): Promise<OutputClosure> {
  const jobId = uuid(input.jobId, "jobId");
  const nonce = nonceOf(input.invocationNonce);
  return run(deps.pool, async (tx) => {
    const locked = await tx.query(
      "SELECT 1 FROM jobs WHERE id = $1 FOR UPDATE",
      [jobId],
    );
    if (!locked.rows[0]) throw new TransportError("not_found", "Job not found");
    const existing = await tx.query<ClosureRow>(
      `SELECT ${CLOSURE_COLUMNS} FROM job_output_closures WHERE job_id = $1`,
      [jobId],
    );
    if (existing.rows[0]) {
      if (
        existing.rows[0].invocation_nonce !== nonce ||
        existing.rows[0].outcome !== input.outcome
      )
        throw conflict("Output inventory is already closed differently");
      return closureView(existing.rows[0]);
    }
    const open = await tx.query(JOB_OUTPUT_OPEN_SQL, [jobId, nonce]);
    if (!open.rows[0]) throw forbidden();
    const stats = await tx.query<{
      files: number;
      bytes: string;
      clips: number;
      manifest: string | null;
    }>(
      `SELECT count(*)::int AS files, coalesce(sum(f.size_bytes), 0)::text AS bytes,
              count(DISTINCT substr(s.slot, 7, 3)) FILTER (WHERE f.role <> 'result_manifest')::int AS clips,
              (array_agg(f.id) FILTER (WHERE f.role = 'result_manifest'))[1] AS manifest
       FROM files f LEFT JOIN job_output_slots s ON s.file_id = f.id AND s.job_id = f.job_id
       WHERE f.job_id = $1 AND f.purpose = 'output'`,
      [jobId],
    );
    const s = stats.rows[0]!;
    if (!s.manifest || s.files < 1)
      throw conflict("A completed result manifest output is required");
    const inserted = await tx.query<ClosureRow>(
      `INSERT INTO job_output_closures
         (job_id, invocation_nonce, outcome, file_count, clip_count, total_bytes, manifest_file_id, inventory_sha256)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${CLOSURE_COLUMNS}`,
      [
        jobId,
        nonce,
        input.outcome,
        s.files,
        s.clips,
        s.bytes,
        s.manifest,
        SHA_ZERO,
      ],
    );
    return closureView(inserted.rows[0]!);
  });
}

// ------------------------------------------------------------------ candidate

export type CandidateBody = {
  jobId: string;
  invocationNonce: string;
  manifestFileId: string;
  manifestSha256: string;
  summary: ManifestFacts["summary"] & { outcome: "succeeded" | "failed" };
};

export type ResultAck = {
  schemaVersion: 1;
  jobId: string;
  candidateStatus: "provisional" | "verified" | "accepted" | "rejected";
  jobState: string;
  reasonCode?: string;
};

type CandidateRow = {
  job_id: string;
  invocation_nonce: string;
  manifest_file_id: string;
  manifest_sha256: string;
  inventory_sha256: string;
  outcome: "succeeded" | "failed";
  clip_count: number;
  error_code: string | null;
  summary: ManifestFacts["summary"] & { outcome: string };
  status: "provisional" | "verified" | "accepted" | "rejected";
  clip_plan: unknown[] | null;
  reason_code: string | null;
  received_at: Date;
};

const CANDIDATE_COLUMNS = `job_id, invocation_nonce, manifest_file_id, manifest_sha256, inventory_sha256,
  outcome, clip_count, error_code, summary, status, clip_plan, reason_code, received_at`;

function ackOf(jobId: string, cand: CandidateRow, jobState: string): ResultAck {
  return {
    schemaVersion: 1,
    jobId,
    candidateStatus: cand.status,
    jobState,
    ...(cand.reason_code ? { reasonCode: cand.reason_code } : {}),
  };
}

/**
 * Records the worker's result CALLBACK as a provisional candidate and moves the
 * job to result_pending (which ends every worker mutation). It selects nothing
 * and frees no capacity: acceptance happens only in `advanceResult`, when the
 * API itself holds every fact. A byte-identical replay is idempotent; a
 * different candidate is a conflict; a stale, cancelled, expired or
 * revoked-permission claim is forbidden.
 */
export async function submitCandidate(
  deps: Pick<AcceptanceDeps, "pool" | "config">,
  body: CandidateBody,
): Promise<ResultAck> {
  const jobId = uuid(body.jobId, "jobId");
  const nonce = nonceOf(body.invocationNonce);
  return run(deps.pool, async (tx) => {
    const job = await tx.query<{ state: string }>(
      "SELECT state FROM jobs WHERE id = $1 FOR UPDATE",
      [jobId],
    );
    if (!job.rows[0]) throw new TransportError("not_found", "Job not found");
    const existing = await tx.query<CandidateRow>(
      `SELECT ${CANDIDATE_COLUMNS} FROM job_result_candidates WHERE job_id = $1`,
      [jobId],
    );
    if (existing.rows[0]) {
      const c = existing.rows[0];
      if (
        c.invocation_nonce !== nonce ||
        c.manifest_file_id !== body.manifestFileId ||
        c.manifest_sha256 !== body.manifestSha256 ||
        canonicalJson(c.summary) !== canonicalJson(body.summary)
      )
        throw conflict("A different result candidate was already received");
      return ackOf(jobId, c, job.rows[0].state);
    }
    const current = await tx.query(JOB_CURRENT_SQL, [jobId, nonce]);
    if (!current.rows[0]) throw forbidden();
    // The finite grace runs from the exact terminal-evidence timestamp and is
    // never reset: a candidate after it is refused even if reconcile has not
    // yet failed the job. (A candidate received before it stays eligible no
    // matter how long verification then takes.)
    const late = await tx.query(
      `SELECT 1 FROM job_execution_evidence
       WHERE job_id = $1 AND now() > recorded_at + make_interval(secs => $2)`,
      [jobId, deps.config.graceSeconds],
    );
    if (late.rows[0])
      throw forbidden("Result grace after execution ended elapsed");
    const closure = await tx.query<ClosureRow>(
      `SELECT ${CLOSURE_COLUMNS} FROM job_output_closures WHERE job_id = $1`,
      [jobId],
    );
    const closed = closure.rows[0];
    if (
      !closed ||
      closed.manifest_file_id !== body.manifestFileId ||
      closed.invocation_nonce !== nonce ||
      closed.outcome !== body.summary.outcome
    )
      throw conflict(
        "Close the output inventory for this manifest and outcome first",
      );
    await tx.query(
      "UPDATE jobs SET state = 'result_pending' WHERE id = $1 AND state = 'running'",
      [jobId],
    );
    const outcome = body.summary.outcome;
    const inserted = await tx.query<CandidateRow>(
      `INSERT INTO job_result_candidates
         (job_id, invocation_nonce, manifest_file_id, manifest_sha256, inventory_sha256,
          outcome, clip_count, error_code, summary)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${CANDIDATE_COLUMNS}`,
      [
        jobId,
        nonce,
        body.manifestFileId,
        body.manifestSha256,
        closed.inventory_sha256,
        outcome,
        outcome === "failed" ? 0 : body.summary.clipCount,
        body.summary.errorCode,
        JSON.stringify(body.summary),
      ],
    );
    return ackOf(jobId, inserted.rows[0]!, "result_pending");
  });
}

// --------------------------------------------------------------- verification

type State = {
  job: {
    id: string;
    recording_id: string;
    state: string;
    execution_deadline: Date;
  };
  candidate: CandidateRow | null;
  evidenceAt: Date | null;
};

async function loadState(pool: pg.Pool, jobId: string): Promise<State | null> {
  const job = await pool.query<State["job"]>(
    "SELECT id, recording_id, state, execution_deadline FROM jobs WHERE id = $1",
    [jobId],
  );
  if (!job.rows[0]) return null;
  const [cand, ev] = await Promise.all([
    pool.query<CandidateRow>(
      `SELECT ${CANDIDATE_COLUMNS} FROM job_result_candidates WHERE job_id = $1`,
      [jobId],
    ),
    pool.query<{ recorded_at: Date }>(
      "SELECT recorded_at FROM job_execution_evidence WHERE job_id = $1",
      [jobId],
    ),
  ]);
  return {
    job: job.rows[0],
    candidate: cand.rows[0] ?? null,
    evidenceAt: ev.rows[0]?.recorded_at ?? null,
  };
}

type OutputRow = {
  id: string;
  role: string;
  size_bytes: string;
  sha256: string;
  object_key: string;
  slot: string;
  verified: boolean;
};

type Verification =
  | { kind: "verified" }
  | { kind: "incomplete" }
  | { kind: "rejected"; code: string; detail?: string };

/**
 * Out-of-transaction verification of a provisional candidate. Everything it
 * learns is bound to the closed inventory digest and persisted per file, so a
 * request that ends mid-way resumes (reconcile) without repeating finished
 * files. It decides nothing alone: acceptance rechecks every fact afterwards.
 */
async function verifyCandidate(
  deps: AcceptanceDeps,
  st: State,
  cand: CandidateRow,
): Promise<Verification> {
  const { pool, config } = deps;
  const wall = cand.received_at.getTime() + config.verifyWallSeconds * 1000;
  const reject = (code: string, detail?: string): Verification => ({
    kind: "rejected",
    code,
    ...(detail ? { detail } : {}),
  });
  // One finite wall for the whole verification, measured from candidate receipt
  // and checked at entry and after every failed or slow step, so an outage
  // before the manifest EOF cannot keep a candidate provisional forever.
  const sliceEnd = Date.now() + config.verifySliceMs;
  if (Date.now() > wall) return reject("verification_timeout");
  const files = (
    await pool.query<OutputRow>(
      `SELECT f.id, f.role, f.size_bytes::text, f.sha256, f.object_key, s.slot,
              (v.file_id IS NOT NULL) AS verified
       FROM files f
       JOIN job_output_slots s ON s.file_id = f.id AND s.job_id = f.job_id
       LEFT JOIN job_output_verifications v ON v.file_id = f.id AND v.inventory_sha256 = $2
       WHERE f.job_id = $1 AND f.purpose = 'output' ORDER BY s.slot`,
      [st.job.id, cand.inventory_sha256],
    )
  ).rows;
  const manifest = files.find((f) => f.id === cand.manifest_file_id);
  if (!manifest) return reject("manifest_missing");
  const required =
    cand.outcome === "succeeded" ? files : files.filter((f) => f === manifest);
  const totalBytes = required.reduce((n, f) => n + Number(f.size_bytes), 0);
  if (
    files.length > config.verifyMaxFiles ||
    totalBytes > config.verifyMaxBytes
  )
    return reject("verification_budget_exceeded");

  const inputs = (
    await pool.query<{
      source_manifest_sha256: string;
      profile_revision: string;
      code_revision: string;
      image_spec_sha256: string;
      model_sha256: string;
      config_sha256: string;
      task_input: Record<string, unknown>;
      max_control_document_bytes: number;
    }>("SELECT * FROM job_inputs WHERE job_id = $1", [st.job.id])
  ).rows[0];
  if (!inputs) return reject("job_inputs_missing");

  // 1. The manifest: bytes hash to the declared SHA-256 at EOF, then the contract.
  let bytes: Uint8Array;
  try {
    bytes = await deps.reader.read(
      manifest.object_key,
      Math.min(inputs.max_control_document_bytes, MANIFEST_MAX_BYTES),
    );
  } catch (error) {
    if (error instanceof ObjectTooLargeError)
      return reject("manifest_too_large");
    return { kind: "incomplete" };
  }
  if (
    bytes.byteLength !== Number(manifest.size_bytes) ||
    sha256Hex(bytes) !== cand.manifest_sha256
  )
    return reject("manifest_hash_mismatch");
  const verdict = validateBytes(MANIFEST_CONTRACT, bytes);
  if (!verdict.valid) return reject("manifest_contract_invalid", verdict.code);

  const sources: SourceFile[] = (
    await pool.query<{
      id: string;
      role: string;
      size_bytes: string;
      sha256: string;
    }>(
      `SELECT id, role, size_bytes::text, sha256 FROM files
       WHERE recording_id = $1 AND purpose = 'source' AND state IN ('completed', 'verified')`,
      [st.job.recording_id],
    )
  ).rows.map((r) => ({
    fileId: r.id,
    role: r.role,
    sizeBytes: r.size_bytes,
    sha256: r.sha256,
  }));
  const outputs: InventoryFile[] = files
    .filter((f) => f !== manifest)
    .map((f) => ({
      fileId: f.id,
      role: f.role,
      slot: f.slot,
      sizeBytes: f.size_bytes,
      sha256: f.sha256,
    }));
  const checked = checkManifest(verdict.value as Record<string, unknown>, {
    jobId: st.job.id,
    recordingId: st.job.recording_id,
    nonce: cand.invocation_nonce,
    outcome: cand.outcome,
    summary: {
      clipCount: cand.summary.clipCount,
      checks: cand.summary.checks,
      errorCode: cand.error_code,
    },
    inputs: {
      sourceManifestSha256: inputs.source_manifest_sha256,
      profileRevision: inputs.profile_revision,
      codeRevision: inputs.code_revision,
      imageSpecSha256: inputs.image_spec_sha256,
      modelSha256: inputs.model_sha256,
      configSha256: inputs.config_sha256,
      taskInput: inputs.task_input,
    },
    outputs,
    sources,
  });
  if (!checked.ok) return reject(checked.code, checked.detail);
  const taken = await pool.query(
    "SELECT 1 FROM clips WHERE id = ANY($1::uuid[]) LIMIT 1",
    [checked.clipPlan.map((c) => c.clipId)],
  );
  if (taken.rows[0]) return reject("clip_id_conflict");

  // 2. Stream-hash each required object once, sequentially. Upper bound of one
  // call: the manifest read + verifySliceMs (checked BEFORE each object) + the
  // one object in flight, itself capped by the remaining wall. An object read
  // is not resumable mid-stream, so progress is per whole file.
  for (const f of required) {
    if (f.verified) continue;
    if (Date.now() > wall) return reject("verification_timeout");
    if (Date.now() > sliceEnd) return { kind: "incomplete" };
    if (f !== manifest) {
      try {
        const got = await deps.hasher.hash(
          f.object_key,
          Number(f.size_bytes),
          Math.max(
            1000,
            Math.min(config.verifyObjectTimeoutMs, wall - Date.now()),
          ),
        );
        if (got.sha256 !== f.sha256)
          return reject("output_hash_mismatch", f.slot);
      } catch (error) {
        if (error instanceof ObjectHashError) {
          if (error.code === "object_read_failed")
            return { kind: "incomplete" };
          return reject(error.code, f.slot);
        }
        return { kind: "incomplete" };
      }
    }
    await pool.query(
      `INSERT INTO job_output_verifications (file_id, job_id, inventory_sha256, size_bytes, sha256)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (file_id) DO NOTHING`,
      [f.id, st.job.id, cand.inventory_sha256, f.size_bytes, f.sha256],
    );
  }
  await run(pool, async (tx) => {
    await tx.query(
      `UPDATE job_result_candidates SET status = 'verified', clip_plan = $2, verified_checks = $3, verified_at = now()
       WHERE job_id = $1 AND status = 'provisional'`,
      [
        st.job.id,
        JSON.stringify(checked.clipPlan),
        JSON.stringify(
          ((verdict.value as Record<string, unknown>).checks as unknown[]) ??
            [],
        ),
      ],
    );
  });
  return { kind: "verified" };
}

// ----------------------------------------------------------------- disposition

/** Rejects the candidate and fails the job (diagnostics retained, no clip). */
async function rejectAndFail(
  deps: Pick<AcceptanceDeps, "pool">,
  jobId: string,
  code: string,
  detail?: string,
): Promise<void> {
  await run(deps.pool, async (tx) => {
    const r = await tx.query<{ recording_id: string }>(
      "SELECT recording_id FROM jobs WHERE id = $1",
      [jobId],
    );
    if (!r.rows[0]) return;
    await tx.query("SELECT 1 FROM recordings WHERE id = $1 FOR UPDATE", [
      r.rows[0].recording_id,
    ]);
    const job = await tx.query<{ state: string }>(
      "SELECT state FROM jobs WHERE id = $1 FOR UPDATE",
      [jobId],
    );
    if (job.rows[0]?.state !== "result_pending") return;
    await tx.query(
      `UPDATE job_result_candidates SET status = 'rejected', reason_code = $2, reason_detail = $3, decided_at = now()
       WHERE job_id = $1 AND status IN ('provisional', 'verified')`,
      [
        jobId,
        code,
        JSON.stringify(detail ? { detail: detail.slice(0, 200) } : {}),
      ],
    );
    await tx.query(
      `UPDATE jobs SET state = 'failed', error_code = $2, error_message = $3, finished_at = now()
       WHERE id = $1`,
      [jobId, code, `Result rejected: ${code}`],
    );
  });
}

type Accept = "accepted" | "waiting_evidence" | "rejected" | "noop";

/**
 * The single atomic acceptance. Locks recording then job, rechecks every fact
 * against LIVE rows after any streaming finished, and either selects the whole
 * result (clips, verified files, job succeeded, recording reviewable, candidate
 * accepted) or changes nothing. Exact physical terminal evidence is mandatory:
 * a callback alone never selects a result. The terminal state plus evidence is
 * what releases the admission slot (database trigger).
 */
async function acceptVerified(
  deps: Pick<AcceptanceDeps, "pool">,
  jobId: string,
): Promise<Accept> {
  return run(deps.pool, async (tx): Promise<Accept> => {
    const rec = await tx.query<{ recording_id: string }>(
      "SELECT recording_id FROM jobs WHERE id = $1",
      [jobId],
    );
    if (!rec.rows[0]) return "noop";
    const recordingId = rec.rows[0].recording_id;
    await tx.query("SELECT 1 FROM recordings WHERE id = $1 FOR UPDATE", [
      recordingId,
    ]);
    const job = (
      await tx.query<{ state: string }>(
        "SELECT state FROM jobs WHERE id = $1 FOR UPDATE",
        [jobId],
      )
    ).rows[0]!;
    if (job.state === "succeeded") return "accepted";
    if (job.state !== "result_pending") return "noop";
    const cand = (
      await tx.query<CandidateRow>(
        `SELECT ${CANDIDATE_COLUMNS} FROM job_result_candidates WHERE job_id = $1 FOR UPDATE`,
        [jobId],
      )
    ).rows[0];
    if (!cand || cand.status !== "verified") return "noop";
    const evidence = await tx.query(
      "SELECT 1 FROM job_execution_evidence WHERE job_id = $1",
      [jobId],
    );
    if (!evidence.rows[0]) return "waiting_evidence";

    const fail = async (code: string): Promise<Accept> => {
      await tx.query(
        `UPDATE job_result_candidates SET status = 'rejected', reason_code = $2, reason_detail = '{}'::jsonb, decided_at = now()
         WHERE job_id = $1`,
        [jobId, code],
      );
      await tx.query(
        `UPDATE jobs SET state = 'failed', error_code = $2, error_message = $3, finished_at = now() WHERE id = $1`,
        [jobId, code, `Result rejected: ${code}`],
      );
      return "rejected";
    };
    const digest = await tx.query<{ d: string }>(
      "SELECT job_output_inventory_digest($1) AS d",
      [jobId],
    );
    if (digest.rows[0]?.d !== cand.inventory_sha256)
      return fail("inventory_changed");
    const live = await tx.query<{
      pointer: boolean;
      live: boolean;
      processing: boolean;
      role: boolean;
      permission: boolean;
      in_time: boolean;
    }>(
      `SELECT r.current_job_id = $1 AS pointer, r.deleted_at IS NULL AS live, r.status = 'processing' AS processing,
              catalog_has_role(r.owner_user_id, 'collector') AS role,
              EXISTS (SELECT 1 FROM recording_registrations g
                      WHERE g.recording_id = r.id AND g.owner_user_id = r.owner_user_id
                        AND ingest_permission_ok(g.ingest_permission_id, g.owner_user_id, true)) AS permission,
              $3::timestamptz <= j.execution_deadline AS in_time
       FROM recordings r JOIN jobs j ON j.id = $1 WHERE r.id = $2`,
      [jobId, recordingId, cand.received_at],
    );
    const l = live.rows[0]!;
    if (!l.pointer || !l.live || !l.processing)
      return fail("recording_replaced");
    if (!l.role || !l.permission) return fail("permission_revoked");
    if (!l.in_time) return fail("deadline_exceeded");

    if (cand.outcome === "failed") {
      await tx.query(
        `UPDATE files SET state = 'verified' WHERE id = $1 AND state = 'completed'`,
        [cand.manifest_file_id],
      );
      await tx.query(
        `UPDATE jobs SET state = 'failed', error_code = $2, error_message = 'Worker reported a failed result',
           result_manifest_file_id = $3, result_manifest_sha256 = $4, finished_at = now() WHERE id = $1`,
        [
          jobId,
          cand.error_code ?? "worker_failed",
          cand.manifest_file_id,
          cand.manifest_sha256,
        ],
      );
      await tx.query(
        "UPDATE job_result_candidates SET status = 'accepted', decided_at = now() WHERE job_id = $1",
        [jobId],
      );
      return "accepted";
    }

    const plan = (cand.clip_plan ?? []) as Array<
      Record<string, string | number>
    >;
    for (const c of plan)
      await tx.query(
        `INSERT INTO clips (id, job_id, recording_id, ordinal, title, source_start_ns, source_end_ns,
           duration_ns, clock_domain, raster_width, raster_height, frame_count, rgb_mp4_file_id,
           hand_arrays_file_id, hand_observations_file_id, frame_map_file_id, thumbnail_file_id, viewer_rrd_file_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [
          c.clipId,
          jobId,
          recordingId,
          c.ordinal,
          c.title,
          c.sourceStartNs,
          c.sourceEndNs,
          c.durationNs,
          c.clockDomain,
          c.rasterWidth,
          c.rasterHeight,
          c.frameCount,
          c.rgbMp4FileId,
          c.handArraysFileId,
          c.handObservationsFileId,
          c.frameMapFileId,
          c.thumbnailFileId,
          c.viewerRrdFileId,
        ],
      );
    await tx.query(
      "UPDATE files SET state = 'verified' WHERE job_id = $1 AND purpose = 'output' AND state = 'completed'",
      [jobId],
    );
    await tx.query(
      `UPDATE files SET state = 'verified'
       WHERE recording_id = $1 AND purpose = 'source' AND role = 'source_mcap' AND state = 'completed'`,
      [recordingId],
    );
    await tx.query(
      `UPDATE jobs SET state = 'succeeded', result_manifest_file_id = $2, result_manifest_sha256 = $3,
         finished_at = now() WHERE id = $1`,
      [jobId, cand.manifest_file_id, cand.manifest_sha256],
    );
    await tx.query(
      "UPDATE recordings SET status = 'reviewable' WHERE id = $1 AND current_job_id = $2",
      [recordingId, jobId],
    );
    await tx.query(
      "UPDATE job_result_candidates SET status = 'accepted', decided_at = now() WHERE job_id = $1",
      [jobId],
    );
    return "accepted";
  });
}

/** Evidence recorded but the worker never reported: fail after the finite grace. */
async function settleMissingResult(
  deps: Pick<AcceptanceDeps, "pool" | "config">,
  st: State,
): Promise<void> {
  if (st.job.state !== "running" || !st.evidenceAt || st.candidate) return;
  const graceEnd = st.evidenceAt.getTime() + deps.config.graceSeconds * 1000;
  if (Date.now() < graceEnd && Date.now() < st.job.execution_deadline.getTime())
    return;
  await run(deps.pool, async (tx) => {
    await tx.query("SELECT 1 FROM recordings WHERE id = $1 FOR UPDATE", [
      st.job.recording_id,
    ]);
    const job = await tx.query<{ state: string }>(
      "SELECT state FROM jobs WHERE id = $1 FOR UPDATE",
      [st.job.id],
    );
    const cand = await tx.query(
      "SELECT 1 FROM job_result_candidates WHERE job_id = $1",
      [st.job.id],
    );
    if (job.rows[0]?.state !== "running" || cand.rows[0]) return;
    await tx.query(
      `UPDATE jobs SET state = 'failed', error_code = 'worker_exited_without_result',
         error_message = 'The physical execution ended without reporting a result', finished_at = now()
       WHERE id = $1`,
      [st.job.id],
    );
  });
}

/**
 * Drives one job as far as the facts allow. Safe to call from a request, the
 * evidence recorder and the reconcile repair, in any order and any number of
 * times: both arrival orders (result first, physical evidence first) reach the
 * same selected result, and nothing is ever selected without all facts.
 */
export async function advanceResult(
  deps: AcceptanceDeps,
  jobId: string,
): Promise<ResultAck | null> {
  uuid(jobId, "jobId");
  let st = await loadState(deps.pool, jobId);
  if (!st) return null;
  if (!st.candidate) {
    await settleMissingResult(deps, st);
    return null;
  }
  if (
    st.job.state === "result_pending" &&
    st.candidate.status === "provisional"
  ) {
    const v = await verifyCandidate(deps, st, st.candidate);
    if (v.kind === "rejected")
      await rejectAndFail(deps, jobId, v.code, v.detail);
  }
  st = (await loadState(deps.pool, jobId))!;
  if (
    st.job.state === "result_pending" &&
    st.candidate?.status === "verified"
  ) {
    await acceptVerified(deps, jobId);
    st = (await loadState(deps.pool, jobId))!;
  }
  return st.candidate ? ackOf(jobId, st.candidate, st.job.state) : null;
}

/** Cron/controller repair: continue unfinished verification and evidence-gated acceptance. */
export async function repairResults(
  deps: AcceptanceDeps,
  limit = 5,
): Promise<number> {
  const { rows } = await deps.pool.query<{ id: string }>(
    `SELECT j.id FROM jobs j
     WHERE j.state = 'result_pending'
        OR (j.state = 'running' AND EXISTS (SELECT 1 FROM job_execution_evidence e WHERE e.job_id = j.id))
     ORDER BY j.updated_at LIMIT $1`,
    [limit],
  );
  let advanced = 0;
  for (const row of rows) {
    try {
      await advanceResult(deps, row.id);
      advanced += 1;
    } catch (error) {
      // Class and message only: no URLs, keys or tokens exist in these errors.
      console.error(
        "[acceptance] repair failed",
        error instanceof Error ? `${error.name}: ${error.message}` : "error",
      );
    }
  }
  return advanced;
}
