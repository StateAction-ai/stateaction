import "server-only";
import { s3ObjectHasher } from "../acceptance/storage.js";
import { authenticateHuman } from "../auth/guard.js";
import { errorResponse, newRequestId } from "../auth/http.js";
import { authRuntime, type AuthRuntime } from "../auth/runtime.js";
import { serverConfig } from "../config.js";
import { sourceCleanupConfigFromEnv } from "./config.js";
import { sourceCleanupRoutes, type Authenticate } from "./http.js";

/**
 * Better Auth boundary: every request re-reads the session and the enabled
 * role from operator-managed `access` rows; mutations pass the origin /
 * Fetch-Metadata / client-header checks; bearer credentials are refused.
 * There is no fixture identity or header fallback.
 */
export function sourceCleanupAuthenticator(
  role: "staff" | "collector",
  get: () => AuthRuntime = authRuntime,
): Authenticate {
  return async (request) => {
    let runtime: AuthRuntime;
    try {
      runtime = get();
      await runtime.ready();
    } catch (error) {
      console.error(
        "[source-cleanup] auth unavailable",
        error instanceof Error ? error.name : "unknown",
      );
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

function unavailable(): Response {
  return errorResponse(
    "provider_unavailable",
    "Source verification is temporarily unavailable",
    newRequestId(),
  );
}

type Routes = ReturnType<typeof sourceCleanupRoutes>;
const KEY = Symbol.for("stateaction.sourceCleanup.routes");
type Holder = { [KEY]?: Routes };

/**
 * Process-wide routes over the restricted application-role pool and the
 * backend-only storage settings used solely to stream-hash sealed originals.
 * Configuration errors answer 503 and are logged without detail.
 */
export function sourceCleanupRouteHandlers(
  get: () => AuthRuntime = authRuntime,
) {
  const routes = (): Routes => {
    const holder = globalThis as Holder;
    if (holder[KEY]) return holder[KEY];
    const runtime = get();
    return (holder[KEY] = sourceCleanupRoutes({
      pool: runtime.pool,
      hasher: s3ObjectHasher(serverConfig()),
      config: sourceCleanupConfigFromEnv(),
      authenticateStaff: sourceCleanupAuthenticator("staff", get),
      authenticateCollector: sourceCleanupAuthenticator("collector", get),
    }));
  };
  const guarded =
    (
      pick: (
        r: Routes,
      ) => (request: Request, recordingId: string) => Promise<Response>,
    ) =>
    async (request: Request, recordingId: string): Promise<Response> => {
      let r: Routes;
      try {
        r = routes();
      } catch (error) {
        console.error(
          "[source-cleanup] configuration error:",
          error instanceof Error ? error.message : "unknown",
        );
        return unavailable();
      }
      return pick(r)(request, recordingId);
    };
  return {
    confirm: guarded((r) => r.confirm),
    issueProof: guarded((r) => r.issueProof),
  };
}
