import {
  formatDuration,
  type CachedImport,
} from "@stateaction/server/pipeline";

import { StageRerunActions } from "./stage-rerun-actions";

function fact(value: unknown): string {
  if (value === null || value === undefined || value === "")
    return "not recorded";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

export function ImportedStages({
  cached,
  recordingId,
  jobId,
  disabledReason,
}: {
  cached: CachedImport;
  recordingId?: string;
  jobId?: string | null;
  disabledReason?: string | undefined;
}) {
  const { attribution, counts, evidence } = cached;
  const recordedDuration = (stage: Record<string, unknown>) => {
    const { startedAt, finishedAt } = stage;
    return typeof startedAt === "number" &&
      typeof finishedAt === "number" &&
      finishedAt >= startedAt
      ? formatDuration(finishedAt - startedAt)
      : null;
  };
  const stages = [
    [
      "segment",
      "Segmentation",
      `${counts.segments} segments · ${counts.failedWindows} failed windows`,
    ],
    [
      "caption",
      "Captioning",
      `${counts.captions} captions · ${counts.failedCaptions} failed captions`,
    ],
    ["hand_pose", "Hand pose", `${counts.handPoseFrames} frames`],
  ] as const;
  return (
    <>
      <p className="m-0 text-sm">
        {attribution.dataset} by {attribution.creators}. {attribution.license}.{" "}
        {attribution.changes}
      </p>
      <p className="m-0 text-xs wrap-anywhere text-muted">
        Source: {attribution.sourceUrl}
      </p>
      {stages.map(([stage, label, count]) => {
        const producer = evidence[stage] ?? {};
        return (
          <div
            key={stage}
            data-stage={stage}
            className="rounded-md border border-line p-3"
          >
            <details>
              <summary className="cursor-pointer text-sm font-medium">
                <span>
                  {label} · {count}
                </span>{" "}
                <span className="rounded-full bg-brand-soft px-2 py-0.5 text-xs font-semibold text-brand-ink">
                  Imported
                </span>
              </summary>
              <dl className="mt-3 grid grid-cols-1 gap-y-2 sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-x-3 text-sm">
                {[
                  ["Generator", producer.generator],
                  ["Model", producer.model],
                  ["Revision", producer.revision],
                  ["Weights SHA-256", producer.weightsSha256],
                  ["Prompt SHA-256", producer.promptSha256],
                  ["Prompt settings", producer.prompt],
                  ["Recorded wall time", recordedDuration(producer)],
                  ["Decoding", producer.decoding],
                  ["GPU requested", producer.requestedGpu],
                  ["GPU observed", producer.gpuReport ?? producer.observedGpu],
                  ["Cost", null],
                  ...Object.entries(cached.originals)
                    .filter(([slot]) =>
                      slot.startsWith(`diagnostics/${stage}/`),
                    )
                    .map(([slot, sha]) => [slot.split("/").at(-1), sha]),
                ].map(([key, value]) => (
                  <div key={String(key)} className="contents">
                    <dt className="text-muted">{String(key)}</dt>
                    <dd className="m-0 whitespace-pre-wrap break-all">
                      {fact(value)}
                    </dd>
                  </div>
                ))}
              </dl>
            </details>
            {jobId && recordingId ? (
              <StageRerunActions
                recordingId={recordingId}
                jobId={jobId}
                stage={stage}
                module=""
                disabledReason={disabledReason}
              />
            ) : null}
          </div>
        );
      })}
    </>
  );
}
