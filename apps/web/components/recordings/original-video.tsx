"use client";

import { useEffect, useRef, useState } from "react";
import { fmtClock, fmtPrecise, niceStep } from "../../lib/review/timeline";
import { fetchVideoUrl, MAX_RENEWALS } from "../../lib/review/video-url";
import type { TimelineSpan } from "../../lib/recording-timeline";
import { privateSignal } from "../../lib/private-state";
import { Card } from "../ui/card";

export function OriginalVideo({
  readPath,
  initialTime,
  expectedDuration,
  spans,
  range,
}: {
  readPath: string | null;
  initialTime: number;
  expectedDuration: number | null;
  spans: TimelineSpan[];
  range?: { start: number; end: number } | undefined;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [generation, setGeneration] = useState(0);
  const [src, setSrc] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [mediaDuration, setMediaDuration] = useState<number | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const failedLoads = useRef(0);
  const position = useRef(initialTime);
  const wasPlaying = useRef(false);
  const duration = mediaDuration ?? expectedDuration ?? 0;
  const lower = range?.start ?? 0;
  const upper = range?.end ?? Infinity;
  const heading = range ? "Clip preview" : "Original video";
  const previewDuration = range ? range.end - range.start : duration;

  useEffect(() => {
    if (!readPath) return;
    const controller = new AbortController();
    fetchVideoUrl(readPath, {
      signal: AbortSignal.any([controller.signal, privateSignal()]),
    }).then(
      ({ url }) => {
        if (!controller.signal.aborted) setSrc(url);
      },
      () => {
        if (!controller.signal.aborted) setUnavailable(true);
      },
    );
    return () => controller.abort();
  }, [generation, readPath]);

  useEffect(() => {
    const video = ref.current;
    position.current = initialTime;
    if (video && video.readyState >= 1 && Number.isFinite(video.duration)) {
      video.currentTime = Math.min(
        Math.max(initialTime, lower),
        upper,
        video.duration,
      );
      setPlayhead(video.currentTime);
    }
  }, [initialTime, lower, upper]);

  function seek(seconds: number) {
    const video = ref.current;
    if (!video || !mediaDuration) return;
    video.currentTime = Math.min(
      Math.max(seconds, lower),
      upper,
      mediaDuration,
    );
    position.current = video.currentTime;
    setPlayhead(video.currentTime);
  }

  const ready = mediaDuration !== null && src !== null && !unavailable;
  const hasExclusions = spans.some((span) => span.kind === "excluded");
  const step = niceStep(duration * 1.5);
  const marks =
    duration > 0
      ? [
          ...Array.from(
            { length: Math.ceil(duration / step) },
            (_, index) => index * step,
          ),
          duration,
        ]
      : [];
  const format = duration < 5 ? fmtPrecise : fmtClock;
  return (
    <Card
      aria-labelledby="original-video-heading"
      className="min-w-0 p-3 sm:p-4"
    >
      <header className="mb-2 flex items-center justify-between gap-2">
        <h2 id="original-video-heading" className="text-lg font-bold">
          {heading}
        </h2>
        {previewDuration > 0 && (
          <span className="text-muted tabular-nums">
            {format(previewDuration)}
          </span>
        )}
      </header>
      {src && !unavailable ? (
        <video
          key={generation}
          ref={ref}
          src={src}
          controls
          playsInline
          preload="metadata"
          aria-label={heading}
          className="block aspect-[1.16] w-full rounded-lg bg-[#111917] sm:aspect-auto sm:h-[clamp(16rem,28vw,22rem)]"
          onLoadedMetadata={({ currentTarget: video }) => {
            if (!Number.isFinite(video.duration) || video.duration <= 0) return;
            setMediaDuration(video.duration);
            video.currentTime = Math.min(
              Math.max(position.current, lower),
              upper,
              video.duration,
            );
            setPlayhead(video.currentTime);
            if (wasPlaying.current) void video.play().catch(() => {});
          }}
          onPlay={({ currentTarget: video }) => {
            if (range && video.currentTime >= upper) video.currentTime = lower;
            wasPlaying.current = true;
          }}
          onPause={() => {
            wasPlaying.current = false;
          }}
          onCanPlay={() => {
            failedLoads.current = 0;
          }}
          onSeeking={({ currentTarget: video }) => {
            if (range && Number.isFinite(video.duration)) {
              const time = Math.min(
                Math.max(video.currentTime, lower),
                upper,
                video.duration,
              );
              if (video.currentTime !== time) video.currentTime = time;
            }
            position.current = video.currentTime;
          }}
          onTimeUpdate={({ currentTarget: video }) => {
            if (range && video.currentTime >= upper) {
              video.pause();
              if (video.currentTime > upper) video.currentTime = upper;
            }
            position.current = video.currentTime;
            setPlayhead(video.currentTime);
          }}
          onError={() => {
            if (failedLoads.current >= MAX_RENEWALS) {
              setUnavailable(true);
              return;
            }
            failedLoads.current += 1;
            setSrc(null);
            setMediaDuration(null);
            setGeneration((value) => value + 1);
          }}
        />
      ) : (
        <div
          className="grid min-h-32 place-items-center rounded-lg bg-field px-3 text-center text-muted"
          role="status"
        >
          {!readPath || unavailable
            ? "Original video unavailable."
            : "Loading original video…"}
        </div>
      )}
      {spans.length > 0 && !range && (
        <div
          className="mt-3"
          role="group"
          aria-labelledby="clip-timeline-heading"
        >
          <div className="mb-1 flex flex-wrap justify-between gap-x-2">
            <h3 className="font-semibold" id="clip-timeline-heading">
              Clip timeline
            </h3>
          </div>
          {spans.length ? (
            <>
              <div className="relative flex">
                {spans.map((span) => {
                  const end = span.end ?? duration;
                  const excluded = span.kind === "excluded";
                  return (
                    <button
                      key={span.start}
                      type="button"
                      title={span.label}
                      aria-label={`${span.label}. Seek to ${format(span.start)}`}
                      disabled={!ready}
                      onClick={() => seek(span.start)}
                      style={{
                        flexGrow:
                          duration > 0
                            ? Math.max(0, end - span.start) / duration
                            : 1,
                      }}
                      className={`min-h-9 min-w-0 basis-0 truncate rounded border px-1.5 text-left text-xs font-semibold ${excluded ? "border-[#9aa49b] bg-[repeating-linear-gradient(135deg,#eef1ee_0_6px,#dce3dc_6px_12px)] text-ink" : "border-[#7a97c7] bg-brand-soft text-brand-ink"}`}
                    >
                      {span.label}
                    </button>
                  );
                })}
                {ready && (
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-0 w-0.5 bg-brand-ink"
                    style={{
                      left: `${Math.min(100, (playhead / duration) * 100)}%`,
                    }}
                  />
                )}
              </div>
              {marks.length > 0 && (
                <div
                  aria-hidden="true"
                  className="mt-1 flex justify-between text-xs text-muted tabular-nums"
                >
                  {marks.map((mark) => (
                    <span key={mark}>{format(mark)}</span>
                  ))}
                </div>
              )}
              {hasExclusions && (
                <ul className="mt-2 list-disc pl-5 text-sm text-muted">
                  {spans
                    .filter((span) => span.kind === "excluded")
                    .map((span) => (
                      <li key={span.start}>
                        {format(span.start)} {span.label}
                      </li>
                    ))}
                </ul>
              )}
            </>
          ) : (
            <p className="text-sm text-muted">Waiting for the clip plan.</p>
          )}
          {duration > 0 && (
            <div className="mt-1 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3">
              <input
                aria-label="Seek original video"
                aria-valuetext={`${format(playhead)} of ${format(duration)}`}
                type="range"
                min={0}
                max={duration}
                step="any"
                value={playhead}
                disabled={!ready}
                onChange={(event) => seek(event.currentTarget.valueAsNumber)}
                className="min-h-8 w-full accent-brand"
              />
              <span
                aria-hidden="true"
                className="text-xs text-muted tabular-nums"
              >
                {format(playhead)} / {format(duration)}
              </span>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
