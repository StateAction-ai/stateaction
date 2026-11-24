import { randomUUID } from "node:crypto";
import type pg from "pg";
import { PUBLIC_VIDEO_RECIPE } from "../admission/public-video-canary.js";
import type {
  JobControlAction,
  JobControlCapabilities,
  JobState,
} from "../pipeline/model.js";
import { TransportError } from "../transport/errors.js";
import { repairLimits, type JobsConfig, type RepairLimits } from "./config.js";
import {
  listPendingDispatches,
  boundedRun,
  type JobsDeps,
  type PendingDispatch,
} from "./service.js";

import { promoteRecipeEvidence } from "./stages.js";

/**
 * SA-27 safe recovery. Everything here builds on SA-25's state machine and
 * evidence rules; none of it writes a state the database guards would refuse,
 * and none of it can free the admission slot (only terminal business state +
 * exact execution evidence can, in SA-25's triggers).
 *
 * Hard rules enforced below:
 * - `cancel_requested` is not stopped. It becomes `cancelled` only when
 *   authoritative execution evidence exists, or when the database itself
 *   proves no execution was ever submitted (no intent/ID/nonce; intent can no
 *   longer be recorded once the state left `submitting`).
 * - Retry needs exact termination (terminal state + evidence + slot not held),
 *   targets the exact current job and state the caller saw, and creates a NEW
 *   job (new ID, therefore a new `jobs/{id}/outputs/` prefix). A job that
 *   failed on source bytes asks for corrected source instead.
 * - Uncertain spawn acknowledgement is never cleared or resubmitted: it stays
 *   `submit_unknown`/`needs_attention`, which keeps intent, deadlines and slot.
 * - Dispatch only (re)starts the Render task with the fixed `job:{id}` key.
 */

/** Recovery steps need the pool and only the repair bounds of the configuration. */
export type RepairDeps = Pick<JobsDeps, "pool"> & {
  config: Pick<JobsConfig, "repair">;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const refuse = (reason: string, text: string) =>
  new TransportError("conflict", `${reason}: ${text}`);

/**
 * Failure codes meaning the worker could not trust the source bytes. A
 * same-byte retry would fail identically (and recordings and their originals
 * are immutable), so these ask for corrected source / a new upload instead.
 */
export const SOURCE_REUPLOAD_ERROR_CODES: ReadonlySet<string> = new Set([
  "source_sha_mismatch",
  "source_checksum_mismatch",
]);

// ------------------------------------------------------------------ snapshot

export type RecoverySnapshot = {
  jobId: string;
  recordingId: string;
  state: JobState;
  isCurrent: boolean;
  holdsSlot: boolean;
  hasEvidence: boolean;
  evidenceKind: string | null;
  neverSubmitted: boolean;
  submissionIntent: boolean;
  claimed: boolean;
  errorCode: string | null;
  leaseLive: boolean;
  executionDeadlinePassed: boolean;
  hasSuccessor: boolean;
};

const SNAPSHOT_SQL = `
  SELECT j.id, j.recording_id, j.state, j.error_code,
    (r.current_job_id = j.id) AS is_current,
    EXISTS (SELECT 1 FROM dispatch_admission a WHERE a.slot = 1 AND a.job_id = j.id) AS holds_slot,
    e.kind AS evidence_kind,
    (j.submission_intent_at IS NULL AND j.execution_call_id IS NULL AND j.invocation_nonce IS NULL) AS never_submitted,
    (j.submission_intent_at IS NOT NULL) AS intent,
    (j.claimed_at IS NOT NULL) AS claimed,
    (j.controller_lease_expires_at IS NOT NULL AND j.controller_lease_expires_at > now()) AS lease_live,
    (j.execution_deadline IS NOT NULL AND j.execution_deadline <= now()) AS deadline_passed,
    EXISTS (SELECT 1 FROM jobs s WHERE s.previous_job_id = j.id) AS has_successor
  FROM jobs j
  JOIN recordings r ON r.id = j.recording_id
  LEFT JOIN job_execution_evidence e ON e.job_id = j.id
  WHERE j.id = $1`;

type SnapshotRow = {
  id: string;
  recording_id: string;
  state: JobState;
  error_code: string | null;
  is_current: boolean;
  holds_slot: boolean;
  evidence_kind: string | null;
  never_submitted: boolean;
  intent: boolean;
  claimed: boolean;
  lease_live: boolean;
  deadline_passed: boolean;
  has_successor: boolean;
};

export async function recoverySnapshot(
  db: Pick<pg.Pool, "query">,
  jobId: string,
): Promise<RecoverySnapshot> {
  if (!UUID.test(jobId))
    throw new TransportError("invalid_request", "jobId must be a UUID");
  const { rows } = await db.query<SnapshotRow>(SNAPSHOT_SQL, [jobId]);
  const r = rows[0];
  if (!r) throw new TransportError("not_found", "Job not found");
  return {
    jobId: r.id,
    recordingId: r.recording_id,
    state: r.state,
    isCurrent: r.is_current,
    holdsSlot: r.holds_slot,
    hasEvidence: r.evidence_kind !== null,
    evidenceKind: r.evidence_kind,
    neverSubmitted: r.never_submitted,
    submissionIntent: r.intent,
    claimed: r.claimed,
    errorCode: r.error_code,
    leaseLive: r.lease_live,
    executionDeadlinePassed: r.deadline_passed,
    hasSuccessor: r.has_successor,
  };
}

// ------------------------------------------------------------------ guidance

export type RecoveryGuidance = {
  code:
    | "none"
    | "in_progress"
    | "cancel_pending_termination"
    | "unknown_spawn"
    | "needs_operator"
    | "retry_available"
    | "reupload_required"
    | "retry_blocked_termination_unproven"
    | "superseded";
  instruction: string;
};

const SPAWN_RULE =
  "Do not clear the admission slot, edit job or evidence rows, or start another worker by hand.";

/** Precise, state-derived operator instruction. Pure: contains no secrets or identifiers. */
export function operatorGuidance(s: RecoverySnapshot): RecoveryGuidance {
  if (!s.isCurrent || s.hasSuccessor)
    return {
      code: "superseded",
      instruction:
        "A newer job exists for this recording; this attempt cannot be changed. Act on the recording's current job.",
    };
  switch (s.state) {
    case "queued":
    case "submitting":
    case "running":
    case "result_pending":
      return {
        code: "in_progress",
        instruction:
          "Nothing to repair: the controller or worker is still within its leases and deadlines. The minute repair pass will act if dispatch is lost.",
      };
    case "cancel_requested":
      return {
        code: "cancel_pending_termination",
        instruction: `Cancellation is requested, not complete: the execution may still be running and capacity stays held. It completes only after the controller records exact termination evidence (reaped local child or terminal provider call). Re-check later; retry stays unavailable until then. ${SPAWN_RULE}`,
      };
    case "submit_unknown":
      return {
        code: "unknown_spawn",
        instruction: `The worker submission was made (or may have been) but its acknowledgement was lost, so the execution is unproven either way. Resubmission is blocked on purpose. On the controller host, let the controller recover the job from its local journal: it adopts a proven child or, once the child's whole process group is provably empty, records the termination evidence itself. If the journal or process identity cannot be proven, the job stays fail-closed for an operator to cancel and inspect on the host. ${SPAWN_RULE}`,
      };
    case "needs_attention":
      return {
        code: "needs_operator",
        instruction: `The execution outlived its deadline or lost its controller without termination evidence, so capacity stays held. Verify on the controller host that no worker process for this job remains, then re-run the controller recovery so it records the evidence, or cancel the job (it completes only with evidence). ${SPAWN_RULE}`,
      };
    case "failed":
    case "cancelled": {
      if (
        s.state === "failed" &&
        s.errorCode !== null &&
        SOURCE_REUPLOAD_ERROR_CODES.has(s.errorCode)
      )
        return {
          code: "reupload_required",
          instruction:
            "The worker could not verify the source bytes. Retrying the same bytes would fail again and the original upload is immutable. Ask the collector to provide corrected source (a new upload of the recording); the original stays untouched.",
        };
      const terminated = !s.holdsSlot && (s.hasEvidence || s.neverSubmitted);
      if (!terminated)
        return {
          code: "retry_blocked_termination_unproven",
          instruction: `The job is ${s.state} but the exact execution termination is not recorded, so capacity is still held and retry is blocked. Wait for the controller to record evidence. ${SPAWN_RULE}`,
        };
      return {
        code: "retry_available",
        instruction:
          "Termination is proven. Retry creates a new job with a new output location from the same immutable source.",
      };
    }
    default:
      return { code: "none", instruction: "No action." };
  }
}

// ------------------------------------------------------- cancel finalization

async function lockJob(tx: pg.PoolClient, jobId: string) {
  const rec = await tx.query<{ recording_id: string }>(
    "SELECT recording_id FROM jobs WHERE id = $1",
    [jobId],
  );
  if (!rec.rows[0]) return null;
  // Lock order: recording, then job.
  await tx.query("SELECT 1 FROM recordings WHERE id = $1 FOR UPDATE", [
    rec.rows[0].recording_id,
  ]);
  return rec.rows[0].recording_id;
}

/**
 * `cancel_requested` -> `cancelled` only with proof of termination. With a
 * recorded evidence row this is the exact physical proof SA-26 produced. When
 * nothing was ever submitted (no intent, ID or nonce), the evidence guard
 * itself accepts `pre_submission_rejected`, which the database verifies.
 * Completing the state with evidence present releases the slot (trigger).
 */
export async function finalizeCancellations(
  deps: Pick<JobsDeps, "pool">,
  input: { recordedBy: string; limit: number; jobId?: string },
): Promise<string[]> {
  const { rows } = await deps.pool.query<{ id: string }>(
    `SELECT id FROM jobs WHERE state = 'cancel_requested' AND ($2::uuid IS NULL OR id = $2::uuid)
     ORDER BY updated_at, id LIMIT $1`,
    [input.limit, input.jobId ?? null],
  );
  const done: string[] = [];
  for (const { id } of rows) {
    const finished = await boundedRun(deps.pool, async (tx) => {
      if (!(await lockJob(tx, id))) return false;
      const job = await tx.query<{
        state: string;
        recipe_parallel: boolean;
        never: boolean;
        holds: boolean;
        evidence: boolean;
        unfinished_stage: boolean;
      }>(
        `SELECT j.state, j.recipe_parallel,
           (j.submission_intent_at IS NULL AND j.execution_call_id IS NULL AND j.invocation_nonce IS NULL) AS never,
           EXISTS (SELECT 1 FROM dispatch_admission a WHERE a.slot = 1 AND a.job_id = j.id) AS holds,
           EXISTS (SELECT 1 FROM job_execution_evidence e WHERE e.job_id = j.id) AS evidence,
           EXISTS (
             SELECT 1 FROM job_stage_claims c
             LEFT JOIN job_stage_runs r ON r.job_id = c.job_id AND r.stage = c.stage
             WHERE c.job_id = j.id AND
               (r.state IS NULL OR r.state NOT IN ('succeeded', 'failed', 'cancelled'))
           ) AS unfinished_stage
         FROM jobs j WHERE j.id = $1 FOR UPDATE`,
        [id],
      );
      const j = job.rows[0];
      if (!j || j.state !== "cancel_requested") return false;
      // The controller records stage proof before settling the stage. A lost response
      // must leave the job available to the original workflow lease for re-entry.
      if (j.unfinished_stage) return false;
      const proven =
        j.evidence ||
        (j.recipe_parallel &&
          j.holds &&
          (await promoteRecipeEvidence(tx, id, input.recordedBy)));
      if (!proven) {
        // Unproven (possibly running): stays cancel_requested and holds capacity.
        if (!j.never || !j.holds) return false;
        await tx.query(
          `INSERT INTO job_execution_evidence (job_id, kind, execution_ref, detail, recorded_by)
           VALUES ($1, 'pre_submission_rejected', NULL, $2, $3)`,
          [
            id,
            JSON.stringify({ reason: "cancelled_before_submission" }),
            input.recordedBy,
          ],
        );
      }
      await tx.query(
        `UPDATE jobs SET state = 'cancelled', finished_at = now()
         WHERE id = $1 AND state = 'cancel_requested'`,
        [id],
      );
      return true;
    });
    if (finished) done.push(id);
  }
  return done;
}

// ------------------------------------------------------ lost/exhausted dispatch

/**
 * An admitted job whose controller never recorded a worker submission within
 * the dispatch window (the Render task was never started, lost, or its
 * controller exhausted its retries before submitting) is failed. This is safe
 * because the database proves no execution exists: intent is recorded only in
 * `submitting` by a live lease holder, so once the job is `failed` a late
 * controller is refused at every step. The pre-submission evidence is verified
 * by the evidence guard and releases the slot with the failed state.
 */
export async function failUndispatched(
  deps: RepairDeps,
  input: { recordedBy: string; limit: number; jobId?: string },
): Promise<string[]> {
  const lim = repairLimits(deps.config);
  const { rows } = await deps.pool.query<{ id: string }>(
    `SELECT id FROM jobs
     WHERE ($4::uuid IS NULL OR id = $4::uuid)
       AND state = 'submitting' AND submission_intent_at IS NULL
       AND admitted_at <= now() - make_interval(secs => $1)
       AND (controller_lease_expires_at IS NULL
            OR controller_lease_expires_at <= now() - make_interval(secs => $2))
     ORDER BY admitted_at, id LIMIT $3`,
    [
      lim.dispatchWindowSeconds,
      lim.leaseGraceSeconds,
      input.limit,
      input.jobId ?? null,
    ],
  );
  const failed: string[] = [];
  for (const { id } of rows) {
    const ok = await boundedRun(deps.pool, async (tx) => {
      if (!(await lockJob(tx, id))) return false;
      const j = (
        await tx.query<{ ok: boolean; run: string | null }>(
          `SELECT (j.state = 'submitting' AND j.submission_intent_at IS NULL AND j.execution_call_id IS NULL
                   AND j.invocation_nonce IS NULL
                   AND j.admitted_at <= now() - make_interval(secs => $2)
                   AND (j.controller_lease_expires_at IS NULL
                        OR j.controller_lease_expires_at <= now() - make_interval(secs => $3))
                   AND EXISTS (SELECT 1 FROM dispatch_admission a WHERE a.slot = 1 AND a.job_id = j.id)) AS ok,
                  j.workflow_run_ref AS run
           FROM jobs j WHERE j.id = $1 FOR UPDATE`,
          [id, lim.dispatchWindowSeconds, lim.leaseGraceSeconds],
        )
      ).rows[0];
      if (!j?.ok) return false;
      const code = j.run ? "controller_exhausted" : "dispatch_lost";
      await tx.query(
        `INSERT INTO job_execution_evidence (job_id, kind, execution_ref, detail, recorded_by)
         VALUES ($1, 'pre_submission_rejected', NULL, $2, $3)`,
        [id, JSON.stringify({ reason: code }), input.recordedBy],
      );
      await tx.query(
        `UPDATE jobs SET state = 'failed', error_code = $2, error_message = $3, finished_at = now()
         WHERE id = $1`,
        [
          id,
          code,
          code === "dispatch_lost"
            ? "The processing task was never started within the dispatch window"
            : "The controller ended before submitting any worker",
        ],
      );
      return true;
    });
    if (ok) failed.push(id);
  }
  return failed;
}

// ----------------------------------------------- uncertain / overdue visibility

/**
 * Surfaces executions that may have started but have no live controller:
 * - `submitting` WITH recorded intent and an expired lease: the spawn
 *   acknowledgement was lost -> `submit_unknown` (never resubmitted).
 * - `submit_unknown`/`running` past the immutable deadline with an expired
 *   lease and no evidence -> `needs_attention`.
 * Neither frees the slot and neither records evidence.
 */
export async function flagUncertain(
  deps: RepairDeps,
  input: { limit: number; jobId?: string },
): Promise<{ unknown: string[]; attention: string[] }> {
  const lim = repairLimits(deps.config);
  const out = { unknown: [] as string[], attention: [] as string[] };
  const lapsed = `(j.controller_lease_expires_at IS NULL
      OR j.controller_lease_expires_at <= now() - make_interval(secs => $2))`;
  const moves: Array<{
    to: "submit_unknown" | "attention";
    where: string;
  }> = [
    {
      to: "submit_unknown",
      where: `j.state = 'submitting' AND j.submission_intent_at IS NOT NULL AND ${lapsed}`,
    },
    {
      to: "attention",
      where: `j.state IN ('submit_unknown', 'running') AND j.execution_deadline <= now() AND ${lapsed}
              AND NOT EXISTS (SELECT 1 FROM job_execution_evidence e WHERE e.job_id = j.id)`,
    },
  ];
  for (const move of moves) {
    const { rows } = await deps.pool.query<{ id: string }>(
      `SELECT j.id FROM jobs j WHERE ($3::uuid IS NULL OR j.id = $3::uuid) AND ${move.where} ORDER BY j.updated_at, j.id LIMIT $1`,
      [input.limit, lim.leaseGraceSeconds, input.jobId ?? null],
    );
    for (const { id } of rows) {
      const hit = await boundedRun(deps.pool, async (tx) => {
        if (!(await lockJob(tx, id))) return false;
        const res = await tx.query(
          move.to === "submit_unknown"
            ? `UPDATE jobs j SET state = 'submit_unknown', unknown_at = COALESCE(unknown_at, now())
               WHERE j.id = $1 AND ${move.where}`
            : `UPDATE jobs j SET state = 'needs_attention', unknown_at = COALESCE(unknown_at, now())
               WHERE j.id = $1 AND ${move.where}`,
          [id, lim.leaseGraceSeconds],
        );
        return (res.rowCount ?? 0) > 0;
      });
      if (hit) (move.to === "attention" ? out.attention : out.unknown).push(id);
    }
  }
  return out;
}

// ----------------------------------------------------------------------- retry

export type RetryResult = {
  jobId: string;
  previousJobId: string;
  replayed: boolean;
};

/**
 * Operator retry. Creates a NEW queued job (new ID, so a new output prefix)
 * from the same immutable sealed source; the old attempt is untouched. The
 * request names the exact job and state the operator saw: a newer current job
 * or a different state refuses with no mutation. Replaying a retry that
 * already created the current successor returns it instead of another job.
 */
export async function retryJob(
  deps: Pick<JobsDeps, "pool">,
  input: { jobId: string; expectedState: string; newJobId?: string },
): Promise<RetryResult> {
  if (!UUID.test(input.jobId))
    throw new TransportError("invalid_request", "jobId must be a UUID");
  const newId = input.newJobId ?? randomUUID();
  return boundedRun(deps.pool, async (tx) => {
    const recordingId = await lockJob(tx, input.jobId);
    if (!recordingId) throw new TransportError("not_found", "Job not found");
    const rec = (
      await tx.query<{
        current_job_id: string | null;
        deleted_at: Date | null;
        status: string;
      }>(
        "SELECT current_job_id, deleted_at, status FROM recordings WHERE id = $1",
        [recordingId],
      )
    ).rows[0]!;
    // Prior canary jobs keep the same identity after their approved budgets change.
    const job = (
      await tx.query<{
        state: string;
        error_code: string | null;
        admitted_at: Date | null;
        profile_revision: string;
        source_manifest_sha256: string;
        public_video_canary: boolean;
      }>(
        `SELECT state, error_code, admitted_at, profile_revision, source_manifest_sha256,
                EXISTS (
                  SELECT 1 FROM job_inputs i WHERE i.job_id = $1
                    AND i.task_input->'recipe'->>'recipeId' = $2
                ) AS public_video_canary
         FROM jobs WHERE id = $1 FOR UPDATE`,
        [input.jobId, PUBLIC_VIDEO_RECIPE.recipeId],
      )
    ).rows[0]!;
    // Bind the request to the exact prior job AND the terminal state the operator
    // saw (a finished job's state is immutable, so a true replay always matches).
    if (job.state !== input.expectedState)
      throw refuse(
        "stale_state",
        `job is ${job.state}, not ${input.expectedState}`,
      );
    const successor = (
      await tx.query<{ id: string }>(
        "SELECT id FROM jobs WHERE previous_job_id = $1",
        [input.jobId],
      )
    ).rows[0];
    if (input.newJobId) {
      // HTTP retry: the client request ID IS the new job's ID. Only the same ID
      // for the same prior job replays; any other ID is refused, never a
      // second retry and never someone else's job.
      const taken = (
        await tx.query<{ previous_job_id: string | null }>(
          "SELECT previous_job_id FROM jobs WHERE id = $1",
          [newId],
        )
      ).rows[0];
      if (taken) {
        if (taken.previous_job_id === input.jobId && successor?.id === newId)
          return { jobId: newId, previousJobId: input.jobId, replayed: true };
        throw refuse(
          "request_id_in_use",
          "requestId already identifies a different job",
        );
      }
      if (successor)
        throw refuse(
          "already_retried",
          "this attempt was already retried by a different request",
        );
    } else if (successor) {
      // Operator CLI has no request ID: report the existing current successor.
      if (rec.current_job_id === successor.id)
        return {
          jobId: successor.id,
          previousJobId: input.jobId,
          replayed: true,
        };
      throw refuse(
        "stale_current_job",
        "this attempt was already retried and superseded",
      );
    }
    if (rec.current_job_id !== input.jobId)
      throw refuse(
        "stale_current_job",
        "the recording has a different current job",
      );
    if (job.state !== "failed" && job.state !== "cancelled")
      throw refuse(
        "not_terminal",
        job.state === "cancel_requested"
          ? "cancel_requested is not stopped; retry waits for exact termination evidence"
          : "only a failed or cancelled job can be retried",
      );
    if (job.public_video_canary)
      throw refuse(
        "canary_one_attempt",
        "public-video canary allows one approved attempt",
      );
    if (
      job.state === "failed" &&
      job.error_code &&
      SOURCE_REUPLOAD_ERROR_CODES.has(job.error_code)
    )
      throw refuse(
        "source_reupload_required",
        "the source bytes failed verification; request corrected source instead of retrying the same bytes",
      );
    if (job.admitted_at !== null) {
      const proof = await tx.query<{ evidence: boolean; holds: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM job_execution_evidence e WHERE e.job_id = $1) AS evidence,
                EXISTS (SELECT 1 FROM dispatch_admission a WHERE a.slot = 1 AND a.job_id = $1) AS holds`,
        [input.jobId],
      );
      if (!proof.rows[0]!.evidence || proof.rows[0]!.holds)
        throw refuse(
          "termination_unproven",
          "exact execution termination is not recorded; capacity is still held",
        );
    }
    if (
      rec.deleted_at !== null ||
      !["uploaded", "processing"].includes(rec.status)
    )
      throw refuse(
        "recording_not_processable",
        "the recording cannot be processed",
      );
    await tx.query(
      `INSERT INTO jobs (id, kind, recording_id, previous_job_id, source_manifest_sha256, profile_revision)
       VALUES ($1, 'process_recording', $2, $3, $4, $5)`,
      [
        newId,
        recordingId,
        input.jobId,
        job.source_manifest_sha256,
        job.profile_revision,
      ],
    );
    await tx.query(
      "UPDATE recordings SET current_job_id = $2, status = 'processing' WHERE id = $1",
      [recordingId, newId],
    );
    return { jobId: newId, previousJobId: input.jobId, replayed: false };
  });
}

// ------------------------------------------------------------- manual reconcile

/**
 * Operator reconcile for ONE job: re-evaluates it from authoritative facts and
 * applies only the same guarded, non-dispatching repair steps (finish a proven
 * cancellation, fail a provably never-submitted job, surface an uncertain
 * execution). It never starts, resubmits or records evidence by itself.
 */
export async function reconcileJob(
  deps: RepairDeps,
  input: { jobId: string; expectedState: string; recordedBy: string },
): Promise<RecoverySnapshot> {
  const before = await recoverySnapshot(deps.pool, input.jobId);
  if (!before.isCurrent || before.hasSuccessor)
    throw refuse("stale_current_job", "the recording has a newer job");
  if (before.state !== input.expectedState)
    throw refuse(
      "stale_state",
      `job is ${before.state}, not ${input.expectedState}`,
    );
  const one = { limit: 1, jobId: input.jobId };
  await finalizeCancellations(deps, { ...one, recordedBy: input.recordedBy });
  await failUndispatched(deps, { ...one, recordedBy: input.recordedBy });
  await flagUncertain(deps, one);
  return recoverySnapshot(deps.pool, input.jobId);
}

// ------------------------------------------------- capabilities (SA-34 seam)

/**
 * JobControlCapabilities backed by live rows: answers for the exact current
 * job and state, re-read on every request. `reconcile` is intentionally not
 * offered: repair is a machine pass, not an operator button.
 *
 * A control is advertised ONLY if its authenticated mutation is wired by the
 * caller (`wired`): the Pipeline route (SA-34) passes the kinds it actually
 * serves. The default is none, because the owner CLI is not a UI mutation.
 * `check_cancellation` is a read and `reupload_guidance` is state-derived
 * guidance (no mutation), so both are wired by the Pipeline page itself.
 */
export function jobControlCapabilities(
  pool: Pick<pg.Pool, "query">,
  wired: ReadonlySet<JobControlAction["kind"]> = new Set(),
): JobControlCapabilities {
  return {
    async forJob(input) {
      const s = await recoverySnapshot(pool, input.jobId).catch(
        (e: unknown) => {
          if (e instanceof TransportError && e.code === "not_found")
            return null;
          throw e;
        },
      );
      if (!s || s.recordingId !== input.recordingId || s.state !== input.state)
        return [];
      const g = operatorGuidance(s);
      const act = (kind: JobControlAction["kind"]): JobControlAction => ({
        kind,
        jobId: s.jobId,
        expectedState: s.state,
      });
      if (!s.isCurrent || s.hasSuccessor) return [];
      const offered = (kinds: JobControlAction["kind"][]) =>
        kinds.filter((k) => wired.has(k)).map(act);
      switch (g.code) {
        case "in_progress":
          return offered(["cancel"]);
        case "unknown_spawn":
        case "needs_operator":
          return offered(["cancel", "reconcile"]);
        case "cancel_pending_termination":
          return offered(["check_cancellation"]);
        case "retry_available":
          return offered(["retry"]);
        case "reupload_required":
          return offered(["reupload_guidance"]);
        default:
          return [];
      }
    },
  };
}

// ----------------------------------------------------------------- repair pass

export type RepairReport = {
  ran: boolean;
  cancelled: string[];
  failedUndispatched: string[];
  markedUnknown: string[];
  markedAttention: string[];
  dispatch: {
    available: boolean;
    started: Array<{ jobId: string; taskRunId: string }>;
    /** No usable acknowledgement; the job stays pending with the same key. */
    ambiguous: string[];
    skippedForBudget: string[];
  };
};

const REPAIR_LOCK = 0x5a27_0001;

/**
 * Runs the recovery steps and the bounded dispatch of pending jobs. A session
 * advisory lock makes concurrent repair passes (duplicate cron, retried
 * request) do nothing instead of racing; the Render idempotency key and the
 * database fences remain the safety net beyond that. Returns the still-pending
 * dispatches after the attempt so an unacknowledged start stays visible.
 */
export async function runRepair<A>(
  deps: JobsDeps,
  input: { recordedBy: string; startedAt?: number },
  admit: () => Promise<A>,
): Promise<{ report: RepairReport; pending: PendingDispatch[]; admission: A }> {
  const lim: RepairLimits = repairLimits(deps.config);
  const report: RepairReport = {
    ran: false,
    cancelled: [],
    failedUndispatched: [],
    markedUnknown: [],
    markedAttention: [],
    dispatch: {
      available: !!deps.taskStarter,
      started: [],
      ambiguous: [],
      skippedForBudget: [],
    },
  };
  const client = await deps.pool.connect();
  let locked = false;
  let poisoned = false;
  try {
    const got = await client.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_lock($1::bigint) AS ok",
      [REPAIR_LOCK],
    );
    locked = !!got.rows[0]?.ok;
    if (!locked) {
      const admission = await admit();
      return {
        report,
        admission,
        pending: await listPendingDispatches(deps, lim.batchLimit),
      };
    }
    report.ran = true;
    // The soft dispatch budget counts from the caller's pass start (so slow
    // SA-28 result repair before this call also consumes it).
    const started = input.startedAt ?? Date.now();
    const by = input.recordedBy;
    report.cancelled = await finalizeCancellations(deps, {
      recordedBy: by,
      limit: lim.batchLimit,
    });
    report.failedUndispatched = await failUndispatched(deps, {
      recordedBy: by,
      limit: lim.batchLimit,
    });
    const flagged = await flagUncertain(deps, { limit: lim.batchLimit });
    report.markedUnknown = flagged.unknown;
    report.markedAttention = flagged.attention;
    const admission = await admit();
    const pending = await listPendingDispatches(deps, lim.batchLimit);
    const starter = deps.taskStarter;
    if (starter) {
      for (const p of pending) {
        const left = lim.wallBudgetMs - (Date.now() - started);
        if (left < 1000) {
          report.dispatch.skippedForBudget.push(p.jobId);
          continue;
        }
        try {
          const run = await starter.start(
            { jobId: p.jobId, dispatchKey: p.dispatchKey },
            AbortSignal.timeout(Math.min(lim.startTimeoutMs, left)),
          );
          report.dispatch.started.push({
            jobId: p.jobId,
            taskRunId: run.taskRunId,
          });
        } catch {
          // Timeout, reset or rejection: no usable acknowledgement. Never retried
          // inside this pass; the next pass repeats the SAME idempotency key.
          report.dispatch.ambiguous.push(p.jobId);
        }
      }
    }
    return {
      report,
      admission,
      pending: await listPendingDispatches(deps, lim.batchLimit),
    };
  } finally {
    if (locked) {
      try {
        await client.query("SELECT pg_advisory_unlock($1::bigint)", [
          REPAIR_LOCK,
        ]);
      } catch {
        poisoned = true;
      }
    }
    client.release(poisoned);
  }
}
