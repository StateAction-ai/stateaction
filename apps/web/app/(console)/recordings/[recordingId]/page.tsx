import Link from "next/link";
import { notFound } from "next/navigation";
import {
  formatUsd,
  parseRecordingId,
  RECIPE_STAGE_LABEL,
  clipReads,
} from "@stateaction/server/pipeline";
import { requireConsoleSession } from "../../../../lib/server-session";
import {
  elapsedSeconds,
  planTimeline,
  sourceTime,
} from "../../../../lib/recording-timeline";
import { isCurrentImport } from "../../../../lib/clip-pipeline";
import { fmtClock, fmtPrecise } from "../../../../lib/review/timeline";
import {
  ClipState,
  stageDisplayState,
} from "../../../../components/recordings/clip-states";
import { OriginalVideo } from "../../../../components/recordings/original-video";
import { Card } from "../../../../components/ui/card";

export const metadata = { title: "Recording · StateAction.ai" };
export const dynamic = "force-dynamic";

const headings = ["Clip", "Pipeline state", "Stages", "Est. cost", "Open"];

export default async function RecordingPage({
  params,
  searchParams,
}: {
  params: Promise<{ recordingId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireConsoleSession(["staff"]);
  const id = parseRecordingId((await params).recordingId);
  if (!id) notFound();
  const recording = await clipReads().getRecording(session.userId, id);
  if (!recording) notFound();
  const { plan, clips } = recording;
  const legacy =
    plan === null && clips.length === 1 && clips[0]?.sourceRange === null;
  const imported =
    clips.length === 1 && clips[0]?.selectedResult?.source === "imported";
  const importedRun =
    clips.length === 1 && clips[0] && isCurrentImport(clips[0]);
  const [title, ...sourceLabel] = imported
    ? recording.title.split(" · ")
    : [recording.title];
  const whole = clips.length === 1 && (!plan || plan.mode !== "apply");
  const duration =
    whole && clips[0]?.durationNs ? elapsedSeconds(clips[0].durationNs) : null;
  const spans = planTimeline(plan);
  if (legacy)
    spans.push({
      kind: "clip",
      label: "Clip 1 · Whole recording",
      start: 0,
      end: null,
    });

  return (
    <>
      <nav
        aria-label="Breadcrumb"
        className="mb-2 flex items-center gap-2 text-sm text-muted"
      >
        <Link href="/pipeline" className="text-brand-ink underline">
          Recordings
        </Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">Recording</span>
      </nav>
      <header className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[clamp(1.55rem,3vw,2.125rem)] leading-tight font-bold tracking-tight wrap-break-word">
            {title}
          </h1>
          {imported && (
            <p className="mt-1 text-muted wrap-break-word">
              {[...sourceLabel, "Cached import"].join(" · ")}
            </p>
          )}
        </div>
        <ClipState state={importedRun ? "imported" : recording.state} />
      </header>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_12rem] xl:grid-cols-[minmax(0,1fr)_15.75rem] sm:items-start">
        <Card
          aria-labelledby="clip-plan-heading"
          className="min-w-0 p-3 sm:col-start-2 sm:row-start-1 sm:p-4"
        >
          <h2 id="clip-plan-heading" className="mb-2 text-lg font-bold">
            Clip plan
          </h2>
          {plan || legacy ? (
            <>
              <dl className="grid grid-cols-3 gap-2 text-sm sm:grid-cols-1">
                <div className="sm:border-b sm:border-line sm:pb-2">
                  <dt className="text-xs text-muted">Mode</dt>
                  <dd className="font-semibold capitalize">
                    {plan?.mode ?? "passthrough"}
                  </dd>
                </div>
                <div className="sm:border-b sm:border-line sm:pb-2">
                  <dt className="text-xs text-muted">Filter version</dt>
                  <dd className="text-xs font-semibold wrap-break-word">
                    <code>{plan?.filter_version ?? "clip_filter@0"}</code>
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted">Plan state</dt>
                  <dd className="font-semibold">
                    {plan?.state === "failed" ? "Failed" : "Completed"}
                  </dd>
                </div>
              </dl>
              {plan?.state === "failed" ? (
                <p className="mt-3 border-t border-line pt-2 text-danger">
                  Clip planning failed. The clip covers the whole recording.{" "}
                  {plan.error_code && <code>{plan.error_code}</code>}
                </p>
              ) : (
                (legacy || plan?.mode === "passthrough") && (
                  <p className="mt-3 border-t border-line pt-2 text-sm">
                    Cutting is off. The clip covers the whole recording.
                  </p>
                )
              )}
            </>
          ) : (
            <p className="text-muted">Waiting for the clip plan.</p>
          )}
        </Card>
        <div className="min-w-0 sm:col-start-1 sm:row-start-1">
          <OriginalVideo
            key={`${id}:${recording.canReadOriginal}`}
            readPath={
              recording.canReadOriginal
                ? `/api/v1/recordings/${id}/reads`
                : null
            }
            initialTime={sourceTime((await searchParams).t)}
            expectedDuration={duration}
            spans={spans}
          />
        </div>
      </div>

      <Card aria-labelledby="recording-clips-heading" className="mt-4 min-w-0">
        <div className="flex justify-between gap-3 p-3 sm:p-4">
          <h2 id="recording-clips-heading" className="text-lg font-bold">
            Clips
          </h2>
          <span className="text-muted">
            {clips.length} {clips.length === 1 ? "clip" : "clips"}
          </span>
        </div>
        {clips.length > 0 && (
          <div role="table" aria-label="Clips and pipeline status">
            <div
              role="row"
              className="sr-only lg:not-sr-only lg:grid lg:grid-cols-[0.85fr_1fr_1.45fr_0.85fr_0.85fr] lg:gap-3 lg:border-y lg:border-line lg:bg-field lg:px-4 lg:py-2 lg:text-xs lg:text-muted"
            >
              {headings.map((heading) => (
                <span key={heading} role="columnheader">
                  {heading}
                </span>
              ))}
            </div>
            {clips.map((clip) => {
              const from =
                clip.sourceOffsetNs === null
                  ? null
                  : elapsedSeconds(clip.sourceOffsetNs);
              const length =
                clip.durationNs === null
                  ? null
                  : elapsedSeconds(clip.durationNs);
              const cached = isCurrentImport(clip);
              const format =
                length !== null && length < 5 ? fmtPrecise : fmtClock;
              return (
                <div
                  key={clip.id}
                  role="row"
                  className="grid grid-cols-2 items-start gap-3 border-t border-line p-3 text-sm lg:grid-cols-[0.85fr_1fr_1.45fr_0.85fr_0.85fr] lg:px-4"
                >
                  <div role="cell">
                    <strong>Clip {clip.ordinal + 1}</strong>
                    <p className="text-xs text-muted tabular-nums">
                      {from !== null && length !== null
                        ? `${format(from)}–${format(from + length)}`
                        : whole
                          ? "Whole recording"
                          : "Source time unavailable"}
                    </p>
                  </div>
                  <div role="cell" className="grid gap-1">
                    <span
                      aria-hidden="true"
                      className="text-xs text-muted lg:hidden"
                    >
                      Pipeline state
                    </span>
                    <ClipState
                      state={cached ? "imported" : clip.pipeline.state}
                    />
                    {clip.pipeline.errorCode && (
                      <code className="text-xs text-danger wrap-break-word">
                        {clip.pipeline.errorCode}
                      </code>
                    )}
                  </div>
                  <div role="cell" className="col-span-2 lg:col-span-1">
                    <span
                      aria-hidden="true"
                      className="text-xs text-muted lg:hidden"
                    >
                      Stages
                    </span>
                    {cached || clip.pipeline.stages.length ? (
                      <ul className="flex flex-wrap gap-x-2 gap-y-1 text-xs">
                        {(cached
                          ? (Object.keys(RECIPE_STAGE_LABEL) as Array<
                              keyof typeof RECIPE_STAGE_LABEL
                            >)
                          : clip.pipeline.stages.map((stage) => stage.stage)
                        ).map((key) => {
                          const stage = clip.pipeline.stages.find(
                            (item) => item.stage === key,
                          );
                          return (
                            <li key={key} className="flex items-center gap-1">
                              {RECIPE_STAGE_LABEL[key]}{" "}
                              <ClipState
                                state={
                                  cached
                                    ? "reused"
                                    : stage
                                      ? stageDisplayState(stage)
                                      : "pending"
                                }
                              />
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <p className="text-xs text-muted">
                        Stage records unavailable
                      </p>
                    )}
                  </div>
                  <div role="cell">
                    <span
                      aria-hidden="true"
                      className="block text-xs text-muted lg:hidden"
                    >
                      Est. cost
                    </span>
                    {cached
                      ? "Cached import"
                      : clip.pipeline.estimatedCostUsd === null
                        ? "Unavailable"
                        : formatUsd(clip.pipeline.estimatedCostUsd)}
                  </div>
                  <div
                    role="cell"
                    className="col-span-2 flex flex-wrap items-center gap-x-4 lg:col-span-1 lg:items-start"
                  >
                    <Link
                      href={`/pipeline/clips/${clip.id}`}
                      className="inline-flex min-h-9 items-center font-semibold text-brand-ink underline lg:min-h-7"
                    >
                      View pipeline
                    </Link>
                    {clip.reviewStatus === "not_ready" ? (
                      <span className="text-xs text-muted">
                        Review unavailable
                      </span>
                    ) : (
                      <Link
                        href={`/review/${clip.recordingId}`}
                        className="inline-flex min-h-9 items-center font-semibold text-brand-ink underline lg:min-h-7"
                      >
                        Review clip
                      </Link>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </>
  );
}
