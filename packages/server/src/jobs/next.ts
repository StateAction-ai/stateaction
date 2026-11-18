import "server-only";
import { errorResponse as authError, newRequestId } from "../auth/http.js";
import { authRuntime, type AuthRuntime } from "../auth/runtime.js";
import {
  authenticateService,
  type ServiceCredentialStore,
  type ServiceKind,
  type ServiceScope,
} from "../auth/service.js";
import { serverConfig } from "../config.js";
import { acceptanceConfigFromEnv } from "../acceptance/config.js";
import { s3ObjectHasher } from "../acceptance/storage.js";
import { s3ObjectReader } from "../admission/object-reader.js";
import { presignObject } from "../storage.js";
import { JobCapabilityStore, WORKER_AUDIENCE } from "../transport/runtime.js";
import {
  BootstrapCapabilityStore,
  ControllerCapabilityStore,
  RUNNING_WORKER_SCOPES,
} from "./credentials.js";
import { jobsConfigFromEnv } from "./config.js";
import { jobHandlers, type JobHandlers } from "./http.js";
import type { JobsDeps } from "./service.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const notFound = () =>
  new Response(
    JSON.stringify({
      error: { code: "not_found", message: "Job not found", retryable: false },
      requestId: newRequestId(),
    }),
    {
      status: 404,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    },
  );

export function jobsDepsFromEnv(
  pool: AuthRuntime["pool"],
  env: NodeJS.ProcessEnv = process.env,
): JobsDeps {
  const config = serverConfig(env);
  return {
    pool,
    config: jobsConfigFromEnv(env),
    presignRead: (key, expiresInSeconds) =>
      presignObject(config, { method: "GET", key, expiresInSeconds }),
    acceptance: {
      config: acceptanceConfigFromEnv(env),
      reader: s3ObjectReader(config, { timeoutMs: 15000 }),
      hasher: s3ObjectHasher(config),
    },
  };
}

type Holder = { [KEY]?: JobHandlers };
const KEY = Symbol.for("stateaction.jobs.handlers");

/**
 * Route bindings for /internal/v1/jobs. Every route authenticates a MACHINE
 * capability (operator-issued controller/cron credential, the private worker
 * bootstrap, or the running worker capability); Better Auth cookies and
 * custom user tokens are never consulted. Same code runs locally and hosted.
 */
export function jobRouteHandlers(
  get: () => AuthRuntime = authRuntime,
  depsFor: (pool: AuthRuntime["pool"]) => JobsDeps = (pool) =>
    jobsDepsFromEnv(pool),
) {
  const handlers = (): JobHandlers => {
    const holder = globalThis as Holder;
    if (holder[KEY]) return holder[KEY];
    return (holder[KEY] = jobHandlers(() => depsFor(get().pool)));
  };
  const unavailable = () =>
    authError(
      "provider_unavailable",
      "Job service is temporarily unavailable",
      newRequestId(),
    );

  async function guarded(
    request: Request,
    jobId: string | null,
    storeFor: (pool: AuthRuntime["pool"]) => ServiceCredentialStore,
    requirement: { kinds: ServiceKind[]; scope: ServiceScope },
    run: (h: JobHandlers, principalId: string) => Promise<Response>,
  ): Promise<Response> {
    if (jobId !== null && !UUID.test(jobId)) return notFound();
    let pool: AuthRuntime["pool"];
    let h: JobHandlers;
    try {
      pool = get().pool;
      h = handlers();
    } catch (error) {
      console.error(
        "[jobs] runtime unavailable",
        error instanceof Error ? error.message : error,
      );
      return unavailable();
    }
    const auth = await authenticateService(request, storeFor(pool), {
      audience: WORKER_AUDIENCE,
      kinds: requirement.kinds,
      scope: requirement.scope,
      ...(jobId ? { jobId } : {}),
    });
    if (!auth.ok) return auth.response;
    return run(h, auth.principal.credentialId);
  }

  const controller = (pool: AuthRuntime["pool"]) =>
    new ControllerCapabilityStore(pool);
  const worker = (pool: AuthRuntime["pool"]) =>
    new JobCapabilityStore(pool, RUNNING_WORKER_SCOPES);
  const fileOk = (id: string) => UUID.test(id);

  return {
    reconcile: (request: Request) =>
      guarded(
        request,
        null,
        controller,
        { kinds: ["cron", "workflow"], scope: "jobs:repair" },
        (h) => h.reconcile(request),
      ),
    status: (request: Request, jobId: string) =>
      guarded(
        request,
        jobId,
        controller,
        { kinds: ["workflow", "cron"], scope: "jobs:status" },
        (h) => h.status(request, jobId),
      ),
    controller: (request: Request, jobId: string) =>
      guarded(
        request,
        jobId,
        controller,
        { kinds: ["workflow"], scope: "jobs:reconcile" },
        (h, principal) => h.controller(request, jobId, principal),
      ),
    claim: (request: Request, jobId: string) =>
      guarded(
        request,
        jobId,
        (pool) => new BootstrapCapabilityStore(pool),
        { kinds: ["worker"], scope: "job:claim" },
        (h) => h.claim(request, jobId),
      ),
    heartbeat: (request: Request, jobId: string) =>
      guarded(
        request,
        jobId,
        worker,
        { kinds: ["worker"], scope: "job:heartbeat" },
        (h) => h.heartbeat(request, jobId),
      ),
    taskInput: (request: Request, jobId: string) =>
      guarded(
        request,
        jobId,
        worker,
        { kinds: ["worker"], scope: "job:input" },
        (h) => h.taskInput(request, jobId),
      ),
    closeOutputs: (request: Request, jobId: string) =>
      guarded(
        request,
        jobId,
        worker,
        { kinds: ["worker"], scope: "job:output" },
        (h) => h.closeOutputs(request, jobId),
      ),
    result: (request: Request, jobId: string) =>
      guarded(
        request,
        jobId,
        worker,
        { kinds: ["worker"], scope: "job:result" },
        (h) => h.result(request, jobId),
      ),
    inputRead: (request: Request, jobId: string, fileId: string) =>
      fileOk(fileId)
        ? guarded(
            request,
            jobId,
            worker,
            { kinds: ["worker"], scope: "job:input" },
            (h) => h.inputRead(request, jobId, fileId),
          )
        : Promise.resolve(notFound()),
  };
}
