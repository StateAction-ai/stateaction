import { CLIENT_HEADER } from "./guard.js";
import { parseDisplayName, DISPLAY_NAME_MESSAGES } from "./display-name.js";
import { errorResponse, successResponse } from "./http.js";
import { authRuntime, withHuman, type AuthRuntime } from "./runtime.js";

/** The only value the browser console sends in X-StateAction-Client. */
export const WEB_CLIENT = "web";
/** A profile body is `{"name": <= 80 code points}`; 1 KiB is generous. */
export const PROFILE_BODY_MAX_BYTES = 1024;
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;

/**
 * Stricter than the shared mutation guard because this route is browser-only:
 * Origin must be present and exactly trusted, Fetch Metadata (when sent) must
 * say same-origin, and the client header must be the console's value.
 */
export function profileOriginProblem(
  request: Request,
  trustedOrigins: readonly string[],
): string | null {
  const origin = request.headers.get("origin");
  if (origin === null || !trustedOrigins.includes(origin))
    return "Origin not allowed";
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin")
    return "Cross-site request blocked";
  if (request.headers.get(CLIENT_HEADER) !== WEB_CLIENT)
    return "Missing client header";
  return null;
}

async function readBoundedJson(
  request: Request,
): Promise<{ ok: true; value: unknown } | { ok: false }> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > PROFILE_BODY_MAX_BYTES)
    return { ok: false };
  if (!request.body) return { ok: false };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > PROFILE_BODY_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      return { ok: false };
    }
    chunks.push(value);
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/** Closed schema: exactly one own key, `name`, holding a string. */
function bodyName(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "name") return undefined;
  return (value as { name: unknown }).name;
}

/**
 * PATCH /api/v1/me/profile. The signed-in human edits ONLY their own display
 * name. The target row is the session's `userId`; email, roles, id and any
 * other field are never read from the request. Better Auth's broad
 * `/update-user` stays disabled.
 *
 * Proposed local contract (NOT published conformance; a v4 registry superset
 * follows backend SA-19's catalog.v3 merge): request `{ "name": string }`,
 * response `{ data: { user: { id, email, name } }, requestId }`.
 */
export function profileRoute(
  get: () => AuthRuntime = authRuntime,
  now: () => number = Date.now,
) {
  const recent = new Map<string, number[]>();
  return (request: Request) =>
    withHuman(
      request,
      // Any enabled role may edit its own name; pending/disabled may not.
      {},
      async (principal, requestId, headers) => {
        const runtime = get();
        const problem = profileOriginProblem(
          request,
          runtime.config.trustedOrigins,
        );
        if (problem)
          return errorResponse("forbidden", problem, requestId, headers);
        if (
          !/^application\/json(\s*;|$)/i.test(
            request.headers.get("content-type") ?? "",
          )
        )
          return errorResponse(
            "invalid_request",
            "JSON body required",
            requestId,
            headers,
          );

        const at = now();
        const hits = (recent.get(principal.userId) ?? []).filter(
          (t) => at - t < WINDOW_MS,
        );
        if (hits.length >= MAX_PER_WINDOW) {
          recent.set(principal.userId, hits);
          return errorResponse(
            "rate_limited",
            "Too many changes; try again shortly",
            requestId,
            headers,
          );
        }
        recent.set(principal.userId, [...hits, at]);
        if (recent.size > 1000)
          for (const [user, times] of recent)
            if (times.every((t) => at - t >= WINDOW_MS)) recent.delete(user);

        const body = await readBoundedJson(request);
        const name = body.ok ? bodyName(body.value) : undefined;
        if (name === undefined)
          return errorResponse(
            "invalid_request",
            "Send only { name }",
            requestId,
            headers,
          );
        const parsed = parseDisplayName(name);
        if (!parsed.ok)
          return errorResponse(
            "invalid_request",
            DISPLAY_NAME_MESSAGES[parsed.reason],
            requestId,
            headers,
          );

        try {
          const { rows } = await runtime.pool.query<{
            id: string;
            email: string;
            name: string;
          }>(
            `UPDATE "user" SET "name" = $1, "updatedAt" = CURRENT_TIMESTAMP
               WHERE "id" = $2 RETURNING "id", "email", "name"`,
            [parsed.value, principal.userId],
          );
          const row = rows[0];
          if (!row)
            return errorResponse(
              "unauthenticated",
              "Sign in to continue",
              requestId,
              headers,
            );
          return successResponse(
            { user: { id: row.id, email: row.email, name: row.name } },
            requestId,
            headers,
          );
        } catch {
          return errorResponse(
            "provider_unavailable",
            "Profile is temporarily unavailable",
            requestId,
            headers,
          );
        }
      },
      get,
    );
}
