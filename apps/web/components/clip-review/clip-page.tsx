"use client";

import { formatMediaDuration } from "../../lib/media-duration";
import * as React from "react";
import Link from "next/link";
import type { ClipReviewState, DatasetClipView } from "@stateaction/contracts";
import type { ConsoleRole } from "../../lib/console-session";
import type { ClipViewerState } from "../../lib/rerun/clip-viewer";
import { registerPrivateState } from "../../lib/private-state";
import { browserApi, BrowserApiError } from "../data-browser/client";
import { ClipViewer } from "../rerun/clip-viewer";
import { Button } from "../ui/button";
import { ReviewEditor } from "./review-editor";
import { Spinner } from "../ui/spinner";
import { shortRecordingId } from "@stateaction/server/pipeline-model";

const messageOf = (error: unknown) =>
  error instanceof BrowserApiError
    ? error.message
    : "The request could not be completed. Try again.";

type Context = { clip: DatasetClipView; review?: ClipReviewState };
export function ClipPage({
  clipId,
  userId,
  role,
  returnTo,
  mediaOrigin,
}: {
  clipId: string;
  userId: string;
  role: ConsoleRole;
  returnTo: string;
  mediaOrigin: string | null;
}) {
  const [context, setContext] = React.useState<Context>();
  const [error, setError] = React.useState<string>();
  const [hidden, setHidden] = React.useState(false);
  const [reload, setReload] = React.useState(0);
  const [viewer, setViewer] = React.useState<ClipViewerState>({
    phase: "idle",
  });
  const current = React.useRef(true);
  React.useEffect(() => {
    current.current = true;
    const unregister = registerPrivateState(() => {
      current.current = false;
      setHidden(true);
      setContext(undefined);
    });
    return () => {
      current.current = false;
      unregister();
    };
  }, []);
  React.useEffect(() => {
    const cancel = new AbortController();
    void (async () => {
      const [clip, review] = await Promise.all([
        browserApi<DatasetClipView>(`/api/v1/clips/${clipId}`, {
          signal: cancel.signal,
        }),
        role === "staff"
          ? browserApi<ClipReviewState>(`/api/v1/clips/${clipId}/review`, {
              signal: cancel.signal,
            })
          : undefined,
      ]);
      if (!cancel.signal.aborted && current.current) {
        setContext({ clip, ...(review ? { review } : {}) });
        setError(undefined);
      }
    })().catch((failure: unknown) => {
      if (!cancel.signal.aborted && current.current) {
        setContext(undefined);
        setError(messageOf(failure));
      }
    });
    return () => cancel.abort();
  }, [clipId, role, reload]);

  const refreshReview =
    React.useCallback(async (): Promise<ClipReviewState> => {
      const [clip, review] = await Promise.all([
        browserApi<DatasetClipView>(`/api/v1/clips/${clipId}`),
        browserApi<ClipReviewState>(`/api/v1/clips/${clipId}/review`),
      ]);
      if (!current.current) throw new Error("Session ended");
      setContext({ clip, review });
      return review;
    }, [clipId]);
  if (hidden) return null;
  return (
    <section aria-labelledby="clip-heading">
      <Link
        href={returnTo}
        className="mb-4 inline-flex min-h-11 items-center text-sm font-medium text-brand underline"
      >
        Back to Data browser
      </Link>
      {error ? (
        <div
          role="alert"
          className="rounded-xl border border-line bg-white p-6"
        >
          <h1 id="clip-heading" className="text-2xl font-semibold">
            Clip unavailable
          </h1>
          <p>{error}</p>
          <Button
            variant="outline"
            onClick={() => {
              setError(undefined);
              setReload((n) => n + 1);
            }}
          >
            Try again
          </Button>
        </div>
      ) : !context ? (
        <p role="status" className="flex items-center gap-2">
          <Spinner /> Loading clip…
        </p>
      ) : (
        <>
          <div className="mb-5">
            <h1
              id="clip-heading"
              className="m-0 break-words text-[32px] font-bold tracking-[-0.03em]"
            >
              {context.clip.title}
            </h1>
            {role === "staff" && context.clip.recordingId ? (
              <Link
                href={"/pipeline/" + context.clip.recordingId}
                className="mt-2 inline-block text-sm font-medium text-brand underline"
              >
                Recording {shortRecordingId(context.clip.recordingId)}
              </Link>
            ) : null}
            <p className="mt-2 text-sm text-muted">
              {formatMediaDuration(context.clip.durationNs)}{" "}
              <span className="mx-2" aria-hidden="true">
                /
              </span>
              {context.clip.raster.width} × {context.clip.raster.height}{" "}
              <span className="mx-2" aria-hidden="true">
                /
              </span>
              {context.clip.frameCount.toLocaleString()} frames
            </p>
            {context.clip.simulation ? (
              <p className="text-xs text-muted">Simulation recording</p>
            ) : null}
          </div>
          <div
            className={
              role === "staff"
                ? "grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_21rem]"
                : ""
            }
          >
            <div className="min-w-0">
              {context.clip.media.viewer ? (
                <ClipViewer
                  key={clipId}
                  clipId={clipId}
                  allowedOrigins={mediaOrigin ? [mediaOrigin] : []}
                  onStateChange={setViewer}
                />
              ) : (
                <div
                  role="status"
                  className="rounded-xl border border-line bg-white p-8 text-muted"
                >
                  The preview is unavailable for this clip.
                </div>
              )}
              {role === "staff" && context.review ? (
                <QualityChecks state={context.review} />
              ) : (
                <div className="mt-5 rounded-xl border border-line bg-white p-5">
                  <p className="m-0 text-xs font-medium text-good">Approved</p>
                  <h2 className="mb-0 mt-2 text-lg font-semibold">
                    {context.clip.taskLabel ?? "Approved clip"}
                  </h2>
                </div>
              )}
            </div>
            {role === "staff" && context.review ? (
              <ReviewEditor
                key={`${clipId}:${context.review.resultManifestSha256}`}
                userId={userId}
                reviewPath={`/api/v1/clips/${clipId}/review`}
                state={context.review}
                mediaReady={viewer.phase === "ready"}
                refresh={refreshReview}
              />
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}

const CHECK_NAMES: Record<string, string> = {
  source_accepted: "Source integrity",
  source_sha256: "Source integrity",
  decode_and_inference_once: "Video decoding and hand processing",
  frame_map_complete: "Frame mapping",
  arrays_valid: "Hand arrays",
  output_bounds: "Preview files",
  hand_detection_summary: "Hand detections",
  capture_counts: "Capture frame counts",
  native_mp4_remux: "Original video preservation",
  clip_bounds: "Clip duration and frame limits",
  proxy_rrd_bounds: "Rerun preview limits",
};
const STATUS: Record<string, string> = {
  pass: "Passed",
  warn: "Warning",
  fail: "Failed",
  measured: "Measured",
  not_evaluated: "Not evaluated",
  unknown: "Unknown",
};
const MEASUREMENTS: Record<string, [string, string][]> = {
  source_accepted: [["frames_decoded", "Decoded frames"]],
  decode_and_inference_once: [
    ["frames_inferred", "Processed frames"],
    ["decoder_instances", "Video decoders"],
  ],
  native_mp4_remux: [
    ["clips", "Clips"],
    ["reencoded_clips", "Original clips re-encoded"],
  ],
  clip_bounds: [
    ["ceiling_seconds", "Maximum seconds per clip"],
    ["max_frames", "Maximum frames per clip"],
  ],
  proxy_rrd_bounds: [
    ["proxy_max_width", "Maximum preview width"],
    ["proxy_max_height", "Maximum preview height"],
  ],
  hand_detection_summary: [
    ["frames", "Total frames"],
    ["frames_no_hand", "Frames without hands"],
    ["frames_one_hand", "Frames with one hand"],
    ["frames_two_hands", "Frames with two hands"],
  ],
};
function checkMeasurements(id: string, measurements: unknown): string[] {
  if (
    !measurements ||
    typeof measurements !== "object" ||
    Array.isArray(measurements)
  )
    return [];
  const values = measurements as Record<string, unknown>;
  return (MEASUREMENTS[id] ?? []).flatMap(([key, label]) => {
    const value = values[key];
    return typeof value === "string" && /^(0|[1-9][0-9]{0,18})$/.test(value)
      ? [`${label}: ${BigInt(value).toLocaleString()}`]
      : [];
  });
}
function QualityChecks({ state }: { state: ClipReviewState }) {
  const checks = state.qualityChecks;
  return (
    <section
      aria-labelledby="quality-heading"
      className="mt-6 rounded-xl border border-line bg-white p-5"
    >
      <h2 id="quality-heading" className="m-0 text-lg font-semibold">
        Automatic quality checks
      </h2>
      {checks.status === "not_evaluated" ? (
        <p className="text-sm text-muted">
          These checks have not been evaluated for this result.
        </p>
      ) : (
        <ul className="m-0 mt-3 list-none divide-y divide-line p-0">
          {checks.checks.map((check, i) => (
            <li key={`${check.id}:${i}`} className="py-3 text-sm">
              <div className="flex items-start justify-between gap-4">
                <span>
                  {CHECK_NAMES[check.id] ?? "Additional processing check"}
                </span>
                <span
                  className={`shrink-0 font-medium ${check.status === "fail" ? "text-danger" : check.status === "pass" ? "text-good" : "text-muted"}`}
                >
                  {STATUS[check.status] ?? "Unknown"}
                </span>
              </div>
              {checkMeasurements(check.id, check.measurements).map((detail) => (
                <p key={detail} className="mb-0 mt-1 text-xs text-muted">
                  {detail}
                </p>
              ))}
            </li>
          ))}
        </ul>
      )}
      <p className="mb-0 text-xs text-muted">
        Hand detection coverage measures how often hands were found. Pose
        accuracy has not been evaluated.
      </p>
    </section>
  );
}
