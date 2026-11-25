// The recording's length on the review time axis. The annotations carry no
// duration field: ranges that run to the end of the stream have a null end.
// The length is the latest known timestamp, extended to frame_count / fps when
// hand pose reports the frame count and a bounded span gives the frame rate.
// It is an estimate for the axis only; no annotation time is derived from it.

import type { ClipDetail, EndFrameRef, FrameRef } from "@stateaction/contracts";
import { originOf } from "./model.ts";
import type { RecordingAnnotations } from "./types.ts";

const NS = 1e9;
export const FALLBACK_DURATION_S = 1;

export function reviewDurationS(
  annotations: RecordingAnnotations,
  range: ClipDetail["sourceRange"],
  durationNs: string | null,
): number {
  if (range) {
    const frames = range.end_ordinal - range.start_ordinal;
    if (frames > 1) {
      // The sealed end timestamp belongs to the last frame. Estimate the end
      // of that frame from the range cadence for open-ended annotations.
      const elapsed =
        Number(BigInt(range.end_ts_ns) - BigInt(range.start_ts_ns)) / NS;
      return elapsed + elapsed / (frames - 1);
    }
    return 0;
  }
  return durationNs === null
    ? estimateDurationS(annotations, originOf(annotations))
    : Number(BigInt(durationNs)) / NS;
}

export function estimateDurationS(
  a: RecordingAnnotations,
  originNs: bigint,
): number {
  let latest = 0n;
  const see = (ref: FrameRef | EndFrameRef | null | undefined) => {
    if (ref && ref.timestamp_ns !== null) {
      const t = BigInt(ref.timestamp_ns);
      if (t > latest) latest = t;
    }
  };
  for (const r of a.segments?.rows ?? []) {
    see(r.start);
    see(r.end);
  }
  for (const w of a.segments?.windows.failed ?? []) {
    see(w.core_start);
    see(w.core_end);
  }
  for (const s of a.segments?.windows.failed_core_spans ?? []) {
    see(s.start);
    see(s.end);
  }
  const lanes = [
    ...(a.hand_presence?.lanes.left ?? []),
    ...(a.hand_presence?.lanes.right ?? []),
  ];
  let frames = 0;
  let seconds = 0;
  for (const s of lanes) {
    see(s.start);
    see(s.end);
    if (s.end.timestamp_ns !== null && s.frames > 0) {
      frames += s.frames;
      seconds +=
        Number(BigInt(s.end.timestamp_ns) - BigInt(s.start.timestamp_ns)) / NS;
    }
  }
  const known = latest > originNs ? Number(latest - originNs) / NS : 0;
  const frameCount = a.hand_presence?.frame_count ?? 0;
  const fps = seconds > 0 && frames > 0 ? frames / seconds : 0;
  const fromFrames = fps > 0 && frameCount > 0 ? frameCount / fps : 0;
  const duration = Math.max(known, fromFrames);
  return duration > 0 ? duration : FALLBACK_DURATION_S;
}
