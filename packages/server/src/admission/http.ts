import { randomUUID } from "node:crypto";
import {
  recordingCreateContractFor,
  validateBytes,
} from "@stateaction/contracts";
import { CatalogError, type CatalogErrorCode } from "../catalog/errors.js";
import {
  hostedDevProfile,
  HOSTED_DEV_READ_ONLY_MESSAGE,
} from "../hosted-dev.js";
import {
  getRecording,
  registerRecording,
  sealRecordingInventory,
  selectRecordingCaptureRecipe,
  toRecordingV1,
  toRecordingV2,
  type AdmissionDeps,
  type RecordingView,
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
  | "not_acceptable"
  | "internal";
const STATUS: Record<ErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  idempotency_conflict: 409,
  payload_too_large: 413,
  not_acceptable: 406,
  invalid_request: 422,
  internal: 500,
};
const PRIVATE: Record<string, string> = {
  "Cache-Control": "private, no-store, max-age=0",
  Pragma: "no-cache",
  Vary: "Cookie, Authorization",
};

export async function captureRecipeSelectionRoute(
  getDeps: () => AdmissionDeps,
  authenticate: AuthenticateCollector,
  request: Request,
  recordingId: string,
) {
  const auth = await authenticate(request);
  if (!auth.ok) {
    return auth.response.status === 403
      ? failure(
          "not_found",
          "Not found",
          randomUUID(),
          new Headers(auth.response.headers),
        )
      : auth.response;
  }
  const requestId = auth.requestId ?? randomUUID();
  if (hostedDevProfile()?.mode === "read-only")
    return failure(
      "forbidden",
      HOSTED_DEV_READ_ONLY_MESSAGE,
      requestId,
      auth.headers,
    );
  const deps = getDeps();
  try {
    const body = await readContractBody(
      request,
      "http.capture-recipe-select.v1",
    );
    const data = await selectRecordingCaptureRecipe(
      deps,
      auth.principal,
      recordingId,
      body,
    );
    return respond({ data, requestId }, 200, auth.headers);
  } catch (error) {
    if (error instanceof BodyError)
      return failure(error.code, error.message, requestId, auth.headers);
    if (error instanceof CatalogError)
      return error.code === "forbidden" || error.code === "not_found"
        ? failure("not_found", "Not found", requestId, auth.headers)
        : failure(error.code, safeMessage(error), requestId, auth.headers);
    return failure(
      "internal",
      "Recipe selection is unavailable",
      requestId,
      auth.headers,
    );
  }
}

/**
 * Media type of the additive recording representation (http.recording.v2 and
 * http.recording-registration.v2, SA-71). A simulated recording is only ever
 * served in it; the unchanged v1 representation has no field that could say
 * "simulation" and is therefore never used for one.
 */
export const RECORDING_V2_MEDIA_TYPE =
  "application/vnd.stateaction.recording.v2+json";

function respond(
  body: unknown,
  status: number,
  headers = new Headers(),
  contentType = "application/json",
): Response {
  for (const [k, v] of Object.entries(PRIVATE)) headers.set(k, v);
  headers.set("Content-Type", contentType);
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
    readonly code: "payload_too_large" | "invalid_request" | "not_acceptable",
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
  contract: string | ((value: unknown) => string),
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
  if (reader) {
    let complete = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          complete = true;
          break;
        }
        total += value.byteLength;
        if (total > MAX_BODY_BYTES)
          throw new BodyError("payload_too_large", "Request body is too large");
        chunks.push(value);
      }
    } finally {
      if (!complete)
        // Oversized or failed read: cancel the source explicitly so no more
        // bytes are pulled; never drain an arbitrary remainder.
        await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  let selected: string;
  if (typeof contract === "string") selected = contract;
  else {
    let peek: unknown;
    try {
      peek = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      peek = undefined;
    }
    selected = contract(peek);
  }
  const result = validateBytes(selected, bytes);
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
    ) => Promise<{ data: unknown; status: number; contentType?: string }>,
  ): Promise<Response> => {
    const auth = await deps.authenticateCollector(request);
    if (!auth.ok) return auth.response;
    const requestId = auth.requestId ?? randomUUID();
    try {
      const { data, status, contentType } = await handler(auth.principal);
      return respond({ data, requestId }, status, auth.headers, contentType);
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
          recordingCreateContractFor,
        );
        const out = await registerRecording(deps, principal, body);
        const status = out.created ? 201 : 200;
        const collectionPermissionRef = out.collectionPermissionRef;
        // A v2 request gets the v2 representation; a v1 body (hardware only)
        // gets the frozen v1 representation.
        if (recordingCreateContractFor(body) === "http.recording-create.v2")
          return {
            status,
            contentType: RECORDING_V2_MEDIA_TYPE,
            data: {
              recording: toRecordingV2(out.recording),
              collectionPermissionRef,
            },
          };
        return {
          status,
          data: {
            recording: toRecordingV1(out.recording)!,
            collectionPermissionRef,
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
        // The seal request carries no profile: a simulated recording's
        // response is always v2, a hardware one v1 unless v2 is requested.
        return representation(request, out.recording, false);
      }),
    get: (request: Request, recordingId: string) =>
      run(request, async (principal) =>
        representation(
          request,
          await getRecording(deps.pool, principal, recordingId),
          true,
        ),
      ),
  };
}

/**
 * Chooses http.recording.v1 or v2 for a recording view. v2 only on explicit
 * Accept; a simulated recording is never downgraded: reads without the v2
 * Accept are refused (406) and writes answer in v2 unprompted.
 */
function representation(
  request: Request,
  view: RecordingView,
  refuseDowngrade: boolean,
): { data: unknown; status: number; contentType?: string } {
  const wantsV2 = (request.headers.get("accept") ?? "")
    .toLowerCase()
    .includes(RECORDING_V2_MEDIA_TYPE);
  const v1 = toRecordingV1(view);
  if (wantsV2 || (v1 === undefined && !refuseDowngrade))
    return {
      status: 200,
      data: toRecordingV2(view),
      contentType: RECORDING_V2_MEDIA_TYPE,
    };
  if (v1 === undefined)
    throw new BodyError(
      "not_acceptable",
      `Simulated recordings are served only as ${RECORDING_V2_MEDIA_TYPE}`,
    );
  return { status: 200, data: v1 };
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
