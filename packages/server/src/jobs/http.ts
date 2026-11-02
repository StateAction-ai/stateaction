import { randomUUID } from "node:crypto";
import {
  validateValue,
  type ControllerAction,
  type ControllerResult,
  type HeartbeatAck,
  type InputRead,
  type ReconcileResult,
} from "@stateaction/contracts";
import {
  advanceResult,
  closeOutputs,
  repairResults,
  submitCandidate,
  type AcceptanceDeps,
  type CandidateBody,
  type OutputClosure,
  type ResultAck,
} from "../acceptance/service.js";
import { TransportError } from "../transport/errors.js";
import { errorResponse, readBoundedJson } from "../transport/http.js";
import { runRepair } from "./recovery.js";
import {
  admitNextJob,
  claimControllerLease,
  claimWorker,
  getJobStatus,
  markSubmissionUnknown,
  parseExecutor,
  recordExecutionEvidence,
  recordExecutionRef,
  readTaskInput,
  recordHeartbeat,
  recordWorkerSubmissionIntent,
  recordWorkflowRun,
  refreshInputReadUrl,
  renewControllerLease,
  type JobsDeps,
} from "./service.js";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      // Responses may carry bearer capabilities or signed URLs: never cache.
      "cache-control": "private, no-store, max-age=0",
    },
  });
}

async function respond(work: () => Promise<unknown>): Promise<Response> {
  const requestId = randomUUID();
  try {
    return json(200, { data: await work(), requestId });
  } catch (error) {
    if (!(error instanceof TransportError))
      console.error("[jobs] unexpected error", error);
    return errorResponse(error, requestId);
  }
}

const bad = (m: string) => new TransportError("invalid_request", m);

function bearer(request: Request): string {
  const match = /^Bearer (\S+)$/.exec(
    request.headers.get("authorization") ?? "",
  );
  if (!match?.[1]) throw new TransportError("forbidden", "Bearer required");
  return match[1];
}

/**
 * Every response is validated against its published catalog.v7 contract before
 * it is sent: a server bug fails closed (500) rather than leaking a shape SA-26
 * does not expect.
 */
function checked<T>(contract: string, doc: unknown): T {
  const result = validateValue(contract, doc);
  if (!result.valid)
    throw new Error(`${contract} response invalid: ${result.code}`);
  return doc as T;
}

const iso = (d: Date) => d.toISOString();

function acceptanceOf(d: JobsDeps): AcceptanceDeps {
  if (!d.acceptance)
    throw new TransportError(
      "provider_unavailable",
      "Output acceptance is not configured",
    );
  return { pool: d.pool, ...d.acceptance };
}

/** Best-effort acceptance step after an event; reconcile repairs a failure. */
async function advanceQuietly(d: JobsDeps, jobId: string): Promise<void> {
  if (!d.acceptance) return;
  try {
    await advanceResult(acceptanceOf(d), jobId);
  } catch (error) {
    console.error(
      "[jobs] acceptance step failed",
      error instanceof Error ? error.name : "error",
    );
  }
}

/**
 * Framework-neutral job handlers. Authentication (machine capabilities for the
 * scope each route needs; never a human session) happens before these run, in
 * the Next binding. Every handler additionally rechecks live database state.
 */
export function jobHandlers(deps: () => JobsDeps) {
  return {
    /**
     * Cron repair pass (jobs:repair). Bounded and finite: finalize proven
     * cancellations, fail jobs whose dispatch is provably lost, surface
     * uncertain executions, admit the next queued job and (re)start the Render
     * task for undelivered dispatches with the fixed `job:{id}` key. The caller
     * holds only this API capability; the Render start authority is the API's.
     */
    reconcile: (_request: Request, principalId = "repair") =>
      respond(async () => {
        const passStart = Date.now();
        const d = deps();
        // Repair first: a result whose facts are now complete frees the slot
        // before this pass tries to admit the next job.
        if (d.acceptance) await repairResults(acceptanceOf(d));
        const { report, pending, admission } = await runRepair(
          d,
          {
            recordedBy: `repair:${principalId}`.slice(0, 200),
            startedAt: passStart,
          },
          () => admitNextJob(d),
        );
        // Counts and IDs only: no tokens, URLs or credentials.
        console.log(
          "[jobs] repair",
          JSON.stringify({
            ran: report.ran,
            cancelled: report.cancelled.length,
            failedUndispatched: report.failedUndispatched.length,
            markedUnknown: report.markedUnknown.length,
            markedAttention: report.markedAttention.length,
            dispatchAvailable: report.dispatch.available,
            started: report.dispatch.started.length,
            ambiguous: report.dispatch.ambiguous,
            pending: pending.length,
          }),
        );
        return checked<ReconcileResult>("jobs.reconcile-result.v1", {
          admission:
            admission.state === "admitted"
              ? {
                  state: "admitted",
                  jobId: admission.job.jobId,
                  dispatchKey: admission.job.dispatchKey,
                  executionDeadline: iso(admission.job.executionDeadline),
                }
              : admission,
          pendingDispatches: pending,
        });
      }),

    status: (_request: Request, jobId: string) =>
      respond(() => getJobStatus(deps(), jobId)),

    controller: (request: Request, jobId: string, principalId: string) =>
      respond(async () => {
        const a = (await readBoundedJson(
          request,
          "jobs.controller-action.v1",
          4096,
        )) as ControllerAction;
        const d = deps();
        const out = async (): Promise<unknown> => {
          switch (a.action) {
            case "record_workflow_run":
              return recordWorkflowRun(d, { jobId, runRef: a.runRef });
            case "claim_lease": {
              const r = await claimControllerLease(d, {
                jobId,
                runRef: a.runRef,
                owner: a.owner,
              });
              return r.granted
                ? { granted: true, expiresAt: iso(r.expiresAt) }
                : r;
            }
            case "renew_lease": {
              const r = await renewControllerLease(d, {
                jobId,
                owner: a.owner,
              });
              return r.renewed
                ? { renewed: true, expiresAt: iso(r.expiresAt!) }
                : { renewed: false };
            }
            case "record_worker_submission": {
              const r = await recordWorkerSubmissionIntent(d, {
                jobId,
                owner: a.owner,
              });
              return r.state === "recorded"
                ? {
                    ...r,
                    startDeadline: iso(r.startDeadline),
                    executionDeadline: iso(r.executionDeadline),
                  }
                : r;
            }
            case "record_execution":
              return recordExecutionRef(d, {
                jobId,
                owner: a.owner,
                executor: parseExecutor(a.executor),
              });
            case "mark_submit_unknown":
              return markSubmissionUnknown(d, { jobId, owner: a.owner });
            case "record_execution_evidence": {
              const recorded = await recordExecutionEvidence(d, {
                jobId,
                recordedBy: principalId,
                evidence:
                  a.evidence.kind === "pre_submission_rejected"
                    ? { kind: a.evidence.kind, detail: a.evidence.detail }
                    : {
                        kind: a.evidence.kind,
                        executionRef: a.evidence.executionRef,
                        detail: a.evidence.detail,
                      },
              });
              // Either arrival order converges here: the evidence may be the
              // last fact an already verified result was waiting for.
              await advanceQuietly(d, jobId);
              const held = await d.pool.query(
                "SELECT 1 FROM dispatch_admission WHERE slot = 1 AND job_id = $1",
                [jobId],
              );
              return { ...recorded, slotReleased: held.rowCount === 0 };
            }
          }
        };
        return checked<ControllerResult>(
          "jobs.controller-result.v1",
          await out(),
        );
      }),

    claim: (request: Request, jobId: string) =>
      respond(async () => {
        const body = (await readBoundedJson(
          request,
          "jobs.worker-claim.v1",
        )) as {
          jobId: string;
          invocationNonce: string;
          executor: unknown;
        };
        if (body.jobId !== jobId) throw bad("jobId does not match the route");
        return claimWorker(deps(), {
          jobId,
          bootstrapToken: bearer(request),
          invocationNonce: body.invocationNonce,
          executor: parseExecutor(body.executor),
        });
      }),

    heartbeat: (request: Request, jobId: string) =>
      respond(async () => {
        const body = (await readBoundedJson(request, "jobs.heartbeat.v1")) as {
          jobId: string;
          invocationNonce: string;
          phase: string;
          processedFrames?: string;
          totalFrames?: string | null;
        };
        if (body.jobId !== jobId) throw bad("jobId does not match the route");
        const r = await recordHeartbeat(deps(), {
          jobId,
          invocationNonce: body.invocationNonce,
          phase: body.phase,
          processedFrames: body.processedFrames,
          totalFrames: body.totalFrames,
        });
        return checked<HeartbeatAck>("jobs.heartbeat-ack.v1", {
          accepted: true,
          executionDeadline: iso(r.executionDeadline),
        });
      }),

    /** GET /internal/v1/jobs/{id}/task-input: the admitted task input of the claimed job. */
    taskInput: (_request: Request, jobId: string) =>
      respond(async () =>
        checked<Record<string, unknown>>(
          "jobs.task-input.v2",
          await readTaskInput(deps(), { jobId }),
        ),
      ),

    /** POST /internal/v1/jobs/{id}/outputs/close: seal the output inventory. */
    closeOutputs: (request: Request, jobId: string) =>
      respond(async () => {
        const body = (await readBoundedJson(
          request,
          "jobs.output-close.v1",
        )) as {
          jobId: string;
          invocationNonce: string;
          outcome: "succeeded" | "failed";
        };
        if (body.jobId !== jobId) throw bad("jobId does not match the route");
        return checked<OutputClosure>(
          "jobs.output-closure.v1",
          await closeOutputs(acceptanceOf(deps()), {
            jobId,
            invocationNonce: body.invocationNonce,
            outcome: body.outcome,
          }),
        );
      }),

    /** POST /internal/v1/jobs/{id}/result: provisional candidate; selects nothing. */
    result: (request: Request, jobId: string) =>
      respond(async () => {
        const body = (await readBoundedJson(
          request,
          "jobs.result-candidate.v1",
        )) as CandidateBody;
        if (body.jobId !== jobId) throw bad("jobId does not match the route");
        const a = acceptanceOf(deps());
        const received = await submitCandidate(a, body);
        let ack: ResultAck = received;
        try {
          ack = (await advanceResult(a, jobId)) ?? received;
        } catch (error) {
          // The candidate is durably recorded; reconcile continues the work.
          console.error(
            "[jobs] acceptance step failed",
            error instanceof Error ? error.name : "error",
          );
        }
        return checked<ResultAck>("jobs.result-ack.v1", ack);
      }),

    inputRead: (_request: Request, jobId: string, fileId: string) =>
      respond(async () =>
        checked<InputRead>(
          "http.input-read.v1",
          await refreshInputReadUrl(deps(), { jobId, fileId }),
        ),
      ),
  };
}
export type JobHandlers = ReturnType<typeof jobHandlers>;
