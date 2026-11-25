"use client";

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type RefObject,
} from "react";
import type { ClipHandFrames } from "@stateaction/server/annotations";
import {
  clipForFrame,
  frameAtPts,
  handsAtFrame,
  type ClipPtsRange,
} from "../../lib/review/hand-frames";
import type { ReviewModel } from "../../lib/review/types";

const EDGES = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [0, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [5, 9],
  [9, 10],
  [10, 11],
  [11, 12],
  [9, 13],
  [13, 14],
  [14, 15],
  [15, 16],
  [13, 17],
  [0, 17],
  [17, 18],
  [18, 19],
  [19, 20],
] as const;
const LABEL = "Hand pose";
const CACHE_SIZE = 4;

export function HandOverlay({
  videoRef,
  model,
  path,
  mediaOffsetS,
  enabled,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  model: ReviewModel;
  path: string;
  mediaOffsetS: number;
  enabled: boolean;
}) {
  const [pts, setPts] = useState<number | null>(null);
  const [chunks, setChunks] = useState(new Map<number, ClipHandFrames>());
  const [ranges, setRanges] = useState(new Map<number, ClipPtsRange>());
  const [failure, setFailure] = useState<number | null>(null);
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const video = videoRef.current;
  useEffect(() => {
    const el = videoRef.current;
    if (!el?.requestVideoFrameCallback) return;
    let request = 0;
    const frame: VideoFrameRequestCallback = (_, metadata) => {
      setPts(Math.round((metadata.mediaTime - mediaOffsetS) * 1e6));
      request = el.requestVideoFrameCallback(frame);
    };
    const clear = () => setPts(null);
    request = el.requestVideoFrameCallback(frame);
    el.addEventListener("seeking", clear);
    el.addEventListener("emptied", clear);
    el.addEventListener("error", clear);
    return () => {
      el.cancelVideoFrameCallback(request);
      el.removeEventListener("seeking", clear);
      el.removeEventListener("emptied", clear);
      el.removeEventListener("error", clear);
    };
  }, [videoRef, mediaOffsetS]);

  const clip =
    enabled && pts !== null ? clipForFrame(model.clips, ranges, pts) : null;
  const cached = clip === null ? undefined : chunks.get(clip);
  const clipId = clip === null ? undefined : model.clips[clip]?.clipId;
  useEffect(() => {
    if (clip === null || !clipId || cached || failure === clip) return;
    const index = clip;
    const id = clipId;
    const abort = new AbortController();
    async function load() {
      try {
        const url = new URL(path, window.location.origin);
        url.searchParams.set("clip", id);
        const response = await fetch(url, {
          cache: "no-store",
          signal: abort.signal,
        });
        if (!response.ok) throw new Error("Hand frame request failed");
        const { data } = (await response.json()) as { data: ClipHandFrames };
        if (abort.signal.aborted) return;
        const first = data.frames[0]!.ptsUs;
        const last = data.frames.at(-1)!.ptsUs;
        setRanges((old) => new Map(old).set(index, { first, last }));
        setChunks((old) => {
          const next = new Map(old).set(index, data);
          if (next.size > CACHE_SIZE) next.delete(next.keys().next().value!);
          return next;
        });
      } catch {
        if (!abort.signal.aborted) setFailure(clip);
      }
    }
    void load();
    return () => abort.abort();
  }, [cached, clip, clipId, failure, path]);

  useEffect(() => {
    if (!enabled) setFailure(null);
  }, [enabled]);

  const frame = cached && pts !== null ? frameAtPts(cached, pts) : null;
  const aligned =
    cached &&
    video?.videoWidth === cached.raster.width &&
    video.videoHeight === cached.raster.height;
  const result = useMemo(
    () => (frame && aligned ? handsAtFrame(frame, model) : null),
    [frame, aligned, model],
  );
  const status = !enabled
    ? null
    : video && !video.requestVideoFrameCallback
      ? LABEL + " unavailable in this browser"
      : clip !== null && failure === clip
        ? LABEL + " unavailable"
        : cached && !aligned
          ? LABEL + " raster unavailable"
          : pts === null || (clip !== null && !cached)
            ? LABEL + " loading…"
            : !result
              ? LABEL + " unavailable for this frame"
              : result.failed
                ? LABEL + " failed"
                : result.hands.length
                  ? result.hands
                      .map((hand) => (hand.side === "left" ? "L ✓" : "R ✓"))
                      .join(" · ")
                  : "No hand detected";

  useLayoutEffect(() => {
    const context = canvas?.getContext("2d");
    if (!context || !canvas) return;
    context.clearRect(0, 0, canvas.width, canvas.height);
    if (!result) return;
    for (const { side, points } of result.hands) {
      const color = side === "left" ? "#55b6ff" : "#ff7ab9";
      const unit = Math.max(canvas.width, canvas.height) / 480;
      context.lineCap = "round";
      context.beginPath();
      for (const [a, b] of EDGES) {
        const start = points[a];
        const end = points[b];
        if (!start || !end) continue;
        context.moveTo(...start);
        context.lineTo(...end);
      }
      context.strokeStyle = "#111827";
      context.lineWidth = 4 * unit;
      context.stroke();
      context.strokeStyle = color;
      context.lineWidth = 2 * unit;
      context.stroke();
      for (const point of points) {
        if (!point) continue;
        context.beginPath();
        context.arc(point[0], point[1], 3 * unit, 0, 2 * Math.PI);
        context.fillStyle = color;
        context.fill();
        context.strokeStyle = "#111827";
        context.lineWidth = unit;
        context.stroke();
      }
    }
  }, [canvas, result]);

  if (!enabled) return null;
  return (
    <>
      <canvas
        ref={setCanvas}
        width={cached?.raster.width ?? 1}
        height={cached?.raster.height ?? 1}
        aria-hidden="true"
        data-testid="hand-overlay"
        data-frame-id={result ? frame?.sourceFrameId : undefined}
        data-timestamp-ns={result ? frame?.timestampNs : undefined}
        className="pointer-events-none absolute inset-0 h-full w-full object-contain"
      />
      <span
        data-testid="hand-overlay-state"
        className="absolute top-3 right-3.5 rounded-md border border-white/10 bg-[rgba(10,12,18,.62)] px-2 py-0.5 text-[11px] font-semibold text-[#e8eaf0]"
      >
        {status}
      </span>
    </>
  );
}
