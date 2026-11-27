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
  const directUrl = source.kind === "direct" ? source.url : null;
  const [brokerUrl, setBrokerUrl] = useState<string | null>(null);
  const [srcKey, setSrcKey] = useState(0);
  const [seekCount, setSeekCount] = useState(0);
  const [status, setStatus] = useState<VideoStatus>(
    source.kind === "none" ? "none" : "loading",
  );
  const tRef = useRef(0);
  const rateRef = useRef(1);
  const renewals = useRef(0);
  const request = useRef<AbortController | null>(null);
  const awaitingMedia = useRef(false);
  const expiresAt = useRef(0);
  const wantPlay = useRef(false);
  const readPath = source.kind === "broker" ? source.readPath : null;
  const readMethod =
    source.kind === "broker" ? (source.readMethod ?? "POST") : "POST";
  const hasMedia = source.kind !== "none";
  const range = hasMedia ? source.range : undefined;
  const offset = range?.startS ?? 0;
  const rangeDuration = range?.durationS;
  const lastSourceTime =
    offset +
    (rangeDuration === undefined
      ? Infinity
      : Math.max(0, rangeDuration - 1e-6));

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
        method: readMethod,
      });
      if (controller.signal.aborted) return;
      expiresAt.current = grant.expiresAt;
      setBrokerUrl(grant.url);
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
  }, [readPath, readMethod]);

  useEffect(() => {
    renewals.current = 0;
    if (readPath) void renew();
    else setStatus(directUrl ? "loading" : "none");
    return () => {
      request.current?.abort();
      request.current = null;
    };
  }, [directUrl, readPath, renew]);

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
      onMediaDuration(rangeDuration ?? el.duration);
    el.playbackRate = rateRef.current;
    const next = Math.min(offset + tRef.current, el.duration, lastSourceTime);
    if (el.currentTime !== next) el.currentTime = next;
    else renewals.current = 0;
    if (wantPlay.current) playMedia(el);
  }, [onMediaDuration, playMedia, offset, rangeDuration, lastSourceTime]);

  const onSeeked = useCallback(() => {
    const el = videoRef.current;
    if (el && !awaitingMedia.current) {
      commit(
        Math.min(
          rangeDuration ?? Infinity,
          Math.max(0, el.currentTime - offset),
        ),
      );
      renewals.current = 0;
    }
  }, [commit, offset, rangeDuration]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const el = videoRef.current;
      if (el && !awaitingMedia.current && !el.seeking && !el.paused) {
        const next = Math.max(0, el.currentTime - offset);
        if (rangeDuration !== undefined && next >= rangeDuration) {
          wantPlay.current = false;
          el.pause();
          el.currentTime = lastSourceTime;
          commit(rangeDuration);
          setPlaying(false);
          return;
        }
        commit(next);
      }
      if (!hasMedia) {
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
  }, [
    playing,
    hasMedia,
    durationS,
    commit,
    offset,
    rangeDuration,
    lastSourceTime,
  ]);

  const seek = useCallback(
    (to: number, startPlaying = false) => {
      const el = videoRef.current;
      const end =
        rangeDuration ??
        (el && Number.isFinite(el.duration) ? el.duration : durationS);
      const next = Math.min(Math.max(0, to), end);
      commit(next);
      setSeekCount((count) => count + 1);
      const play = startPlaying && rangeDuration !== 0;
      if (play) {
        wantPlay.current = true;
        setPlaying(true);
      }
      if (!el || awaitingMedia.current) return;
      // Unbuffered seeks can require a new range request even with metadata loaded.
      if (readPath && expiresAt.current <= Date.now()) {
        void renew();
        return;
      }
      el.currentTime = Math.min(offset + next, lastSourceTime);
      if (play) playMedia(el);
    },
    [
      durationS,
      commit,
      renew,
      readPath,
      playMedia,
      offset,
      rangeDuration,
      lastSourceTime,
    ],
  );

  const toggle = useCallback(() => {
    if (rangeDuration === 0) return;
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
      if (readPath && expiresAt.current <= Date.now()) void renew();
      else playMedia(el);
    }
  }, [durationS, readPath, renew, seek, playMedia, rangeDuration]);

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
    src: directUrl ?? (readPath ? brokerUrl : null),
    srcKey,
    seekCount,
    status,
    singleFrame: rangeDuration === 0,
    seek,
    toggle,
    setRate,
    onVideoError: () => {
      if (readPath) {
        void renew();
      } else {
        wantPlay.current = false;
        setPlaying(false);
        setStatus("unavailable");
      }
    },
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
