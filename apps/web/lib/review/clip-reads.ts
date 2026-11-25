import "server-only";

import type { ClipDetail, ClipSelectedResultRef } from "@stateaction/contracts";
import { clipReads } from "@stateaction/server/pipeline";
import { reviewDurationS } from "./duration";
import { ReviewDataUnavailable, type ReviewBundle } from "./types";

export function loadReviewClip(userId: string, clipId: string) {
  return clipReads().getClip(userId, clipId);
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
    const durationS = reviewDurationS(
      annotations,
      clip.sourceRange,
      clip.durationNs,
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
            ...(result.sourcePlaybackDurationNs != null &&
            clip.sourceOffsetNs !== null
              ? {
                  range: {
                    startS: seconds(clip.sourceOffsetNs)!,
                    durationS: seconds(result.sourcePlaybackDurationNs)!,
                  },
                }
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
