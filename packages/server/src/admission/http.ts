import { randomUUID } from "node:crypto";
import { validateBytes } from "@stateaction/contracts";
import { CatalogError, type CatalogErrorCode } from "../catalog/errors.js";
import {
  getRecording,
  registerRecording,
  sealRecordingInventory,
  type AdmissionDeps,
  type CollectorPrincipal,
} from "./recordings.js";

/**
 * Server-side authentication boundary, injected. Production binds the SA-15
 * Better Auth session guard (enabled collector role, CSRF/origin checks);
 * independent tests inject a fixture. Identity never comes from the body,
 * query or a client-chosen header.
 */
export type AuthenticateCollector = (request: Request) => Promise<
  | {
      ok: true;
      principal: CollectorPrincipal;
      requestId?: string;
      headers?: Headers;
    }
  | { ok: false; response: Response }
>;

export type RecordingRoutesDeps = AdmissionDeps & {
  authenticateCollector: AuthenticateCollector;
};

/** Control-document bound for v1 HTTP bodies (contract maxBytes). */
export const MAX_BODY_BYTES = 1048576;

type ErrorCode =
  | CatalogErrorCode
  | "unauthenticated"
  | "payload_too_large"
  | "internal";
const STATUS: Record<ErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  idempotency_conflict: 409,
  payload_too_large: 413,
  invalid_request: 422,
  internal: 500,
};
const PRIVATE: Record<string, string> = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  Vary: "Cookie, Authorization",
};

function respond(
  body: unknown,
  status: number,
  headers = new Headers(),
): Response {
  for (const [k, v] of Object.entries(PRIVATE)) headers.set(k, v);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), { status, headers });
}
function failure(
  code: ErrorCode,
  message: string,
  requestId: string,
  headers?: Headers,
) {
  return respond(
    { error: { code, message, retryable: false }, requestId },
    STATUS[code],
    headers,
  );
}

class BodyError extends Error {
  constructor(
    readonly code: "payload_too_large" | "invalid_request",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Reads a JSON body with a hard byte bound before allocating beyond it, then
 * validates the exact bytes against the contract (BOM, UTF-8, JSON, schema,
 * rules). Returns the parsed value.
 */
async function readContractBody(
  request: Request,
  contract: string,
): Promise<unknown> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json(\s*;|$)/i.test(type))
    throw new BodyError(
      "invalid_request",
      "Content-Type must be application/json",
    );
  const declared = request.headers.get("content-length");
  if (
    declared !== null &&
    (!/^[0-9]{1,16}$/.test(declared) || Number(declared) > MAX_BODY_BYTES)
  )
    throw new BodyError("payload_too_large", "Request body is too large");
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = request.body?.getReader();
  if (reader)
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        // Stop reading (nothing more is buffered); the host drains/closes.
        reader.releaseLock();
        throw new BodyError("payload_too_large", "Request body is too large");
      }
      chunks.push(value);
    }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  const result = validateBytes(contract, bytes);
  if (!result.valid)
    throw new BodyError("invalid_request", `Request failed ${result.code}`);
  return result.value;
}

/**
 * Route handlers for POST /api/v1/recordings, POST
 * /api/v1/recordings/{recordingId}/seal and GET /api/v1/recordings/{recordingId}.
 * Web-standard Request -> Response, so a Next.js route or the test adapter can
 * bind them unchanged. There is no unauthenticated fallback: construction
 * fails without an authentication boundary.
 */
export function recordingRoutes(deps: RecordingRoutesDeps) {
  if (typeof deps.authenticateCollector !== "function")
    throw new Error(
      "recordingRoutes requires an authenticateCollector boundary",
    );
  const run = async (
    request: Request,
    handler: (
      principal: CollectorPrincipal,
    ) => Promise<{ data: unknown; status: number }>,
  ): Promise<Response> => {
    const auth = await deps.authenticateCollector(request);
    if (!auth.ok) return auth.response;
    const requestId = auth.requestId ?? randomUUID();
    try {
      const { data, status } = await handler(auth.principal);
      return respond({ data, requestId }, status, auth.headers);
    } catch (error) {
      if (error instanceof BodyError)
        return failure(error.code, error.message, requestId, auth.headers);
      if (error instanceof CatalogError)
        return failure(error.code, safeMessage(error), requestId, auth.headers);
      return failure("internal", "Internal error", requestId, auth.headers);
    }
  };
  return {
    create: (request: Request) =>
      run(request, async (principal) => {
        const body = await readContractBody(
          request,
          "http.recording-create.v1",
        );
        const out = await registerRecording(deps, principal, body);
        return {
          status: out.created ? 201 : 200,
          data: {
            recording: out.recording,
            collectionPermissionRef: out.collectionPermissionRef,
          },
        };
      }),
    seal: (request: Request, recordingId: string) =>
      run(request, async (principal) => {
        const body = await readContractBody(request, "http.recording-seal.v1");
        const out = await sealRecordingInventory(
          deps,
          principal,
          recordingId,
          body,
        );
        return { status: 200, data: out.recording };
      }),
    get: (request: Request, recordingId: string) =>
      run(request, async (principal) => ({
        status: 200,
        data: await getRecording(deps.pool, principal, recordingId),
      })),
  };
}

/** Database messages never leave the server; only our own messages do. */
function safeMessage(error: CatalogError): string {
  if (error.sqlstate === undefined) return error.message;
  return (
    {
      conflict: "Conflicting state",
      idempotency_conflict: "Conflicting request",
      forbidden: "Not permitted",
      not_found: "Not found",
      invalid_request: "Invalid request",
    } as const
  )[error.code];
}
