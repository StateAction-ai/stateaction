import { randomUUID } from "node:crypto";
import {
  confirmSourceCopy,
  isHex64,
  isUuid,
  issueCleanupProof,
  SourceCleanupError,
  type ExpectedInventory,
  type SourceCleanupDeps,
} from "./service.js";

/** Strict request bound for both routes (a few hex digests). */
export const MAX_BODY_BYTES = 1024;

export type Authenticated =
  | {
      ok: true;
      principal: { userId: string };
      requestId?: string;
      headers?: Headers;
    }
  | { ok: false; response: Response };
export type Authenticate = (request: Request) => Promise<Authenticated>;

export type SourceCleanupRoutesDeps = SourceCleanupDeps & {
  /** Active `staff` role, cookies + CSRF checks (never a bearer credential). */
  authenticateStaff: Authenticate;
  /** Active `collector` role; the principal is the only owner identity used. */
  authenticateCollector: Authenticate;
};

const PRIVATE: Record<string, string> = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  Vary: "Cookie, Authorization",
};

function respond(body: unknown, status: number, headers = new Headers()) {
  for (const [k, v] of Object.entries(PRIVATE)) headers.set(k, v);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), { status, headers });
}

function failure(
  code: string,
  message: string,
  status: number,
  retryable: boolean,
  requestId: string,
  headers?: Headers,
) {
  const out = headers ?? new Headers();
  if (code === "verifier_busy") out.set("Retry-After", "5");
  return respond(
    { error: { code, message, retryable }, requestId },
    status,
    out,
  );
}

class BodyError extends Error {
  constructor(
    readonly status: number,
    readonly code: "payload_too_large" | "invalid_request" | "request_timeout",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Reads at most MAX_BODY_BYTES within a finite wall; never drains an oversized
 * remainder and never waits on a trickling or stalled sender: the reader is
 * cancelled and the request refused (408) when the deadline passes.
 */
async function readJsonObject(
  request: Request,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json(\s*;|$)/i.test(type))
    throw new BodyError(
      422,
      "invalid_request",
      "Content-Type must be application/json",
    );
  const declared = request.headers.get("content-length");
  if (
    declared !== null &&
    (!/^[0-9]{1,16}$/.test(declared) || Number(declared) > MAX_BODY_BYTES)
  )
    throw new BodyError(413, "payload_too_large", "Request body is too large");
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = request.body?.getReader();
  if (reader) {
    const deadline = Date.now() + timeoutMs;
    let complete = false;
    try {
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0)
          throw new BodyError(
            408,
            "request_timeout",
            "The request body was not received in time",
          );
        let timer: NodeJS.Timeout | undefined;
        const step = await Promise.race([
          reader.read(),
          new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), remaining);
          }),
        ]).finally(() => clearTimeout(timer));
        if (step === "timeout")
          throw new BodyError(
            408,
            "request_timeout",
            "The request body was not received in time",
          );
        if (step.done) {
          complete = true;
          break;
        }
        total += step.value.byteLength;
        if (total > MAX_BODY_BYTES)
          throw new BodyError(
            413,
            "payload_too_large",
            "Request body is too large",
          );
        chunks.push(step.value);
      }
    } finally {
      if (!complete) void reader.cancel().catch(() => undefined);
      try {
        reader.releaseLock();
      } catch {
        // a still-pending read on a cancelled stream; nothing left to release
      }
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    throw new BodyError(422, "invalid_request", "Body must be a JSON object");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new BodyError(422, "invalid_request", "Body must be a JSON object");
  return parsed as Record<string, unknown>;
}

function exactKeys(body: Record<string, unknown>, keys: readonly string[]) {
  const actual = Object.keys(body).sort();
  const want = [...keys].sort();
  if (actual.length !== want.length || actual.some((k, i) => k !== want[i]))
    throw new BodyError(
      422,
      "invalid_request",
      `Body must contain exactly: ${want.join(", ")}`,
    );
}

/** Staff body: no owner or staff identity, only the sealed inventory named. */
function staffExpected(body: Record<string, unknown>): ExpectedInventory {
  exactKeys(body, [
    "expectedSealSha256",
    "expectedSourceManifestSha256",
    "expectedFileCount",
  ]);
  const count = body.expectedFileCount;
  if (
    !isHex64(body.expectedSealSha256) ||
    !isHex64(body.expectedSourceManifestSha256) ||
    typeof count !== "number" ||
    !Number.isInteger(count) ||
    count < 3 ||
    count > 2000
  )
    throw new BodyError(422, "invalid_request", "Body fields are malformed");
  return {
    sealSha256: body.expectedSealSha256,
    sourceManifestSha256: body.expectedSourceManifestSha256,
    fileCount: count,
  };
}

function ownerExpected(body: Record<string, unknown>): ExpectedInventory {
  exactKeys(body, ["sealSha256", "sourceManifestSha256", "clientRecordingId"]);
  if (
    !isHex64(body.sealSha256) ||
    !isHex64(body.sourceManifestSha256) ||
    !isUuid(body.clientRecordingId)
  )
    throw new BodyError(422, "invalid_request", "Body fields are malformed");
  return {
    sealSha256: body.sealSha256,
    sourceManifestSha256: body.sourceManifestSha256,
    clientRecordingId: body.clientRecordingId,
  };
}

/**
 * POST /api/v1/recordings/{id}/source-copy-confirmation (staff) and
 * POST /api/v1/recordings/{id}/cleanup-proofs (original owner). Web-standard
 * Request -> Response. Both routes require an injected authentication
 * boundary; identity is never read from the body, query or headers.
 */
export function sourceCleanupRoutes(deps: SourceCleanupRoutesDeps) {
  if (
    typeof deps.authenticateStaff !== "function" ||
    typeof deps.authenticateCollector !== "function"
  )
    throw new Error("sourceCleanupRoutes requires authentication boundaries");

  const handle = async (
    request: Request,
    recordingId: string,
    authenticate: Authenticate,
    work: (
      principal: { userId: string },
      body: Record<string, unknown>,
    ) => Promise<{ data: unknown; status: number }>,
  ): Promise<Response> => {
    const auth = await authenticate(request);
    if (!auth.ok) return auth.response;
    const requestId = auth.requestId ?? randomUUID();
    try {
      if (!isUuid(recordingId))
        throw new SourceCleanupError("not_found", "Recording not found");
      const body = await readJsonObject(request, deps.config.bodyTimeoutMs);
      const { data, status } = await work(auth.principal, body);
      return respond({ data, requestId }, status, auth.headers);
    } catch (error) {
      if (error instanceof BodyError)
        return failure(
          error.code,
          error.message,
          error.status,
          false,
          requestId,
          auth.headers,
        );
      if (error instanceof SourceCleanupError)
        return failure(
          error.code,
          error.message,
          error.status,
          error.retryable,
          requestId,
          auth.headers,
        );
      console.error(
        "[source-cleanup] internal error:",
        error instanceof Error ? error.name : "unknown",
      );
      return failure(
        "internal",
        "Internal error",
        500,
        false,
        requestId,
        auth.headers,
      );
    }
  };

  return {
    confirm: (request: Request, recordingId: string) =>
      handle(
        request,
        recordingId,
        deps.authenticateStaff,
        async (principal, body) => {
          const out = await confirmSourceCopy(
            deps,
            principal,
            recordingId,
            staffExpected(body),
          );
          return { data: out.confirmation, status: out.created ? 201 : 200 };
        },
      ),
    issueProof: (request: Request, recordingId: string) =>
      handle(
        request,
        recordingId,
        deps.authenticateCollector,
        async (principal, body) => ({
          data: await issueCleanupProof(
            deps,
            principal,
            recordingId,
            ownerExpected(body),
          ),
          status: 200,
        }),
      ),
  };
}
