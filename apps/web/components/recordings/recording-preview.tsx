import {
  formatBytes,
  formatDuration,
  type RecordingMetadata,
} from "@stateaction/server/pipeline";
import type { TimelineSpan } from "../../lib/recording-timeline";
import { fmtPrecise } from "../../lib/review/timeline";
import { Card } from "../ui/card";
import { OriginalVideo } from "./original-video";

export function rangeLabel(start: number | null, end: number | null) {
  if (start === null || end === null) return "Source time unavailable";
  return `${fmtPrecise(start)}–${fmtPrecise(end)}`;
}

export function RecordingPreview({
  recordingId,
  initialTime,
  spans = [],
  range,
  metadata,
  capturedAt,
  clipId,
}: {
  recordingId: string;
  initialTime?: number;
  spans?: TimelineSpan[];
  range?: { start: number; end: number } | undefined;
  metadata: RecordingMetadata;
  capturedAt: string;
  clipId?: string;
}) {
  const {
    canReadOriginal,
    durationSeconds,
    device,
    sourceLabel,
    captureFormat,
    sizeBytes,
    width,
    height,
    frameRate,
  } = metadata;
  const hardware =
    [device.model, device.osVersion && "OS " + device.osVersion]
      .filter(Boolean)
      .join(" · ") || null;
  return (
    <div className="grid min-w-0 gap-4 md:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
      <OriginalVideo
        key={`${recordingId}:${canReadOriginal}:${range?.start}:${range?.end}`}
        readPath={
          canReadOriginal ? `/api/v1/recordings/${recordingId}/reads` : null
        }
        initialTime={initialTime ?? range?.start ?? 0}
        expectedDuration={durationSeconds}
        spans={spans}
        range={range}
      />
      <Card className="min-w-0 p-4 sm:p-5">
        <h2 className="mb-3 text-lg font-bold">Recording details</h2>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          {[
            ["Device", hardware],
            [
              "Capture time (UTC)",
              capturedAt
                ? new Date(capturedAt).toLocaleString("en-CA", {
                    timeZone: "UTC",
                  })
                : null,
            ],
            ["Source", sourceLabel ?? captureFormat],
            ["Size", formatBytes(sizeBytes)],
            [
              "Resolution",
              width !== null && height !== null ? width + " × " + height : null,
            ],
            ["Frame rate", frameRate !== null ? frameRate + " fps" : null],
            [
              "Duration",
              durationSeconds === null ? null : formatDuration(durationSeconds),
            ],
            ...(range
              ? [["Clip source time", rangeLabel(range.start, range.end)]]
              : []),
            ["Recording ID", recordingId],
            ...(clipId ? [["Clip ID", clipId]] : []),
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs text-muted">{label}</dt>
              <dd className="font-medium wrap-break-word">
                {value ?? "Not recorded"}
              </dd>
            </div>
          ))}
        </dl>
      </Card>
    </div>
  );
}
