"use client";

import { useState } from "react";
import { ClipViewer } from "../../../components/rerun/clip-viewer";
import type { ClipViewerState } from "../../../lib/rerun/clip-viewer";

// Observes (never replaces) the WebCodecs decoder the viewer uses, so a test can
// prove real H.264 frames were decoded.
type Telemetry = { decoded: number[]; configs: unknown[]; errors: string[] };
function observeDecoder() {
  const w = window as unknown as {
    VideoDecoder?: typeof VideoDecoder;
    __decoder?: Telemetry;
  };
  if (w.__decoder || !w.VideoDecoder) return;
  const t: Telemetry = (w.__decoder = { decoded: [], configs: [], errors: [] });
  const Native = w.VideoDecoder;
  w.VideoDecoder = class extends Native {
    constructor(init: VideoDecoderInit) {
      super({
        output: (frame) => {
          t.decoded.push(frame.timestamp);
          init.output(frame);
        },
        error: (error) => {
          t.errors.push(String(error));
          init.error(error);
        },
      });
    }
    configure(config: VideoDecoderConfig) {
      t.configs.push(config);
      return super.configure(config);
    }
  };
}
if (typeof window !== "undefined") observeDecoder();

// `origin` stands in for the future signed-read broker: GET /issue?clip=<name>
// answers { url } with a fresh storage URL.
export function ViewerHarness({ origin }: { origin: string }) {
  const [clip, setClip] = useState("a");
  const [mounted, setMounted] = useState(true);
  const [state, setState] = useState<ClipViewerState>({ phase: "idle" });
  return (
    <main className="mx-auto max-w-4xl p-6">
      <div className="mb-3 flex gap-2">
        {["a", "b"].map((name) => (
          <button key={name} type="button" onClick={() => setClip(name)}>
            clip {name}
          </button>
        ))}
        <button type="button" onClick={() => setMounted((m) => !m)}>
          {mounted ? "unmount" : "mount"}
        </button>
        <output data-testid="phase">{state.phase}</output>
        <output data-testid="detail">{JSON.stringify(state)}</output>
      </div>
      {mounted ? (
        <ClipViewer
          key={clip}
          allowedOrigins={[origin]}
          onStateChange={setState}
          onController={(c) =>
            ((window as unknown as { __clipViewer?: unknown }).__clipViewer = c)
          }
          resolveUrl={async (signal) => {
            const r = await fetch(`${origin}/issue?clip=${clip}`, {
              signal,
              credentials: "omit",
            });
            if (!r.ok) throw new Error("issue failed");
            return ((await r.json()) as { url: string }).url;
          }}
        />
      ) : null}
    </main>
  );
}
