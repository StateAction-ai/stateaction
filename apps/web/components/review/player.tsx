"use client";

import { useCallback, useRef, useState } from "react";
import { Pause, Play, SkipBack, SkipForward } from "lucide-react";
import type { Card, ReviewModel } from "../../lib/review/types";
import { fmtClock, fmtPrecise } from "../../lib/review/timeline";
import { cn } from "../../lib/utils";
import { HandOverlay } from "./hand-overlay";
import type { usePlayback } from "./use-playback";

type Playback = ReturnType<typeof usePlayback>;

const SPEEDS = [0.5, 1, 2, 4];

function laneState(
  model: ReviewModel,
  spans: ReviewModel["lanes"]["left"],
  t: number,
): "present" | "failed" | "no hand" | "unknown" {
  if (model.presence === "absent") return "unknown";
  return spans.find((s) => t >= s.startS && t < s.endS)?.state ?? "no hand";
}

export function Player({
  model,
  playback,
  active,
  videoMessage,
  handFramesPath,
  handPoseFailed,
  mediaOffsetS,
  poster,
  onPrev,
  onNext,
}: {
  model: ReviewModel;
  playback: Playback;
  active: Card | null;
  videoMessage: string | null;
  handFramesPath: string | null;
  handPoseFailed: boolean;
  mediaOffsetS: number;
  poster: string | undefined;
  onPrev: () => void;
  onNext: () => void;
}) {
  const { t, playing, status } = playback;
  const [overlay, setOverlay] = useState(true);
  const canOverlay = handFramesPath !== null && model.clips.length > 0;
  const l = laneState(model, model.lanes.left, t);
  const r = laneState(model, model.lanes.right, t);
  const handText = (state: ReturnType<typeof laneState>) =>
    state === "failed" ? "no result" : state;
  return (
    <section
      data-testid="review-player"
      className="min-w-0 overflow-hidden rounded-2xl border border-line bg-paper shadow-[0_6px_25px_#21332a06] max-md:sticky max-md:top-0 max-md:z-20"
    >
      <div className="relative aspect-video max-h-[50vh] w-full overflow-hidden bg-[#05060a]">
        {playback.src ? (
          <video
            key={playback.srcKey}
            ref={playback.videoRef}
            src={playback.src}
            poster={poster}
            data-testid="review-video"
            className="h-full w-full bg-black object-contain"
            playsInline
            preload="metadata"
            onLoadedMetadata={playback.onLoadedMetadata}
            onError={playback.onVideoError}
            onEnded={playback.onEnded}
            onSeeked={playback.onSeeked}
            onPlaying={playback.onPlaying}
          />
        ) : poster ? (
          <img src={poster} alt="" className="h-full w-full object-contain" />
        ) : (
          <div
            data-testid="review-video-placeholder"
            className="grid h-full w-full place-items-center px-6 pb-12 text-center text-[13px] text-[#9aa3b8]"
          >
            {status === "loading"
              ? "Loading video…"
              : (videoMessage ?? "The review video is not available.")}
          </div>
        )}
        {playback.src && canOverlay && !handPoseFailed ? (
          <HandOverlay
            key={"hand-" + playback.srcKey}
            videoRef={playback.videoRef}
            model={model}
            path={handFramesPath}
            mediaOffsetS={mediaOffsetS}
            enabled={overlay}
          />
        ) : null}
        <div className="absolute top-3 left-3.5 flex flex-wrap gap-1.5">
          <Overlay data-testid="review-clock">{fmtPrecise(t)}</Overlay>
          {status === "unavailable" ? (
            <Overlay className="text-[#f2b84b]">video link unavailable</Overlay>
          ) : null}
        </div>
        {!canOverlay || !overlay || handPoseFailed ? (
          <div className="absolute top-3 right-3.5 flex max-w-[70%] gap-1.5 text-right">
            <Overlay>
              {handPoseFailed || l === "failed" || r === "failed" ? (
                "Hand pose failed"
              ) : (
                <>
                  Left: {handText(l)} · Right: {handText(r)}
                </>
              )}
            </Overlay>
          </div>
        ) : null}
      </div>
      <div
        data-testid="review-caption"
        className="min-h-[3.5rem] bg-[#080a0f] px-3.5 py-1.5 text-center text-[13.5px] text-[#f1f2f6]"
      >
        {active ? (
          <>
            <small className="mb-px block text-[11px] text-[#9aa3b8]">
              #{active.index + 1}
              {active.caption.state === "complete"
                ? ` · ${active.caption.label}`
                : ""}
            </small>
            {active.caption.state === "complete" ? (
              active.caption.text
            ) : active.caption.state === "omitted" ? (
              "Caption not needed"
            ) : (
              <span title={active.caption.code}>
                {active.kind === "failed_window"
                  ? "No segments could be produced for this time range."
                  : "No caption is available for this segment."}
              </span>
            )}
          </>
        ) : null}
      </div>
      <div
        data-testid="review-controls"
        className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line bg-field px-5 py-3"
      >
        <button
          type="button"
          onClick={playback.toggle}
          disabled={status === "unavailable" || playback.singleFrame}
          aria-label={playing ? "Pause" : "Play"}
          title={
            playback.singleFrame
              ? "This clip contains one frame."
              : "Play / pause (space)"
          }
          className="grid h-11 w-11 flex-none place-items-center rounded-full border-0 bg-brand text-white hover:bg-brand-strong disabled:opacity-50"
        >
          {playing ? (
            <Pause aria-hidden="true" size={16} fill="currentColor" />
          ) : (
            <Play aria-hidden="true" size={16} fill="currentColor" />
          )}
        </button>
        <div className="flex gap-1">
          <IconButton label="Previous segment" onClick={onPrev}>
            <SkipBack aria-hidden="true" size={14} fill="currentColor" />
          </IconButton>
          <IconButton label="Next segment" onClick={onNext}>
            <SkipForward aria-hidden="true" size={14} fill="currentColor" />
          </IconButton>
        </div>
        <div className="font-mono text-[13px] whitespace-nowrap tabular-nums">
          {fmtClock(t)}{" "}
          <span className="text-muted">/ {fmtClock(model.durationS)}</span>
        </div>
        <Scrubber model={model} t={t} onSeek={playback.seek} />
        <select
          aria-label="Playback speed"
          title="Playback speed"
          value={playback.rate}
          onChange={(e) => playback.setRate(Number(e.target.value))}
          className="min-h-11 rounded-lg border border-line bg-white px-3 text-sm text-ink"
        >
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}×
            </option>
          ))}
        </select>
        <button
          type="button"
          aria-pressed={overlay && canOverlay && !handPoseFailed}
          disabled={!canOverlay || handPoseFailed}
          onClick={() => setOverlay((shown) => !shown)}
          className={cn(
            "min-h-11 rounded-lg border border-line bg-white px-3 text-sm font-semibold text-ink disabled:opacity-50",
            overlay &&
              canOverlay &&
              !handPoseFailed &&
              "border-transparent bg-brand-soft text-brand-ink",
          )}
        >
          Hand overlay
        </button>
      </div>
    </section>
  );
}

function Overlay({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { "data-testid"?: string }) {
  return (
    <span
      className={cn(
        "rounded-md border border-white/10 bg-[rgba(10,12,18,.62)] px-2 py-0.5 text-[11px] font-semibold text-[#e8eaf0] backdrop-blur-md",
        className,
      )}
      {...props}
    />
  );
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-grid h-11 w-11 place-items-center rounded-lg border border-line bg-white text-ink hover:bg-field"
    >
      {children}
    </button>
  );
}

/** Scrubber with segment-start ticks and failure ticks over the whole recording. */
function Scrubber({
  model,
  t,
  onSeek,
}: {
  model: ReviewModel;
  t: number;
  onSeek: (t: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const pct = (s: number) =>
    model.durationS > 0 ? `${(s / model.durationS) * 100}%` : "0%";
  const seekFromEvent = useCallback(
    (e: React.PointerEvent) => {
      const rect = ref.current?.getBoundingClientRect();
      if (!rect || rect.width === 0) return;
      onSeek(((e.clientX - rect.left) / rect.width) * model.durationS);
    },
    [model.durationS, onSeek],
  );
  return (
    <div
      ref={ref}
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(model.durationS)}
      aria-valuenow={Math.round(t)}
      aria-valuetext={fmtClock(t)}
      data-testid="review-scrubber"
      className="relative h-11 min-w-24 flex-1 cursor-pointer touch-none"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        seekFromEvent(e);
      }}
      onPointerMove={(e) => {
        if (e.buttons === 1) seekFromEvent(e);
      }}
      onKeyDown={(e) => {
        const target =
          e.key === "Home"
            ? 0
            : e.key === "End"
              ? model.durationS
              : e.key === "ArrowLeft" || e.key === "ArrowDown"
                ? t - 5
                : e.key === "ArrowRight" || e.key === "ArrowUp"
                  ? t + 5
                  : null;
        if (target === null) return;
        e.preventDefault();
        onSeek(target);
      }}
    >
      <div className="absolute top-1/2 -translate-y-1/2 right-0 left-0 h-1.5 overflow-hidden rounded bg-[#e6eae4]">
        <div
          className="absolute inset-y-0 left-0 bg-brand opacity-35"
          style={{ width: pct(t) }}
        />
        {model.cards.length <= 40
          ? model.cards.map((c) => (
              <i
                key={c.segmentId}
                className="absolute top-0 h-full w-px bg-ink/25"
                style={{ left: pct(c.startS) }}
              />
            ))
          : null}
        {model.failures.map((f, i) => (
          <i
            key={`${f.kind}-${i}`}
            data-testid="scrub-failure-tick"
            className="absolute top-0 h-full bg-danger"
            style={{
              left: pct(f.startS),
              width: `max(2px, ${((f.endS - f.startS) / model.durationS) * 100}%)`,
            }}
          />
        ))}
      </div>
      <div
        className="absolute top-1/2 h-3.5 w-3.5 -translate-1/2 rounded-full border-2 border-brand bg-white shadow"
        style={{ left: pct(t) }}
      />
    </div>
  );
}
