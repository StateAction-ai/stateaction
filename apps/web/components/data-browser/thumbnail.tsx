"use client";

import * as React from "react";
import type { ClipRead } from "@stateaction/contracts";
import { Spinner } from "../ui/spinner";
import { browserApi, readBounded } from "./client";
import { privateSignal, registerPrivateState } from "../../lib/private-state";

/** A storage request never carries the browser's Better Auth cookie, including on local host aliases. */
export function ClipThumbnail({
  clipId,
  datasetId,
  available,
  mediaOrigin,
}: {
  clipId: string;
  datasetId?: string;
  available: boolean;
  mediaOrigin: string | null;
}) {
  const [src, setSrc] = React.useState<string>();
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    setSrc(undefined);
    setFailed(false);
    if (!available || !mediaOrigin) return;
    const cancel = new AbortController();
    let objectUrl: string | undefined;
    let alive = true;
    const cleanup = () => {
      alive = false;
      cancel.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    const unregister = registerPrivateState(cleanup);
    void (async () => {
      const path = datasetId
        ? `/api/v1/datasets/${datasetId}/clips/${clipId}/reads`
        : `/api/v1/clips/${clipId}/reads`;
      const grant = await browserApi<ClipRead>(path, {
        method: "POST",
        body: { role: "thumbnail_jpeg" },
        signal: cancel.signal,
      });
      const url = new URL(grant.url);
      const size = Number(grant.sizeBytes);
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
        !Number.isFinite(Date.parse(grant.expiresAt)) ||
        Date.parse(grant.expiresAt) <= Date.now()
      )
        throw new Error("Invalid thumbnail grant");
      const response = await fetch(url, {
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: AbortSignal.any([
          cancel.signal,
          privateSignal(),
          AbortSignal.timeout(15_000),
        ]),
      });
      if (!response.ok) throw new Error("Thumbnail unavailable");
      const bytes = await readBounded(response, size);
      if (bytes.length !== size) throw new Error("Thumbnail size changed");
      objectUrl = URL.createObjectURL(
        new Blob([bytes], { type: "image/jpeg" }),
      );
      if (alive) setSrc(objectUrl);
    })().catch(() => {
      if (alive) setFailed(true);
    });
    return () => {
      unregister();
      cleanup();
    };
  }, [clipId, datasetId, available, mediaOrigin]);
  return (
    <div className="flex aspect-video items-center justify-center overflow-hidden rounded-t-xl bg-[#e7ece8] text-xs text-muted">
      {src && !failed ? (
        <img
          src={src}
          alt=""
          className="h-full w-full object-contain"
          onError={() => setFailed(true)}
        />
      ) : available && mediaOrigin && !failed ? (
        <span className="flex items-center gap-2">
          <Spinner /> Loading preview…
        </span>
      ) : (
        <span>
          {failed ? "Preview could not load" : "No preview available"}
        </span>
      )}
    </div>
  );
}
