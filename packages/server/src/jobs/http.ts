import { randomUUID } from "node:crypto";
import {
  validateBytes,
  validateValue,
  type ControllerActionV4,
  type ControllerResult,
  type HeartbeatAck,
  type InputRead,
  type ReconcileResult,
} from "@stateaction/contracts";
import {
  advanceResult,
  closeOutputs,
  repairResults,
  sealParallelRecipe,
  submitCandidate,
  type AcceptanceDeps,
  type CandidateBody,
  type OutputClosure,
  type ResultAck,
} from "../acceptance/service.js";
import { TransportError } from "../transport/errors.js";
import {
  errorResponse,
  readBoundedBytes,
  readBoundedJson,
} from "../transport/http.js";
import { runRepair } from "./recovery.js";
import { prepareStageRerun } from "./stage-rerun-preparation.js";
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
import {
  claimStage,
  getDagRun,
  getJobRecipe,
  getPriorStages,
  issueStageClaim,
  readStageOutput,
  recordStageHeartbeat,
  recordStageRun,
  stageOfCredential,
  startParallelRecipe,
} from "./stages.js";

/** controller-action.v2 bodies may carry a stage receipt (<= 64 KiB). */
const CONTROLLER_BODY_MAX_BYTES = 81920;

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

    /**
     * SA-91 controller reads (jobs:status): the admitted recipe (404 for a job without one) and
     * the recorded stage runs. Identity and budgets only; never spawn authority.
     */
    recipe: (_request: Request, jobId: string) =>
      respond(async () =>
        checked<Record<string, unknown>>(
          "jobs.recipe.v1",
          await getJobRecipe(deps(), jobId),
        ),
      ),
    priorStages: (_request: Request, jobId: string) =>
      respond(async () =>
        checked<Record<string, unknown>>(
          "jobs.prior-stages.v1",
          await getPriorStages(deps(), jobId),
        ),
      ),
    dagRun: (_request: Request, jobId: string) =>
      respond(async () =>
        checked<Record<string, unknown>>(
          "http.dag-run.v1",
          await getDagRun(deps(), jobId),
        ),
      ),

    prepareRerun: (request: Request, jobId: string) =>
      respond(async () => {
        const body = (await readBoundedJson(
          request,
          "jobs.rerun-preparation-command.v1",
          4096,
        )) as { owner: string };
        return checked(
          "jobs.rerun-preparation.v1",
          await prepareStageRerun(deps(), jobId, body.owner),
        );
      }),

    controller: (request: Request, jobId: string, principalId: string) =>
      respond(async () => {
        const a = (await readBoundedJson(
          request,
          "jobs.controller-action.v4",
          CONTROLLER_BODY_MAX_BYTES,
        )) as ControllerActionV4;
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
            case "start_parallel_recipe":
              return {
                recorded: await startParallelRecipe(d.pool, jobId, a.owner),
              };
            case "seal_parallel_recipe": {
              if (!d.sealTransport)
                throw new TransportError(
                  "provider_unavailable",
                  "Seal transport is not configured",
                );
              const recorded = await sealParallelRecipe(
                acceptanceOf(d),
                jobId,
                a.owner,
                principalId,
                d.sealTransport(),
              );
              await advanceQuietly(d, jobId);
              return { recorded };
            }
            case "issue_stage_claim": {
              const r = await issueStageClaim(d, {
                jobId,
                owner: a.owner,
                stage: a.stage,
              });
              return r.state === "recorded"
                ? {
                    ...r,
                    startDeadline: iso(r.startDeadline),
                    executionDeadline: iso(r.executionDeadline),
                  }
                : r;
            }
            case "record_stage_run":
              return recordStageRun(d, {
                jobId,
                owner: a.owner,
                stage: a.stage,
                state: a.state,
                module: a.module,
                callId: a.callId,
                errorCode: a.errorCode,
                receipt: a.receipt,
              });
          }
        };
        return checked<ControllerResult>(
          "jobs.controller-result.v1",
          await out(),
        );
      }),

    claim: (request: Request, jobId: string, principalId = "") =>
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
        // A stage bootstrap (SA-88 recipe job) claims exactly its stage.
        if (stageOfCredential(principalId))
          return claimStage(deps(), {
            jobId,
            bootstrapToken: bearer(request),
            invocationNonce: body.invocationNonce,
            executor: parseExecutor(body.executor),
          });
        return claimWorker(deps(), {
          jobId,
          bootstrapToken: bearer(request),
          invocationNonce: body.invocationNonce,
          executor: parseExecutor(body.executor),
        });
      }),

    heartbeat: (request: Request, jobId: string, principalId = "") =>
      respond(async () => {
        // heartbeat.v2 (SA-88) names the stage; v1 stays the single-claim path.
        const bytes = await readBoundedBytes(request);
        let version: unknown;
        try {
          version = (
            JSON.parse(new TextDecoder().decode(bytes)) as {
              schemaVersion?: unknown;
            }
          )?.schemaVersion;
        } catch {
          version = undefined;
        }
        const contract =
          version === 2 ? "jobs.heartbeat.v2" : "jobs.heartbeat.v1";
        const parsed = validateBytes(contract, bytes);
        if (!parsed.valid)
          throw bad(
            `${contract}: ${parsed.code}${parsed.errors[0] ? ` at ${parsed.errors[0].path || "/"}` : ""}`,
          );
        const body = parsed.value as {
          jobId: string;
          invocationNonce: string;
          stage?: "segment" | "caption" | "hand_pose";
          phase: string;
          processedFrames?: string;
          totalFrames?: string | null;
        };
        if (body.jobId !== jobId) throw bad("jobId does not match the route");
        const caller = stageOfCredential(principalId);
        if (
          body.stage !== undefined &&
          caller !== null &&
          caller !== body.stage
        )
          throw new TransportError(
            "forbidden",
            "Heartbeat stage does not match the capability",
          );
        const r =
          body.stage !== undefined
            ? await recordStageHeartbeat(deps(), {
                jobId,
                stage: body.stage,
                invocationNonce: body.invocationNonce,
                phase: body.phase,
                processedFrames: body.processedFrames,
                totalFrames: body.totalFrames,
              })
            : await recordHeartbeat(deps(), {
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
      respond(async () => {
        const task = await readTaskInput(deps(), { jobId });
        return checked<Record<string, unknown>>(
          task.schemaVersion === 3
            ? "jobs.task-input.v3"
            : "jobs.task-input.v2",
          task,
        );
      }),

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

    /**
     * POST /internal/v1/jobs/{id}/outputs/{fileId}/read (SA-88): the caption
     * stage reads the completed segments_json output of the same job.
     */
    outputRead: (
      _request: Request,
      jobId: string,
      fileId: string,
      principalId = "",
    ) =>
      respond(async () => {
        const body = await readStageOutput(deps(), {
          jobId,
          fileId,
          stage: stageOfCredential(principalId),
        });
        if (new URL(_request.url).searchParams.get("version") === "2")
          return checked("jobs.stage-input-read.v1", body);
        const { producerJobId: _producer, ...legacy } = body;
        return checked<InputRead>("http.input-read.v1", legacy);
      }),
  };
}
export type JobHandlers = ReturnType<typeof jobHandlers>;
