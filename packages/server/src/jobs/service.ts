import { promoteRecipeEvidence } from "./stages.js";
import { randomBytes } from "node:crypto";
import type pg from "pg";
import {
  ContractViolation,
  requestSha256,
  validateValue,
  type Sha256Hex,
} from "@stateaction/contracts";
import { processRecordingTaskInputV2 } from "../admission/job-input.js";
import { inTransaction, type Queryable } from "../catalog/catalog.js";
import { CatalogError } from "../catalog/errors.js";
import { hashServiceToken } from "../auth/service.js";
import { TransportError } from "../transport/errors.js";
import type { RecipeV1 } from "@stateaction/contracts";
import {
  admissionDeadlineSeconds,
  RECIPE_DEADLINE_ERROR_CODE,
  TASK_INPUT_BUILD_FAILED_ERROR_CODE,
  TASK_INPUT_INVALID_ERROR_CODE,
  type JobsConfig,
} from "./config.js";
import { withLocalRecipes } from "./local-recipe.js";
import { assertJobCurrent, JOB_CURRENT_SQL } from "./current.js";

type Tx = pg.PoolClient;

/** Signs one short-lived read URL for a stored object (offline; no network). */
export type PresignRead = (
  objectKey: string,
  expiresInSeconds: number,
) => Promise<string>;

/**
 * Builds the secret-free task input document for an admitted job. Defaults to
 * the simulation-aware jobs.task-input.v2 (SA-71); tests may inject another.
 */
export type TaskInputBuilder = (
  q: Pick<pg.PoolClient, "query">,
  job: {
    jobId: string;
    recordingId: string;
    profileRevision: string;
    sourceManifestSha256: string;
  },
) => Promise<Record<string, unknown>>;

export type JobsDeps = {
  pool: pg.Pool;
  config: JobsConfig;
  presignRead: PresignRead;
  taskInput?: TaskInputBuilder;
  /**
   * Render task start used by the repair pass (the API's authority; the cron
   * holds none). Absent/null: dispatch is reported unavailable and nothing is
   * started.
   */
  taskStarter?: import("./dispatch.js").TaskStarter | null;
  /**
   * Storage-backed verification used by SA-28 output acceptance (manifest
   * reader, streaming hasher, finite budgets). Absent in tests that do not
   * exercise acceptance; the result routes then fail closed.
   */
  acceptance?: Omit<import("../acceptance/service.js").AcceptanceDeps, "pool">;
  sealTransport?: () => import("../transport/service.js").TransportDeps;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NONCE = /^[A-Za-z0-9_-]{43}$/;
const OWNER = /^[A-Za-z0-9._:-]{1,200}$/;
const REF = /^[A-Za-z0-9._:-]{1,200}$/;
const CALL_ID = /^fc-[A-Za-z0-9]{1,77}$/;
const LOCAL_REF = /^[A-Za-z0-9._:-]{1,128}$/;

const invalid = (m: string) => new TransportError("invalid_request", m);
const conflict = (m: string) => new TransportError("conflict", m);
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

/** Runs one READ COMMITTED transaction, mapping DB lifecycle errors. */
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

/** Finite, transaction-local waits for the SA-27 recovery mutation paths only. */
export const RECOVERY_LOCK_TIMEOUT_MS = 5_000;
export const RECOVERY_STATEMENT_TIMEOUT_MS = 15_000;

/**
 * Like `run`, but the transaction sets LOCAL lock and statement timeouts first
 * (nothing global changes), and a lock/statement timeout or deadlock becomes a
 * retryable `provider_unavailable` instead of a request that waits forever.
 * The pool checkout itself is bounded only by the pool's own settings.
 */
export async function boundedRun<T>(
  pool: pg.Pool,
  work: (tx: Tx) => Promise<T>,
): Promise<T> {
  try {
    return await inTransaction(pool, async (tx) => {
      await tx.query(
        "SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)",
        [
          String(RECOVERY_LOCK_TIMEOUT_MS),
          String(RECOVERY_STATEMENT_TIMEOUT_MS),
        ],
      );
      return work(tx);
    });
  } catch (error) {
    // inTransaction already mapped 55P03/40P01 to a CatalogError that keeps the
    // SQLSTATE; 57014 (statement timeout) stays a raw driver error. Decide on the
    // SQLSTATE BEFORE the generic lifecycle mapping below.
    const state =
      error instanceof CatalogError
        ? error.sqlstate
        : (error as { code?: unknown })?.code;
    if (state === "55P03" || state === "57014" || state === "40P01")
      throw new TransportError(
        "provider_unavailable",
        "busy: the job is locked by another operation; retry shortly",
        { cause: error },
      );
    if (error instanceof CatalogError)
      throw new TransportError(
        error.code === "idempotency_conflict" ? "conflict" : error.code,
        error.message,
        { cause: error },
      );
    throw error;
  }
}

export type ExecutorRef =
  | { kind: "local"; localExecutionRef: string }
  | { kind: "modal"; functionCallId: string };
export const executorRefId = (e: ExecutorRef): string =>
  e.kind === "local" ? e.localExecutionRef : e.functionCallId;

function parseExecutor(value: unknown): ExecutorRef {
  const e = value as Partial<{
    kind: string;
    localExecutionRef: string;
    functionCallId: string;
  }> | null;
  if (e?.kind === "local")
    return {
      kind: "local",
      localExecutionRef: pattern(
        e.localExecutionRef,
        LOCAL_REF,
        "localExecutionRef",
      ),
    };
  if (e?.kind === "modal")
    return {
      kind: "modal",
      functionCallId: pattern(e.functionCallId, CALL_ID, "functionCallId"),
    };
  throw invalid("executor is malformed");
}
export { parseExecutor };

// ------------------------------------------------------------------ admission

export type AdmittedJob = {
  jobId: string;
  recordingId: string;
  /** Fixed provider dispatch idempotency key `job:{jobId}`. */
  dispatchKey: string;
  executionBackend: "local" | "modal";
  admittedAt: Date;
  /** Absolute hard deadline, anchored here and never reset. */
  executionDeadline: Date;
};
export type AdmitResult =
  | { state: "admitted"; job: AdmittedJob; rejectedJobIds?: string[] }
  | { state: "slot_busy"; holderJobId: string }
  /** No queued job is eligible (none queued, or revoked/deleted/retired). */
  | { state: "idle"; rejectedJobIds?: string[] };

/**
 * Default builder: jobs.task-input.v2 from the immutable admission evidence of
 * THIS job (capture profile and, for simulated captures, the explicit
 * simulation marker), so a worker can never treat simulated input as hardware.
 * There is deliberately no v1 fallback that could strip simulation provenance.
 */
const defaultTaskInput: TaskInputBuilder = async (q, job) =>
  (await processRecordingTaskInputV2(
    q as unknown as Queryable,
    job.jobId,
  )) as unknown as Record<string, unknown>;

/**
 * Rejects one queued job at admission: queued -> cancelled (the only terminal
 * state the job guard permits from queued) with a stable error_code and
 * message, in the admission transaction. No slot is taken, no job_inputs.
 */
async function rejectQueuedJob(
  q: Tx,
  jobId: string,
  code: string,
  message: string,
): Promise<void> {
  await q.query(
    `UPDATE jobs SET state = 'cancelled', error_code = $2, error_message = $3, finished_at = now()
     WHERE id = $1 AND state = 'queued'`,
    [jobId, code, message.slice(0, 2000)],
  );
}

/**
 * True only for a builder refusal about this one job: the job or its admission
 * evidence is missing (CatalogError not_found without a SQLSTATE), or its task
 * input fails the contract. Every other error, including a database failure
 * (raw driver error or a SQLSTATE-mapped CatalogError), propagates and rolls the
 * admission back. A refusal happens after a successful read, so the transaction
 * is still usable for rejectQueuedJob.
 */
function isBuilderRejection(error: unknown): boolean {
  if (error instanceof ContractViolation) return true;
  return (
    error instanceof CatalogError &&
    error.code === "not_found" &&
    error.sqlstate === undefined
  );
}

/**
 * Admits the oldest eligible queued job through the single global slot. The
 * permanent inputs, dispatch key, backend and absolute deadline are committed
 * together with the slot, before any external effect (Render dispatch, worker
 * submission). Concurrent callers serialize on the slot row: exactly one wins,
 * the rest observe `slot_busy`. Queued jobs hold nothing.
 */
export async function admitNextJob(deps: JobsDeps): Promise<AdmitResult> {
  const build =
    deps.taskInput ??
    (deps.config.localRecipeDir
      ? withLocalRecipes(defaultTaskInput, deps.config.localRecipeDir)
      : defaultTaskInput);
  return run(deps.pool, async (tx): Promise<AdmitResult> => {
    // Serialize every admission on the singleton slot row FIRST; the winner
    // then chooses an eligible job while concurrent callers wait here and see
    // the slot occupied once it commits.
    const slot = await tx.query<{ job_id: string | null }>(
      "SELECT job_id FROM dispatch_admission WHERE slot = 1 FOR UPDATE",
    );
    const holder = slot.rows[0]?.job_id;
    if (holder) return { state: "slot_busy", holderJobId: holder };
    const candidates = await tx.query<{
      id: string;
      recording_id: string;
      owner_user_id: string;
      profile_revision: string;
      source_manifest_sha256: string;
    }>(
      `SELECT j.id, j.recording_id, r.owner_user_id, j.profile_revision, j.source_manifest_sha256
       FROM jobs j JOIN recordings r ON r.id = j.recording_id
       WHERE j.state = 'queued' AND r.current_job_id = j.id AND r.deleted_at IS NULL
         AND r.status IN ('uploaded', 'processing')
       ORDER BY j.created_at, j.id
       FOR UPDATE OF j SKIP LOCKED LIMIT 25`,
    );
    const rejectedJobIds: string[] = [];
    for (const c of candidates.rows) {
      const ok = await tx.query<{ ok: boolean }>(
        `SELECT catalog_has_role($2, 'collector') AND EXISTS (
           SELECT 1 FROM recording_registrations g
           WHERE g.recording_id = $1 AND g.owner_user_id = $2
             AND ingest_permission_ok(g.ingest_permission_id, g.owner_user_id, true)) AS ok`,
        [c.recording_id, c.owner_user_id],
      );
      if (!ok.rows[0]?.ok) continue;
      let task: Record<string, unknown>;
      try {
        task = await build(tx, {
          jobId: c.id,
          recordingId: c.recording_id,
          profileRevision: c.profile_revision,
          sourceManifestSha256: c.source_manifest_sha256,
        });
      } catch (error) {
        if (!isBuilderRejection(error)) throw error;
        // Cancel THIS job only (SA-121): the same no-block rule as SA-109.
        await rejectQueuedJob(
          tx,
          c.id,
          TASK_INPUT_BUILD_FAILED_ERROR_CODE,
          `task input build failed: ${(error as Error).message}`,
        );
        rejectedJobIds.push(c.id);
        continue;
      }
      // v3 (SA-88) carries the inline recipe; v1/v2 keep the single-claim path.
      const contract =
        task.schemaVersion === 3
          ? "jobs.task-input.v3"
          : task.schemaVersion === 2
            ? "jobs.task-input.v2"
            : "jobs.task-input.v1";
      // A bad task input rejects only THIS job (never a throw, which would
      // roll back the transaction and leave it at the head of the queue).
      const valid = validateValue(contract, task);
      if (!valid.valid) {
        await rejectQueuedJob(
          tx,
          c.id,
          TASK_INPUT_INVALID_ERROR_CODE,
          `task input rejected: ${valid.code}`,
        );
        rejectedJobIds.push(c.id);
        continue;
      }
      const cfg = deps.config;
      // Deadline from the recipe (SA-89), or the fallback without one. A
      // recipe over the 12 h bound is refused here, before any write.
      let deadlineSeconds: number;
      try {
        // The v3 task input was validated above, so its recipe has the RecipeV1 shape.
        deadlineSeconds = admissionDeadlineSeconds(
          cfg,
          task.schemaVersion === 3 ? (task.recipe as RecipeV1) : null,
        );
      } catch (error) {
        // Reject THIS job (queued -> cancelled with the code) and keep going,
        // so a permanently over-limit recipe never blocks the jobs behind it.
        await rejectQueuedJob(
          tx,
          c.id,
          RECIPE_DEADLINE_ERROR_CODE,
          (error as Error).message,
        );
        rejectedJobIds.push(c.id);
        continue;
      }
      await tx.query(
        `INSERT INTO job_inputs (job_id, source_manifest_sha256, profile_revision, execution_backend,
           code_revision, image_spec_sha256, model_sha256, config_sha256, max_output_files,
           max_output_bytes, max_control_document_bytes, task_input, task_input_sha256)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          c.id,
          c.source_manifest_sha256,
          c.profile_revision,
          cfg.executionBackend,
          cfg.codeRevision,
          cfg.imageSpecSha256,
          cfg.modelSha256,
          cfg.configSha256,
          cfg.limits.maxOutputFiles,
          cfg.limits.maxOutputBytes,
          cfg.limits.maxControlDocumentBytes,
          JSON.stringify(task),
          requestSha256(task),
        ],
      );
      // We hold the slot row lock, so this conditional update cannot lose.
      const won = await tx.query<{ admitted_at: Date }>(
        `UPDATE dispatch_admission SET job_id = $1, admitted_at = now()
         WHERE slot = 1 AND job_id IS NULL RETURNING admitted_at`,
        [c.id],
      );
      const admittedAt = won.rows[0]!.admitted_at;
      // The recipe (if any) is stored with the admission, written once and
      // checked by the database against the persisted task input.
      const recipe = task.schemaVersion === 3 ? task.recipe : null;
      const updated = await tx.query<{ execution_deadline: Date }>(
        `UPDATE jobs SET state = 'submitting', admitted_at = $2, dispatch_key = 'job:' || id::text,
           execution_backend = $3,
           execution_deadline = $2::timestamptz + make_interval(secs => $4),
           recipe = $5::jsonb, recipe_sha256 = $6
         WHERE id = $1 AND state = 'queued' RETURNING execution_deadline`,
        [
          c.id,
          admittedAt,
          cfg.executionBackend,
          deadlineSeconds,
          recipe === null ? null : JSON.stringify(recipe),
          recipe === null ? null : task.recipeSha256,
        ],
      );
      return {
        state: "admitted",
        ...(rejectedJobIds.length > 0 ? { rejectedJobIds } : {}),
        job: {
          jobId: c.id,
          recordingId: c.recording_id,
          dispatchKey: `job:${c.id}`,
          executionBackend: cfg.executionBackend,
          admittedAt,
          executionDeadline: updated.rows[0]!.execution_deadline,
        },
      };
    }
    return rejectedJobIds.length > 0
      ? { state: "idle", rejectedJobIds }
      : { state: "idle" };
  });
}

export type PendingDispatch = { jobId: string; dispatchKey: string };

/**
 * Admitted jobs whose Render task start was never acknowledged. SA-26 retries
 * `startTask` with the SAME dispatch key (the provider deduplicates), so a
 * lost acknowledgement never starts a second controller.
 */
export async function listPendingDispatches(
  deps: Pick<JobsDeps, "pool">,
  limit = 10,
): Promise<PendingDispatch[]> {
  const { rows } = await deps.pool.query<{ id: string; dispatch_key: string }>(
    `SELECT id, dispatch_key FROM jobs
     WHERE state = 'submitting' AND workflow_run_ref IS NULL AND dispatch_key IS NOT NULL
     ORDER BY admitted_at, id LIMIT $1`,
    [Math.min(Math.max(limit, 1), 50)],
  );
  return rows.map((r) => ({ jobId: r.id, dispatchKey: r.dispatch_key }));
}

// ---------------------------------------------------------- controller control

/** Records the Render run ID once (repairs a lost start acknowledgement). */
export async function recordWorkflowRun(
  deps: Pick<JobsDeps, "pool">,
  input: { jobId: string; runRef: string },
): Promise<{ recorded: boolean }> {
  const jobId = uuid(input.jobId, "jobId");
  const runRef = pattern(input.runRef, REF, "runRef");
  const set = await deps.pool.query(
    `UPDATE jobs SET workflow_run_ref = $2
     WHERE id = $1 AND workflow_run_ref IS NULL
       AND state IN ('submitting', 'submit_unknown', 'running', 'result_pending', 'cancel_requested', 'needs_attention')
     RETURNING id`,
    [jobId, runRef],
  );
  if (set.rowCount) return { recorded: true };
  const { rows } = await deps.pool.query<{ workflow_run_ref: string | null }>(
    "SELECT workflow_run_ref FROM jobs WHERE id = $1",
    [jobId],
  );
  if (!rows[0]) throw new TransportError("not_found", "Job not found");
  if (rows[0].workflow_run_ref === runRef) return { recorded: false };
  throw conflict("A different workflow run is already recorded");
}

export type LeaseResult =
  | { granted: true; expiresAt: Date }
  | { granted: false; reason: "live_owner" | "different_run" | "not_active" };

/**
 * Claims the controller lease for one task entry (`owner` is a fresh nonce per
 * entry). A native retry of the same run must wait for its predecessor's lease
 * to lapse; a different Render run than the recorded one never gets effects.
 * The lease is NOT physical worker authority and never releases admission.
 */
export async function claimControllerLease(
  deps: Pick<JobsDeps, "pool" | "config">,
  input: { jobId: string; runRef: string; owner: string },
): Promise<LeaseResult> {
  const jobId = uuid(input.jobId, "jobId");
  const runRef = pattern(input.runRef, REF, "runRef");
  const owner = pattern(input.owner, OWNER, "owner");
  const { rows } = await deps.pool.query<{ controller_lease_expires_at: Date }>(
    `UPDATE jobs SET controller_lease_owner = $3,
       controller_lease_expires_at = now() + make_interval(secs => $4),
       workflow_run_ref = COALESCE(workflow_run_ref, $2)
     WHERE id = $1
       AND state IN ('submitting', 'submit_unknown', 'running', 'result_pending', 'cancel_requested', 'needs_attention')
       AND (workflow_run_ref IS NULL OR workflow_run_ref = $2)
       AND (controller_lease_owner IS NULL OR controller_lease_owner = $3
            OR controller_lease_expires_at <= now())
     RETURNING controller_lease_expires_at`,
    [jobId, runRef, owner, deps.config.leaseSeconds],
  );
  if (rows[0])
    return { granted: true, expiresAt: rows[0].controller_lease_expires_at };
  const cur = await deps.pool.query<{
    state: string;
    workflow_run_ref: string | null;
  }>("SELECT state, workflow_run_ref FROM jobs WHERE id = $1", [jobId]);
  const job = cur.rows[0];
  if (!job) throw new TransportError("not_found", "Job not found");
  if (
    ![
      "submitting",
      "submit_unknown",
      "running",
      "result_pending",
      "cancel_requested",
      "needs_attention",
    ].includes(job.state)
  )
    return { granted: false, reason: "not_active" };
  if (job.workflow_run_ref && job.workflow_run_ref !== runRef)
    return { granted: false, reason: "different_run" };
  return { granted: false, reason: "live_owner" };
}

export async function renewControllerLease(
  deps: Pick<JobsDeps, "pool" | "config">,
  input: { jobId: string; owner: string },
): Promise<{ renewed: boolean; expiresAt?: Date }> {
  const { rows } = await deps.pool.query<{ controller_lease_expires_at: Date }>(
    `UPDATE jobs SET controller_lease_expires_at = now() + make_interval(secs => $3)
     WHERE id = $1 AND controller_lease_owner = $2 AND controller_lease_expires_at > now()
       AND state IN ('submitting', 'submit_unknown', 'running', 'result_pending', 'cancel_requested', 'needs_attention')
     RETURNING controller_lease_expires_at`,
    [
      uuid(input.jobId, "jobId"),
      pattern(input.owner, OWNER, "owner"),
      deps.config.leaseSeconds,
    ],
  );
  return rows[0]
    ? { renewed: true, expiresAt: rows[0].controller_lease_expires_at }
    : { renewed: false };
}

export type WorkerSubmission =
  | {
      state: "recorded";
      /** Private bootstrap capability: pass to the worker once, never persist. */
      bootstrapToken: string;
      startDeadline: Date;
      executionDeadline: Date;
      taskInput: Record<string, unknown>;
      executionBackend: "local" | "modal";
    }
  /** Intent already exists: the controller MUST NOT submit again. */
  | { state: "already_recorded" };

/**
 * Persists the worker submission intent (and the one-time bootstrap
 * capability's hash and start deadline) BEFORE the single executor submission.
 * A second call never yields another token, so a controller retry can never
 * authorize a second worker.
 */
export async function recordWorkerSubmissionIntent(
  deps: Pick<JobsDeps, "pool" | "config">,
  input: { jobId: string; owner: string },
): Promise<WorkerSubmission> {
  const jobId = uuid(input.jobId, "jobId");
  const owner = pattern(input.owner, OWNER, "owner");
  const token = `sa_svc_${randomBytes(32).toString("base64url")}`;
  return run(deps.pool, async (tx) => {
    const set = await tx.query<{
      start_deadline: Date;
      execution_deadline: Date;
      execution_backend: "local" | "modal";
    }>(
      `UPDATE jobs SET submission_intent_at = now(), submission_intent_owner = $2,
         bootstrap_token_sha256 = $3,
         start_deadline = LEAST(now() + make_interval(secs => $4), execution_deadline)
       WHERE id = $1 AND state = 'submitting' AND submission_intent_at IS NULL
         AND controller_lease_owner = $2 AND controller_lease_expires_at > now()
         AND execution_deadline > now()
         AND EXISTS (SELECT 1 FROM dispatch_admission a WHERE a.slot = 1 AND a.job_id = jobs.id)
       RETURNING start_deadline, execution_deadline, execution_backend`,
      [jobId, owner, hashServiceToken(token), deps.config.startDeadlineSeconds],
    );
    if (!set.rows[0]) {
      const cur = await tx.query<{ submission_intent_at: Date | null }>(
        "SELECT submission_intent_at FROM jobs WHERE id = $1",
        [jobId],
      );
      if (!cur.rows[0]) throw new TransportError("not_found", "Job not found");
      if (cur.rows[0].submission_intent_at)
        return { state: "already_recorded" } as const;
      throw conflict(
        "Job is not awaiting submission for this controller lease",
      );
    }
    const input_ = await tx.query<{ task_input: Record<string, unknown> }>(
      "SELECT task_input FROM job_inputs WHERE job_id = $1",
      [jobId],
    );
    return {
      state: "recorded",
      bootstrapToken: token,
      startDeadline: set.rows[0].start_deadline,
      executionDeadline: set.rows[0].execution_deadline,
      taskInput: input_.rows[0]!.task_input,
      executionBackend: set.rows[0].execution_backend,
    } as const;
  });
}

/**
 * The submission acknowledgement was lost or errored ambiguously. Marks the
 * job `submit_unknown`, keeping intent, nonce hash, deadlines and admission as
 * evidence for SA-27 repair. NEVER resubmits and NEVER frees the slot.
 */
export async function markSubmissionUnknown(
  deps: Pick<JobsDeps, "pool">,
  input: { jobId: string; owner: string },
): Promise<{ state: "submit_unknown" }> {
  const jobId = uuid(input.jobId, "jobId");
  const owner = pattern(input.owner, OWNER, "owner");
  const set = await deps.pool.query(
    `UPDATE jobs SET state = 'submit_unknown', unknown_at = COALESCE(unknown_at, now())
     WHERE id = $1 AND state IN ('submitting', 'submit_unknown')
       AND submission_intent_at IS NOT NULL AND controller_lease_owner = $2
     RETURNING id`,
    [jobId, owner],
  );
  if (!set.rowCount) throw conflict("No submitted job for this controller");
  return { state: "submit_unknown" };
}

/**
 * Saves the executor's execution reference once (repairs a missing reference
 * the worker has not yet reported). A different reference than the recorded
 * one is a conflict, never an overwrite.
 */
export async function recordExecutionRef(
  deps: Pick<JobsDeps, "pool" | "config">,
  input: { jobId: string; owner: string; executor: ExecutorRef },
): Promise<{ recorded: boolean }> {
  const jobId = uuid(input.jobId, "jobId");
  const owner = pattern(input.owner, OWNER, "owner");
  const executor = parseExecutor(input.executor);
  const ref = executorRefId(executor);
  const set = await deps.pool.query(
    `UPDATE jobs SET execution_call_id = $3
     WHERE id = $1 AND execution_call_id IS NULL AND submission_intent_at IS NOT NULL
       AND execution_backend = $4 AND controller_lease_owner = $2
       AND controller_lease_expires_at > now()
       AND state IN ('submitting', 'submit_unknown', 'running', 'cancel_requested', 'needs_attention')
     RETURNING id`,
    [jobId, owner, ref, executor.kind],
  );
  if (set.rowCount) return { recorded: true };
  const { rows } = await deps.pool.query<{ execution_call_id: string | null }>(
    "SELECT execution_call_id FROM jobs WHERE id = $1",
    [jobId],
  );
  if (rows[0]?.execution_call_id === ref) return { recorded: false };
  throw conflict("Execution reference cannot be recorded for this job");
}

// --------------------------------------------------------------------- cancel

/**
 * Blocks new claims, output signing and acceptance immediately. A job that was
 * never admitted becomes cancelled outright (it holds nothing); an admitted job
 * becomes `cancel_requested` and keeps the slot until terminal execution
 * evidence is recorded.
 */
export async function requestJobCancel(
  deps: Pick<JobsDeps, "pool">,
  jobId: string,
  guard: { expectedState?: string; requireCurrent?: boolean } = {},
): Promise<{ state: "cancelled" | "cancel_requested" }> {
  uuid(jobId, "jobId");
  return boundedRun(deps.pool, async (tx) => {
    const rec = await tx.query<{ recording_id: string }>(
      "SELECT recording_id FROM jobs WHERE id = $1",
      [jobId],
    );
    if (!rec.rows[0]) throw new TransportError("not_found", "Job not found");
    // Lock order: recording, then job.
    await tx.query("SELECT 1 FROM recordings WHERE id = $1 FOR UPDATE", [
      rec.rows[0].recording_id,
    ]);
    const { rows } = await tx.query<{ state: string }>(
      "SELECT state FROM jobs WHERE id = $1 FOR UPDATE",
      [jobId],
    );
    const state = rows[0]!.state;
    // Operator requests are bound to the exact current job and state they saw.
    if (guard.requireCurrent) {
      const cur = await tx.query<{ current: boolean }>(
        "SELECT current_job_id = $2 AS current FROM recordings WHERE id = $1",
        [rec.rows[0].recording_id, jobId],
      );
      if (!cur.rows[0]?.current)
        throw conflict("stale_current_job: the recording has a newer job");
    }
    if (guard.expectedState !== undefined && guard.expectedState !== state)
      throw conflict(
        `stale_state: job is ${state}, not ${guard.expectedState}`,
      );
    if (state === "queued") {
      await tx.query(
        "UPDATE jobs SET state = 'cancelled', finished_at = now() WHERE id = $1",
        [jobId],
      );
      return { state: "cancelled" } as const;
    }
    if (state === "cancel_requested")
      return { state: "cancel_requested" } as const;
    if (["succeeded", "failed", "cancelled"].includes(state))
      throw conflict("Job already finished");
    await tx.query("UPDATE jobs SET state = 'cancel_requested' WHERE id = $1", [
      jobId,
    ]);
    return { state: "cancel_requested" } as const;
  });
}

// ------------------------------------------------------------- terminal evidence

export type ExecutionEvidence =
  | {
      kind: "local_child_reaped" | "provider_call_terminal";
      executionRef: string;
      detail?: Record<string, unknown> | undefined;
    }
  | {
      kind: "pre_submission_rejected";
      detail?: Record<string, unknown> | undefined;
    };

/**
 * Persists authoritative evidence that the exact execution is over (or never
 * happened). The admission slot is released by the database only when BOTH this
 * evidence AND a terminal business state (succeeded/failed/cancelled, e.g. SA-28
 * atomic acceptance) exist, whichever arrives last. Evidence may therefore be
 * recorded while the result is still `result_pending`; the slot stays held. A
 * job that never submitted (`pre_submission_rejected`, no intent) also becomes
 * `failed` here, which completes the release. An expired lease or deadline, a
 * missing heartbeat or an unknown submission never frees the slot.
 */
export async function recordExecutionEvidence(
  deps: Pick<JobsDeps, "pool">,
  input: { jobId: string; evidence: ExecutionEvidence; recordedBy: string },
): Promise<{ recorded: true; slotReleased: boolean }> {
  const jobId = uuid(input.jobId, "jobId");
  const by = pattern(input.recordedBy, OWNER, "recordedBy");
  const ev = input.evidence;
  const ref =
    ev.kind === "pre_submission_rejected"
      ? null
      : pattern(ev.executionRef, REF, "executionRef");
  return run(deps.pool, async (tx) => {
    const { rows } = await tx.query<{
      state: string;
      recipe: boolean;
      recipe_parallel: boolean;
    }>(
      "SELECT state, recipe IS NOT NULL AS recipe, recipe_parallel FROM jobs WHERE id = $1 FOR UPDATE",
      [jobId],
    );
    if (!rows[0]) throw new TransportError("not_found", "Job not found");
    // SA-88 recipe job: the proof first names the exact call of one stage
    // (job_stage_evidence). It is also the job's terminal evidence only when
    // that stage is the latest issued and no later stage can still run (the
    // sealing hand_pose stage, or a job that can no longer continue).
    if (rows[0].recipe && ev.kind !== "pre_submission_rejected") {
      const stage = (
        await tx.query<{ stage: string }>(
          "SELECT job_stage_record_evidence($1, $2, $3, $4::jsonb, $5) AS stage",
          [jobId, ev.kind, ref, JSON.stringify(ev.detail ?? {}), by],
        )
      ).rows[0]!.stage;
      if (rows[0].recipe_parallel) {
        // A hand-pose call may finish before caption launches. While the job
        // can run, only the seal transaction can publish job-level evidence.
        if (
          !["submitting", "submit_unknown", "running"].includes(rows[0].state)
        )
          await promoteRecipeEvidence(tx, jobId, by);
        const held = await tx.query(
          "SELECT 1 FROM dispatch_admission WHERE slot = 1 AND job_id = $1",
          [jobId],
        );
        return { recorded: true, slotReleased: held.rowCount === 0 };
      }
      const latest = (
        await tx.query<{ stage: string }>(
          `SELECT stage FROM job_stage_claims WHERE job_id = $1
           ORDER BY job_stage_ord(stage) DESC LIMIT 1`,
          [jobId],
        )
      ).rows[0]?.stage;
      const final =
        stage === latest &&
        (stage === "hand_pose" ||
          !["submitting", "submit_unknown", "running"].includes(rows[0].state));
      const already = await tx.query(
        "SELECT 1 FROM job_execution_evidence WHERE job_id = $1",
        [jobId],
      );
      if (!final || already.rows[0]) {
        const held = await tx.query(
          "SELECT 1 FROM dispatch_admission WHERE slot = 1 AND job_id = $1",
          [jobId],
        );
        return { recorded: true, slotReleased: held.rowCount === 0 } as const;
      }
    }
    await tx.query(
      `INSERT INTO job_execution_evidence (job_id, kind, execution_ref, detail, recorded_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [jobId, ev.kind, ref, JSON.stringify(ev.detail ?? {}), by],
    );
    if (
      ev.kind === "pre_submission_rejected" &&
      ["submitting", "submit_unknown"].includes(rows[0].state)
    )
      await tx.query(
        `UPDATE jobs SET state = 'failed', error_code = 'never_submitted', finished_at = now()
         WHERE id = $1`,
        [jobId],
      );
    const held = await tx.query(
      "SELECT 1 FROM dispatch_admission WHERE slot = 1 AND job_id = $1",
      [jobId],
    );
    return { recorded: true, slotReleased: held.rowCount === 0 } as const;
  });
}

// ---------------------------------------------------------------- worker claim

type InputRow = {
  id: string;
  role: string;
  size_bytes: string;
  sha256: string;
  object_key: string;
};

async function sourceInputs(q: Pick<Tx, "query">, recordingId: string) {
  const { rows } = await q.query<InputRow>(
    `SELECT id, role, size_bytes::text, sha256, object_key FROM files
     WHERE recording_id = $1 AND purpose = 'source' AND state IN ('completed', 'verified')
     ORDER BY id`,
    [recordingId],
  );
  return rows;
}

async function signedInputs(
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

export type ClaimGrant = Record<string, unknown>;

/**
 * The only way to obtain a running job and signed source URLs. The caller has
 * already authenticated the private bootstrap capability for `job:claim`.
 * One transaction rechecks everything live and wins or fails atomically:
 * awaiting-claim state inside the start deadline, unexpired absolute deadline,
 * the slot, the recording's current pointer, owner role and processing
 * permission, the configured backend and (if the controller already recorded
 * one) the exact execution ID. Nonce, execution ID and capability hash are
 * written once, so a duplicate, replayed or mismatched physical worker fails
 * BEFORE any source URL is signed or database input is read. URLs are signed
 * offline inside the winning transaction; a grant that cannot be built rolls
 * the claim back.
 */
export async function claimWorker(
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
  const ref = executorRefId(executor);
  const bootstrapHash = hashServiceToken(input.bootstrapToken);
  const capability = `sa_svc_${randomBytes(32).toString("base64url")}`;
  return run(deps.pool, async (tx) => {
    const pre = await tx.query<{ recording_id: string }>(
      "SELECT recording_id FROM jobs WHERE id = $1",
      [jobId],
    );
    if (!pre.rows[0]) throw forbidden();
    const recordingId = pre.rows[0].recording_id;
    // Lock order: recording, then job.
    await tx.query("SELECT 1 FROM recordings WHERE id = $1 FOR UPDATE", [
      recordingId,
    ]);
    const locked = await tx.query<{
      state: string;
      claimed_at: Date | null;
      invocation_nonce: string | null;
      execution_call_id: string | null;
      execution_backend: string;
      bootstrap_token_sha256: string | null;
      start_deadline: Date | null;
      execution_deadline: Date;
      source_manifest_sha256: string;
      now: Date;
    }>(
      `SELECT state, claimed_at, invocation_nonce, execution_call_id, execution_backend,
         bootstrap_token_sha256, start_deadline, execution_deadline, source_manifest_sha256, now() AS now
       FROM jobs WHERE id = $1 FOR UPDATE`,
      [jobId],
    );
    const job = locked.rows[0]!;
    if (
      job.bootstrap_token_sha256 !== bootstrapHash ||
      !["submitting", "submit_unknown"].includes(job.state) ||
      job.claimed_at !== null ||
      job.invocation_nonce !== null
    )
      throw conflict("Job cannot be claimed");
    if (
      !job.start_deadline ||
      job.start_deadline <= job.now ||
      job.execution_deadline <= job.now
    )
      throw forbidden("Claim deadline has passed");
    if (job.execution_backend !== executor.kind)
      throw conflict("Executor backend does not match the job");
    if (job.execution_call_id !== null && job.execution_call_id !== ref)
      throw conflict("Execution does not match the submitted execution");
    const gate = await tx.query<{ ok: boolean }>(
      `SELECT r.current_job_id = $1 AND r.deleted_at IS NULL AND r.status IN ('uploaded', 'processing')
         AND EXISTS (SELECT 1 FROM dispatch_admission a WHERE a.slot = 1 AND a.job_id = $1)
         AND catalog_has_role(r.owner_user_id, 'collector')
         AND EXISTS (SELECT 1 FROM recording_registrations g
           WHERE g.recording_id = r.id AND g.owner_user_id = r.owner_user_id
             AND ingest_permission_ok(g.ingest_permission_id, g.owner_user_id, true)) AS ok
       FROM recordings r WHERE r.id = $2`,
      [jobId, recordingId],
    );
    if (!gate.rows[0]?.ok) throw forbidden("Job is not current");
    await tx.query(
      `UPDATE jobs SET state = 'running', claimed_at = now(), invocation_nonce = $2,
         execution_call_id = COALESCE(execution_call_id, $3), capability_token_sha256 = $4,
         last_heartbeat_at = now()
       WHERE id = $1`,
      [jobId, nonce, ref, hashServiceToken(capability)],
    );
    await tx.query(
      "UPDATE recordings SET status = 'processing' WHERE id = $1",
      [recordingId],
    );
    // Past this point we won the physical claim; only now are inputs read.
    const cfg = await tx.query<{
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
    );
    const c = cfg.rows[0];
    if (!c) throw conflict("Job has no persisted inputs");
    const files = await sourceInputs(tx, recordingId);
    const grant = {
      schemaVersion: 1,
      jobId,
      invocationNonce: nonce,
      kind: "process_recording",
      startDeadline: iso(job.start_deadline),
      executionDeadline: iso(job.execution_deadline),
      digests: {
        sourceManifestSha256: job.source_manifest_sha256 as Sha256Hex,
        codeRevision: c.code_revision,
        imageSpecSha256: c.image_spec_sha256,
        modelSha256: c.model_sha256,
        configSha256: c.config_sha256,
      },
      limits: {
        maxOutputFiles: c.max_output_files,
        maxOutputBytes: c.max_output_bytes,
        maxControlDocumentBytes: c.max_control_document_bytes,
      },
      inputs: await signedInputs(deps, files, job.execution_deadline, job.now),
      capability: { token: capability, expiresAt: iso(job.execution_deadline) },
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

export type HeartbeatBody = {
  phase: string;
  processedFrames?: string | undefined;
  totalFrames?: string | null | undefined;
};

/** Progress only: never extends any deadline; stale/cancelled workers fail. */
export async function recordHeartbeat(
  deps: Pick<JobsDeps, "pool">,
  input: { jobId: string; invocationNonce: string } & HeartbeatBody,
): Promise<{ accepted: true; executionDeadline: Date }> {
  const jobId = uuid(input.jobId, "jobId");
  const nonce = pattern(input.invocationNonce, NONCE, "invocationNonce");
  const { rows } = await deps.pool.query<{ execution_deadline: Date }>(
    `UPDATE jobs j SET last_heartbeat_at = now(), heartbeat_phase = $3,
       processed_frames = $4::bigint, total_frames = $5::bigint
     WHERE j.id = $1 AND j.id IN (SELECT c.id FROM (${JOB_CURRENT_SQL}) c)
     RETURNING j.execution_deadline`,
    [
      jobId,
      nonce,
      input.phase,
      input.processedFrames ?? null,
      input.totalFrames ?? null,
    ],
  );
  if (!rows[0]) throw forbidden("Job is not current");
  return { accepted: true, executionDeadline: rows[0].execution_deadline };
}

/** Fresh signed read URL for one sealed source file of the current job. */
export async function refreshInputReadUrl(
  deps: JobsDeps,
  input: { jobId: string; fileId: string },
): Promise<{ fileId: string; readUrl: string; expiresAt: string }> {
  const jobId = uuid(input.jobId, "jobId");
  const fileId = uuid(input.fileId, "fileId");
  const current = await assertJobCurrent(deps.pool, jobId);
  const { rows } = await deps.pool.query<InputRow>(
    `SELECT id, role, size_bytes::text, sha256, object_key FROM files
     WHERE id = $1 AND recording_id = $2 AND purpose = 'source' AND state IN ('completed', 'verified')`,
    [fileId, current.recordingId],
  );
  if (!rows[0]) throw new TransportError("not_found", "Input not found");
  const [signed] = await signedInputs(
    deps,
    rows,
    current.executionDeadline,
    new Date(),
  );
  return { fileId, readUrl: signed!.readUrl, expiresAt: signed!.expiresAt };
}

/**
 * The admitted, secret-free task input (jobs.task-input.v2) of the current
 * claimed job, read from the immutable admission evidence. A worker needs the
 * recording identity, profile revision and the admitted capture profile (with
 * the simulation marker for simulated captures) to bind its result to them; the
 * frozen claim grant deliberately carries none of these.
 */
export async function readTaskInput(
  deps: Pick<JobsDeps, "pool">,
  input: { jobId: string },
): Promise<Record<string, unknown>> {
  const jobId = uuid(input.jobId, "jobId");
  await assertJobCurrent(deps.pool, jobId);
  const { rows } = await deps.pool.query<{
    task_input: Record<string, unknown>;
  }>("SELECT task_input FROM job_inputs WHERE job_id = $1", [jobId]);
  if (!rows[0]) throw new TransportError("not_found", "Job not found");
  return rows[0].task_input;
}

// ---------------------------------------------------------------------- status

export async function getJobStatus(
  deps: Pick<JobsDeps, "pool">,
  jobId: string,
): Promise<Record<string, unknown>> {
  uuid(jobId, "jobId");
  const { rows } = await deps.pool.query<{
    id: string;
    kind: string;
    recording_id: string;
    state: string;
    previous_job_id: string | null;
    created_at: Date;
    updated_at: Date;
    execution_backend: "local" | "modal" | null;
    execution_call_id: string | null;
    start_deadline: Date | null;
    execution_deadline: Date | null;
  }>(
    `SELECT id, kind, recording_id, state, previous_job_id, created_at, updated_at,
            execution_backend, execution_call_id, start_deadline, execution_deadline
     FROM jobs WHERE id = $1`,
    [jobId],
  );
  const j = rows[0];
  if (!j) throw new TransportError("not_found", "Job not found");
  const status = {
    jobId: j.id,
    kind: j.kind,
    targetId: j.recording_id,
    state: j.state,
    previousJobId: j.previous_job_id,
    createdAt: iso(j.created_at),
    updatedAt: iso(j.updated_at),
    // SA-42: the recorded identity only (set by the controller or the winning worker claim).
    // It lets a controller on another instance ADOPT a known call; it never authorizes a spawn.
    executionBackend: j.execution_backend,
    executionRef: j.execution_call_id,
    startDeadline: j.start_deadline ? iso(j.start_deadline) : null,
    executionDeadline: j.execution_deadline ? iso(j.execution_deadline) : null,
  };
  const valid = validateValue("jobs.job-status.v2", status);
  if (!valid.valid) throw new Error(`job status invalid: ${valid.code}`);
  return status;
}
