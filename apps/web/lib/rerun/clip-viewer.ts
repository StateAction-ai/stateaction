// Framework-independent start/stop adapter around the pinned self-hosted
// @rerun-io/web-viewer. It owns exactly one viewer, loads clips one at a time
// from server-issued URLs, recovers from an expired URL by asking the resolver
// for a fresh one, and releases every resource on stop(). It is client-only:
// the viewer package is imported lazily so the module is safe to import in SSR.

import type { WebViewer } from "@rerun-io/web-viewer";
import { ClipSourceError, fetchBoundedRrd } from "./bounded-rrd.ts";

export const RERUN_VIEWER_VERSION = "0.41.0";
/** Same-origin directory holding the self-hosted viewer WASM (see scripts/platform/rerun-assets.mjs). */
export const RERUN_ASSET_BASE = `/rerun/${RERUN_VIEWER_VERSION}/`;

export type ClipViewerState =
  | { phase: "idle" }
  | { phase: "loading"; attempt: number }
  | { phase: "ready"; storeId: string; bytes: number }
  | {
      phase: "error";
      code: ClipSourceError["code"] | "viewer";
      message: string;
    }
  | { phase: "stopped" };

export interface ClipViewerOptions {
  allowedOrigins: readonly string[];
  maxBytes?: number | undefined;
  assetBase?: string;
  /** Viewer-side memory cap, e.g. "512MB". */
  memoryLimit?: string;
  loadTimeoutMs?: number;
  onState?: (state: ClipViewerState) => void;
  /** Test seam: replaces the lazy import of the viewer package. */
  loadViewerModule?: () => Promise<{ WebViewer: new () => WebViewer }>;
}

/** Returns a fresh, server-authorized URL for the clip. Called again after expiry. */
export type ClipUrlResolver = (signal: AbortSignal) => Promise<string>;

export interface ClipViewerController {
  readonly viewer: WebViewer | null;
  load(resolve: ClipUrlResolver): Promise<ClipViewerState>;
  stop(): void;
}

export function createClipViewer(
  parent: HTMLElement,
  options: ClipViewerOptions,
): ClipViewerController {
  let viewer: WebViewer | null = null;
  let stopped = false;
  let generation = 0;
  let controller: AbortController | null = null;
  let adoptedUrl: string | null = null;
  let current: ClipViewerState = { phase: "idle" };
  // Every mutation of the viewer (start, close/open, stop) runs here, one at
  // a time, so a superseding load or stop() can never touch a half-started
  // viewer. Fetching stays outside the queue and is cancelled by abort.
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };
  const emit = (state: ClipViewerState) => {
    current = state;
    options.onState?.(state);
    return state;
  };
  const release = (url: string | null) => {
    if (url) URL.revokeObjectURL(url);
  };
  const superseded = (mine: number) => stopped || mine !== generation;

  async function waitLoaded(v: WebViewer, mine: number): Promise<string> {
    const deadline = Date.now() + (options.loadTimeoutMs ?? 60_000);
    for (;;) {
      if (superseded(mine)) throw new ClipSourceError("aborted", "Superseded.");
      const state = await v.get_state();
      const recording = state.recordings[0];
      if (recording && state.loading.length === 0)
        return String(recording.store_id);
      if (Date.now() > deadline)
        throw new ClipSourceError(
          "unavailable",
          "Viewer did not finish loading the clip.",
        );
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async function show(blob: Blob, mine: number): Promise<ClipViewerState> {
    if (superseded(mine)) return current;
    const candidate = URL.createObjectURL(blob);
    let adopted = false;
    try {
      if (!viewer) {
        const mod = await (
          options.loadViewerModule ?? (() => import("@rerun-io/web-viewer"))
        )();
        if (superseded(mine)) return current;
        const fresh = new mod.WebViewer();
        try {
          await fresh.start(candidate, parent, {
            width: "100%",
            height: "100%",
            render_backend: "webgl",
            hide_welcome_screen: true,
            check_for_updates_on_startup: false,
            memory_limit: options.memoryLimit ?? "512MB",
            base_url: new URL(
              options.assetBase ?? RERUN_ASSET_BASE,
              location.href,
            ).href,
          } as Parameters<WebViewer["start"]>[2]);
        } catch (error) {
          try {
            fresh.stop();
          } catch {
            // Never fully started.
          }
          throw error;
        }
        viewer = fresh;
      } else {
        await viewer.close("all");
        await viewer.open(candidate);
      }
      const storeId = await waitLoaded(viewer, mine);
      if (superseded(mine)) return current;
      release(adoptedUrl);
      adoptedUrl = candidate;
      adopted = true;
      return emit({ phase: "ready", storeId, bytes: blob.size });
    } finally {
      if (!adopted) release(candidate);
    }
  }

  async function load(resolve: ClipUrlResolver): Promise<ClipViewerState> {
    if (stopped) return current;
    const mine = ++generation;
    controller?.abort();
    const abort = (controller = new AbortController());
    try {
      let blob: Blob | null = null;
      // At most one retry, and only for an expired URL: a fresh issuance
      // rechecks access on the server, so a revoked grant fails here too.
      for (let attempt = 1; attempt <= 2 && !blob; attempt += 1) {
        emit({ phase: "loading", attempt });
        const url = await resolve(abort.signal);
        if (superseded(mine)) return current;
        try {
          blob = await fetchBoundedRrd(url, {
            allowedOrigins: options.allowedOrigins,
            ...(options.maxBytes !== undefined
              ? { maxBytes: options.maxBytes }
              : {}),
            signal: abort.signal,
          });
        } catch (error) {
          const expired =
            error instanceof ClipSourceError && error.code === "expired";
          if (!expired || attempt === 2) throw error;
        }
      }
      if (!blob || superseded(mine)) return current;
      const done = blob;
      return await serialize(() => show(done, mine));
    } catch (error) {
      if (superseded(mine)) return current;
      if (error instanceof ClipSourceError && error.code === "aborted")
        return current;
      return emit(
        error instanceof ClipSourceError
          ? { phase: "error", code: error.code, message: error.message }
          : {
              phase: "error",
              code: "viewer",
              message:
                error instanceof Error ? error.message : "Viewer failed.",
            },
      );
    }
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    generation += 1;
    controller?.abort();
    emit({ phase: "stopped" });
    // Runs after any in-flight start/open settles, so nothing outlives it.
    void serialize(async () => {
      try {
        viewer?.stop();
      } catch {
        // Already torn down.
      }
      viewer = null;
      release(adoptedUrl);
      adoptedUrl = null;
    });
  }

  return {
    get viewer() {
      return viewer;
    },
    load,
    stop,
  };
}
