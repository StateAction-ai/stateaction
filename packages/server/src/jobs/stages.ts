import { randomBytes } from "node:crypto";
import type pg from "pg";
import {
  requestSha256,
  validateValue,
  type DagRunNode,
  type DagRunV1,
  type RecipeV1,
  type Stage,
  type StageReceiptV1,
  type StageRunState,
} from "@stateaction/contracts";
import { inTransaction } from "../catalog/catalog.js";
import { CatalogError } from "../catalog/errors.js";
import { hashServiceToken } from "../auth/service.js";
import { TransportError } from "../transport/errors.js";
import { JOB_CURRENT_SQL } from "./current.js";
import {
  executorRefId,
  parseExecutor,
  type ClaimGrant,
  type ExecutorRef,
  type JobsDeps,
} from "./service.js";

/**
 * SA-88 recipe stage runs and per-stage claims. The database owns every
 * invariant (011 triggers) and the restricted role writes the stage tables
 * only through the SECURITY DEFINER functions called here; this module adds
 * the contract checks, token minting and signed URLs.
 */

type Tx = pg.PoolClient;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NONCE = /^[A-Za-z0-9_-]{43}$/;
const OWNER = /^[A-Za-z0-9._:-]{1,200}$/;
export const STAGES: readonly Stage[] = ["segment", "caption", "hand_pose"];

const invalid = (m: string) => new TransportError("invalid_request", m);
const forbidden = (m = "Not permitted") => new TransportError("forbidden", m);
const iso = (d: Date) => d.toISOString();

function uuid(value: string, field: string): string {
  if (!UUID.test(value)) throw invalid(`${field} must be a UUID`);
  return value;
}
function pattern(value: unknown, re: RegExp, field: string): string {
  if (typeof value !== "string" || !re.test(value))
    throw invalid(`${field} is malformed`);
  return value;
}
function stageOf(value: unknown): Stage {
  if (!STAGES.includes(value as Stage)) throw invalid("stage is malformed");
  return value as Stage;
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

/**
 * Credential identity of a stage capability (bootstrap or running). The
 * route principal carries it so a handler knows which stage is calling.
 */
export const stageCredentialId = (jobId: string, stage: Stage) =>
  `stage:${stage}:${jobId}`;
export function stageOfCredential(credentialId: string): Stage | null {
  const m = /^stage:(segment|caption|hand_pose):/.exec(credentialId);
  return m ? (m[1] as Stage) : null;
}

/** The v2 projection of an admitted v3 task input (controller-result.v1 shape). */
export function taskInputV2Projection(
  task: Record<string, unknown>,
): Record<string, unknown> {
  if (task.schemaVersion !== 3) return task;
  const { recipe: _recipe, recipeSha256: _sha, ...rest } = task;
  return { ...rest, schemaVersion: 2 };
}

/** A leased controller selects the graph before any stage claim is issued. */
export async function startParallelRecipe(
  pool: pg.Pool,
  jobId: string,
  owner: string,
): Promise<boolean> {
  return run(pool, async (tx) => {
    const { rows } = await tx.query<{ enabled: boolean }>(
      "SELECT job_start_parallel_recipe($1, $2) AS enabled",
      [uuid(jobId, "jobId"), pattern(owner, OWNER, "owner")],
    );
    return rows[0]!.enabled;
  });
}

// ------------------------------------------------------------- stage claims

export type StageClaimIssue =
  | {
      state: "recorded";
      /** Private bootstrap capability of this stage: pass once, never persist. */
      bootstrapToken: string;
      startDeadline: Date;
      executionDeadline: Date;
      taskInput: Record<string, unknown>;
      executionBackend: "local" | "modal";
    }
  /** The stage claim already exists: the controller MUST NOT spawn again. */
  | { state: "already_recorded" };

/**
 * Issues the single-use claim of one recipe stage (controller, lease-fenced).
 * Stages are issued in recipe order once every earlier enabled stage has a
 * terminal run. The first issued stage also records the job's submission
 * intent. A second call never yields another token.
 */
export async function issueStageClaim(
  deps: Pick<JobsDeps, "pool" | "config">,
  input: { jobId: string; owner: string; stage: Stage },
): Promise<StageClaimIssue> {
  const jobId = uuid(input.jobId, "jobId");
  const owner = pattern(input.owner, OWNER, "owner");
  const stage = stageOf(input.stage);
  const token = `sa_svc_${randomBytes(32).toString("base64url")}`;
  return run(deps.pool, async (tx) => {
    const { rows } = await tx.query<{
      outcome: "issued" | "already_issued";
      start_deadline: Date | null;
      execution_deadline: Date;
      execution_backend: "local" | "modal";
    }>("SELECT * FROM job_stage_issue_claim($1, $2, $3, $4, $5)", [
      jobId,
      owner,
      stage,
      hashServiceToken(token),
      deps.config.startDeadlineSeconds,
    ]);
    const r = rows[0]!;
    if (r.outcome === "already_issued")
      return { state: "already_recorded" } as const;
    const task = await tx.query<{ task_input: Record<string, unknown> }>(
      "SELECT task_input FROM job_inputs WHERE job_id = $1",
      [jobId],
    );
    return {
      state: "recorded",
      bootstrapToken: token,
      startDeadline: r.start_deadline!,
      executionDeadline: r.execution_deadline,
      taskInput: taskInputV2Projection(task.rows[0]!.task_input),
      executionBackend: r.execution_backend,
    } as const;
  });
}

type InputRow = {
  id: string;
  role: string;
  size_bytes: string;
  sha256: string;
  object_key: string;
};

async function sign(
  deps: Pick<JobsDeps, "config" | "presignRead">,
  rows: InputRow[],
  executionDeadline: Date,
  now: Date,
) {
  const horizonMs = Math.min(
    deps.config.readUrlSeconds * 1000,
    executionDeadline.getTime() - now.getTime(),
  );
  if (horizonMs < 1000) throw forbidden("Job deadline has passed");
  const expires = new Date(now.getTime() + horizonMs);
  return Promise.all(
    rows.map(async (f) => ({
      fileId: f.id,
      role: f.role,
      sizeBytes: f.size_bytes,
      sha256: f.sha256,
      readUrl: await deps.presignRead(
        f.object_key,
        Math.floor(horizonMs / 1000),
      ),
      expiresAt: iso(expires),
    })),
  );
}

/**
 * The only way a stage worker obtains its running capability and signed
 * source URLs (the caller authenticated the stage bootstrap capability).
 * One transaction: the definer function rechecks everything live and writes
 * nonce, call ID and capability once (a replayed token or a second claim of
 * the stage fails first); the grant is built inside the same transaction, so a
 * grant that cannot be built rolls the claim back. The grant is the unchanged
 * jobs.claim-grant.v1.
 */
export async function claimStage(
  deps: JobsDeps,
  input: {
    jobId: string;
    bootstrapToken: string;
    invocationNonce: string;
    executor: ExecutorRef;
  },
): Promise<ClaimGrant> {
  const jobId = uuid(input.jobId, "jobId");
  const nonce = pattern(input.invocationNonce, NONCE, "invocationNonce");
  const executor = parseExecutor(input.executor);
  const capability = `sa_svc_${randomBytes(32).toString("base64url")}`;
  return run(deps.pool, async (tx) => {
    const { rows } = await tx.query<{
      stage: Stage;
      start_deadline: Date;
      execution_deadline: Date;
      recording_id: string;
      source_manifest_sha256: string;
    }>("SELECT * FROM job_stage_take_claim($1, $2, $3, $4, $5, $6)", [
      jobId,
      hashServiceToken(input.bootstrapToken),
      nonce,
      executor.kind,
      executorRefId(executor),
      hashServiceToken(capability),
    ]);
    const won = rows[0]!;
    const now = (await tx.query<{ now: Date }>("SELECT now() AS now")).rows[0]!
      .now;
    const cfg = (
      await tx.query<{
        code_revision: string;
        image_spec_sha256: string;
        model_sha256: string;
        config_sha256: string;
        max_output_files: number;
        max_output_bytes: string;
        max_control_document_bytes: number;
      }>(
        `SELECT code_revision, image_spec_sha256, model_sha256, config_sha256, max_output_files,
           max_output_bytes::text, max_control_document_bytes FROM job_inputs WHERE job_id = $1`,
        [jobId],
      )
    ).rows[0];
    if (!cfg)
      throw new TransportError("conflict", "Job has no persisted inputs");
    const files = (
      await tx.query<InputRow>(
        `SELECT id, role, size_bytes::text, sha256, object_key FROM files
         WHERE recording_id = $1 AND purpose = 'source' AND state IN ('completed', 'verified')
         ORDER BY id`,
        [won.recording_id],
      )
    ).rows;
    const grant = {
      schemaVersion: 1,
      jobId,
      invocationNonce: nonce,
      kind: "process_recording",
      startDeadline: iso(won.start_deadline),
      executionDeadline: iso(won.execution_deadline),
      digests: {
        sourceManifestSha256: won.source_manifest_sha256,
        codeRevision: cfg.code_revision,
        imageSpecSha256: cfg.image_spec_sha256,
        modelSha256: cfg.model_sha256,
        configSha256: cfg.config_sha256,
      },
      limits: {
        maxOutputFiles: cfg.max_output_files,
        maxOutputBytes: cfg.max_output_bytes,
        maxControlDocumentBytes: cfg.max_control_document_bytes,
      },
      inputs: await sign(deps, files, won.execution_deadline, now),
      capability: {
        token: capability,
        expiresAt: iso(won.execution_deadline),
      },
    };
    const valid = validateValue("jobs.claim-grant.v1", grant);
    if (!valid.valid)
      throw new TransportError(
        "conflict",
        `claim grant invalid: ${valid.code}`,
      );
    return grant;
  });
}

/** heartbeat.v2: progress of one claimed, unfinished stage; never extends deadlines. */
export async function recordStageHeartbeat(
  deps: Pick<JobsDeps, "pool">,
  input: {
    jobId: string;
    stage: Stage;
    invocationNonce: string;
    phase: string;
    processedFrames?: string | undefined;
    totalFrames?: string | null | undefined;
  },
): Promise<{ accepted: true; executionDeadline: Date }> {
  const jobId = uuid(input.jobId, "jobId");
  const nonce = pattern(input.invocationNonce, NONCE, "invocationNonce");
  // heartbeat.v2 rule heartbeat_stage (also a database CHECK).
  if (
    (input.phase === "segmenting" && input.stage !== "segment") ||
    (input.phase === "captioning" && input.stage !== "caption")
  )
    throw invalid("phase is not valid for this stage");
  const { rows } = await deps.pool.query<{ deadline: Date | null }>(
    "SELECT job_stage_heartbeat($1, $2, $3, $4, $5::bigint, $6::bigint) AS deadline",
    [
      jobId,
      stageOf(input.stage),
      nonce,
      input.phase,
      input.processedFrames ?? null,
      input.totalFrames ?? null,
    ],
  );
  if (!rows[0]?.deadline) throw forbidden("Stage is not current");
  return { accepted: true, executionDeadline: rows[0].deadline };
}

// --------------------------------------------------------------- stage runs

export type StageRunInput = {
  jobId: string;
  owner: string;
  stage: Stage;
  state: StageRunState;
  module: string;
  callId?: string | undefined;
  errorCode?: string | undefined;
  receipt?: StageReceiptV1 | undefined;
};

/**
 * Records one stage run state (controller, lease-fenced): forward-only, call
 * ID and receipt write-once, enforced by the database. The receipt must be a
 * valid jobs.stage-receipt.v1 for this job; its digest is the sa-cjson-v1
 * digest. An identical replay reports `recorded: false`.
 */
export async function recordStageRun(
  deps: Pick<JobsDeps, "pool">,
  input: StageRunInput,
): Promise<{ recorded: boolean }> {
  const jobId = uuid(input.jobId, "jobId");
  const owner = pattern(input.owner, OWNER, "owner");
  const stage = stageOf(input.stage);
  let receiptSha: string | null = null;
  if (input.receipt !== undefined) {
    const valid = validateValue("jobs.stage-receipt.v1", input.receipt);
    if (!valid.valid) throw invalid(`stage receipt rejected: ${valid.code}`);
    if (input.receipt.jobId !== jobId)
      throw invalid("stage receipt names another job");
    receiptSha = requestSha256(input.receipt);
  }
  return run(deps.pool, async (tx) => {
    const { rows } = await tx.query<{ recorded: boolean }>(
      "SELECT job_stage_record_run($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9) AS recorded",
      [
        jobId,
        owner,
        stage,
        input.state,
        input.module,
        input.callId ?? null,
        input.errorCode ?? null,
        input.receipt === undefined ? null : JSON.stringify(input.receipt),
        receiptSha,
      ],
    );
    return { recorded: rows[0]!.recorded };
  });
}

// ------------------------------------------------ stage-scoped output read

/**
 * Fresh signed read URL for the segments document the caption stage
 * captions: only a completed (or verified) segments_json output of the SAME
 * current job, and only for the claimed, unfinished caption stage. Reuses the
 * input-read signing horizon (never past the execution deadline).
 */
export async function readStageOutput(
  deps: Pick<JobsDeps, "pool" | "config" | "presignRead">,
  input: { jobId: string; fileId: string; stage: Stage | null },
): Promise<{ fileId: string; readUrl: string; expiresAt: string }> {
  const jobId = uuid(input.jobId, "jobId");
  const fileId = uuid(input.fileId, "fileId");
  if (input.stage !== "caption")
    throw forbidden("Only the caption stage reads job outputs");
  const current = await deps.pool.query<{ execution_deadline: Date }>(
    `SELECT c.execution_deadline FROM (${JOB_CURRENT_SQL}) c
     WHERE EXISTS (SELECT 1 FROM job_stage_claims s WHERE s.job_id = c.id AND s.stage = 'caption'
                     AND s.claimed_at IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM job_stage_runs r WHERE r.job_id = c.id AND r.stage = 'caption'
                         AND job_stage_terminal(r.state))`,
    [jobId, null],
  );
  if (!current.rows[0]) throw forbidden("Stage is not current");
  const { rows } = await deps.pool.query<InputRow>(
    `SELECT id, role, size_bytes::text, sha256, object_key FROM files
     WHERE id = $1 AND job_id = $2 AND purpose = 'output' AND role = 'segments_json'
       AND state IN ('completed', 'verified')`,
    [fileId, jobId],
  );
  if (!rows[0]) throw new TransportError("not_found", "Output not found");
  const [signed] = await sign(
    deps,
    rows,
    current.rows[0].execution_deadline,
    new Date(),
  );
  return { fileId, readUrl: signed!.readUrl, expiresAt: signed!.expiresAt };
}

// ------------------------------------------------------- SA-91 stage files

/**
 * The recipe stage a job output slot belongs to (011 slot policy): segments.json
 * and diagnostics/segment/* to segment, captions.json and diagnostics/caption/*
 * to caption, everything else (clips, recording.mp4, hand-presence.json, the
 * manifest, diagnostics/hand_pose/*) to the sealing hand_pose stage. SQL over
 * the aliases `s` (job_output_slots) and `r` (job_stage_runs).
 */
export const STAGE_SLOT_SQL = `(CASE WHEN s.slot = 'segments.json' THEN 'segment'
  WHEN s.slot = 'captions.json' THEN 'caption'
  WHEN s.slot LIKE 'diagnostics/%' THEN split_part(s.slot, '/', 2)
  ELSE 'hand_pose' END) = r.stage`;

export type PriorStageRow = {
  stage: "segment" | "caption";
  state: StageRunState;
  errorCode: string | null;
  counts: Record<string, number>;
  outputs: {
    fileId: string;
    role: string;
    slot: string;
    sizeBytes: string;
    sha256: string;
  }[];
};

/**
 * SA-91 controller read (jobs.prior-stages.v1): the recorded runs of segment and
 * caption, each with every completed output file its slot attributes to it.
 * The controller hands these rows to the sealing hand_pose stage (priorStages)
 * and the caption stage its segments input. A stage with no recorded run is
 * absent. not_found for a job without a recipe.
 */
export async function getPriorStages(
  deps: Pick<JobsDeps, "pool">,
  jobId: string,
): Promise<{ schemaVersion: 1; jobId: string; stages: PriorStageRow[] }> {
  uuid(jobId, "jobId");
  await getJobRecipe(deps, jobId);
  const { rows } = await deps.pool.query<{
    stage: "segment" | "caption";
    state: StageRunState;
    error_code: string | null;
    counts: Record<string, number>;
    outputs: PriorStageRow["outputs"];
  }>(
    `SELECT r.stage, r.state, r.error_code, r.counts,
            coalesce(jsonb_agg(jsonb_build_object('fileId', f.id::text, 'role', f.role,
                       'slot', s.slot, 'sizeBytes', f.size_bytes::text, 'sha256', f.sha256)
                     ORDER BY s.slot) FILTER (WHERE f.id IS NOT NULL), '[]'::jsonb) AS outputs
     FROM job_stage_runs r
     LEFT JOIN (files f JOIN job_output_slots s ON s.file_id = f.id AND s.job_id = f.job_id)
       ON f.job_id = r.job_id AND f.purpose = 'output'
       AND f.state IN ('completed', 'verified') AND ${STAGE_SLOT_SQL}
     WHERE r.job_id = $1 AND r.stage IN ('segment', 'caption')
     GROUP BY r.stage, r.state, r.error_code, r.counts
     ORDER BY job_stage_ord(r.stage)`,
    [jobId],
  );
  return {
    schemaVersion: 1,
    jobId,
    stages: rows.map((r) => ({
      stage: r.stage,
      state: r.state,
      errorCode: r.error_code,
      counts: r.counts ?? {},
      outputs: r.outputs,
    })),
  };
}

// ------------------------------------------------------------------ dag-run

/** SA-91: the admitted recipe of a job (controller read); not_found for a job without one. */
export async function getJobRecipe(
  deps: Pick<JobsDeps, "pool">,
  jobId: string,
): Promise<RecipeV1> {
  uuid(jobId, "jobId");
  const { rows } = await deps.pool.query<{ recipe: RecipeV1 | null }>(
    "SELECT recipe FROM jobs WHERE id = $1",
    [jobId],
  );
  if (!rows[0]?.recipe)
    throw new TransportError("not_found", "Job has no recipe");
  return rows[0].recipe;
}

type RunRow = {
  stage: Stage;
  state: StageRunState;
  module: string;
  call_id: string | null;
  requested_gpu: string;
  observed_gpu: string | null;
  error_code: string | null;
  counts: Record<string, number>;
  receipt_sha256: string | null;
  cost_estimate_usd: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  running_at: Date | null;
  terminal_at: Date | null;
};

const TERMINAL_JOB = new Set(["succeeded", "failed", "cancelled"]);

/**
 * http.dag-run.v1 rendered from job_stage_runs plus the admitted recipe. Every
 * recipe stage appears in order. A stage with no recorded run is `not_run`
 * with a reason when it can no longer run (disabled: stage_disabled; job
 * ended: not_spawned) and `pending` while the job may still reach it. Times
 * are the worker-reported receipt times, else the server-observed ones.
 * Costs are null (unknown) until a stage records an estimate.
 */
export async function getDagRun(
  deps: Pick<JobsDeps, "pool">,
  jobId: string,
): Promise<DagRunV1> {
  uuid(jobId, "jobId");
  const job = (
    await deps.pool.query<{
      id: string;
      recording_id: string;
      state: string;
      recipe: RecipeV1 | null;
      recipe_sha256: string | null;
      now: Date;
    }>(
      "SELECT id, recording_id, state, recipe, recipe_sha256, now() AS now FROM jobs WHERE id = $1",
      [jobId],
    )
  ).rows[0];
  if (!job?.recipe || !job.recipe_sha256)
    throw new TransportError("not_found", "Job has no recipe run");
  const runs = new Map(
    (
      await deps.pool.query<RunRow>(
        // The stage call is the claiming worker's, else the spawn's (as job_stage_call): a
        // controller on another host adopts it and never spawns again (SA-91).
        `SELECT r.stage, r.state, r.module,
                coalesce((SELECT c.call_id FROM job_stage_claims c
                          WHERE c.job_id = r.job_id AND c.stage = r.stage), r.call_id) AS call_id,
                r.requested_gpu, r.observed_gpu, r.error_code, r.counts, r.receipt_sha256,
                r.cost_estimate_usd::text, r.started_at, r.finished_at, r.running_at, r.terminal_at
         FROM job_stage_runs r WHERE r.job_id = $1`,
        [jobId],
      )
    ).rows.map((r) => [r.stage, r]),
  );
  const ended = TERMINAL_JOB.has(job.state);
  const nodes: DagRunNode[] = job.recipe.stages.map((spec) => {
    const r = runs.get(spec.stage);
    if (!r)
      return {
        stage: spec.stage,
        enabled: spec.enabled,
        module: spec.module,
        state: !spec.enabled || ended ? "not_run" : "pending",
        errorCode: !spec.enabled
          ? "stage_disabled"
          : ended
            ? "not_spawned"
            : null,
        callId: null,
        gpu: { requestedType: spec.resources.gpu, observedType: null },
        startedAt: null,
        finishedAt: null,
        counts: {},
        estimatedCostUsd: null,
        receiptSha256: null,
      } as DagRunNode;
    const started = r.started_at ?? r.running_at;
    const finished = r.finished_at ?? r.terminal_at;
    return {
      stage: r.stage,
      enabled: spec.enabled,
      module: r.module,
      state: r.state,
      errorCode: r.error_code,
      callId: r.call_id,
      gpu: {
        requestedType: r.requested_gpu,
        observedType: r.observed_gpu,
      },
      startedAt: started ? iso(started) : null,
      finishedAt:
        finished && (!started || finished >= started) ? iso(finished) : null,
      counts: r.counts,
      estimatedCostUsd: r.cost_estimate_usd,
      receiptSha256: r.receipt_sha256,
    } as DagRunNode;
  });
  const costs = nodes.map((n) => n.estimatedCostUsd);
  const total = costs.every((c) => c !== null)
    ? (
        costs.reduce((cents, c) => cents + Math.round(Number(c) * 100), 0) / 100
      ).toFixed(2)
    : null;
  const doc = {
    schemaVersion: 1,
    jobId: job.id,
    recordingId: job.recording_id,
    jobState: job.state,
    recipeId: job.recipe.recipeId,
    recipeSha256: job.recipe_sha256,
    maxJobCostUsd: job.recipe.maxJobCostUsd,
    estimatedCostUsd: total,
    stages: nodes,
    renderedAt: iso(job.now).replace(/\.\d{3}Z$/, "Z"),
  };
  const valid = validateValue("http.dag-run.v1", doc);
  if (!valid.valid) throw new Error(`dag-run invalid: ${valid.code}`);
  return doc as unknown as DagRunV1;
}

/** Publish the last issued call as job evidence only after every issued call is proven over. */
export async function promoteRecipeEvidence(
  tx: Tx,
  jobId: string,
  recordedBy: string,
): Promise<boolean> {
  const written = await tx.query(
    `INSERT INTO job_execution_evidence (job_id, kind, execution_ref, detail, recorded_by)
     SELECT e.job_id, e.kind, e.execution_ref, e.detail, $2
     FROM job_stage_evidence e
     WHERE e.job_id = $1 AND e.stage = (
       SELECT c.stage FROM job_stage_claims c WHERE c.job_id = $1
       ORDER BY job_stage_ord(c.stage) DESC LIMIT 1
     ) AND NOT EXISTS (
       SELECT 1 FROM job_stage_claims c
       WHERE c.job_id = $1 AND NOT EXISTS (
         SELECT 1 FROM job_stage_evidence proof WHERE proof.job_id = $1 AND proof.stage = c.stage
       )
     ) AND NOT EXISTS (SELECT 1 FROM job_execution_evidence WHERE job_id = $1)`,
    [jobId, recordedBy],
  );
  return written.rowCount === 1;
}
