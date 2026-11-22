import { randomUUID } from "node:crypto";
import type pg from "pg";
import { CatalogError } from "../catalog/errors.js";
import {
  issueRecordingRead,
  RECORDING_READ_ROLES,
  type ReadSigner,
} from "../datasets/broker.js";
import type { DatasetAuthenticate } from "../datasets/http.js";
import { TransportError } from "../transport/errors.js";
import { errorResponse, readBoundedBytes } from "../transport/http.js";
import {
  loadRecordingAnnotations,
  type AnnotationDeps,
} from "./annotations.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PRIVATE = {
  "cache-control": "private, no-store, max-age=0",
  pragma: "no-cache",
  vary: "Cookie, Authorization",
};

export type AnnotationRouteDeps = AnnotationDeps & {
  signer: ReadSigner;
  authenticate: DatasetAuthenticate;
  /** recording_mp4 size limit; default STATEACTION_RECORDING_MP4_MAX_BYTES or 8 GiB. */
  recordingMp4MaxBytes?: number;
  now?: () => Date;
};

const FIXED: Record<string, string> = {
  not_found: "Not found",
  forbidden: "This account cannot perform that action",
  invalid_request: "The request is invalid",
  conflict: "The request conflicts with the current state",
};
/** Catalog failures keep their class but never their database text. */
function fromCatalog(error: unknown): unknown {
  if (!(error instanceof CatalogError)) return error;
  const code =
    error.code === "not_found" ||
    error.code === "forbidden" ||
    error.code === "invalid_request"
      ? error.code
      : "conflict";
  return new TransportError(code, FIXED[code]!);
}

/**
 * SA-98 staff routes of the review page:
 *   GET  /api/v1/recordings/{id}/annotations[?download=1]
 *   POST /api/v1/recordings/{id}/reads   {"role":"recording_mp4"}
 * Both authenticate through the staff session guard (injected) and re-check the
 * enabled staff role in SQL. Unknown, deleted and not-yet-accepted recordings
 * answer the same 404.
 */
export function recordingAnnotationRoutes(deps: AnnotationRouteDeps) {
  const guarded = async (
    request: Request,
    recordingId: string,
    run: (
      userId: string,
      headers: Headers,
      requestId: string,
    ) => Promise<Response>,
  ): Promise<Response> => {
    const auth = await deps.authenticate(request, "staff");
    if (!auth.ok) return auth.response;
    const requestId = auth.requestId ?? randomUUID();
    const headers = new Headers(auth.headers);
    for (const [k, v] of Object.entries(PRIVATE)) headers.set(k, v);
    try {
      if (!UUID.test(recordingId))
        throw new TransportError("not_found", "Recording not found");
      return await run(auth.principal.userId, headers, requestId);
    } catch (raw) {
      const error = fromCatalog(raw);
      if (!(error instanceof TransportError))
        console.error(
          "[annotations] error",
          error instanceof Error ? error.name : "error",
        );
      const res = errorResponse(error, requestId);
      for (const [k, v] of res.headers) headers.set(k, v);
      return new Response(res.body, { status: res.status, headers });
    }
  };
  return {
    annotations: (request: Request, recordingId: string): Promise<Response> =>
      guarded(request, recordingId, async (userId, headers, requestId) => {
        const document = await loadRecordingAnnotations(
          { pool: deps.pool, reader: deps.reader },
          userId,
          recordingId,
        );
        if (!document)
          throw new TransportError("not_found", "Annotations not found");
        const download = new URL(request.url).searchParams.get("download");
        headers.set("content-type", "application/json");
        if (download === "1") {
          headers.set(
            "content-disposition",
            `attachment; filename="annotations-${recordingId}.json"`,
          );
          return new Response(JSON.stringify(document), {
            status: 200,
            headers,
          });
        }
        return new Response(JSON.stringify({ data: document, requestId }), {
          status: 200,
          headers,
        });
      }),
    read: (request: Request, recordingId: string): Promise<Response> =>
      guarded(request, recordingId, async (userId, headers, requestId) => {
        let body: unknown;
        try {
          body = JSON.parse(
            new TextDecoder().decode(await readBoundedBytes(request, 1024)),
          );
        } catch (error) {
          if (error instanceof TransportError) throw error;
          throw new TransportError("invalid_request", "Body must be JSON");
        }
        const role = (body as { role?: unknown } | null)?.role;
        if (
          typeof role !== "string" ||
          !(RECORDING_READ_ROLES as readonly string[]).includes(role)
        )
          throw new TransportError(
            "invalid_request",
            "role must be recording_mp4",
          );
        const view = await issueRecordingRead(
          {
            pool: deps.pool,
            signer: deps.signer,
            ...(deps.recordingMp4MaxBytes
              ? { maxBytes: deps.recordingMp4MaxBytes }
              : {}),
            ...(deps.now ? { now: deps.now } : {}),
          },
          { viewerUserId: userId, recordingId, role: "recording_mp4" },
        );
        headers.set("content-type", "application/json");
        return new Response(JSON.stringify({ data: view, requestId }), {
          status: 200,
          headers,
        });
      }),
  };
}
export type RecordingAnnotationRoutes = ReturnType<
  typeof recordingAnnotationRoutes
>;
