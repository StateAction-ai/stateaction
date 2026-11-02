"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createClipViewer,
  type ClipUrlResolver,
  type ClipViewerController,
  type ClipViewerState,
} from "../../lib/rerun/clip-viewer";
import { cn } from "../../lib/utils";

export interface ClipViewerProps {
  /** Asks the server for a fresh authorized URL; called again after expiry or Retry. */
  resolveUrl: ClipUrlResolver;
  /** Storage origins the server may point the viewer at. */
  allowedOrigins: readonly string[];
  maxBytes?: number;
  className?: string;
  onStateChange?: (state: ClipViewerState) => void;
  /** Exposes the live controller (null after teardown), e.g. for diagnostics. */
  onController?: (controller: ClipViewerController | null) => void;
}

const MESSAGES: Record<string, string> = {
  expired: "This clip link expired and could not be renewed.",
  too_large: "This clip is larger than the viewer allows.",
  not_rrd: "The file is not a valid clip recording.",
  bad_content_type: "The storage service returned an unexpected file type.",
  origin_not_allowed: "The clip came from an unexpected location.",
  unavailable: "The clip could not be loaded.",
  viewer: "The viewer could not display this clip.",
};

export function ClipViewer({
  resolveUrl,
  allowedOrigins,
  maxBytes,
  className,
  onStateChange,
  onController,
}: ClipViewerProps) {
  const host = useRef<HTMLDivElement>(null);
  const controller = useRef<ClipViewerController | null>(null);
  const resolver = useRef(resolveUrl);
  const notify = useRef(onStateChange);
  const expose = useRef(onController);
  const [state, setState] = useState<ClipViewerState>({ phase: "idle" });
  resolver.current = resolveUrl;
  notify.current = onStateChange;
  expose.current = onController;
  const origins = allowedOrigins.join(",");

  // One viewer per mount; stop() on unmount (route change, React Strict Mode).
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const next = createClipViewer(element, {
      allowedOrigins: origins ? origins.split(",") : [],
      ...(maxBytes !== undefined ? { maxBytes } : {}),
      onState: (s) => {
        setState(s);
        notify.current?.(s);
      },
    });
    controller.current = next;
    expose.current?.(next);
    void next.load((signal) => resolver.current(signal));
    return () => {
      next.stop();
      controller.current = null;
      expose.current?.(null);
    };
  }, [origins, maxBytes]);

  const retry = useCallback(() => {
    void controller.current?.load((signal) => resolver.current(signal));
  }, []);

  return (
    <div className={cn("relative", className)}>
      <div
        ref={host}
        data-testid="clip-viewer-host"
        className="h-[min(70vh,640px)] min-h-72 w-full overflow-hidden rounded-xl border border-line bg-field"
      />
      {state.phase === "loading" || state.phase === "idle" ? (
        <p
          role="status"
          className="absolute inset-0 m-0 grid place-items-center text-muted"
        >
          {state.phase === "loading" && state.attempt > 1
            ? "Renewing clip link…"
            : "Loading clip…"}
        </p>
      ) : null}
      {state.phase === "error" ? (
        <div
          role="alert"
          className="absolute inset-0 grid place-content-center justify-items-center gap-3 rounded-xl bg-paper/90 p-6 text-center"
        >
          <p className="m-0 text-danger">
            {MESSAGES[state.code] ?? MESSAGES.unavailable}
          </p>
          <button
            type="button"
            onClick={retry}
            className="rounded-lg border border-line bg-paper px-3 py-1.5 font-medium hover:bg-brand-soft"
          >
            Try again
          </button>
        </div>
      ) : null}
      <p className="mt-2 text-xs text-muted">
        3D hand shapes are model estimates relative to the hand, not measured
        positions.
      </p>
    </div>
  );
}
