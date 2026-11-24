import type pg from "pg";
import type { Stage } from "@stateaction/contracts";
import { boundedRun } from "./service.js";

export type ModalStartupProof = {
  callId: string;
  inputId: string;
  status: "init_failure" | "terminated";
  outputCreatedAt: number;
};
export type ModalStartupRecovery = {
  jobId: string;
  runRef: string;
  stage: Stage;
  callId: string;
};

const active = new Set([
  "submitting",
  "submit_unknown",
  "running",
  "needs_attention",
  "cancel_requested",
]);
const stageOpen = new Set(["submitting", "submit_unknown", "running"]);

/** Operator shell only. The observer queries Modal directly, before acquiring database locks. */
export async function recoverModalStartupFailure(
  pool: pg.Pool,
  input: ModalStartupRecovery,
  observe: (callId: string) => Promise<ModalStartupProof>,
) {
  const { jobId, runRef, stage, callId } = input;
  if (
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(jobId) ||
    !/^fc-[A-Za-z0-9]{1,77}$/.test(callId)
  )
    throw new Error("Expected a job UUID and a Modal call ID");

  const proof = await observe(callId);
  if (
    proof.callId !== callId ||
    !/^in-[A-Za-z0-9]{1,77}$/.test(proof.inputId) ||
    !Number.isFinite(proof.outputCreatedAt) ||
    proof.outputCreatedAt <= 0 ||
    (proof.status !== "init_failure" && proof.status !== "terminated")
  )
    throw new Error("Invalid Modal startup evidence");

  const reason =
    proof.status === "init_failure"
      ? "startup_failure"
      : "terminated_before_start";
  return boundedRun(pool, async (tx) => {
    const target = await tx.query<{ recording_id: string }>(
      "SELECT recording_id FROM jobs WHERE id = $1",
      [jobId],
    );
    if (!target.rows[0]) throw new Error("Job not found");
    const recording = await tx.query<{ current_job_id: string | null }>(
      "SELECT current_job_id FROM recordings WHERE id = $1 FOR UPDATE",
      [target.rows[0].recording_id],
    );
    const job = (
      await tx.query<{
        state: string;
        owner: string | null;
        lease_live: boolean | null;
        holds: boolean;
        has_candidate: boolean;
        error_code: string | null;
      }>(
        `SELECT j.state, j.controller_lease_owner AS owner,
                j.controller_lease_expires_at > clock_timestamp() AS lease_live,
                j.error_code,
                EXISTS (SELECT 1 FROM dispatch_admission a WHERE a.slot = 1 AND a.job_id = j.id) AS holds,
                EXISTS (SELECT 1 FROM job_result_candidates p WHERE p.job_id = j.id) AS has_candidate
         FROM jobs j
         WHERE j.id = $1 AND j.workflow_run_ref = $2 AND j.recipe IS NOT NULL
           AND j.execution_backend = 'modal'
         FOR UPDATE`,
        [jobId, runRef],
      )
    ).rows[0];
    const latest = (
      await tx.query<{
        stage: string;
        call_id: string | null;
        module: string | null;
        state: string | null;
        error_code: string | null;
        claimed_at: Date | null;
        claimed_call: string | null;
      }>(
        `SELECT c.stage, c.claimed_at, c.call_id AS claimed_call,
                r.call_id, r.state, r.module, r.error_code
         FROM job_stage_claims c
         LEFT JOIN job_stage_runs r ON r.job_id = c.job_id AND r.stage = c.stage
         WHERE c.job_id = $1
         ORDER BY job_stage_ord(c.stage) DESC LIMIT 1`,
        [jobId],
      )
    ).rows[0];
    if (
      !job ||
      !latest ||
      latest.stage !== stage ||
      latest.call_id !== callId ||
      latest.claimed_at !== null ||
      latest.claimed_call !== null ||
      latest.module === null
    )
      throw new Error(
        "The call is not the latest unclaimed stage of this Modal run",
      );

    const previous = (
      await tx.query<{
        kind: string;
        execution_ref: string;
        detail: Record<string, unknown>;
      }>(
        "SELECT kind, execution_ref, detail FROM job_execution_evidence WHERE job_id = $1",
        [jobId],
      )
    ).rows[0];
    if (
      (job.state === "failed" || job.state === "cancelled") &&
      !job.holds &&
      job.error_code === reason &&
      latest.state === "failed" &&
      latest.error_code === reason &&
      previous?.kind === "provider_call_terminal" &&
      previous.execution_ref === callId &&
      previous.detail.proof === "modal_terminal_before_input_start" &&
      previous.detail.inputId === proof.inputId &&
      previous.detail.providerStatus === proof.status
    )
      return {
        state: job.state,
        stageState: "failed",
        reason,
        replayed: true,
      } as const;

    if (
      !active.has(job.state) ||
      !job.owner ||
      job.lease_live !== false ||
      !job.holds ||
      job.has_candidate ||
      previous ||
      recording.rows[0]?.current_job_id !== jobId ||
      !latest.state ||
      !stageOpen.has(latest.state)
    )
      throw new Error(
        "The job is not a current, held submission with an expired controller lease",
      );

    const detail = JSON.stringify({
      proof: "modal_terminal_before_input_start",
      inputId: proof.inputId,
      providerStatus: proof.status,
      outputCreatedAt: proof.outputCreatedAt,
      runRef,
    });
    const recordedBy = "operator:modal_startup_recovery";
    await tx.query(
      "SELECT job_stage_record_evidence($1, 'provider_call_terminal', $2, $3::jsonb, $4)",
      [jobId, callId, detail, recordedBy],
    );
    await tx.query(
      `INSERT INTO job_execution_evidence (job_id, kind, execution_ref, detail, recorded_by)
       VALUES ($1, 'provider_call_terminal', $2, $3::jsonb, $4)`,
      [jobId, callId, detail, recordedBy],
    );

    const state = job.state === "cancel_requested" ? "cancelled" : "failed";
    await tx.query(
      "UPDATE jobs SET state = $2, error_code = $3, finished_at = now() WHERE id = $1",
      [jobId, state, reason],
    );
    // A terminal job permits the last recorded lease owner to settle a stage.
    // The stage update and the trigger-driven release commit together.
    await tx.query(
      "SELECT job_stage_record_run($1, $2, $3, 'failed', $4, $5, $6, NULL, NULL)",
      [jobId, job.owner, stage, latest.module, callId, reason],
    );
    return { state, stageState: "failed", reason, replayed: false } as const;
  });
}
