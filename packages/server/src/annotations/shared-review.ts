import type { ClipViewerChunk } from "@stateaction/contracts";
import { listEffectiveCaptionOverrides } from "../datasets/corrections.js";
import {
  getAuthorizedReviewClip,
  getDatasetReviewClip,
} from "../datasets/review-queries.js";
import { TransportError } from "../transport/errors.js";
import {
  loadBoundClipAnnotations,
  type AnnotationDeps,
  type BoundClipResult,
} from "./annotations.js";
import { loadBoundClipHandFrames } from "./hand-frames.js";

export type SharedClipRequest = {
  viewerUserId: string;
  clipId: string;
  datasetId: string;
};

function sameSelection(before: BoundClipResult, after: BoundClipResult | null) {
  return (
    after !== null &&
    before.jobId === after.jobId &&
    before.resultManifestSha256 === after.resultManifestSha256 &&
    before.selectionRevision === after.selectionRevision
  );
}

/** Server-only inputs for building the public view. Do not serialize this bundle. */
export async function loadSharedClipSource(
  deps: AnnotationDeps,
  input: SharedClipRequest,
) {
  const binding = await getAuthorizedReviewClip(deps.pool, input);
  if (!binding) return null;

  const [annotations, metadata, overrides, { rows: chunks }] =
    await Promise.all([
      loadBoundClipAnnotations(deps, binding),
      getDatasetReviewClip(deps.pool, input),
      listEffectiveCaptionOverrides(deps.pool, binding),
      deps.pool.query<ClipViewerChunk>(
        `SELECT id AS "chunkId", source_start_ns::text AS "startNs", source_end_ns::text AS "endNs"
         FROM clips WHERE job_id = $1 AND recording_id = $2 ORDER BY ordinal`,
        [binding.jobId, binding.recordingId],
      ),
    ]);
  if (!annotations || !metadata) return null;
  const current = await getAuthorizedReviewClip(deps.pool, input);
  if (!sameSelection(binding, current)) return null;
  return { annotations, metadata, overrides, chunks, binding };
}

export async function loadSharedClipHandFrames(
  deps: AnnotationDeps,
  input: Omit<SharedClipRequest, "datasetId"> & {
    datasetId?: string;
    selectionRevision: number;
    chunkId: string;
  },
) {
  const unavailable = () =>
    new TransportError("not_found", "Hand frames not found");
  const binding = await getAuthorizedReviewClip(deps.pool, input);
  if (!binding || binding.selectionRevision !== input.selectionRevision)
    throw unavailable();
  const result = await loadBoundClipHandFrames(deps, binding, input.chunkId);
  const current = await getAuthorizedReviewClip(deps.pool, input);
  if (!sameSelection(binding, current)) throw unavailable();
  const range = binding.sourceRange;
  return {
    raster: result.raster,
    frames: result.frames
      .filter(({ timestampNs }) => {
        if (!range) return true;
        const time = BigInt(timestampNs);
        return (
          time >= BigInt(range.start_ts_ns) && time <= BigInt(range.end_ts_ns)
        );
      })
      .map(({ ptsUs, timestampNs, hands }) => ({ ptsUs, timestampNs, hands })),
  };
}
