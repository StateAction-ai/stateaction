import "server-only";
import { s3ObjectReader } from "../admission/object-reader.js";
import { errorResponse as authError, newRequestId } from "../auth/http.js";
import { authRuntime, type AuthRuntime } from "../auth/runtime.js";
import { serverConfig } from "../config.js";
import { S3ReadSigner, recordingMp4MaxBytes } from "../datasets/broker.js";
import { datasetAuthenticator } from "../datasets/next.js";
import { storageClient } from "../storage.js";
import {
  listReviewRecordings,
  loadRecordingAnnotations,
  loadReviewExtras,
  type RecordingAnnotationsDocument,
  type ReviewExtras,
  type ReviewRecordingRow,
} from "./annotations.js";
import { recordingAnnotationRoutes } from "./http.js";
import {
  loadSharedClipSource,
  type SharedClipRequest,
} from "./shared-review.js";

export type {
  RecordingAnnotationsDocument,
  ReviewExtras,
  ReviewRecordingRow,
} from "./annotations.js";

export type { ClipHandFrames } from "./hand-frames.js";

/** Authorized source for the customer projection in the Server Component. */
export function sharedReviewReads(get: () => AuthRuntime = authRuntime) {
  return (input: SharedClipRequest) =>
    loadSharedClipSource(
      {
        pool: get().pool,
        reader: s3ObjectReader(serverConfig(), { timeoutMs: 15_000 }),
      },
      input,
    );
}

const KEY = Symbol.for("stateaction.annotations.routes");
type Routes = ReturnType<typeof recordingAnnotationRoutes>;

/**
 * Staff review routes (/api/v1/recordings/{id}/annotations and /reads): the
 * Better Auth staff guard, the restricted application-role pool, a bounded
 * storage reader and the same S3/R2 read signer family as the dataset reads
 * (credentials never leave this process).
 */
export function recordingAnnotationRouteHandlers(
  get: () => AuthRuntime = authRuntime,
) {
  const routes = (): Routes | Response => {
    const holder = globalThis as { [KEY]?: Routes };
    if (holder[KEY]) return holder[KEY];
    try {
      const config = serverConfig();
      return (holder[KEY] = recordingAnnotationRoutes({
        pool: get().pool,
        reader: s3ObjectReader(config, { timeoutMs: 15_000 }),
        signer: new S3ReadSigner(
          storageClient(config, 15_000, config.publicEndpoint),
          config.bucket,
        ),
        authenticate: datasetAuthenticator(get),
        recordingMp4MaxBytes: recordingMp4MaxBytes(),
      }));
    } catch (error) {
      console.error(
        "[annotations] unavailable:",
        error instanceof Error ? error.message : "error",
      );
      return authError(
        "provider_unavailable",
        "Review service is temporarily unavailable",
        newRequestId(),
      );
    }
  };
  return {
    annotations: async (request: Request, recordingId: string) => {
      const r = routes();
      return r instanceof Response ? r : r.annotations(request, recordingId);
    },
    handFrames: async (request: Request, recordingId: string) => {
      const r = routes();
      return r instanceof Response ? r : r.handFrames(request, recordingId);
    },
    read: async (request: Request, recordingId: string) => {
      const r = routes();
      return r instanceof Response ? r : r.read(request, recordingId);
    },
  };
}

/**
 * Server-rendered review reads for Server Components. The caller must have
 * passed the staff page guard; every query re-checks the enabled staff role.
 */
export function reviewReads(get: () => AuthRuntime = authRuntime) {
  return {
    list: (staffUserId: string): Promise<ReviewRecordingRow[]> =>
      listReviewRecordings(get().pool, staffUserId),
    load: async (
      staffUserId: string,
      recordingId: string,
      viewJobId?: string,
    ): Promise<{
      annotations: RecordingAnnotationsDocument;
      extras: ReviewExtras;
    } | null> => {
      const pool = get().pool;
      const annotations = await loadRecordingAnnotations(
        { pool, reader: s3ObjectReader(serverConfig(), { timeoutMs: 15_000 }) },
        staffUserId,
        recordingId,
        viewJobId,
      );
      if (!annotations) return null;
      const extras = await loadReviewExtras(
        pool,
        staffUserId,
        recordingId,
        annotations.job_id,
      );
      return extras ? { annotations, extras } : null;
    },
  };
}
