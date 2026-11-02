import { randomUUID } from "node:crypto";
import {
  validateValue,
  type ControllerAction,
  type ControllerResult,
  type HeartbeatAck,
  type InputRead,
  type ReconcileResult,
} from "@stateaction/contracts";
import { TransportError } from "../transport/errors.js";
import { errorResponse, readBoundedJson } from "../transport/http.js";
import {
  admitNextJob,
  claimControllerLease,
  claimWorker,
  getJobStatus,
  listPendingDispatches,
  markSubmissionUnknown,
  parseExecutor,
  recordExecutionEvidence,
  recordExecutionRef,
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

/**
 * Framework-neutral job handlers. Authentication (machine capabilities for the
 * scope each route needs; never a human session) happens before these run, in
 * the Next binding. Every handler additionally rechecks live database state.
 */
export function jobHandlers(deps: () => JobsDeps) {
  return {
    /** Cron/controller repair: admit the next queued job; list undelivered dispatches. */
    reconcile: (_request: Request) =>
      respond(async () => {
        const d = deps();
        const admission = await admitNextJob(d);
        const pendingDispatches = await listPendingDispatches(d);
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
          pendingDispatches,
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
            case "record_execution_evidence":
              return recordExecutionEvidence(d, {
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
