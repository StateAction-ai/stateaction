import { randomUUID } from "node:crypto";
import { validateBytes } from "@stateaction/contracts";
import type { Authority } from "./authority.js";
import { TransportError } from "./errors.js";
import {
  allocateJobOutput,
  allocateSourceUpload,
  getUploadPlan,
  journalReceipts,
  signParts,
  type OutputRequest,
  type SourceUploadRequest,
  type TransportDeps,
} from "./service.js";

/**
 * Control routes carry small JSON only (largest legitimate body: 32 receipts,
 * a few KiB). Bodies are read incrementally and rejected the moment they exceed
 * this bound, so a media upload sent to the API cannot be buffered or proxied;
 * media bytes only ever go to the scoped presigned provider URLs.
 */
export const MAX_CONTROL_BODY_BYTES = 16 * 1024;

export async function readBoundedJson(
  request: Request,
  contract: string | null,
  maxBytes = MAX_CONTROL_BODY_BYTES,
): Promise<unknown> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(type))
    throw new TransportError(
      "unsupported_media_type",
      "Body must be application/json",
    );
  const declared = request.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > maxBytes)
  )
    throw new TransportError("payload_too_large", "Control body too large");
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (request.body) {
    const reader = request.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new TransportError(
            "payload_too_large",
            "Control body too large",
          );
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  if (contract === null) {
    // Unregistered control body (job output reservation): strict JSON object.
    try {
      const value: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
      if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new Error();
      return value;
    } catch {
      throw new TransportError("invalid_request", "Body must be a JSON object");
    }
  }
  const result = validateBytes(contract, bytes);
  if (!result.valid)
    throw new TransportError(
      "invalid_request",
      `${contract}: ${result.code}${result.errors[0] ? ` at ${result.errors[0].path || "/"}` : ""}`,
    );
  return result.value;
}

const ENVELOPE_CODE: Record<string, string> = {
  provider_ambiguous: "conflict",
  unsupported_media_type: "invalid_request",
};
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      // Responses may hold bearer URLs: never cache.
      "cache-control": "no-store",
    },
  });
}
export function errorResponse(error: unknown, requestId: string): Response {
  if (error instanceof TransportError)
    return json(error.status, {
      error: {
        code: ENVELOPE_CODE[error.code] ?? error.code,
        message: error.message.slice(0, 500),
        retryable: error.retryable,
      },
      requestId,
    });
  return json(500, {
    error: { code: "internal", message: "Internal error", retryable: false },
    requestId,
  });
}

type Handler = (
  request: Request,
  authority: Authority,
  fileId?: string,
) => Promise<unknown>;
function route(handler: Handler) {
  return async (request: Request, authority: Authority, fileId?: string) => {
    const requestId = randomUUID();
    try {
      return json(200, {
        data: await handler(request, authority, fileId),
        requestId,
      });
    } catch (error) {
      return errorResponse(error, requestId);
    }
  };
}
const need = (authority: Authority, kind: Authority["kind"]) => {
  if (authority.kind !== kind)
    throw new TransportError(
      "forbidden",
      "Wrong credential type for this route",
    );
};

/**
 * Framework-neutral Web Request/Response handlers. The Next route files that
 * bind these to Better Auth sessions (owner) and job capabilities (job) are
 * added with SA-19 admission; the handlers themselves are the final logic.
 */
export function transportHandlers(deps: TransportDeps) {
  return {
    /** POST /api/v1/uploads */
    createSourceUpload: route(async (request, authority) => {
      need(authority, "owner");
      const body = (await readBoundedJson(
        request,
        "http.upload-create.v1",
      )) as SourceUploadRequest;
      return allocateSourceUpload(
        deps,
        authority as Extract<Authority, { kind: "owner" }>,
        body,
      );
    }),
    /** GET /api/v1/uploads/{fileId} and the job-scoped equivalent */
    getUpload: route(async (_request, authority, fileId) =>
      getUploadPlan(deps, authority, fileId ?? ""),
    ),
    /** POST /uploads/{fileId}/parts/sign (human and job-scoped) */
    signParts: route(async (request, authority, fileId) =>
      signParts(
        deps,
        authority,
        fileId ?? "",
        (await readBoundedJson(request, "http.parts-sign.v1")) as never,
      ),
    ),
    /** PUT /uploads/{fileId}/parts/receipts (human and job-scoped) */
    putReceipts: route(async (request, authority, fileId) =>
      journalReceipts(
        deps,
        authority,
        fileId ?? "",
        (await readBoundedJson(request, "http.parts-receipts.v1")) as never,
      ),
    ),
    /** POST /internal/v1/jobs/{jobId}/outputs */
    createJobOutput: route(async (request, authority) => {
      need(authority, "job");
      const body = (await readBoundedJson(request, null)) as OutputRequest;
      const keys = Object.keys(body).sort().join(",");
      if (keys !== "role,sha256,sizeBytes,slot")
        throw new TransportError(
          "invalid_request",
          "Unexpected output reservation fields",
        );
      return allocateJobOutput(
        deps,
        authority as Extract<Authority, { kind: "job" }>,
        body,
      );
    }),
  };
}
