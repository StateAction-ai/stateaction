import type pg from "pg";
import { randomUUID } from "node:crypto";
import {
  canonicalJson,
  requestSha256,
  sha256Hex,
  validateBytes,
  type ClipPlanTaskInputV5,
  type ClipPlanV1,
} from "@stateaction/contracts";
import {
  ObjectTooLargeError,
  type ObjectReader,
} from "../admission/recordings.js";
import { inTransaction } from "../catalog/catalog.js";
import { CatalogError, toCatalogError } from "../catalog/errors.js";
import { recordingMp4MaxBytes } from "../datasets/broker.js";
import { JOB_CURRENT_SQL, JOB_OUTPUT_OPEN_SQL } from "../jobs/current.js";
import {
  getJobRecipe,
  getPriorStages,
  promoteRecipeEvidence,
  STAGE_SLOT_SQL,
} from "../jobs/stages.js";
import { TransportError } from "../transport/errors.js";
import {
  PREPARED_RECIPE_SLOT,
  RESULT_MANIFEST_SLOT,
} from "../transport/authority.js";
import { completeTransport } from "../transport/recovery.js";
import {
  allocateJobOutput,
  signParts,
  type TransportDeps,
} from "../transport/service.js";
import {
  jobOutputByteLimit,
  jobOutputFileLimit,
  type AcceptanceConfig,
} from "./config.js";
import {
  checkManifest,
  summarizeChecks,
  type AnnotationFiles,
  type InventoryFile,
  type ManifestFacts,
  type SourceFile,
} from "./manifest.js";
import { ObjectHashError, type ObjectHasher } from "./storage.js";
import {
  hasNoHandInterval,
  indexAcceptedReviewAnnotations,
  type PresenceSpan,
  type VerifiedReviewSearch,
} from "./review-search.js";

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
/** SA-88: a recipe job's sealing hand_pose stage posts processing-result.v3. */
const MANIFEST_CONTRACT_V3 = "artifacts.processing-result.v3";
const MANIFEST_CONTRACT_V4 = "artifacts.processing-result.v4";
const MANIFEST_CONTRACT_V5 = "artifacts.processing-result.v5";
const MANIFEST_CONTRACT_V6 = "artifacts.processing-result.v6";
const reusedHandManifestContract = (clipTask: boolean) =>
  clipTask ? MANIFEST_CONTRACT_V6 : MANIFEST_CONTRACT_V4;

const recipeManifestContract = (clipTask: boolean) =>
  clipTask ? MANIFEST_CONTRACT_V5 : MANIFEST_CONTRACT_V3;
/**
 * Bounded read of each recording-level annotation document (segments,
 * captions, hand presence) at acceptance. Larger documents are rejected
 * (`annotation_too_large`), never truncated.
 */
export const ANNOTATION_MAX_BYTES = 32 * 1024 ** 2;
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
  return run(deps.pool, (tx) => closeOutputsInTransaction(tx, input));
}

async function closeOutputsInTransaction(
  tx: Tx,
  input: {
    jobId: string;
    invocationNonce: string;
    outcome: "succeeded" | "failed";
  },
): Promise<OutputClosure> {
  const jobId = uuid(input.jobId, "jobId");
  const nonce = nonceOf(input.invocationNonce);
  const locked = await tx.query("SELECT 1 FROM jobs WHERE id = $1 FOR UPDATE", [
    jobId,
  ]);
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
              count(DISTINCT substr(s.slot, 7, 3)) FILTER (WHERE s.slot LIKE 'clips/%')::int AS clips,
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
  verified_clip_plan: ClipPlanV1 | null;
  verified_counts: AnnotationCounts | null;
  verified_review_search: VerifiedReviewSearch | null;
  reason_code: string | null;
  received_at: Date;
};

/** Accepted annotation counts (null: that document was not produced). */
export type AnnotationCounts = {
  segmentCount: number | null;
  failedWindowCount: number | null;
  captionCount: number | null;
  captionFailedCount: number | null;
};

const CANDIDATE_COLUMNS = `job_id, invocation_nonce, manifest_file_id, manifest_sha256, inventory_sha256,
  outcome, clip_count, error_code, summary, status, clip_plan, verified_clip_plan,
  verified_counts, verified_review_search, reason_code, received_at`;

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
  return run(deps.pool, (tx) =>
    submitCandidateInTransaction(tx, deps.config, body),
  );
}

async function submitCandidateInTransaction(
  tx: Tx,
  config: AcceptanceConfig,
  body: CandidateBody,
): Promise<ResultAck> {
  const jobId = uuid(body.jobId, "jobId");
  const nonce = nonceOf(body.invocationNonce);
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
    [jobId, config.graceSeconds],
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
}

// ------------------------------------------------------------ parallel recipes

/** The draft is a completed, immutable hand-pose output. Its final bytes are
 * deterministic because the controller joins only terminal stage rows. */
async function publishPreparedManifest(
  deps: AcceptanceDeps,
  transport: TransportDeps,
  jobId: string,
  owner: string,
): Promise<void> {
  const draft = (
    await deps.pool.query<{
      id: string;
      object_key: string;
      sha256: string;
      size_bytes: string;
      slot: string;
      nonce: string;
      recipe_sha256: string;
      stage_state: string;
      clip_task: boolean;
    }>(
      `SELECT f.id, f.object_key, f.sha256, f.size_bytes::text, s.slot,
              job_seal_nonce(j.id) AS nonce, j.recipe_sha256, r.state AS stage_state,
              i.task_input -> 'schemaVersion' = '4'::jsonb AS clip_task
       FROM jobs j
       JOIN job_inputs i ON i.job_id = j.id
       JOIN job_stage_runs r ON r.job_id = j.id AND r.stage = 'hand_pose' AND r.state IN ('succeeded', 'failed')
       JOIN job_output_slots s ON s.job_id = j.id AND s.slot = $3
       JOIN files f ON f.id = s.file_id AND f.state = 'completed' AND f.role = 'diagnostic_blob'
       WHERE j.id = $1 AND j.recipe_parallel AND j.state = 'running'
         AND j.controller_lease_owner = $2 AND j.controller_lease_expires_at > now()
         AND job_recipe_stages_settled(j.id)`,
      [jobId, owner, PREPARED_RECIPE_SLOT],
    )
  ).rows[0];
  let finalBytes: Buffer | undefined;
  if (draft && Number(draft.size_bytes) <= MANIFEST_MAX_BYTES) {
    const bytes = await deps.reader.read(draft.object_key, MANIFEST_MAX_BYTES);
    if (
      bytes.length !== Number(draft.size_bytes) ||
      sha256Hex(bytes) !== draft.sha256
    )
      return;
    finalBytes =
      draft.stage_state === "failed"
        ? validateBytes(MANIFEST_CONTRACT, bytes).valid
          ? Buffer.from(bytes)
          : undefined
        : await composePreparedManifest(deps, jobId, draft, bytes);
  } else {
    finalBytes = await composeReusedHandManifest(deps, jobId, owner);
  }
  if (!finalBytes) return;

  const authority = { kind: "job" as const, jobId, sealLeaseOwner: owner };
  const plan = await allocateJobOutput(transport, authority, {
    slot: RESULT_MANIFEST_SLOT,
    role: "result_manifest",
    sizeBytes: String(finalBytes.length),
    sha256: sha256Hex(finalBytes),
  });
  if (plan.state === "completed") return;
  const epoch = { expectedTransportEpoch: plan.transportEpoch };
  if (plan.state === "uploading") {
    const {
      parts: [part],
    } = await signParts(transport, authority, plan.fileId, {
      ...epoch,
      partNumbers: [1],
    });
    const uploaded = await fetch(part!.url, {
      method: "PUT",
      headers: part!.headers,
      body: finalBytes,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    }).catch(() => undefined);
    if (!uploaded?.ok)
      throw new TransportError(
        "provider_unavailable",
        "Manifest upload unavailable",
      );
  }
  const complete = await completeTransport(
    transport,
    authority,
    plan.fileId,
    epoch,
  );
  if (complete.state !== "completed")
    throw new TransportError(
      "provider_unavailable",
      "Manifest upload is awaiting completion",
    );
}

async function composePreparedManifest(
  deps: AcceptanceDeps,
  jobId: string,
  draft: {
    id: string;
    slot: string;
    size_bytes: string;
    sha256: string;
    nonce: string;
    recipe_sha256: string;
    clip_task: boolean;
  },
  bytes: Uint8Array,
): Promise<Buffer | undefined> {
  let prepared: Record<string, unknown>;
  try {
    prepared = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    return;
  }
  if (
    !prepared ||
    prepared.job_id !== jobId ||
    prepared.recipe_sha256 !== draft.recipe_sha256 ||
    (prepared.attestation as { invocation_nonce?: unknown } | undefined)
      ?.invocation_nonce !== draft.nonce ||
    !Array.isArray(prepared.outputs) ||
    !Array.isArray(prepared.nodes) ||
    prepared.nodes.length !== 1 ||
    prepared.nodes[0]?.stage !== "hand_pose" ||
    !Array.isArray(prepared.nodes[0]?.outputs) ||
    !Array.isArray(prepared.checks)
  )
    return;
  const [recipe, prior] = await Promise.all([
    getJobRecipe(deps, jobId),
    getPriorStages(deps, jobId),
  ]);
  const upstream = prior.stages.flatMap((row) =>
    row.outputs.map((f) => ({
      file_id: f.fileId,
      role: f.role,
      relative_path: f.slot,
      size_bytes: f.sizeBytes,
      sha256: f.sha256,
    })),
  );
  const output = {
    file_id: draft.id,
    role: "diagnostic_blob",
    relative_path: draft.slot,
    size_bytes: draft.size_bytes,
    sha256: draft.sha256,
  };
  const hand = prepared.nodes[0];
  const manifest = {
    ...prepared,
    outputs: [...upstream, ...prepared.outputs, output],
    nodes: [
      ...prior.stages.map((row) => ({
        stage: row.stage,
        status: row.state === "cancelled" ? "failed" : row.state,
        module: recipe.stages.find((s) => s.stage === row.stage)!.module,
        error_code: row.errorCode,
        counts: row.counts,
        outputs: row.outputs.map((f) => f.fileId),
      })),
      { ...hand, outputs: [...hand.outputs, draft.id] },
    ],
    checks: [
      ...prepared.checks,
      {
        code: "annotation_files_consistent",
        status: "not_evaluated",
        message: "Acceptance verifies the completed annotation files.",
        rule_revision: "sa31-export-2",
      },
    ],
  };
  const finalBytes = Buffer.from(JSON.stringify(manifest));
  return validateBytes(recipeManifestContract(draft.clip_task), finalBytes)
    .valid
    ? finalBytes
    : undefined;
}

type HandOrigin = { job_id: string; manifest_sha256: string };

async function composeReusedHandManifest(
  deps: AcceptanceDeps,
  jobId: string,
  owner: string,
): Promise<Buffer | undefined> {
  const {
    rows: [source],
  } = await deps.pool.query<{
    parent_job_id: string;
    original_job_id: string;
    original_sha256: string;
    object_key: string;
    sha256: string;
    size_bytes: string;
    nonce: string | null;
    recipe_sha256: string;
    clip_task: boolean;
  }>(
    `SELECT p.id AS parent_job_id, r.execution_job_id AS original_job_id,
            o.result_manifest_sha256 AS original_sha256,
            f.object_key, f.sha256, f.size_bytes::text, job_seal_nonce(j.id) AS nonce, j.recipe_sha256,
            j.kind = 'clip_pipeline' AS clip_task
     FROM jobs j
     JOIN job_stage_reuse r ON r.job_id = j.id AND r.stage = 'hand_pose' AND r.state = 'succeeded'
     JOIN jobs p ON p.id = r.source_job_id AND p.state = 'succeeded'
       AND p.kind = j.kind AND p.clip_id IS NOT DISTINCT FROM j.clip_id
     JOIN jobs o ON o.id = r.execution_job_id AND o.state = 'succeeded'
       AND o.kind = j.kind AND o.clip_id IS NOT DISTINCT FROM j.clip_id
     JOIN files f ON f.id = p.result_manifest_file_id AND f.job_id = p.id AND f.state = 'verified'
     WHERE j.id = $1 AND j.recipe_parallel AND j.state = 'running'
       AND j.controller_lease_owner = $2 AND j.controller_lease_expires_at > now()
       AND job_recipe_stages_settled(j.id)`,
    [jobId, owner],
  );
  if (!source?.nonce || !source.original_sha256) return;
  const bytes = await deps.reader.read(source.object_key, MANIFEST_MAX_BYTES);
  if (
    bytes.length !== Number(source.size_bytes) ||
    sha256Hex(bytes) !== source.sha256
  )
    return;
  const contract = reusedHandManifestContract(source.clip_task);
  const parsedReuse = validateBytes(contract, bytes);
  const parsed = parsedReuse.valid
    ? parsedReuse
    : validateBytes(recipeManifestContract(source.clip_task), bytes);
  if (!parsed.valid) return;
  const parent = parsed.value as {
    job_id: string;
    attestation: Record<string, unknown>;
    clips: { clip_id: string; files: Record<string, string> }[];
    nodes: Record<string, unknown>[];
    reused_hand?: HandOrigin & {
      clips: { clip_id: string; original_clip_id: string }[];
    };
  };
  if (parent.job_id !== source.parent_job_id) return;
  const [recipe, prior, copies] = await Promise.all([
    getJobRecipe(deps, jobId),
    getPriorStages(deps, jobId),
    deps.pool.query<{
      source_file_id: string;
      file_id: string;
      role: string;
      relative_path: string;
      size_bytes: string;
      sha256: string;
    }>(
      `SELECT source_file_id, file_id, role, slot AS relative_path, size_bytes::text, sha256
       FROM job_rerun_copies WHERE job_id = $1 AND stage = 'hand_pose' ORDER BY slot`,
      [jobId],
    ),
  ]);
  const files = new Map(
    copies.rows.map((row) => [row.source_file_id, row.file_id]),
  );
  const rootClips = new Map(
    parent.reused_hand?.clips.map((clip) => [
      clip.clip_id,
      clip.original_clip_id,
    ]),
  );
  const clipMap: { clip_id: string; original_clip_id: string }[] = [];
  const clips = parent.clips.map((clip) => {
    const hash = sha256Hex(Buffer.from(`${jobId}:${clip.clip_id}`));
    const childId = [
      hash.slice(0, 8),
      hash.slice(8, 12),
      "8" + hash.slice(13, 16),
      "8" + hash.slice(17, 20),
      hash.slice(20, 32),
    ].join("-");
    clipMap.push({
      clip_id: childId,
      original_clip_id: rootClips.get(clip.clip_id) ?? clip.clip_id,
    });
    return {
      ...clip,
      clip_id: childId,
      files: Object.fromEntries(
        Object.entries(clip.files).map(([role, id]) => [role, files.get(id)]),
      ),
    };
  });
  const upstream = prior.stages.flatMap((row) =>
    row.outputs.map((file) => ({
      file_id: file.fileId,
      role: file.role,
      relative_path: file.slot,
      size_bytes: file.sizeBytes,
      sha256: file.sha256,
    })),
  );
  const outputs = copies.rows.map(({ source_file_id: _id, ...file }) => file);
  const nodes = prior.stages.map((row) => ({
    stage: row.stage,
    status: row.state === "cancelled" ? "failed" : row.state,
    module: recipe.stages.find((entry) => entry.stage === row.stage)!.module,
    error_code: row.errorCode,
    counts: row.counts,
    outputs: row.outputs.map((file) => file.fileId),
  }));
  const final = {
    ...parent,
    schema: source.clip_task
      ? "stateaction.processing_result.v6"
      : "stateaction.processing_result.v4",
    job_id: jobId,
    attestation: { ...parent.attestation, invocation_nonce: source.nonce },
    recipe_id: recipe.recipeId,
    recipe_sha256: source.recipe_sha256,
    outputs: [...upstream, ...outputs],
    clips,
    nodes: [
      ...nodes,
      { ...parent.nodes[2], outputs: outputs.map((file) => file.file_id) },
    ],
    reused_hand: {
      job_id: source.original_job_id,
      manifest_sha256: source.original_sha256,
      clips: clipMap,
    },
  };
  const finalBytes = Buffer.from(JSON.stringify(final));
  const valid = validateBytes(contract, finalBytes);
  if (!valid.valid) {
    console.error(
      "[jobs] reused hand manifest validation failed",
      valid.code,
      valid.errors[0]?.path,
    );
    return;
  }
  return finalBytes;
}

/** Close and submit prepared outputs only under a lease and after all stages have settled. */
export async function sealParallelRecipe(
  deps: AcceptanceDeps,
  jobId: string,
  owner: string,
  recordedBy: string,
  transport: TransportDeps,
): Promise<boolean> {
  uuid(jobId, "jobId");
  await publishPreparedManifest(deps, transport, jobId, owner);
  const file = (
    await deps.pool.query<{
      id: string;
      object_key: string;
      sha256: string;
      size_bytes: string;
      invocation_nonce: string;
      state: string;
      error_code: string | null;
      reused: boolean;
      clip_task: boolean;
    }>(
      `SELECT f.id, f.object_key, f.sha256, f.size_bytes::text,
              job_seal_nonce(j.id) AS invocation_nonce, r.state, r.error_code, (r.source_job_id IS NOT NULL) AS reused,
              i.task_input -> 'schemaVersion' = '4'::jsonb AS clip_task
       FROM jobs j
       JOIN job_inputs i ON i.job_id = j.id
       JOIN job_effective_stage_runs r ON r.job_id = j.id AND r.stage = 'hand_pose'
       JOIN files f ON f.job_id = j.id AND f.role = 'result_manifest' AND f.state = 'completed'
       WHERE j.id = $1 AND j.recipe_parallel AND j.state = 'running'
         AND j.controller_lease_owner = $2 AND j.controller_lease_expires_at > now()
         AND job_recipe_stages_settled(j.id)`,
      [uuid(jobId, "jobId"), owner],
    )
  ).rows[0];

  let candidate: CandidateBody | undefined;
  if (file && (file.state === "succeeded" || file.state === "failed")) {
    const succeeded = file.state === "succeeded";
    const bytes = await deps.reader
      .read(file.object_key, MANIFEST_MAX_BYTES)
      .catch((error: unknown) => {
        if (error instanceof ObjectTooLargeError) return undefined;
        throw error;
      });
    const parsed =
      bytes &&
      validateBytes(
        succeeded
          ? file.reused
            ? reusedHandManifestContract(file.clip_task)
            : recipeManifestContract(file.clip_task)
          : MANIFEST_CONTRACT,
        bytes,
      );
    if (
      parsed?.valid &&
      bytes &&
      bytes.length === Number(file.size_bytes) &&
      sha256Hex(bytes) === file.sha256
    ) {
      const manifest = parsed.value as {
        clips: unknown[];
        checks: { status: string }[];
      };
      candidate = {
        jobId,
        invocationNonce: file.invocation_nonce,
        manifestFileId: file.id,
        manifestSha256: file.sha256,
        summary: {
          outcome: succeeded ? "succeeded" : "failed",
          clipCount: manifest.clips.length,
          checks: summarizeChecks(manifest.checks),
          errorCode: file.error_code,
        },
      };
    }
  }

  return run(deps.pool, async (tx) => {
    const {
      rows: [job],
    } = await tx.query<{
      state: string;
      ended: boolean;
      has_candidate: boolean;
    }>(
      `SELECT state, EXISTS (SELECT 1 FROM job_execution_evidence WHERE job_id = jobs.id) AS ended,
                     EXISTS (SELECT 1 FROM job_result_candidates WHERE job_id = jobs.id) AS has_candidate
       FROM jobs WHERE id = $1 AND recipe_parallel AND controller_lease_owner = $2
         AND controller_lease_expires_at > now() AND job_recipe_stages_settled(id)
       FOR UPDATE`,
      [jobId, owner],
    );
    if (!job) throw forbidden("Parallel recipe cannot be sealed");
    if (job.ended) return job.has_candidate;
    let sealed = false;
    if (candidate && job.state === "running") {
      const { invocationNonce, summary } = candidate;
      await tx.query("SAVEPOINT recipe_candidate");
      try {
        await closeOutputsInTransaction(tx, {
          jobId,
          invocationNonce,
          outcome: summary.outcome,
        });
        await submitCandidateInTransaction(tx, deps.config, candidate);
        sealed = true;
      } catch (error) {
        // An incomplete or refused inventory cannot produce a candidate.
        // Keep the independently proven physical outcome for grace/recovery.
        const refusal = toCatalogError(error);
        if (
          !(
            refusal instanceof TransportError &&
            ["conflict", "forbidden"].includes(refusal.code)
          ) &&
          !(
            refusal instanceof CatalogError &&
            ["SAC03", "SAC04", "SAC05"].includes(refusal.sqlstate ?? "")
          )
        )
          throw error;
        await tx.query("ROLLBACK TO SAVEPOINT recipe_candidate");
      }
      await tx.query("RELEASE SAVEPOINT recipe_candidate");
    }
    await promoteRecipeEvidence(tx, jobId, recordedBy);
    return sealed;
  });
}

// --------------------------------------------------------------- verification

type State = {
  job: {
    id: string;
    recording_id: string;
    kind: string;
    state: string;
    execution_deadline: Date;
  };
  candidate: CandidateRow | null;
  evidenceAt: Date | null;
};

async function loadState(pool: pg.Pool, jobId: string): Promise<State | null> {
  const job = await pool.query<State["job"]>(
    "SELECT id, recording_id, kind, state, execution_deadline FROM jobs WHERE id = $1",
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
  original_job_id: string | null;
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
  // A transient storage failure is retried by the next invocation only while the
  // wall holds; the wall is re-checked AFTER the failure, so the invocation in
  // which it expires reports the deterministic outcome itself. The wall is
  // enforced between steps: one in-flight read can overrun it by at most its own
  // timeout (verifyObjectTimeoutMs for objects; the reader's own bound for the
  // manifest), so this is a finite bound, not a hard 25 s limit.
  const transientOrExpired = (): Verification =>
    Date.now() > wall ? reject("verification_timeout") : { kind: "incomplete" };
  const sliceEnd = Date.now() + config.verifySliceMs;
  if (Date.now() > wall) return reject("verification_timeout");
  const files = (
    await pool.query<OutputRow>(
      `SELECT f.id, f.role, f.size_bytes::text, f.sha256, f.object_key, s.slot,
              (v.file_id IS NOT NULL) AS verified, c.original_job_id
       FROM files f
       JOIN job_output_slots s ON s.file_id = f.id AND s.job_id = f.job_id
       LEFT JOIN job_output_verifications v ON v.file_id = f.id AND v.inventory_sha256 = $2
       LEFT JOIN job_rerun_copies c ON c.job_id = f.job_id AND c.file_id = f.id AND c.sha256 = f.sha256
       WHERE f.job_id = $1 AND f.purpose = 'output' ORDER BY s.slot`,
      [st.job.id, cand.inventory_sha256],
    )
  ).rows;
  const manifest = files.find((f) => f.id === cand.manifest_file_id);
  if (!manifest) return reject("manifest_missing");
  const required =
    cand.outcome === "succeeded" ? files : files.filter((f) => f === manifest);
  const totalBytes = required.reduce((n, f) => n + Number(f.size_bytes), 0);
  const planJob = st.job.kind === "clip_plan" && cand.outcome === "succeeded";
  // Per-job budget from the closure's declared clip count, never above the
  // configured hard ceiling (SA-89).
  const maxFiles = jobOutputFileLimit(config.verifyMaxFiles, cand.clip_count);
  const maxBytes = planJob
    ? Math.min(
        config.verifyMaxBytes,
        recordingMp4MaxBytes() + MANIFEST_MAX_BYTES,
      )
    : jobOutputByteLimit(config.verifyMaxBytes, cand.clip_count);
  if (files.length > maxFiles || totalBytes > maxBytes)
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
    return transientOrExpired();
  }
  if (
    bytes.byteLength !== Number(manifest.size_bytes) ||
    sha256Hex(bytes) !== cand.manifest_sha256
  )
    return reject("manifest_hash_mismatch");
  const recipe = await recipeFacts(pool, st.job.id);
  // Successful recipe jobs seal using the contract selected at admission.
  // Failed runs still carry a diagnostics-only v2 manifest.
  const sealing = recipe !== null && cand.outcome === "succeeded";
  const handOrigin = sealing
    ? (
        await pool.query<
          HandOrigin & {
            code_revision: string;
            image_spec_sha256: string;
            model_sha256: string;
            config_sha256: string;
          }
        >(
          `SELECT j.id AS job_id, j.result_manifest_sha256 AS manifest_sha256,
            i.code_revision, i.image_spec_sha256, i.model_sha256, i.config_sha256
     FROM job_stage_reuse r JOIN jobs j ON j.id = r.execution_job_id
     JOIN job_inputs i ON i.job_id = j.id
     WHERE r.job_id = $1 AND r.stage = 'hand_pose' AND r.state = 'succeeded'`,
          [st.job.id],
        )
      ).rows[0]
    : undefined;
  const verdict = validateBytes(
    planJob
      ? "artifacts.clip-plan.v1"
      : sealing
        ? handOrigin
          ? reusedHandManifestContract(inputs.task_input.schemaVersion === 4)
          : recipeManifestContract(inputs.task_input.schemaVersion === 4)
        : MANIFEST_CONTRACT,
    bytes,
  );
  if (!verdict.valid) return reject("manifest_contract_invalid", verdict.code);

  const verifiedClipPlan = planJob ? (verdict.value as ClipPlanV1) : null;
  if (verifiedClipPlan) {
    const task = inputs.task_input as ClipPlanTaskInputV5;
    const original = files.find((f) => f.slot === "recording.mp4");
    const originalMatches =
      verifiedClipPlan.state === "succeeded"
        ? files.length === 2 &&
          original?.role === "recording_mp4" &&
          BigInt(original.size_bytes) <= BigInt(recordingMp4MaxBytes())
        : files.length === 1;
    const {
      rows: [admission],
    } = await pool.query<{
      frames: string;
      clock_domains: string[];
    }>(
      `SELECT counts ->> 'video_frames' AS frames, clock_domains
       FROM recording_admissions
       WHERE recording_id = $1 AND source_manifest_sha256 = $2 AND outcome = 'admitted'`,
      [st.job.recording_id, inputs.source_manifest_sha256],
    );
    if (
      task.schemaVersion !== 5 ||
      verifiedClipPlan.recording_id !== st.job.recording_id ||
      verifiedClipPlan.source_manifest_sha256 !==
        inputs.source_manifest_sha256 ||
      verifiedClipPlan.plan_version !== task.planVersion ||
      verifiedClipPlan.mode !== task.clipFilter.mode ||
      verifiedClipPlan.filter_version !== task.clipFilter.module ||
      verifiedClipPlan.params_sha256 !==
        requestSha256(task.clipFilter.params) ||
      verifiedClipPlan.producer.module_id !== "clip_filter" ||
      verifiedClipPlan.producer.revision !== "0" ||
      verifiedClipPlan.producer.weights_sha256 !== null ||
      verifiedClipPlan.producer.gpu_type !== null ||
      String(verifiedClipPlan.frame_count) !== admission?.frames ||
      !admission?.clock_domains.includes(verifiedClipPlan.clock_domain) ||
      cand.clip_count !== 0 ||
      Object.values(cand.summary.checks).some((n) => n !== 0) ||
      !originalMatches
    )
      return reject("clip_plan_provenance_mismatch");
  }

  if (handOrigin) {
    const origin = (verdict.value as { reused_hand: HandOrigin }).reused_hand;
    if (
      origin.job_id !== handOrigin.job_id ||
      origin.manifest_sha256 !== handOrigin.manifest_sha256
    )
      return reject("manifest_provenance_mismatch");
  }
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
  const checked = verifiedClipPlan
    ? { ok: true as const, clipPlan: [], annotations: null }
    : checkManifest(verdict.value as Record<string, unknown>, {
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
          codeRevision: handOrigin?.code_revision ?? inputs.code_revision,
          imageSpecSha256:
            handOrigin?.image_spec_sha256 ?? inputs.image_spec_sha256,
          modelSha256: handOrigin?.model_sha256 ?? inputs.model_sha256,
          configSha256: handOrigin?.config_sha256 ?? inputs.config_sha256,
          taskInput: inputs.task_input,
        },
        outputs,
        sources,
        ...(sealing ? { recipe: recipe! } : {}),
      });
  if (!checked.ok) return reject(checked.code, checked.detail);
  let counts: AnnotationCounts | null = null;
  let search: VerifiedReviewSearch | null = null;
  if (recipe && cand.outcome === "succeeded") {
    const annotated = await checkAnnotations(
      deps,
      files,
      checked.annotations!,
      {
        jobId: st.job.id,
        recordingId: st.job.recording_id,
        sourceManifestSha256: inputs.source_manifest_sha256,
      },
    );
    if (annotated.kind === "incomplete") return transientOrExpired();
    if (annotated.kind === "rejected")
      return reject(annotated.code, annotated.detail);
    counts = annotated.counts;
    search = annotated.search;
  } else if (recipe) {
    counts = {
      segmentCount: null,
      failedWindowCount: null,
      captionCount: null,
      captionFailedCount: null,
    };
  }
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
          if (error.code === "object_read_failed") return transientOrExpired();
          return reject(error.code, f.slot);
        }
        return transientOrExpired();
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
      `UPDATE job_result_candidates SET status = 'verified', clip_plan = $2, verified_checks = $3,
         verified_counts = $4::jsonb, verified_clip_plan = $5::jsonb, verified_at = now(),
         verified_review_search = $6::jsonb
       WHERE job_id = $1 AND status = 'provisional'`,
      [
        st.job.id,
        JSON.stringify(checked.clipPlan),
        JSON.stringify(
          ((verdict.value as Record<string, unknown>).checks as unknown[]) ??
            [],
        ),
        counts === null ? null : JSON.stringify(counts),
        verifiedClipPlan === null ? null : JSON.stringify(verifiedClipPlan),
        search === null ? null : JSON.stringify(search),
      ],
    );
  });
  return { kind: "verified" };
}

// ------------------------------------------------------- SA-88 recipe facts

/** The admitted recipe and recorded stage runs of a recipe job, else null. */
async function recipeFacts(
  pool: pg.Pool,
  jobId: string,
): Promise<NonNullable<ManifestFacts["recipe"]> | null> {
  const job = (
    await pool.query<{
      recipe: {
        recipeId: string;
        stages: { stage: string; enabled: boolean; module: string }[];
      } | null;
      recipe_sha256: string | null;
    }>("SELECT recipe, recipe_sha256 FROM jobs WHERE id = $1", [jobId])
  ).rows[0];
  if (!job?.recipe || !job.recipe_sha256) return null;
  // SA-91: a stage's files are every completed output of the job its slot
  // attributes to it (stageOfSlot), not only those its receipt names: a stage
  // that ended without a receipt (crash, budget) still owns what it uploaded,
  // so its node can list them and the closed inventory stays fully claimed.
  const runs = (
    await pool.query<{
      stage: string;
      state: string;
      file_ids: string[];
    }>(
      `SELECT r.stage, r.state,
              coalesce(array_agg(f.id::text ORDER BY f.id) FILTER (WHERE f.id IS NOT NULL),
                       '{}') AS file_ids
       FROM job_effective_stage_runs r
       LEFT JOIN (files f JOIN job_output_slots s ON s.file_id = f.id AND s.job_id = f.job_id)
         ON f.job_id = r.job_id AND f.purpose = 'output'
         AND f.state IN ('completed', 'verified') AND ${STAGE_SLOT_SQL}
       WHERE r.job_id = $1 GROUP BY r.stage, r.state`,
      [jobId],
    )
  ).rows;
  return {
    recipeId: job.recipe.recipeId,
    recipeSha256: job.recipe_sha256,
    modules: Object.fromEntries(
      job.recipe.stages.map((x) => [x.stage, x.module]),
    ),
    enabled: Object.fromEntries(
      job.recipe.stages.map((x) => [x.stage, x.enabled]),
    ),
    runs: Object.fromEntries(
      runs.map((r) => [
        r.stage,
        {
          state: r.state,
          stageFileIds: r.file_ids,
        },
      ]),
    ),
  };
}

type Annotated =
  | { kind: "ok"; counts: AnnotationCounts; search: VerifiedReviewSearch }
  | { kind: "incomplete" }
  | { kind: "rejected"; code: string; detail?: string };

/**
 * Bounded read and contract check of the recording-level annotation
 * documents of a succeeded v3 result: each is the exact stored bytes, a valid
 * segments.v1 / captions.v1 / hand-presence.v1 for this job, recording and
 * source; captions pin the exact segments bytes and caption only accepted
 * segments. Returns the counts acceptance stores.
 */
export async function checkAnnotations(
  deps: Pick<AcceptanceDeps, "reader">,
  files: OutputRow[],
  listed: AnnotationFiles,
  ids: { jobId: string; recordingId: string; sourceManifestSha256: string },
  source: "execution" | "imported" = "execution",
): Promise<Annotated> {
  const byId = new Map(files.map((f) => [f.id, f]));
  type Doc = Record<string, unknown>;
  const load = async (
    fileId: string | null,
    contract: string,
  ): Promise<
    | { kind: "ok"; doc: Doc | null; file: OutputRow | null }
    | Exclude<Annotated, { kind: "ok" }>
  > => {
    if (fileId === null) return { kind: "ok", doc: null, file: null };
    const file = byId.get(fileId);
    if (!file) return { kind: "rejected", code: "annotation_missing" };
    let bytes: Uint8Array;
    try {
      bytes = await deps.reader.read(file.object_key, ANNOTATION_MAX_BYTES);
    } catch (error) {
      if (error instanceof ObjectTooLargeError)
        return {
          kind: "rejected",
          code: "annotation_too_large",
          detail: file.slot,
        };
      return { kind: "incomplete" };
    }
    if (
      bytes.byteLength !== Number(file.size_bytes) ||
      sha256Hex(bytes) !== file.sha256
    )
      return {
        kind: "rejected",
        code: "output_hash_mismatch",
        detail: file.slot,
      };
    const verdict = validateBytes(contract, bytes);
    if (!verdict.valid)
      return {
        kind: "rejected",
        code: "annotation_contract_invalid",
        detail: `${file.slot}: ${verdict.code}`,
      };
    const doc = verdict.value as Doc;
    const producer = doc.producer as { module_id: string; stage: string };
    if (
      source === "imported"
        ? producer.module_id !== `imported_${producer.stage}`
        : producer.module_id.startsWith("imported_")
    ) {
      return {
        kind: "rejected",
        code: "annotation_producer_mismatch",
        detail: file.slot,
      };
    }
    if (
      doc.job_id !== (file.original_job_id ?? ids.jobId) ||
      doc.recording_id !== ids.recordingId ||
      doc.source_manifest_sha256 !== ids.sourceManifestSha256
    )
      return {
        kind: "rejected",
        code: "annotation_identity_mismatch",
        detail: file.slot,
      };
    return { kind: "ok", doc, file };
  };
  const version = source === "imported" ? "v2" : "v1";
  const seg = await load(listed.segments, `artifacts.segments.${version}`);
  if (seg.kind !== "ok") return seg;
  const cap = await load(listed.captions, `artifacts.captions.${version}`);
  if (cap.kind !== "ok") return cap;
  const hand = await load(
    listed.handPresence,
    `artifacts.hand-presence.${version}`,
  );
  if (hand.kind !== "ok") return hand;
  if (!hand.doc) return { kind: "rejected", code: "annotation_missing" };
  const rows = (d: Doc | null) =>
    (Array.isArray(d?.rows) ? d.rows : []) as Record<string, unknown>[];
  let counts: AnnotationCounts = {
    segmentCount: null,
    failedWindowCount: null,
    captionCount: null,
    captionFailedCount: null,
  };
  if (seg.doc) {
    const windows = (seg.doc.windows ?? {}) as { failed?: unknown[] };
    counts = {
      ...counts,
      segmentCount: rows(seg.doc).filter((r) => r.status === "ok").length,
      failedWindowCount: (windows.failed ?? []).length,
    };
  }
  if (cap.doc) {
    if (!seg.doc || cap.doc.segments_sha256 !== seg.file!.sha256)
      return { kind: "rejected", code: "captions_segments_mismatch" };
    const known = new Set(rows(seg.doc).map((r) => r.segment_id));
    const unknown = rows(cap.doc).find((r) => !known.has(r.segment_id));
    if (unknown)
      return {
        kind: "rejected",
        code: "caption_unknown_segment",
        detail: String(unknown.segment_id),
      };
    counts = {
      ...counts,
      captionCount: rows(cap.doc).filter((r) => r.status === "complete").length,
      captionFailedCount: rows(cap.doc).filter((r) => r.status === "failed")
        .length,
    };
  }
  const captions = new Map(
    rows(cap.doc).map((caption) => [caption.segment_id, caption]),
  );
  const lanes = hand.doc.lanes as {
    left: PresenceSpan[];
    right: PresenceSpan[];
  };
  const search: VerifiedReviewSearch = {
    segmentsSha256: seg.file?.sha256 ?? null,
    clockDomain: (seg.doc?.clock_domain as string | undefined) ?? null,
    noHandDetected: hasNoHandInterval(lanes.left, lanes.right),
    segments: rows(seg.doc)
      .filter((row) => row.status === "ok")
      .map((row) => {
        const caption = captions.get(row.segment_id);
        const derived = caption?.derived as { short_label: string } | undefined;
        return {
          segmentId: row.segment_id as string,
          startTsNs: (row.start as { timestamp_ns: string }).timestamp_ns,
          text: (caption?.text as string | undefined) ?? null,
          label: derived?.short_label ?? null,
        };
      }),
  };
  return { kind: "ok", counts, search };
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
      await tx.query<{ state: string; kind: string; clip_id: string | null }>(
        "SELECT state, kind, clip_id FROM jobs WHERE id = $1 FOR UPDATE",
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
      `SELECT job_is_current($1) AS pointer, r.deleted_at IS NULL AS live, r.status = 'processing' AS processing,
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
    // Recipe jobs store the verified annotation counts with the success (the
    // database requires them to equal the candidate's verified counts).
    const n = cand.verified_counts;
    await tx.query(
      `UPDATE jobs SET state = 'succeeded', result_manifest_file_id = $2, result_manifest_sha256 = $3,
         segment_count = $4, failed_window_count = $5, caption_count = $6, caption_failed_count = $7,
         finished_at = now() WHERE id = $1`,
      [
        jobId,
        cand.manifest_file_id,
        cand.manifest_sha256,
        n?.segmentCount ?? null,
        n?.failedWindowCount ?? null,
        n?.captionCount ?? null,
        n?.captionFailedCount ?? null,
      ],
    );
    await tx.query(
      "UPDATE job_result_candidates SET status = 'accepted', decided_at = now(), verified_review_search = NULL WHERE job_id = $1",
      [jobId],
    );
    if (cand.verified_review_search)
      await indexAcceptedReviewAnnotations(
        tx,
        jobId,
        cand.manifest_sha256,
        cand.verified_review_search,
      );
    if (job.kind === "clip_plan") {
      const plan = cand.verified_clip_plan!;
      // The admitted passthrough filter allows exactly one whole-source span.
      const span = plan.spans[0]!;
      await tx.query(
        `INSERT INTO clip_plans (recording_id, version, plan_job_id, manifest_sha256,
                                original_mp4_file_id, original_mp4_sha256, frame_count, plan)
         SELECT j.recording_id, $2, j.id, j.result_manifest_sha256, f.id, f.sha256, $3, $4
         FROM jobs j LEFT JOIN job_output_slots s ON s.job_id = j.id AND s.slot = 'recording.mp4'
         LEFT JOIN files f ON f.id = s.file_id AND f.job_id = j.id AND f.role = 'recording_mp4'
         WHERE j.id = $1`,
        [jobId, plan.plan_version, plan.frame_count, JSON.stringify(plan)],
      );
      await tx.query(
        `INSERT INTO review_clips (id, recording_id, plan_version, ordinal, start_ordinal, end_ordinal,
                                   first_source_frame_id, last_source_frame_id, start_ts_ns, end_ts_ns)
         VALUES ($1,$1,$2,0,$3,$4,$5,$6,$7,$8)`,
        [
          recordingId,
          plan.plan_version,
          span.start_ordinal,
          span.end_ordinal,
          span.first_source_frame_id,
          span.last_source_frame_id,
          span.start_ts_ns,
          span.end_ts_ns,
        ],
      );
      const clipJobId = randomUUID();
      await tx.query(
        `INSERT INTO jobs (id, kind, recording_id, source_manifest_sha256, profile_revision, clip_id)
         SELECT $2, 'clip_pipeline', recording_id, source_manifest_sha256, profile_revision, recording_id
         FROM jobs WHERE id = $1`,
        [jobId, clipJobId],
      );
      await tx.query("UPDATE review_clips SET live_job_id = $2 WHERE id = $1", [
        recordingId,
        clipJobId,
      ]);
      return "accepted";
    }
    if (job.kind === "clip_pipeline") {
      await tx.query(
        `INSERT INTO clip_result_selections (clip_id, seq, job_id, reason, kind)
         SELECT c.id, 1 + coalesce(max(s.seq), 0), $1, 'Accepted result', 'auto'
         FROM review_clips c LEFT JOIN clip_result_selections s ON s.clip_id = c.id
         WHERE c.id = $2 GROUP BY c.id`,
        [jobId, job.clip_id],
      );
      await tx.query(
        `UPDATE recordings r SET status = 'reviewable' WHERE r.id = $1 AND NOT EXISTS (
           SELECT 1 FROM review_clips c LEFT JOIN jobs j ON j.id = c.live_job_id
           WHERE c.recording_id = r.id AND j.state IS DISTINCT FROM 'succeeded'
         )`,
        [recordingId],
      );
      return "accepted";
    }
    await tx.query(
      "UPDATE recordings SET status = 'reviewable' WHERE id = $1 AND current_job_id = $2",
      [recordingId, jobId],
    );
    await tx.query(
      `INSERT INTO recording_result_selections (recording_id, seq, job_id, reason, kind)
       SELECT j.recording_id, coalesce(s.seq, 0) + 1, j.id, 'Accepted result', 'auto'
       FROM jobs j
       LEFT JOIN job_rerun_plans p ON p.job_id = j.id
       LEFT JOIN LATERAL (
         SELECT seq, job_id FROM recording_result_selections
         WHERE recording_id = j.recording_id ORDER BY seq DESC LIMIT 1
       ) s ON true
       LEFT JOIN jobs old ON old.id = s.job_id
       WHERE j.id = $1 AND (j.derived_from_job_id IS NULL OR (
         (p.plan ->> 'selectionSeq')::integer = coalesce(s.seq, 0)
         AND NOT EXISTS (
           SELECT 1 FROM job_effective_stage_runs child
           WHERE child.job_id = j.id AND child.state IN ('failed', 'cancelled')
             AND NOT EXISTS (
               SELECT 1 FROM job_effective_stage_runs previous
               WHERE previous.job_id = coalesce(old.id, j.derived_from_job_id)
                 AND previous.stage = child.stage AND previous.state IN ('failed', 'cancelled')
             )
         )
         AND (old.id IS NULL OR (
           NOT EXISTS (
             SELECT 1 FROM job_effective_stage_runs a
             WHERE a.job_id = old.id AND a.state = 'succeeded'
               AND NOT EXISTS (
                 SELECT 1 FROM job_effective_stage_runs b
                 WHERE b.job_id = j.id AND b.stage = a.stage AND b.state = 'succeeded'
               )
           )
           AND coalesce(j.failed_window_count, 0) <= coalesce(old.failed_window_count, 0)
           AND coalesce(j.caption_failed_count, 0) <= coalesce(old.caption_failed_count, 0)
         ))
       ))`,
      [jobId],
    );
    return "accepted";
  });
}

/**
 * Evidence recorded but the worker never reported: fail after the finite grace.
 * A needs_attention job (flagged while the controller was lost, evidence
 * arriving later) is settled as soon as authoritative evidence exists: the
 * state itself has already closed reporting (candidates are recorded only
 * while 'running' and accepted from 'result_pending'), so no grace applies.
 * An existing candidate is always preserved and wins. Without evidence nothing
 * is settled and the slot stays held.
 */
async function settleMissingResult(
  deps: Pick<AcceptanceDeps, "pool" | "config">,
  st: State,
): Promise<void> {
  const lateProof = st.job.state === "needs_attention";
  if (
    (st.job.state !== "running" && !lateProof) ||
    !st.evidenceAt ||
    st.candidate
  )
    return;
  const graceEnd = st.evidenceAt.getTime() + deps.config.graceSeconds * 1000;
  if (
    !lateProof &&
    Date.now() < graceEnd &&
    Date.now() < st.job.execution_deadline.getTime()
  )
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
    // Recheck state, candidate and evidence under the recording -> job locks.
    const proof = await tx.query(
      "SELECT 1 FROM job_execution_evidence WHERE job_id = $1",
      [st.job.id],
    );
    const now = job.rows[0]?.state;
    if (
      (now !== "running" && !(lateProof && now === "needs_attention")) ||
      cand.rows[0] ||
      !proof.rows[0]
    )
      return;
    await tx.query(
      `UPDATE jobs SET state = 'failed', error_code = 'worker_exited_without_result',
         error_message = 'The physical execution ended without reporting a result', finished_at = now()
       WHERE id = $1 AND state = $2`,
      [st.job.id, now],
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
        OR (j.state IN ('running', 'needs_attention')
            AND EXISTS (SELECT 1 FROM job_execution_evidence e WHERE e.job_id = j.id)
            AND NOT EXISTS (SELECT 1 FROM job_result_candidates c WHERE c.job_id = j.id))
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
