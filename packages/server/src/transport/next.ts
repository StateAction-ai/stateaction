import "server-only";
import { stageOfCredential } from "../jobs/stages.js";
import { authenticateHuman } from "../auth/guard.js";
import { errorResponse as authError, newRequestId } from "../auth/http.js";
import { authRuntime, type AuthRuntime } from "../auth/runtime.js";
import { authenticateService } from "../auth/service.js";
import type { Authority } from "./authority.js";
import { TransportError } from "./errors.js";
import { transportHandlers, errorResponse } from "./http.js";
import {
  JobCapabilityStore,
  transportDepsFromEnv,
  WORKER_AUDIENCE,
} from "./runtime.js";
import type { TransportDeps } from "./service.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Handlers = ReturnType<typeof transportHandlers>;
type Resolved =
  | { ok: true; authority: Authority; headers?: Headers }
  | { ok: false; response: Response };

/**
 * Same-session owner authority. Every request re-reads the Better Auth
 * session (refreshed cookies are forwarded), the enabled `collector` role and
 * the mutation origin checks. Bearer credentials are refused, never used as a
 * fallback, and the owner is the session's user, never a request field. The
 * transport service then re-checks session row, role, recording ownership and
 * the recording's active collection permission against the database.
 */
export async function ownerAuthority(
  request: Request,
  get: () => AuthRuntime = authRuntime,
): Promise<Resolved> {
  let runtime: AuthRuntime;
  try {
    runtime = get();
    await runtime.ready();
  } catch (error) {
    console.error("[uploads] auth unavailable", error);
    return { ok: false, response: unavailable() };
  }
  const result = await authenticateHuman(request, runtime.guard, {
    anyRole: ["collector"],
  });
  if (!result.ok) return result;
  return {
    ok: true,
    authority: {
      kind: "owner",
      userId: result.principal.userId,
      sessionId: result.principal.sessionId,
    },
    headers: result.headers,
  };
}

/**
 * Worker authority: a server-issued, job-bound `job:output` capability for
 * exactly the job named by the route. Cookies are never consulted.
 */
export async function jobAuthority(
  request: Request,
  jobId: string,
  get: () => AuthRuntime = authRuntime,
): Promise<Resolved> {
  if (!UUID.test(jobId))
    return {
      ok: false,
      response: errorResponse(
        new TransportError("not_found", "Upload not found"),
        newRequestId(),
      ),
    };
  let pool: AuthRuntime["pool"];
  try {
    pool = get().pool;
  } catch (error) {
    console.error("[uploads] runtime unavailable", error);
    return { ok: false, response: unavailable() };
  }
  const result = await authenticateService(
    request,
    new JobCapabilityStore(pool),
    {
      audience: WORKER_AUDIENCE,
      kinds: ["worker"],
      scope: "job:output",
      jobId,
    },
  );
  if (!result.ok) return result;
  const stage = stageOfCredential(result.principal.credentialId);
  return {
    ok: true,
    authority: { kind: "job", jobId, ...(stage ? { stage } : {}) },
  };
}

function unavailable(): Response {
  return authError(
    "provider_unavailable",
    "Upload service is temporarily unavailable",
    newRequestId(),
  );
}

type Holder = { [KEY]?: Handlers };
const KEY = Symbol.for("stateaction.transport.handlers");

export function transportRouteHandlers(
  get: () => AuthRuntime = authRuntime,
  depsFor: (pool: AuthRuntime["pool"]) => TransportDeps = (pool) =>
    transportDepsFromEnv(pool),
) {
  const handlers = (): Handlers => {
    const holder = globalThis as Holder;
    if (holder[KEY]) return holder[KEY];
    return (holder[KEY] = transportHandlers(depsFor(get().pool)));
  };
  const run = async (
    resolved: Resolved,
    pick: (h: Handlers) => Handlers[keyof Handlers],
    request: Request,
    fileId?: string,
  ): Promise<Response> => {
    if (!resolved.ok) return resolved.response;
    let h: Handlers;
    try {
      h = handlers();
    } catch (error) {
      console.error(
        "[uploads] configuration error:",
        error instanceof Error ? error.message : error,
      );
      return unavailable();
    }
    const response = await pick(h)(request, resolved.authority, fileId);
    // Forward refreshed/cleared Better Auth cookies on human replies.
    if (resolved.headers)
      for (const cookie of resolved.headers.getSetCookie())
        response.headers.append("Set-Cookie", cookie);
    return response;
  };
  const withFile = async (
    resolve: () => Promise<Resolved>,
    pick: (h: Handlers) => Handlers[keyof Handlers],
    request: Request,
    fileId: string,
  ) => {
    // A malformed identifier is "not found" without touching the database.
    if (!UUID.test(fileId))
      return errorResponse(
        new TransportError("not_found", "Upload not found"),
        newRequestId(),
      );
    return run(await resolve(), pick, request, fileId);
  };
  return {
    owner: {
      create: async (request: Request) =>
        run(
          await ownerAuthority(request, get),
          (h) => h.createSourceUpload,
          request,
        ),
      get: (request: Request, fileId: string) =>
        withFile(
          () => ownerAuthority(request, get),
          (h) => h.getUpload,
          request,
          fileId,
        ),
      sign: (request: Request, fileId: string) =>
        withFile(
          () => ownerAuthority(request, get),
          (h) => h.signParts,
          request,
          fileId,
        ),
      receipts: (request: Request, fileId: string) =>
        withFile(
          () => ownerAuthority(request, get),
          (h) => h.putReceipts,
          request,
          fileId,
        ),
      reconcile: (request: Request, fileId: string) =>
        withFile(
          () => ownerAuthority(request, get),
          (h) => h.reconcileUpload,
          request,
          fileId,
        ),
      complete: (request: Request, fileId: string) =>
        withFile(
          () => ownerAuthority(request, get),
          (h) => h.completeUpload,
          request,
          fileId,
        ),
      cancel: (request: Request, fileId: string) =>
        withFile(
          () => ownerAuthority(request, get),
          (h) => h.cancelUpload,
          request,
          fileId,
        ),
      restart: (request: Request, fileId: string) =>
        withFile(
          () => ownerAuthority(request, get),
          (h) => h.restartUpload,
          request,
          fileId,
        ),
    },
    job: {
      create: async (request: Request, jobId: string) =>
        run(
          await jobAuthority(request, jobId, get),
          (h) => h.createJobOutput,
          request,
        ),
      get: (request: Request, jobId: string, fileId: string) =>
        withFile(
          () => jobAuthority(request, jobId, get),
          (h) => h.getUpload,
          request,
          fileId,
        ),
      sign: (request: Request, jobId: string, fileId: string) =>
        withFile(
          () => jobAuthority(request, jobId, get),
          (h) => h.signParts,
          request,
          fileId,
        ),
      receipts: (request: Request, jobId: string, fileId: string) =>
        withFile(
          () => jobAuthority(request, jobId, get),
          (h) => h.putReceipts,
          request,
          fileId,
        ),
      reconcile: (request: Request, jobId: string, fileId: string) =>
        withFile(
          () => jobAuthority(request, jobId, get),
          (h) => h.reconcileUpload,
          request,
          fileId,
        ),
      complete: (request: Request, jobId: string, fileId: string) =>
        withFile(
          () => jobAuthority(request, jobId, get),
          (h) => h.completeUpload,
          request,
          fileId,
        ),
      cancel: (request: Request, jobId: string, fileId: string) =>
        withFile(
          () => jobAuthority(request, jobId, get),
          (h) => h.cancelUpload,
          request,
          fileId,
        ),
      restart: (request: Request, jobId: string, fileId: string) =>
        withFile(
          () => jobAuthority(request, jobId, get),
          (h) => h.restartUpload,
          request,
          fileId,
        ),
    },
  };
}
