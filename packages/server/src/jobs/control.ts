import { randomUUID } from "node:crypto";
import type pg from "pg";
import { validateValue } from "@stateaction/contracts";
import type { DatasetAuthenticate } from "../datasets/http.js";
import { TransportError } from "../transport/errors.js";
import { errorResponse, readBoundedJson } from "../transport/http.js";
import {
  operatorGuidance,
  reconcileJob,
  recoverySnapshot,
  retryJob,
} from "./recovery.js";
import type { JobsConfig } from "./config.js";
import { requestJobCancel } from "./service.js";
import { getDagRun } from "./stages.js";

/**
 * POST /api/v1/jobs/{jobId}/control (staff only): the real authenticated
 * mutation behind the Pipeline cancel/retry/reconcile controls. Authentication
 * is injected (production: the Better Auth staff guard with origin,
 * Fetch-Metadata and client-header checks on this mutation; bearer credentials
 * refused). Every action reuses the recovery functions the repair pass and the
 * owner CLI use and is fenced to the exact current job and state the operator
 * saw. Nothing here starts, resubmits or records execution evidence.
 */
export type JobControlDeps = {
  pool: pg.Pool;
  config: Pick<JobsConfig, "repair">;
  authenticate: DatasetAuthenticate;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const JSON_HEADERS = {
  "content-type": "application/json",
  "cache-control": "private, no-store, max-age=0",
  pragma: "no-cache",
  vary: "Cookie, Authorization",
};

type Command = {
  requestId: string;
  action: "cancel" | "retry" | "reconcile";
  jobId: string;
  expectedState: string;
};

export function jobControlRoutes(deps: JobControlDeps) {
  return {
    control: async (request: Request, jobId: string): Promise<Response> => {
      const auth = await deps.authenticate(request, "staff");
      if (!auth.ok) return auth.response;
      const requestId = auth.requestId ?? randomUUID();
      const finish = (status: number, body: unknown) => {
        const headers = new Headers(auth.headers);
        for (const [k, v] of Object.entries(JSON_HEADERS)) headers.set(k, v);
        return new Response(JSON.stringify(body), { status, headers });
      };
      try {
        if (!UUID.test(jobId))
          throw new TransportError("not_found", "Job not found");
        const body = (await readBoundedJson(
          request,
          "http.job-control-command.v1",
          4096,
        )) as Command;
        if (body.jobId !== jobId)
          throw new TransportError(
            "invalid_request",
            "jobId does not match the route",
          );
        const by = `staff:${auth.principal.userId}`.slice(0, 200);
        let retryJobId: string | null = null;
        let replayed = false;
        if (body.action === "cancel") {
          await requestJobCancel({ pool: deps.pool }, jobId, {
            expectedState: body.expectedState,
            requireCurrent: true,
          });
        } else if (body.action === "retry") {
          const out = await retryJob(
            { pool: deps.pool },
            {
              jobId,
              expectedState: body.expectedState,
              newJobId: body.requestId,
            },
          );
          retryJobId = out.jobId;
          replayed = out.replayed;
        } else {
          await reconcileJob(deps, {
            jobId,
            expectedState: body.expectedState,
            recordedBy: by,
          });
        }
        const snap = await recoverySnapshot(deps.pool, jobId);
        const result = {
          action: body.action,
          jobId,
          state: snap.state,
          retryJobId,
          replayed,
          guidance: operatorGuidance(snap),
        };
        const valid = validateValue("http.job-control-result.v1", result);
        if (!valid.valid)
          throw new Error(`job control result invalid: ${valid.code}`);
        return finish(replayed ? 200 : body.action === "retry" ? 201 : 200, {
          data: result,
          requestId,
        });
      } catch (error) {
        if (!(error instanceof TransportError))
          console.error(
            "[jobs] control error",
            error instanceof Error ? error.name : "error",
          );
        const res = errorResponse(error, requestId);
        const headers = new Headers(auth.headers);
        for (const [k, v] of res.headers) headers.set(k, v);
        return new Response(res.body, { status: res.status, headers });
      }
    },
  };
}
export type JobControlRoutes = ReturnType<typeof jobControlRoutes>;

/**
 * GET /api/v1/jobs/{jobId}/dag-run (staff only, SA-88): http.dag-run.v1
 * rendered from the recorded stage runs plus the admitted recipe. Read-only;
 * the same staff session guard as the control route.
 */
export function jobDagRunRoutes(
  deps: Pick<JobControlDeps, "pool" | "authenticate">,
) {
  return {
    dagRun: async (request: Request, jobId: string): Promise<Response> => {
      const auth = await deps.authenticate(request, "staff");
      if (!auth.ok) return auth.response;
      const requestId = auth.requestId ?? randomUUID();
      const headers = new Headers(auth.headers);
      try {
        if (!UUID.test(jobId))
          throw new TransportError("not_found", "Job not found");
        const data = await getDagRun({ pool: deps.pool }, jobId);
        for (const [k, v] of Object.entries(JSON_HEADERS)) headers.set(k, v);
        return new Response(JSON.stringify({ data, requestId }), {
          status: 200,
          headers,
        });
      } catch (error) {
        if (!(error instanceof TransportError))
          console.error(
            "[jobs] dag-run error",
            error instanceof Error ? error.name : "error",
          );
        const res = errorResponse(error, requestId);
        for (const [k, v] of res.headers) headers.set(k, v);
        return new Response(res.body, { status: res.status, headers });
      }
    },
  };
}
export type JobDagRunRoutes = ReturnType<typeof jobDagRunRoutes>;
