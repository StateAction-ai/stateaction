import {
  decideAccess,
  type AccessDecision,
  type AccessStore,
  type Role,
} from "./access.js";
import { errorResponse, newRequestId, withPrivateHeaders } from "./http.js";
import type { Auth } from "./instance.js";

/** Header every human mutation must carry (forces a CORS preflight). */
export const CLIENT_HEADER = "x-stateaction-client";

export type SessionSnapshot = {
  sessionId: string;
  userId: string;
  email: string;
  name: string;
  expiresAt: Date;
};

/**
 * Reads the Better Auth session and any refreshed/cleared cookies. With
 * `refresh: false` the lookup never extends the session row (Better Auth
 * `disableRefresh`), for callers that cannot forward `Set-Cookie`.
 */
export type SessionLookup = (
  headers: Headers,
  options?: { refresh?: boolean },
) => Promise<{ session: SessionSnapshot | null; setCookies: string[] }>;

export function betterAuthSessionLookup(auth: Auth): SessionLookup {
  return async (headers, options = {}) => {
    const result = await auth.api.getSession({
      headers,
      returnHeaders: true,
      ...(options.refresh === false ? { query: { disableRefresh: true } } : {}),
    });
    const setCookies = result.headers.getSetCookie();
    const found = result.response;
    if (!found) return { session: null, setCookies };
    return {
      setCookies,
      session: {
        sessionId: found.session.id,
        userId: found.user.id,
        email: found.user.email,
        name: found.user.name,
        expiresAt: new Date(found.session.expiresAt),
      },
    };
  };
}

export type HumanPrincipal = SessionSnapshot & {
  kind: "human";
  access: AccessDecision;
};

export type GuardDeps = {
  sessions: SessionLookup;
  access: AccessStore;
  trustedOrigins: readonly string[];
};

export type HumanRequirement = {
  /** Any one of these enabled roles is required. */
  anyRole?: readonly Role[];
  /** Allow pending/disabled identities (only `/api/v1/me`). */
  allowInactive?: boolean;
  /**
   * Set false where `Set-Cookie` cannot reach the browser (Server
   * Components): the session row is then read but never extended, so the
   * database expiry cannot run ahead of the cookie's Max-Age.
   */
  refreshSession?: boolean;
};

export type GuardResult =
  | {
      ok: true;
      principal: HumanPrincipal;
      requestId: string;
      /** Private cache headers plus Better Auth cookie updates to forward. */
      headers: Headers;
    }
  | { ok: false; response: Response };

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Browser and native mutation checks. Browsers always send Origin and Fetch
 * Metadata on cross-origin POSTs; a native client sends neither but still
 * needs the client header and JSON body. No credentialed CORS is offered, so
 * a cross-site page cannot attach the custom header.
 */
export function mutationOriginProblem(
  request: Request,
  trustedOrigins: readonly string[],
): string | null {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none")
    return "Cross-site request blocked";
  const origin = request.headers.get("origin");
  if (origin !== null && !trustedOrigins.includes(origin))
    return "Origin not allowed";
  if (!request.headers.get(CLIENT_HEADER)) return "Missing client header";
  const type = request.headers.get("content-type") ?? "";
  if (
    request.headers.has("content-length") ||
    request.headers.has("transfer-encoding") ||
    type
  )
    if (!/^application\/json(\s*;|$)/i.test(type)) return "JSON body required";
  return null;
}

export async function authenticateHuman(
  request: Request,
  deps: GuardDeps,
  requirement: HumanRequirement = {},
): Promise<GuardResult> {
  const requestId = newRequestId();
  const fail = (
    code: Parameters<typeof errorResponse>[0],
    message: string,
    headers?: Headers,
  ) => ({
    ok: false as const,
    response: errorResponse(code, message, requestId, headers),
  });

  // Service credentials never authenticate a human route, and a human route
  // never falls back from a bearer credential to cookies.
  if (request.headers.has("authorization"))
    return fail("unauthenticated", "Service credentials are not accepted here");

  if (!SAFE_METHODS.has(request.method.toUpperCase())) {
    const problem = mutationOriginProblem(request, deps.trustedOrigins);
    if (problem) return fail("forbidden", problem);
  }

  let lookup: Awaited<ReturnType<SessionLookup>>;
  try {
    lookup = await deps.sessions(request.headers, {
      refresh: requirement.refreshSession !== false,
    });
  } catch {
    return fail("provider_unavailable", "Sign-in is temporarily unavailable");
  }
  const headers = withPrivateHeaders(new Headers());
  for (const cookie of lookup.setCookies) headers.append("Set-Cookie", cookie);
  if (!lookup.session)
    return fail("unauthenticated", "Sign in to continue", headers);

  let access: AccessDecision;
  try {
    access = decideAccess(await deps.access.grantsFor(lookup.session.userId));
  } catch {
    return fail(
      "provider_unavailable",
      "Access is temporarily unavailable",
      headers,
    );
  }
  const principal: HumanPrincipal = {
    kind: "human",
    ...lookup.session,
    access,
  };

  if (!requirement.allowInactive && access.status !== "active")
    return fail(
      "forbidden",
      access.status === "pending" ? "Access pending" : "Access disabled",
      headers,
    );
  if (
    requirement.anyRole &&
    !requirement.anyRole.some((role) => access.roles.includes(role))
  )
    return fail(
      "forbidden",
      "This account cannot perform that action",
      headers,
    );

  return { ok: true, principal, requestId, headers };
}
