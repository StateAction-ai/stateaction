import type { ClipHandFrames } from "@stateaction/server/annotations";
import type { LaneSpan, ReviewModel } from "./types.ts";

export type ClipPtsRange = { first: number; last: number };

/** Clip windows are native-clock hints. An observed encoder PTS range takes precedence. */
export function clipForFrame(
  clips: ReviewModel["clips"],
  ranges: ReadonlyMap<number, ClipPtsRange>,
  ptsUs: number,
): number | null {
  let from = 0;
  let to = clips.length - 1;
  for (const [i, range] of ranges) {
    if (ptsUs >= range.first && ptsUs <= range.last) return i;
    if (ptsUs > range.last) from = Math.max(from, i + 1);
    else to = Math.min(to, i - 1);
  }
  if (from > to) return null;
  const estimate = clips.findIndex(
    (clip) => ptsUs >= clip.startS * 1e6 && ptsUs < clip.endS * 1e6,
  );
  if (estimate >= from && estimate <= to) return estimate;
  const previousEnd = ranges.get(from - 1)?.last;
  if (previousEnd !== undefined && ptsUs - previousEnd <= 1e6) return from;
  return Math.floor((from + to) / 2);
}

export function frameAtPts(chunk: ClipHandFrames, ptsUs: number) {
  let first = 0;
  let last = chunk.frames.length - 1;
  while (first <= last) {
    const middle = Math.floor((first + last) / 2);
    const frame = chunk.frames[middle]!;
    if (frame.ptsUs === ptsUs) return frame;
    if (frame.ptsUs < ptsUs) first = middle + 1;
    else last = middle - 1;
  }
  return null;
}

function failedAt(spans: readonly LaneSpan[], ns: bigint, origin: bigint) {
  const t = Number(ns - origin) / 1e9;
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (spans[mid]!.startS <= t) lo = mid + 1;
    else hi = mid;
  }
  const span = spans[lo - 1];
  return span?.state === "failed" && t < span.endS;
}

export function handsAtFrame(
  frame: ClipHandFrames["frames"][number],
  model: Pick<ReviewModel, "lanes" | "originNs">,
) {
  const ns = BigInt(frame.timestampNs);
  const origin = BigInt(model.originNs);
  const left = failedAt(model.lanes.left, ns, origin);
  const right = failedAt(model.lanes.right, ns, origin);
  return {
    failed: left || right,
    hands: frame.hands.filter((hand) => !(hand.side === "left" ? left : right)),
  };
}
