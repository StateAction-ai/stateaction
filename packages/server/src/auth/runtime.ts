import type pg from "pg";
import {
  CatalogAccessStore,
  TestFixtureAccessStore,
  type AccessDecision,
  type AccessStore,
} from "./access.js";
import { applicationDatabaseUrl } from "../config.js";
import { verifyEffectiveContext } from "./ambient.js";
import {
  assertNoUnsupportedAmbientSettings,
  authConfig,
  AuthConfigError,
  type AuthConfig,
} from "./config.js";
import {
  authenticateHuman,
  betterAuthSessionLookup,
  type GuardDeps,
  type HumanPrincipal,
  type HumanRequirement,
} from "./guard.js";
import {
  errorResponse,
  newRequestId,
  successResponse,
  withPrivateHeaders,
} from "./http.js";
import { createAuth, createAuthPool, type Auth } from "./instance.js";
import { allowsQaSignIn } from "./qa-sign-in.js";

export type AuthRuntime = {
  config: AuthConfig;
  auth: Auth;
  pool: pg.Pool;
  access: AccessStore;
  guard: GuardDeps;
  /**
   * Resolves once the effective Better Auth context matches the validated
   * config, and re-checks the ambient environment Better Auth reads on every
   * request. Every entry point awaits it before Better Auth runs.
   */
  ready(): Promise<void>;
};

export type AuthRuntimeOptions = {
  pool?: pg.Pool;
  access?: AccessStore;
  /** The environment Better Auth reads directly; `process.env` in Node. */
  ambientEnv?: Readonly<Record<string, string | undefined>>;
};

export function createAuthRuntime(
  config: AuthConfig,
  options: AuthRuntimeOptions = {},
): AuthRuntime {
  const ambientEnv = options.ambientEnv ?? process.env;
  // Checked before a pool or instance exists, so nothing is left open.
  assertNoUnsupportedAmbientSettings(ambientEnv);
  const pool = options.pool ?? createAuthPool(config);
  const auth = createAuth(config, pool, ambientEnv);
  const access =
    options.access ??
    (config.accessSource.kind === "test-fixture"
      ? new TestFixtureAccessStore(config.accessSource.file)
      : new CatalogAccessStore(pool));
  let verified: Promise<void> | undefined;
  const ready = async () => {
    // Better Auth re-reads BETTER_AUTH_TRUSTED_ORIGINS per request.
    assertNoUnsupportedAmbientSettings(ambientEnv);
    verified ??= auth.$context.then((context) =>
      verifyEffectiveContext(context, config),
    );
    await verified;
  };
  return {
    config,
    auth,
    pool,
    access,
    ready,
    guard: {
      sessions: betterAuthSessionLookup(auth),
      access,
      trustedOrigins: config.trustedOrigins,
    },
  };
}

const KEY = Symbol.for("stateaction.auth.runtime");
type Holder = { [KEY]?: AuthRuntime };

/** Process-wide runtime from the environment (survives Next dev reloads). */
export function authRuntime(): AuthRuntime {
  const holder = globalThis as Holder;
  return (holder[KEY] ??= createAuthRuntime(
    authConfig(process.env, { resolveDatabaseUrl: applicationDatabaseUrl }),
  ));
}

function unavailable(error: unknown): Response {
  // Operators see the setting problem in server logs; users never do.
  if (error instanceof AuthConfigError)
    console.error(`[auth] configuration error: ${error.message}`);
  else console.error("[auth] unavailable", error);
  return errorResponse(
    "provider_unavailable",
    "Sign-in is temporarily unavailable",
    newRequestId(),
  );
}

/** `/api/auth/[...all]` handlers with private cache headers on every reply. */
export function authRouteHandlers(
  get: () => AuthRuntime = authRuntime,
  env: NodeJS.ProcessEnv = process.env,
) {
  const handler = async (request: Request): Promise<Response> => {
    if (!(await allowsQaSignIn(request, env)))
      return new Response(null, {
        status: 404,
        headers: withPrivateHeaders(new Headers()),
      });
    let runtime: AuthRuntime;
    try {
      runtime = get();
      await runtime.ready();
    } catch (error) {
      return unavailable(error);
    }
    const response = await runtime.auth.handler(request);
    const headers = withPrivateHeaders(new Headers(response.headers));
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
  return { GET: handler, POST: handler };
}

/** Runs a guarded human route; the handler receives the server principal. */
export async function withHuman(
  request: Request,
  requirement: HumanRequirement,
  handle: (
    principal: HumanPrincipal,
    requestId: string,
    headers: Headers,
  ) => Promise<Response> | Response,
  get: () => AuthRuntime = authRuntime,
): Promise<Response> {
  let runtime: AuthRuntime;
  try {
    runtime = get();
    await runtime.ready();
  } catch (error) {
    return unavailable(error);
  }
  const result = await authenticateHuman(request, runtime.guard, requirement);
  if (!result.ok) return result.response;
  return handle(result.principal, result.requestId, result.headers);
}

/**
 * GET /api/v1/me. The only human route that answers pending/disabled
 * identities, so clients can show an access-pending page. Identity, roles
 * and status come from the session row and the access store.
 */
export function meRoute(get: () => AuthRuntime = authRuntime) {
  return (request: Request) =>
    withHuman(
      request,
      { allowInactive: true },
      (principal, requestId, headers) =>
        successResponse(
          {
            user: {
              id: principal.userId,
              email: principal.email,
              name: principal.name,
            },
            access: principal.access,
            session: { expiresAt: principal.expiresAt.toISOString() },
          },
          requestId,
          headers,
        ),
      get,
    );
}

export type PageIdentity =
  | { state: "signed-out" }
  | { state: "unavailable" }
  | {
      state: "signed-in";
      user: { id: string; email: string; name: string };
      access: AccessDecision;
    };

/**
 * Server-component lookup; pages still redirect/deny on the server. Never
 * extends the session (see `refreshSession`).
 */
export async function pageIdentity(
  headers: Headers,
  get: () => AuthRuntime = authRuntime,
): Promise<PageIdentity> {
  let runtime: AuthRuntime;
  try {
    runtime = get();
    await runtime.ready();
  } catch (error) {
    unavailable(error);
    return { state: "unavailable" };
  }
  // Server Components cannot set cookies, so this lookup never extends the
  // session; the browser refreshes through /api/v1/me (SessionRefresh).
  const result = await authenticateHuman(
    new Request(runtime.config.baseURL, { headers }),
    runtime.guard,
    { allowInactive: true, refreshSession: false },
  );
  if (result.ok)
    return {
      state: "signed-in",
      user: {
        id: result.principal.userId,
        email: result.principal.email,
        name: result.principal.name,
      },
      access: result.principal.access,
    };
  return result.response.status === 401
    ? { state: "signed-out" }
    : { state: "unavailable" };
}

/** Which sign-in methods the login page may offer (no setting details). */
export async function signInMethods(
  get: () => AuthRuntime = authRuntime,
): Promise<{ password: boolean; google: boolean } | null> {
  try {
    const runtime = get();
    await runtime.ready();
    const { config } = runtime;
    return { password: config.localPassword, google: config.google !== null };
  } catch (error) {
    unavailable(error);
    return null;
  }
}
