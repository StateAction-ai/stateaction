import "server-only";
import { authenticateHuman } from "../auth/guard.js";
import { errorResponse, newRequestId } from "../auth/http.js";
import { authRuntime, type AuthRuntime } from "../auth/runtime.js";
import type { AuthenticateCollector } from "./http.js";
import { captureRecipeSelectionRoute, recordingRoutes } from "./http.js";
import { admissionDepsFromEnv } from "./runtime.js";

/**
 * The SA-15 Better Auth boundary for collector routes. Every request is
 * re-authenticated: the session is read from the shared Better Auth instance
 * (refreshed cookies are forwarded), the enabled `collector` role is re-read
 * from operator-managed access rows, and mutations must pass the SA-15
 * origin/Fetch-Metadata/client-header checks. Bearer credentials are refused.
 * There is no fixture identity or header fallback.
 */
export function collectorAuthenticator(
  get: () => AuthRuntime = authRuntime,
  role: "collector" | "staff" = "collector",
): AuthenticateCollector {
  return async (request) => {
    let runtime: AuthRuntime;
    try {
      runtime = get();
      await runtime.ready();
    } catch (error) {
      console.error("[recordings] auth unavailable", error);
      return { ok: false, response: unavailable() };
    }
    const result = await authenticateHuman(request, runtime.guard, {
      anyRole: [role],
    });
    if (!result.ok) return result;
    return {
      ok: true,
      principal: { userId: result.principal.userId },
      requestId: result.requestId,
      headers: result.headers,
    };
  };
}

export function selectCaptureRecipe(get: () => AuthRuntime = authRuntime) {
  return async (request: Request, recordingId: string) => {
    try {
      return await captureRecipeSelectionRoute(
        admissionDepsFromEnv(get().pool),
        collectorAuthenticator(get, "staff"),
        request,
        recordingId,
      );
    } catch {
      return unavailable();
    }
  };
}

function unavailable(): Response {
  return errorResponse(
    "provider_unavailable",
    "Recording service is temporarily unavailable",
    newRequestId(),
  );
}

type Routes = ReturnType<typeof recordingRoutes>;
const KEY = Symbol.for("stateaction.recordings.routes");
type Holder = { [KEY]?: Routes };

/**
 * Process-wide recording routes: the auth runtime's restricted
 * application-role pool (the same applicationDatabaseUrl and Better Auth
 * instance), the bounded storage manifest reader and the explicit admission
 * settings. Configuration errors answer 503 and are logged, never leaked.
 */
export function recordingRouteHandlers(get: () => AuthRuntime = authRuntime) {
  const routes = (): Routes => {
    const holder = globalThis as Holder;
    if (holder[KEY]) return holder[KEY];
    const runtime = get();
    return (holder[KEY] = recordingRoutes({
      ...admissionDepsFromEnv(runtime.pool),
      authenticateCollector: collectorAuthenticator(get),
    }));
  };
  const guarded =
    <A extends unknown[]>(
      pick: (r: Routes) => (request: Request, ...args: A) => Promise<Response>,
    ) =>
    async (request: Request, ...args: A): Promise<Response> => {
      let r: Routes;
      try {
        r = routes();
      } catch (error) {
        console.error(
          "[recordings] configuration error:",
          error instanceof Error ? error.message : error,
        );
        return unavailable();
      }
      return pick(r)(request, ...args);
    };
  return {
    create: guarded((r) => r.create),
    seal: guarded((r) => r.seal),
    get: guarded((r) => r.get),
  };
}
