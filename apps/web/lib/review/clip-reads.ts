import "server-only";

import type { ClipDetail, ClipSelectedResultRef } from "@stateaction/contracts";
import { CatalogError } from "@stateaction/server";
import {
  clipReads,
  pipelineReads,
  stageHasFailures,
} from "@stateaction/server/pipeline";
import { estimateDurationS } from "./duration";
import { originOf } from "./model";
import { ReviewDataUnavailable, type ReviewBundle } from "./types";
import type { ReviewQueuePage, ReviewQueueQuery } from "./queue";

export function loadReviewClip(userId: string, clipId: string) {
  return clipReads().getClip(userId, clipId);
}

export function loadReviewRecording(userId: string, recordingId: string) {
  return clipReads().getRecording(userId, recordingId);
}

export async function loadReviewBundle(
  userId: string,
  clip: ClipDetail,
  selected: ClipSelectedResultRef,
): Promise<ReviewBundle | null> {
  try {
    const result = await clipReads().getSelectedResult(
      userId,
      clip.id,
      selected,
    );
    if (!result?.annotations) return null;
    const { annotations } = result;
    const originNs = clip.sourceRange?.start_ts_ns;
    const durationS =
      seconds(clip.durationNs) ??
      estimateDurationS(
        annotations,
        originNs ? BigInt(originNs) : originOf(annotations),
      );
    const query = new URLSearchParams({
      clip: clip.id,
      job: selected.jobId,
      revision: String(selected.selectionRevision),
    });
    return {
      recording: {
        recordingId: clip.recordingId,
        title: clip.recordingTitle,
        durationS,
      },
      ...(originNs ? { originNs } : {}),
      annotations,
      clips: (result.viewerChunks ?? []).map(
        ({ chunkId: clipId, startNs, endNs }) => ({
          clipId,
          startNs,
          endNs,
        }),
      ),
      video: clip.canReadOriginal
        ? {
            kind: "broker",
            readPath:
              "/api/v1/recordings/" + clip.recordingId + "/reads?" + query,
            ...(clip.sourceRange && clip.sourceOffsetNs !== null
              ? { range: { startS: seconds(clip.sourceOffsetNs)!, durationS } }
              : {}),
          }
        : { kind: "none", reason: "This recording has no review video." },
      origin: "api",
    };
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "TransportError" &&
      ["conflict", "provider_unavailable"].includes(
        String((error as Error & { code?: string }).code),
      )
    )
      throw new ReviewDataUnavailable(error.message);
    throw error;
  }
}

export function seconds(ns: string | null) {
  return ns === null ? null : Number(BigInt(ns)) / 1_000_000_000;
}

export async function loadReviewQueue(
  userId: string,
  query: ReviewQueueQuery,
): Promise<ReviewQueuePage> {
  const { state, after, recordingId, collectorId } = query;
  const pager = clipReads();
  const filter = {
    ...(recordingId ? { recordingId } : {}),
    ...(collectorId ? { collectorId } : {}),
    ...(state !== "all"
      ? { reviewStatus: state === "not-ready" ? ("not_ready" as const) : state }
      : {}),
  };
  const [result, options] = await Promise.all([
    pager
      .listClips(userId, { ...filter, ...(after ? { cursor: after } : {}) })
      .catch((error: unknown) => {
        if (
          after &&
          error instanceof CatalogError &&
          error.code === "invalid_request"
        )
          return pager.listClips(userId, filter);
        throw error;
      }),
    pipelineReads().reviewQueueFilters(userId, query),
  ]);
  return {
    ...options,
    next: result.nextCursor,
    rows: result.clips.map((clip) => {
      const sourceStartS = seconds(clip.sourceOffsetNs);
      const durationS = seconds(clip.durationNs);
      const windows = clip.pipeline.failureCounts?.failedWindows ?? null;
      const captions = clip.pipeline.failureCounts?.failedCaptions ?? null;
      return {
        id: clip.id,
        title: clip.recordingTitle,
        ordinal: clip.ordinal,
        sourceStartS,
        durationS,
        sourceEndS:
          sourceStartS === null || durationS === null
            ? null
            : sourceStartS + durationS,
        pipeline:
          clip.pipeline.jobState === "cancelled"
            ? "cancelled"
            : clip.pipeline.jobState === "needs_attention" ||
                clip.pipeline.jobState === "submit_unknown"
              ? "needs_attention"
              : clip.pipeline.state,
        failures:
          windows === null && captions === null
            ? null
            : (windows ?? 0) + (captions ?? 0),
        failedStageCount: clip.pipeline.stages.filter(stageHasFailures).length,
        markedSegments: clip.marks?.checkedCount ?? 0,
        segments: clip.marks?.segmentCount ?? null,
        state:
          clip.reviewStatus === "not_ready" ? "not-ready" : clip.reviewStatus,
      };
    }),
  };
}
