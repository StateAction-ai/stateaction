"use client";

import * as React from "react";
import type { ClipRead } from "@stateaction/contracts";
import { mediaCredentials } from "../../lib/rerun/bounded-rrd";
import { privateSignal, registerPrivateState } from "../../lib/private-state";
import { browserApi, readBounded } from "./client";

export function ClipThumbnail({
  clipId,
  datasetId,
  available,
  mediaOrigin,
  duration,
  compact,
}: {
  clipId: string;
  datasetId?: string;
  available: boolean;
  mediaOrigin: string | null;
  duration: string | null;
  compact: boolean;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [visible, setVisible] = React.useState(false);
  const [src, setSrc] = React.useState<string>();
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    if (!ref.current || !available || !mediaOrigin) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "160px" },
    );
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [available, mediaOrigin]);
  React.useEffect(() => {
    setSrc(undefined);
    setFailed(false);
    if (!visible || !available || !mediaOrigin) return;
    const cancel = new AbortController();
    let objectUrl: string | undefined;
    const cleanup = () => {
      cancel.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    const unregister = registerPrivateState(cleanup);
    void (async () => {
      const query = datasetId
        ? `?dataset=${encodeURIComponent(datasetId)}`
        : "";
      const grant = await browserApi<ClipRead>(
        `/api/v2/review-clips/${clipId}/poster${query}`,
        {
          signal: cancel.signal,
        },
      );
      const url = new URL(grant.url);
      const size = Number(grant.sizeBytes);
      const expiry = Date.parse(grant.expiresAt);
      if (
        grant.role !== "thumbnail_jpeg" ||
        grant.contentType !== "image/jpeg" ||
        url.origin !== mediaOrigin ||
        url.username ||
        url.password ||
        url.hash ||
        !Number.isSafeInteger(size) ||
        size < 1 ||
        size > 5 * 1024 * 1024 ||
        !Number.isFinite(expiry) ||
        expiry <= Date.now()
      )
        throw new Error("Invalid poster grant");
      const response = await fetch(url, {
        credentials: mediaCredentials(url),
        redirect: "error",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.any([
          cancel.signal,
          privateSignal(),
          AbortSignal.timeout(15_000),
        ]),
      });
      if (!response.ok || response.headers.get("content-type") !== "image/jpeg")
        throw new Error("Poster unavailable");
      const bytes = await readBounded(response, size);
      if (bytes.length !== size) throw new Error("Poster size changed");
      if (cancel.signal.aborted) return;
      objectUrl = URL.createObjectURL(
        new Blob([bytes], { type: "image/jpeg" }),
      );
      setSrc(objectUrl);
    })().catch(() => {
      if (!cancel.signal.aborted) setFailed(true);
    });
    return () => {
      unregister();
      cleanup();
    };
  }, [clipId, datasetId, available, mediaOrigin, visible]);
  const loading = available && mediaOrigin && !failed && !src;
  return (
    <div
      ref={ref}
      className={`relative flex aspect-video items-center justify-center overflow-hidden bg-[#e7ece8] text-center text-xs text-muted ${compact ? "rounded-md" : ""}`}
    >
      {src && !failed ? (
        <img
          src={src}
          alt=""
          className="h-full w-full bg-black object-contain"
          onError={() => setFailed(true)}
        />
      ) : loading ? (
        <span role="status" className="motion-safe:animate-pulse px-1">
          Loading preview…
        </span>
      ) : (
        <span className="px-1">Preview unavailable</span>
      )}
      {duration ? (
        <span className="absolute right-1 bottom-1 rounded bg-black/80 px-1.5 py-0.5 text-[10px] leading-none text-white tabular-nums">
          {duration}
        </span>
      ) : null}
    </div>
  );
}
