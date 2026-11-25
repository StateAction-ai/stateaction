"use client";

import { useEffect, useRef, useState } from "react";
import { privateSignal } from "../../lib/private-state";

async function posterUrl(clipId: string): Promise<string> {
  const response = await fetch(`/api/v2/review-clips/${clipId}/poster`, {
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.any([privateSignal(), AbortSignal.timeout(15_000)]),
  });
  if (!response.ok) throw new Error("Poster unavailable");
  const { data } = (await response.json()) as { data?: { url?: unknown } };
  if (typeof data?.url !== "string") throw new Error("Poster unavailable");
  return data.url;
}

export function ClipPoster({
  clipId,
  duration,
}: {
  clipId: string;
  duration: string | null;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<string | null>();
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let current = true;
    const observe = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        observe.disconnect();
        void posterUrl(clipId).then(
          (url) => {
            if (current) setPreview(url);
          },
          () => {
            if (current) setPreview(null);
          },
        );
      },
      { rootMargin: "180px" },
    );
    observe.observe(element);
    return () => {
      current = false;
      observe.disconnect();
    };
  }, [clipId]);

  return (
    <div
      ref={container}
      className="relative grid aspect-video w-28 shrink-0 place-items-center overflow-hidden rounded-md bg-field text-center text-[10px] text-muted sm:w-36"
    >
      {preview ? (
        // The authorized poster URL is short-lived and belongs to the current clip.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={preview}
          alt=""
          className="absolute inset-0 h-full w-full bg-[#111917] object-contain"
          onError={() => setPreview(null)}
        />
      ) : preview === null ? (
        "Preview unavailable"
      ) : (
        <span className="sr-only">Loading preview</span>
      )}
      {duration && (
        <span className="absolute right-1 bottom-1 rounded bg-black/75 px-1 text-white tabular-nums">
          {duration}
        </span>
      )}
    </div>
  );
}
