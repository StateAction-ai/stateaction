import {
  formatDuration,
  type CachedImport,
} from "@stateaction/server/pipeline";

function fact(value: unknown): string {
  if (value === null || value === undefined || value === "")
    return "not recorded";
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

export function ImportedStages({ cached }: { cached: CachedImport }) {
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
          <details key={stage} className="rounded-md border p-3">
            <summary className="cursor-pointer text-sm font-medium">
              {label} · {count}
            </summary>
            <dl className="mt-3 grid grid-cols-1 gap-y-2 text-sm sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-x-3">
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
                  .filter(([slot]) => slot.startsWith(`diagnostics/${stage}/`))
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
        );
      })}
    </>
  );
}
