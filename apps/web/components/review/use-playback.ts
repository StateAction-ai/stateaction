"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { VideoSource } from "../../lib/review/types";
import {
  fetchVideoUrl,
  MAX_RENEWALS,
  resumeAt,
} from "../../lib/review/video-url";

export type VideoStatus = "none" | "loading" | "ready" | "unavailable";

/**
 * One playhead for the whole page. With a broker video the <video> element is
 * the clock; without media (fixtures, no recording_mp4) a virtual clock drives
 * the same playhead so the tiers, rail and hand pose stay reviewable.
 */
export function usePlayback(
  durationS: number,
  source: VideoSource,
  onMediaDuration: (seconds: number) => void = () => {},
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRateState] = useState(1);
  const [src, setSrc] = useState<string | null>(null);
  // Every issued URL mounts a fresh <video>: a renewal can return the same signed
  // string (same second), and an element stuck in its error state must not be kept.
  const [srcKey, setSrcKey] = useState(0);
  const [status, setStatus] = useState<VideoStatus>(
    source.kind === "broker" ? "loading" : "none",
  );
  const tRef = useRef(0);
  const rateRef = useRef(1);
  const renewals = useRef(0);
  const pendingSeek = useRef<number | null>(null);
  const wantPlay = useRef(false);
  const readPath = source.kind === "broker" ? source.readPath : null;

  const commit = useCallback((next: number) => {
    tRef.current = next;
    setT(next);
  }, []);

  // (Re)issue the video URL. Used at mount and after an error or expiry.
  const renew = useCallback(
    async (resume: number) => {
      if (!readPath) return;
      if (renewals.current >= MAX_RENEWALS) {
        setStatus("unavailable");
        return;
      }
      renewals.current += 1;
      setStatus("loading");
      pendingSeek.current = resume;
      try {
        const url = await fetchVideoUrl(readPath);
        setSrc(url);
        setSrcKey((k) => k + 1);
      } catch {
        setStatus("unavailable");
      }
    },
    [readPath],
  );

  useEffect(() => {
    renewals.current = 0;
    setSrc(null);
    if (readPath) void renew(0);
    else setStatus("none");
  }, [readPath, renew]);

  const onVideoError = useCallback(() => {
    const el = videoRef.current;
    wantPlay.current = playing;
    void renew(resumeAt(el?.currentTime ?? 0, tRef.current, durationS));
  }, [renew, playing, durationS]);

  const onLoadedMetadata = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    renewals.current = 0;
    setStatus("ready");
    // The loaded video is the truth for the axis length; the estimate may be short.
    if (Number.isFinite(el.duration) && el.duration > 0)
      onMediaDuration(el.duration);
    el.playbackRate = rateRef.current;
    if (pendingSeek.current !== null) {
      el.currentTime = pendingSeek.current;
      commit(pendingSeek.current);
      pendingSeek.current = null;
    }
    if (wantPlay.current) void el.play().catch(() => setPlaying(false));
  }, [commit, onMediaDuration]);

  const real = source.kind === "broker" && status === "ready";

  // The clock: video.currentTime when real, otherwise a virtual timer.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const el = videoRef.current;
      if (real && el) commit(el.currentTime);
      else {
        const next = Math.min(
          durationS,
          tRef.current + ((now - last) / 1000) * rateRef.current,
        );
        commit(next);
        if (next >= durationS) setPlaying(false);
      }
      last = now;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, real, durationS, commit]);

  const seek = useCallback(
    (to: number) => {
      const clamped = Math.min(Math.max(0, to), durationS);
      const el = videoRef.current;
      if (real && el) el.currentTime = clamped;
      commit(clamped);
    },
    [real, durationS, commit],
  );

  const toggle = useCallback(() => {
    const el = videoRef.current;
    if (playing) {
      el?.pause();
      setPlaying(false);
      return;
    }
    if (tRef.current >= durationS) seek(0);
    wantPlay.current = true;
    if (real && el) void el.play().catch(() => setPlaying(false));
    setPlaying(true);
  }, [playing, real, durationS, seek]);

  const setRate = useCallback((next: number) => {
    rateRef.current = next;
    setRateState(next);
    if (videoRef.current) videoRef.current.playbackRate = next;
  }, []);

  return {
    videoRef,
    t,
    playing,
    rate,
    src,
    srcKey,
    status,
    seek,
    toggle,
    setRate,
    onVideoError,
    onLoadedMetadata,
    onEnded: () => setPlaying(false),
  };
}
