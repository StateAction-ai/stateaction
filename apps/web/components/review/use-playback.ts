"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { VideoSource } from "../../lib/review/types";
import { fetchVideoUrl, MAX_RENEWALS } from "../../lib/review/video-url";

export type VideoStatus = "none" | "loading" | "ready" | "unavailable";

/** The media element drives the playhead. Pages without video use a virtual clock. */
export function usePlayback(
  durationS: number,
  source: VideoSource,
  onMediaDuration: (seconds: number) => void,
) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [rate, setRateState] = useState(1);
  const [src, setSrc] = useState<string | null>(null);
  const [srcKey, setSrcKey] = useState(0);
  const [seekCount, setSeekCount] = useState(0);
  const [status, setStatus] = useState<VideoStatus>(
    source.kind === "broker" ? "loading" : "none",
  );
  const tRef = useRef(0);
  const rateRef = useRef(1);
  const renewals = useRef(0);
  const request = useRef<AbortController | null>(null);
  const awaitingMedia = useRef(false);
  const expiresAt = useRef(0);
  const wantPlay = useRef(false);
  const readPath = source.kind === "broker" ? source.readPath : null;

  const commit = useCallback((next: number) => {
    tRef.current = next;
    setT(next);
  }, []);

  const renew = useCallback(async () => {
    if (!readPath || request.current) return;
    if (renewals.current >= MAX_RENEWALS) {
      awaitingMedia.current = false;
      wantPlay.current = false;
      setPlaying(false);
      setStatus("unavailable");
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    renewals.current += 1;
    awaitingMedia.current = true;
    videoRef.current?.pause();
    setStatus("loading");
    try {
      const grant = await fetchVideoUrl(readPath, {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      expiresAt.current = grant.expiresAt;
      setSrc(grant.url);
      // A new grant may return the same URL within the same second.
      setSrcKey((key) => key + 1);
    } catch {
      if (controller.signal.aborted) return;
      awaitingMedia.current = false;
      wantPlay.current = false;
      setPlaying(false);
      setStatus("unavailable");
    } finally {
      if (request.current === controller) request.current = null;
    }
  }, [readPath]);

  useEffect(() => {
    renewals.current = 0;
    if (readPath) void renew();
    else setStatus("none");
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [readPath, renew]);

  const playMedia = useCallback((el: HTMLVideoElement) => {
    void el.play().catch((error: DOMException) => {
      if (
        videoRef.current !== el ||
        awaitingMedia.current ||
        el.error ||
        error.name === "AbortError" ||
        !el.paused
      )
        return;
      wantPlay.current = false;
      setPlaying(false);
    });
  }, []);

  const onLoadedMetadata = useCallback(() => {
    const el = videoRef.current;
    if (!el) return;
    awaitingMedia.current = false;
    setStatus("ready");
    if (Number.isFinite(el.duration) && el.duration > 0)
      onMediaDuration(el.duration);
    el.playbackRate = rateRef.current;
    const next = Math.min(tRef.current, el.duration);
    if (el.currentTime !== next) el.currentTime = next;
    else renewals.current = 0;
    if (wantPlay.current) playMedia(el);
  }, [onMediaDuration, playMedia]);

  const onSeeked = useCallback(() => {
    const el = videoRef.current;
    if (el && !awaitingMedia.current) {
      commit(el.currentTime);
      renewals.current = 0;
    }
  }, [commit]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const el = videoRef.current;
      if (el && !awaitingMedia.current && !el.seeking && !el.paused)
        commit(el.currentTime);
      if (!readPath) {
        const next = Math.min(
          durationS,
          tRef.current + ((now - last) / 1000) * rateRef.current,
        );
        commit(next);
        if (next >= durationS) {
          wantPlay.current = false;
          setPlaying(false);
          return;
        }
      }
      last = now;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing, readPath, durationS, commit]);

  const seek = useCallback(
    (to: number, startPlaying = false) => {
      const el = videoRef.current;
      const end = el && Number.isFinite(el.duration) ? el.duration : durationS;
      const next = Math.min(Math.max(0, to), end);
      commit(next);
      setSeekCount((count) => count + 1);
      if (startPlaying) {
        wantPlay.current = true;
        setPlaying(true);
      }
      if (!el || awaitingMedia.current) return;
      // Unbuffered seeks can require a new range request even with metadata loaded.
      if (expiresAt.current <= Date.now()) {
        void renew();
        return;
      }
      el.currentTime = next;
      if (startPlaying) playMedia(el);
    },
    [durationS, commit, renew, playMedia],
  );

  const toggle = useCallback(() => {
    const el = videoRef.current;
    if (wantPlay.current) {
      wantPlay.current = false;
      el?.pause();
      setPlaying(false);
      return;
    }
    if (el?.ended || tRef.current >= durationS) {
      seek(0, true);
      return;
    }
    wantPlay.current = true;
    setPlaying(true);
    if (el && !awaitingMedia.current) {
      if (expiresAt.current <= Date.now()) void renew();
      else playMedia(el);
    }
  }, [durationS, renew, seek, playMedia]);

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
    seekCount,
    status,
    seek,
    toggle,
    setRate,
    onVideoError: renew,
    onLoadedMetadata,
    onSeeked,
    onPlaying: () => {
      renewals.current = 0;
    },
    onEnded: () => {
      onSeeked();
      wantPlay.current = false;
      setPlaying(false);
    },
  };
}
