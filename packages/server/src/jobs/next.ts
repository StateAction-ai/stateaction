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
import { presignObject, storageClient } from "../storage.js";
import { S3ReadSigner } from "../datasets/broker.js";
import {
  JobCapabilityStore,
  providerFromConfig,
  WORKER_AUDIENCE,
} from "../transport/runtime.js";
import {
  BootstrapCapabilityStore,
  ControllerCapabilityStore,
  RUNNING_WORKER_SCOPES,
} from "./credentials.js";
import { jobsConfigFromEnv } from "./config.js";
import { renderTaskStarterFromEnv } from "./dispatch.js";
import { datasetAuthenticator } from "../datasets/next.js";
import { jobControlRoutes, jobDagRunRoutes } from "./control.js";
import { jobDiagnosticRoutes } from "./diagnostics.js";
import { stageRerunRoutes } from "./stage-rerun-http.js";
import { jobHandlers, type JobHandlers } from "./http.js";
import type { JobsDeps } from "./service.js";
import { configuredRerunBindings } from "./stage-rerun-bindings.js";
import { s3RerunCopy } from "./stage-rerun-storage.js";

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

/** A malformed Render setting disables dispatch only; it must not take down every job route. */
function starterFromEnv(env: NodeJS.ProcessEnv) {
  try {
    return renderTaskStarterFromEnv(env);
  } catch (error) {
    console.error(
      "[jobs] dispatch disabled:",
      error instanceof Error ? error.message : "invalid Render settings",
    );
    return null;
  }
}

export function jobsDepsFromEnv(
  pool: AuthRuntime["pool"],
  env: NodeJS.ProcessEnv = process.env,
): JobsDeps {
  const config = serverConfig(env);
  const jobsConfig = jobsConfigFromEnv(env);
  return {
    pool,
    config: jobsConfig,
    taskStarter: jobsConfig.publicVideoCanary ? null : starterFromEnv(env),
    presignRead: (key, expiresInSeconds) =>
      presignObject(config, { method: "GET", key, expiresInSeconds }),
    sealTransport: () => ({ pool, provider: providerFromConfig(config) }),
    rerunCopy: s3RerunCopy(config),
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
        (h, principal) => h.reconcile(request, principal),
      ),
    status: (request: Request, jobId: string) =>
      guarded(
        request,
        jobId,
        controller,
        { kinds: ["workflow", "cron"], scope: "jobs:status" },
        (h) => h.status(request, jobId),
      ),
    /** SA-91: the workflow controller reads a job's recipe and its recorded stage runs. */
    recipe: (request: Request, jobId: string) =>
      guarded(
        request,
        jobId,
        controller,
        { kinds: ["workflow"], scope: "jobs:status" },
        (h) => h.recipe(request, jobId),
      ),
    priorStages: (request: Request, jobId: string) =>
      guarded(
        request,
        jobId,
        controller,
        { kinds: ["workflow"], scope: "jobs:status" },
        (h) => h.priorStages(request, jobId),
      ),
    dagRun: (request: Request, jobId: string) =>
      guarded(
        request,
        jobId,
        controller,
        { kinds: ["workflow"], scope: "jobs:status" },
        (h) => h.dagRun(request, jobId),
      ),
    prepareRerun: (request: Request, jobId: string) =>
      guarded(
        request,
        jobId,
        controller,
        { kinds: ["workflow"], scope: "jobs:reconcile" },
        (h) => h.prepareRerun(request, jobId),
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
        (h, principal) => h.claim(request, jobId, principal),
      ),
    heartbeat: (request: Request, jobId: string) =>
      guarded(
        request,
        jobId,
        worker,
        { kinds: ["worker"], scope: "job:heartbeat" },
        (h, principal) => h.heartbeat(request, jobId, principal),
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
    /** SA-88: the caption stage reads the job's completed segments_json (job:input). */
    outputRead: (request: Request, jobId: string, fileId: string) =>
      fileOk(fileId)
        ? guarded(
            request,
            jobId,
            worker,
            { kinds: ["worker"], scope: "job:input" },
            (h, principal) => h.outputRead(request, jobId, fileId, principal),
          )
        : Promise.resolve(notFound()),
  };
}

const CONTROL_KEY = Symbol.for("stateaction.jobs.control");
/**
 * Staff job-control route binding (/api/v1/jobs/{jobId}/control): the same
 * Better Auth staff session guard as the dataset routes, restricted pool, no
 * owner credential and no Render or storage credential in this path.
 */
export function jobControlRouteHandlers(get: () => AuthRuntime = authRuntime) {
  return {
    control: (request: Request, jobId: string): Promise<Response> => {
      const holder = globalThis as {
        [CONTROL_KEY]?: ReturnType<typeof jobControlRoutes>;
      };
      let routes = holder[CONTROL_KEY];
      if (!routes) {
        try {
          const pool = get().pool;
          routes = holder[CONTROL_KEY] = jobControlRoutes({
            pool,
            config: {},
            authenticate: datasetAuthenticator(get),
          });
        } catch (error) {
          console.error(
            "[jobs] control unavailable:",
            error instanceof Error ? error.message : "error",
          );
          return Promise.resolve(
            authError(
              "provider_unavailable",
              "Job service is temporarily unavailable",
              newRequestId(),
            ),
          );
        }
      }
      return routes.control(request, jobId);
    },
  };
}

const DAG_RUN_KEY = Symbol.for("stateaction.jobs.dag-run");
/** Staff recipe-run view binding (/api/v1/jobs/{jobId}/dag-run), staff session guard. */
export function jobDagRunRouteHandlers(get: () => AuthRuntime = authRuntime) {
  return {
    dagRun: (request: Request, jobId: string): Promise<Response> => {
      const holder = globalThis as {
        [DAG_RUN_KEY]?: ReturnType<typeof jobDagRunRoutes>;
      };
      let routes = holder[DAG_RUN_KEY];
      if (!routes) {
        try {
          routes = holder[DAG_RUN_KEY] = jobDagRunRoutes({
            pool: get().pool,
            authenticate: datasetAuthenticator(get),
          });
        } catch (error) {
          console.error(
            "[jobs] dag-run unavailable:",
            error instanceof Error ? error.message : "error",
          );
          return Promise.resolve(
            authError(
              "provider_unavailable",
              "Job service is temporarily unavailable",
              newRequestId(),
            ),
          );
        }
      }
      return routes.dagRun(request, jobId);
    },
  };
}

const DIAGNOSTIC_KEY = Symbol.for("stateaction.jobs.diagnostics");
/**
 * Staff diagnostic read binding (/api/v1/jobs/{jobId}/diagnostics/{fileId}/read):
 * staff session guard, restricted pool, and the same S3/R2 read signer family
 * as the dataset read routes (credentials stay in this process).
 */
export function jobDiagnosticRouteHandlers(
  get: () => AuthRuntime = authRuntime,
) {
  return {
    read: (
      request: Request,
      jobId: string,
      fileId: string,
    ): Promise<Response> => {
      const holder = globalThis as {
        [DIAGNOSTIC_KEY]?: ReturnType<typeof jobDiagnosticRoutes>;
      };
      let routes = holder[DIAGNOSTIC_KEY];
      if (!routes) {
        try {
          const config = serverConfig();
          routes = holder[DIAGNOSTIC_KEY] = jobDiagnosticRoutes({
            pool: get().pool,
            signer: new S3ReadSigner(
              storageClient(config, 15_000, config.publicEndpoint),
              config.bucket,
            ),
            authenticate: datasetAuthenticator(get),
          });
        } catch (error) {
          console.error(
            "[jobs] diagnostics unavailable:",
            error instanceof Error ? error.message : "error",
          );
          return Promise.resolve(
            authError(
              "provider_unavailable",
              "Job service is temporarily unavailable",
              newRequestId(),
            ),
          );
        }
      }
      return routes.read(request, jobId, fileId);
    },
  };
}

export function stageRerunRouteHandlers() {
  return {
    plan: (request: Request, recordingId: string) =>
      routes().plan(request, recordingId),
    confirm: (request: Request, recordingId: string) =>
      routes().confirm(request, recordingId),
    planV2: (request: Request, recordingId: string) =>
      routes().planV2(request, recordingId),
    confirmV2: (request: Request, recordingId: string) =>
      routes().confirmV2(request, recordingId),
    history: (request: Request, recordingId: string) =>
      routes().history(request, recordingId),
    select: (request: Request, recordingId: string) =>
      routes().select(request, recordingId),
  };

  function routes() {
    const runtime = authRuntime();
    const config = jobsConfigFromEnv();
    return stageRerunRoutes({
      pool: runtime.pool,
      reader: s3ObjectReader(serverConfig(), { timeoutMs: 8000 }),
      backend: config.executionBackend,
      production: config.production ?? false,
      ...(config.publicVideoCanary
        ? { publicVideoCanary: config.publicVideoCanary }
        : {}),
      bindings: configuredRerunBindings(process.env.STATEACTION_RERUN_BINDINGS),
      authenticate: datasetAuthenticator(),
    });
  }
}
