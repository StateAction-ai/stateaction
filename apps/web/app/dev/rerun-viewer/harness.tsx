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

export function ViewerHarness({
  origin,
  clipIds,
  datasetId,
}: {
  origin: string;
  clipIds: string[];
  datasetId?: string;
}) {
  const [clip, setClip] = useState(0);
  const [mounted, setMounted] = useState(true);
  const [state, setState] = useState<ClipViewerState>({ phase: "idle" });
  return (
    <main className="mx-auto max-w-4xl p-6">
      <div className="mb-3 flex gap-2">
        {clipIds.map((id, index) => (
          <button key={id} type="button" onClick={() => setClip(index)}>
            clip {index + 1}
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
          clipId={clipIds[clip]!}
          {...(datasetId ? { datasetId } : {})}
          allowedOrigins={[origin]}
          onStateChange={setState}
          onController={(c) =>
            ((window as unknown as { __clipViewer?: unknown }).__clipViewer = c)
          }
        />
      ) : null}
    </main>
  );
}
