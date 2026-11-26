import { randomUUID } from "node:crypto";
import {
  validateBytes,
  type ClipReadCreateRequest,
  type DatasetCreateRequest,
  type DatasetMembersAddRequest,
  type DatasetUpdateRequest,
  type SegmentMarkCommand,
} from "@stateaction/contracts";
import type { Queryable } from "../catalog/catalog.js";
import { CatalogError, type CatalogErrorCode } from "../catalog/errors.js";
import type { AnnotationDeps } from "../annotations/annotations.js";
import { loadSharedClipHandFrames } from "../annotations/shared-review.js";
import {
  hostedDevProfile,
  HOSTED_DEV_READ_ONLY_MESSAGE,
} from "../hosted-dev.js";
import { TransportError } from "../transport/errors.js";
import { issueRead, type BrokerDeps, type ReadSigner } from "./broker.js";
import {
  commitCaptionCorrection,
  getCaptionCorrectionHistory,
  storedCaptionSegments,
  type CaptionCorrectionCommandV2,
} from "./corrections.js";
import {
  addDatasetMembers,
  createDatasetRecord,
  removeDatasetMember,
  renameDatasetRecord,
} from "./mutations.js";
import {
  commitClipReview,
  commitClipReviewV2,
  getClipReviewState,
  getClipReviewStateV2,
  type ClipReviewCommand,
} from "./review.js";
import {
  getAuthorizedReviewClip,
  issueReviewClipPoster,
} from "./review-queries.js";
import { issueReviewClipVideo } from "./review-video.js";
import type { ClipReviewCommandV2 } from "./review-transaction.js";
import { selectReviewClipResult } from "./select-review-result.js";
import {
  getSegmentMarks,
  recordSegmentMark,
  type SegmentIdSource,
} from "./marks.js";
import {
  getClip,
  getDataset,
  listDatasetClips,
  listDatasets,
  listStaffClips,
} from "./queries.js";

/**
 * Route handlers for the SA-35 dataset/clip HTTP surface. Web-standard
 * Request -> Response, bound by thin Next.js route files and by test adapters.
 *
 *   GET    /api/v1/datasets                               staff, customer
 *   POST   /api/v1/datasets                               staff
 *   GET    /api/v1/datasets/{datasetId}                   staff, customer
 *   PATCH  /api/v1/datasets/{datasetId}                   staff
 *   GET    /api/v1/datasets/{datasetId}/clips             staff, customer
 *   POST   /api/v1/datasets/{datasetId}/clips             staff
 *   DELETE /api/v1/datasets/{datasetId}/clips/{clipId}?expectedRevision=N  staff
 *   GET    /api/v1/datasets/{datasetId}/clips/{clipId}    staff, customer
 *   POST   /api/v1/datasets/{datasetId}/clips/{clipId}/reads   staff, customer
 *   GET    /api/v1/clips                                  staff (All clips)
 *   GET    /api/v1/clips/{clipId}                         staff, customer*
 *   POST   /api/v1/clips/{clipId}/reads                   staff, customer*
 *   GET    /api/v1/clips/{clipId}/review                  staff (review state)
 *   POST   /api/v1/clips/{clipId}/review                  staff (atomic review command)
 *   GET    /api/v1/recordings/{id}/segment-marks          staff (newest mark per segment)
 *   POST   /api/v1/recordings/{id}/segments/{segmentId}/marks  staff (append a mark)
 *  (* customers: authorized through any dataset currently granted to them)
 *
 * Authentication is injected: production binds the Better Auth session guard
 * (live enabled roles, origin/client-header checks on mutations). There is no
 * fixture or header fallback. Identity is never taken from a body or query.
 * Grants and sharing evidence are operator-only and have NO HTTP route.
 */
export type DatasetPrincipal = { userId: string };
export type DatasetAuthenticate = (
  request: Request,
  need: "staff" | "member",
) => Promise<
  | {
      ok: true;
      principal: DatasetPrincipal;
      requestId?: string;
      headers?: Headers;
    }
  | { ok: false; response: Response }
>;
export type DatasetRoutesDeps = {
  pool: Queryable;
  signer: ReadSigner;
  authenticate: DatasetAuthenticate;
  readTtlSeconds?: number;
  /** SA-99: resolves a job's accepted segment ids; marks are refused without it. */
  segmentIds?: SegmentIdSource;
};

export const MAX_BODY_BYTES = 65536;
type ErrorCode = CatalogErrorCode | "payload_too_large" | "internal";
const STATUS: Record<ErrorCode, number> = {
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  idempotency_conflict: 409,
  payload_too_large: 413,
  invalid_request: 422,
  internal: 500,
};
const GENERIC: Record<ErrorCode, string> = {
  forbidden: "This account cannot perform that action",
  not_found: "Not found",
  conflict: "The request conflicts with the current state",
  idempotency_conflict: "The request conflicts with an earlier request",
  payload_too_large: "Request body is too large",
  invalid_request: "The request is invalid",
  internal: "Internal error",
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

/** Versioned actions and scoped reads for the canonical review clip. */
export function reviewClipRoutes(
  deps: AnnotationDeps & BrokerDeps & { authenticate: DatasetAuthenticate },
) {
  async function run(
    request: Request,
    clipId: string,
    access: "staff" | "member",
    action: (viewerUserId: string, query: URLSearchParams) => Promise<unknown>,
  ) {
    const auth = await deps.authenticate(request, access);
    if (!auth.ok) {
      if (auth.response.status === 403)
        return failure(
          "not_found",
          "Not found",
          randomUUID(),
          new Headers(auth.response.headers),
        );
      return auth.response;
    }
    const requestId = auth.requestId ?? randomUUID();
    const headers = new Headers(auth.headers);
    try {
      if (request.method === "POST" && hostedDevProfile()?.mode === "read-only")
        return failure(
          "forbidden",
          HOSTED_DEV_READ_ONLY_MESSAGE,
          requestId,
          headers,
        );
      if (!isUuid(clipId))
        throw new CatalogError("not_found", "Clip not found");
      const data = await action(
        auth.principal.userId,
        new URL(request.url).searchParams,
      );
      return respond({ data, requestId }, 200, headers);
    } catch (error) {
      if (error instanceof CatalogError || error instanceof RequestError) {
        const code = error.code === "forbidden" ? "not_found" : error.code;
        return failure(
          code,
          access === "staff" && code !== "not_found"
            ? error.message
            : GENERIC[code],
          requestId,
          headers,
        );
      }
      if (error instanceof TransportError && error.code === "not_found")
        return failure("not_found", "Not found", requestId, headers);
      return failure(
        "internal",
        "Review data could not be read",
        requestId,
        headers,
      );
    }
  }

  function selection(query: URLSearchParams) {
    const values = query.getAll("selection");
    const value = values[0];
    if (
      values.length !== 1 ||
      !value ||
      !/^[1-9][0-9]{0,9}$/.test(value) ||
      Number(value) > 2147483647
    )
      throw invalid("A current result selection is required");
    return Number(value);
  }

  return {
    select: (request: Request, clipId: string) =>
      run(request, clipId, "staff", async (viewerUserId) => {
        const command = await readContract<{
          jobId: string;
          expectedSelectionSeq: number;
          reason: string;
        }>(request, "http.recording-result-selection-command.v1");
        return selectReviewClipResult(deps.pool, {
          clipId,
          viewerUserId,
          ...command,
        });
      }),
    decision: (request: Request, clipId: string) =>
      run(request, clipId, "staff", async (viewerUserId, query) => {
        if (request.method === "GET")
          return getClipReviewStateV2(deps.pool, {
            clipId,
            viewerUserId,
            selectionRevision: selection(query),
          });
        const command = await readContract<ClipReviewCommandV2>(
          request,
          "http.clip-review-command.v2",
        );
        return commitClipReviewV2(deps.pool, {
          clipId,
          reviewerUserId: viewerUserId,
          command,
        });
      }),
    caption: (request: Request, clipId: string, segmentId: string) =>
      run(request, clipId, "staff", async (viewerUserId, query) => {
        if (!isUuid(segmentId))
          throw new CatalogError("not_found", "Caption not found");
        if (request.method === "GET") {
          const before = query.get("before");
          if (
            before !== null &&
            (!/^[1-9][0-9]{0,9}$/.test(before) || Number(before) > 2147483647)
          )
            throw invalid("Invalid caption history revision");
          return getCaptionCorrectionHistory(deps.pool, {
            clipId,
            segmentId,
            viewerUserId,
            jobId: query.get("job") ?? "",
            resultManifestSha256: query.get("manifest") ?? "",
            selectionRevision: selection(query),
            ...(before === null ? {} : { beforeRevision: Number(before) }),
          });
        }
        const command = await readContract<CaptionCorrectionCommandV2>(
          request,
          "http.caption-correction-command.v2",
        );
        return commitCaptionCorrection(deps.pool, storedCaptionSegments(deps), {
          clipId,
          segmentId,
          reviewerUserId: viewerUserId,
          command,
        });
      }),
    poster: (request: Request, clipId: string) =>
      run(request, clipId, "member", (viewerUserId, query) => {
        const datasetId = query.get("dataset") ?? undefined;
        return issueReviewClipPoster(deps, { viewerUserId, clipId, datasetId });
      }),
    handFrames: (request: Request, clipId: string, datasetId: string) =>
      run(request, clipId, "member", (viewerUserId, query) =>
        loadSharedClipHandFrames(deps, {
          viewerUserId,
          clipId,
          datasetId,
          selectionRevision: selection(query),
          chunkId: query.get("clip") ?? "",
        }),
      ),
    staffHandFrames: (request: Request, clipId: string) =>
      run(request, clipId, "staff", (viewerUserId, query) =>
        loadSharedClipHandFrames(deps, {
          viewerUserId,
          clipId,
          selectionRevision: selection(query),
          chunkId: query.get("clip") ?? "",
        }),
      ),
    video: (request: Request, clipId: string, datasetId: string) =>
      run(request, clipId, "member", async (viewerUserId, query) => {
        const binding = await getAuthorizedReviewClip(deps.pool, {
          viewerUserId,
          clipId,
          datasetId,
        });
        if (!binding || binding.selectionRevision !== selection(query))
          throw new CatalogError("not_found", "Clip video not found");
        return issueReviewClipVideo(deps, {
          viewerUserId,
          clipId,
          datasetId,
          expectedSelection: binding,
        });
      }),
  };
}

class RequestError extends Error {
  constructor(
    readonly code: "payload_too_large" | "invalid_request",
    message: string,
  ) {
    super(message);
  }
}
const invalid = (message: string) =>
  new RequestError("invalid_request", message);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isUuid = (v: unknown): v is string =>
  typeof v === "string" && UUID.test(v);

/**
 * Reads a JSON body with a hard byte bound before allocating beyond it, then
 * validates the exact bytes against the catalog.v8 contract (UTF-8, JSON,
 * closed schema). No private route shape exists beyond the contracts.
 */
async function readContract<T>(request: Request, contract: string): Promise<T> {
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json(\s*;|$)/i.test(type))
    throw invalid("Content-Type must be application/json");
  const declared = request.headers.get("content-length");
  if (
    declared !== null &&
    (!/^[0-9]{1,16}$/.test(declared) || Number(declared) > MAX_BODY_BYTES)
  )
    throw new RequestError("payload_too_large", "Request body is too large");
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
          throw new RequestError(
            "payload_too_large",
            "Request body is too large",
          );
        chunks.push(value);
      }
    } finally {
      if (!complete) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  const result = validateBytes(contract, bytes);
  if (!result.valid)
    throw result.code === "document_too_large"
      ? new RequestError("payload_too_large", "Request body is too large")
      : invalid(`Request failed ${result.code}`);
  return result.value as T;
}

type Query = {
  q?: string;
  label?: string;
  cursor?: string;
  limit?: number;
  reviewStatus?: "pending" | "approved" | "rejected";
  recordingId?: string;
  expectedRevision?: number;
  run?: string;
  version?: "2";
  clip?: string;
  selection?: number;
};
function readQuery(request: Request, allowed: readonly (keyof Query)[]): Query {
  const out: Query = {};
  const seen = new Set<string>();
  for (const [key, value] of new URL(request.url).searchParams) {
    if (seen.has(key) || !(allowed as readonly string[]).includes(key))
      throw invalid(`Unsupported query parameter ${key}`);
    seen.add(key);
    if (key === "q" || key === "label") {
      if (value.length > 160 || /[\u0000-\u001f\u007f]/.test(value))
        throw invalid("Invalid search");
      out[key] = value.trim();
    } else if (key === "cursor") {
      if (!value || value.length > 300) throw invalid("Invalid cursor");
      out.cursor = value;
    } else if (key === "limit") {
      if (!/^[0-9]{1,3}$/.test(value)) throw invalid("limit must be 1..100");
      out.limit = Number(value);
    } else if (key === "reviewStatus") {
      if (!["pending", "approved", "rejected"].includes(value))
        throw invalid("Invalid reviewStatus");
      out.reviewStatus = value as NonNullable<Query["reviewStatus"]>;
    } else if (key === "run") {
      if (!isUuid(value)) throw invalid("run must be a UUID");
      out.run = value;
    } else if (key === "version") {
      if (value !== "2") throw invalid("Unsupported marks version");
      out.version = value;
    } else if (key === "recordingId" || key === "clip") {
      if (!isUuid(value)) throw invalid(key + " must be a UUID");
      out[key] = value;
    } else if (key === "selection") {
      if (!/^[1-9]\d{0,9}$/.test(value) || Number(value) > 2147483647)
        throw invalid("Invalid selection revision");
      out.selection = Number(value);
    } else if (key === "expectedRevision") {
      if (!/^[0-9]{1,10}$/.test(value))
        throw invalid("Invalid expectedRevision");
      out.expectedRevision = Number(value);
    }
  }
  return out;
}

const pathId = (value: string, field: string) => {
  if (!isUuid(value)) throw invalid(`${field} must be a UUID`);
  return value;
};

function clipSelectionRevision(request: Request) {
  const { selection } = readQuery(request, ["selection"]);
  if (selection === undefined) throw invalid("Selection revision is required");
  return selection;
}

export function datasetRoutes(deps: DatasetRoutesDeps) {
  if (typeof deps.authenticate !== "function")
    throw new Error("datasetRoutes requires an authenticate boundary");
  const { pool } = deps;
  const run = async (
    request: Request,
    need: "staff" | "member",
    handler: (
      principal: DatasetPrincipal,
    ) => Promise<{ data: unknown; status?: number }>,
    write = false,
  ): Promise<Response> => {
    const auth = await deps.authenticate(request, need);
    if (!auth.ok) return auth.response;
    const requestId = auth.requestId ?? randomUUID();
    try {
      if (write && hostedDevProfile()?.mode === "read-only")
        return failure(
          "forbidden",
          HOSTED_DEV_READ_ONLY_MESSAGE,
          requestId,
          auth.headers,
        );
      const { data, status } = await handler(auth.principal);
      return respond({ data, requestId }, status ?? 200, auth.headers);
    } catch (error) {
      if (error instanceof RequestError)
        return failure(error.code, error.message, requestId, auth.headers);
      if (error instanceof CatalogError) {
        // Database-authored SAC messages are safe and useful to staff; any
        // other driver message (constraint names, key values) is replaced.
        const authored =
          error.sqlstate === undefined || error.sqlstate.startsWith("SAC");
        return failure(
          error.code,
          authored ? error.message : GENERIC[error.code],
          requestId,
          auth.headers,
        );
      }
      console.error(
        "[datasets] unexpected error",
        error instanceof Error ? error.name : "unknown",
      );
      return failure("internal", GENERIC.internal, requestId, auth.headers);
    }
  };

  const write = (
    request: Request,
    handler: (
      principal: DatasetPrincipal,
    ) => Promise<{ data: unknown; status?: number }>,
  ) => run(request, "staff", handler, true);

  const read = async (
    principal: DatasetPrincipal,
    request: Request,
    clipId: string,
    datasetId?: string,
  ) => {
    const body = await readContract<ClipReadCreateRequest>(
      request,
      "http.clip-read-create.v1",
    );
    return {
      data: await issueRead(
        { pool, signer: deps.signer, ttlSeconds: deps.readTtlSeconds },
        {
          viewerUserId: principal.userId,
          clipId,
          role: body.role,
          datasetId,
        },
      ),
    };
  };

  return {
    listDatasets: (request: Request) =>
      run(request, "member", async (p) => {
        const q = readQuery(request, ["cursor", "limit", "q"]);
        const page = await listDatasets(pool, { viewerUserId: p.userId, ...q });
        return { data: { datasets: page.items, nextCursor: page.nextCursor } };
      }),
    createDataset: (request: Request) =>
      write(request, async (p) => {
        const body = await readContract<DatasetCreateRequest>(
          request,
          "http.dataset-create.v1",
        );
        if (!body.name.trim()) throw invalid("name must not be blank");
        const out = await createDatasetRecord(pool, {
          datasetId: body.datasetId,
          name: body.name,
          actorUserId: p.userId,
        });
        return {
          status: out.created ? 201 : 200,
          data: { datasetId: out.datasetId, revision: out.revision },
        };
      }),
    getDataset: (request: Request, datasetId: string) =>
      run(request, "member", async (p) => ({
        data: await getDataset(pool, {
          viewerUserId: p.userId,
          datasetId: pathId(datasetId, "datasetId"),
        }),
      })),
    renameDataset: (request: Request, datasetId: string) =>
      write(request, async (p) => {
        const id = pathId(datasetId, "datasetId");
        const body = await readContract<DatasetUpdateRequest>(
          request,
          "http.dataset-update.v1",
        );
        if (!body.name.trim()) throw invalid("name must not be blank");
        return {
          data: await renameDatasetRecord(pool, {
            datasetId: id,
            name: body.name,
            expectedRevision: body.expectedRevision,
            actorUserId: p.userId,
          }),
        };
      }),
    listDatasetClips: (request: Request, datasetId: string) =>
      run(request, "member", async (p) => {
        const id = pathId(datasetId, "datasetId");
        const q = readQuery(request, ["cursor", "limit", "q", "label"]);
        const page = await listDatasetClips(pool, {
          viewerUserId: p.userId,
          datasetId: id,
          ...q,
        });
        return { data: { clips: page.items, nextCursor: page.nextCursor } };
      }),
    addDatasetClips: (request: Request, datasetId: string) =>
      write(request, async (p) => {
        const id = pathId(datasetId, "datasetId");
        const body = await readContract<DatasetMembersAddRequest>(
          request,
          "http.dataset-members-add.v1",
        );
        return {
          data: await addDatasetMembers(pool, {
            datasetId: id,
            clipIds: body.clipIds,
            expectedRevision: body.expectedRevision,
            actorUserId: p.userId,
          }),
        };
      }),
    removeDatasetClip: (request: Request, datasetId: string, clipId: string) =>
      write(request, async (p) => {
        const q = readQuery(request, ["expectedRevision"]);
        if (q.expectedRevision === undefined || q.expectedRevision < 1)
          throw invalid("expectedRevision is required");
        return {
          data: await removeDatasetMember(pool, {
            datasetId: pathId(datasetId, "datasetId"),
            clipId: pathId(clipId, "clipId"),
            expectedRevision: q.expectedRevision,
            actorUserId: p.userId,
          }),
        };
      }),
    getDatasetClip: (request: Request, datasetId: string, clipId: string) =>
      run(request, "member", async (p) => ({
        data: await getClip(pool, {
          viewerUserId: p.userId,
          clipId: pathId(clipId, "clipId"),
          datasetId: pathId(datasetId, "datasetId"),
        }),
      })),
    readDatasetClip: (request: Request, datasetId: string, clipId: string) =>
      run(request, "member", (p) =>
        read(
          p,
          request,
          pathId(clipId, "clipId"),
          pathId(datasetId, "datasetId"),
        ),
      ),
    listClips: (request: Request) =>
      run(request, "staff", async (p) => {
        const q = readQuery(request, [
          "cursor",
          "limit",
          "reviewStatus",
          "recordingId",
          "q",
          "label",
        ]);
        const page = await listStaffClips(pool, {
          viewerUserId: p.userId,
          ...q,
        });
        return { data: { clips: page.items, nextCursor: page.nextCursor } };
      }),
    getClip: (request: Request, clipId: string) =>
      run(request, "member", async (p) => ({
        data: await getClip(pool, {
          viewerUserId: p.userId,
          clipId: pathId(clipId, "clipId"),
        }),
      })),
    getClipReview: (request: Request, clipId: string, persisted = false) =>
      run(request, "staff", async (p) => {
        const selectionRevision = persisted
          ? clipSelectionRevision(request)
          : undefined;
        if (!persisted) readQuery(request, []);
        return {
          data: await getClipReviewState(pool, {
            viewerUserId: p.userId,
            clipId: pathId(clipId, "clipId"),
            ...(selectionRevision !== undefined ? { selectionRevision } : {}),
          }),
        };
      }),
    commitClipReview: (request: Request, clipId: string, persisted = false) =>
      write(request, async (p) => {
        const id = pathId(clipId, "clipId");
        const selectionRevision = persisted
          ? clipSelectionRevision(request)
          : undefined;
        const body = await readContract<ClipReviewCommand>(
          request,
          "http.clip-review-command.v1",
        );
        const out = await commitClipReview(pool, {
          clipId: id,
          reviewerUserId: p.userId,
          command: body,
          ...(selectionRevision !== undefined ? { selectionRevision } : {}),
        });
        return { status: out.replayed ? 200 : 201, data: out.review };
      }),
    readClip: (request: Request, clipId: string) =>
      run(request, "member", (p) => read(p, request, pathId(clipId, "clipId"))),
    getSegmentMarks: (request: Request, recordingId: string) =>
      run(request, "staff", async (p) => {
        const { version, run } = readQuery(request, ["version", "run"]);
        const includeOrigins = version === "2";
        return {
          data: await getSegmentMarks(pool, {
            viewerUserId: p.userId,
            recordingId: pathId(recordingId, "recordingId"),
            viewJobId: run ? pathId(run, "run") : undefined,
            includeOrigins,
          }),
        };
      }),
    postSegmentMark: (
      request: Request,
      recordingId: string,
      segmentId: string,
    ) =>
      write(request, async (p) => {
        const rid = pathId(recordingId, "recordingId");
        const sid = pathId(segmentId, "segmentId");
        const { clip, selection } = readQuery(request, ["clip", "selection"]);
        if ((clip === undefined) !== (selection === undefined))
          throw invalid("A clip and selection revision are required together");
        const body = await readContract<SegmentMarkCommand>(
          request,
          "http.segment-mark-command.v1",
        );
        if (!deps.segmentIds)
          throw new Error("segment marks are not configured");
        const mark = await recordSegmentMark(pool, deps.segmentIds, {
          recordingId: rid,
          segmentId: sid,
          reviewerUserId: p.userId,
          command: body,
          ...(clip && selection
            ? { clipSelection: { clipId: clip, revision: selection } }
            : {}),
        });
        return { status: mark.replayed ? 200 : 201, data: mark };
      }),
  };
}
