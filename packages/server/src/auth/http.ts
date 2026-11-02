import { randomUUID } from "node:crypto";

/**
 * Applied to every authenticated or auth-related response: browsers and any
 * shared proxy/CDN must neither store nor reuse them across users.
 */
export const PRIVATE_CACHE_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  Vary: "Cookie, Authorization",
};

/** SA-12 `http.error-envelope.v1` codes used by the auth boundary. */
export type AuthErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "invalid_request"
  | "rate_limited"
  | "provider_unavailable"
  | "internal";

const STATUS: Record<AuthErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  invalid_request: 422,
  rate_limited: 429,
  provider_unavailable: 503,
  internal: 500,
};

export function newRequestId(): string {
  return randomUUID();
}

export function withPrivateHeaders(headers: Headers): Headers {
  for (const [key, value] of Object.entries(PRIVATE_CACHE_HEADERS))
    headers.set(key, value);
  return headers;
}

export function errorResponse(
  code: AuthErrorCode,
  message: string,
  requestId: string,
  headers: Headers = new Headers(),
): Response {
  withPrivateHeaders(headers);
  headers.set("Content-Type", "application/json");
  return new Response(
    JSON.stringify({
      error: { code, message, retryable: code === "provider_unavailable" },
      requestId,
    }),
    { status: STATUS[code], headers },
  );
}

export function successResponse(
  data: unknown,
  requestId: string,
  headers: Headers = new Headers(),
  status = 200,
): Response {
  withPrivateHeaders(headers);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify({ data, requestId }), { status, headers });
}
