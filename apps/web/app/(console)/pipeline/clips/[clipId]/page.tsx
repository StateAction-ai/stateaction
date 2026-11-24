import Link from "next/link";
import { notFound } from "next/navigation";
import {
  buildRunStages,
  formatUsd,
  parseRecordingId,
  pipelineReads,
  clipReads,
} from "@stateaction/server/pipeline";
import { requireConsoleSession } from "../../../../../lib/server-session";
import { elapsedSeconds } from "../../../../../lib/recording-timeline";
import { isCurrentImport } from "../../../../../lib/clip-pipeline";
import { fmtClock, fmtPrecise } from "../../../../../lib/review/timeline";
import { ClipState } from "../../../../../components/recordings/clip-states";
import { ImportedStages } from "../../../../../components/pipeline/imported-stages";
import { RecipeStageList } from "../../../../../components/pipeline/recipe-stage-list";
import { Card } from "../../../../../components/ui/card";

export const metadata = { title: "Clip pipeline · StateAction.ai" };
export const dynamic = "force-dynamic";

const pipeline = pipelineReads();

export default async function ClipPipelinePage({
  params,
}: {
  params: Promise<{ clipId: string }>;
}) {
  const session = await requireConsoleSession(["staff"]);
  const id = parseRecordingId((await params).clipId);
  if (!id) notFound();
  const clip = await clipReads().getClip(session.userId, id);
  if (!clip) notFound();
  const run = clip.currentDag
    ? await pipeline.recipeRun({
        jobId: clip.currentDag.jobId,
        hasRecipe: true,
      })
    : null;
  const cached =
    isCurrentImport(clip) && clip.selectedJobId
      ? await pipeline.cachedImportByJob(session.userId, clip.selectedJobId)
      : null;
  const diagnostics = run
    ? await pipeline
        .diagnostics(session.userId, { jobId: run.jobId })
        .catch(() => ({}))
    : {};
  const stages = run ? buildRunStages(run, pipeline.rates(), diagnostics) : [];
  const from =
    clip.sourceOffsetNs === null ? null : elapsedSeconds(clip.sourceOffsetNs);
  const duration =
    clip.durationNs === null ? null : elapsedSeconds(clip.durationNs);
  const format = duration !== null && duration < 5 ? fmtPrecise : fmtClock;
  const originalHref = `/recordings/${clip.recordingId}`;
  const heading = `Clip ${clip.ordinal + 1} pipeline`;

  return (
    <>
      <nav
        aria-label="Breadcrumb"
        className="mb-2 flex flex-wrap items-center gap-2 text-sm text-muted"
      >
        <Link href="/pipeline" className="text-brand-ink underline">
          Recordings
        </Link>
        <span aria-hidden="true">/</span>
        <Link href={originalHref} className="text-brand-ink underline">
          {clip.recordingTitle}
        </Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{heading}</span>
      </nav>
      <header className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-[clamp(1.55rem,3vw,2.125rem)] leading-tight font-bold tracking-tight">
            {heading}
          </h1>
          <p className="mt-1 text-muted tabular-nums">
            {clip.recordingTitle}
            {from !== null &&
              duration !== null &&
              ` · Source ${format(from)}–${format(from + duration)}`}
          </p>
        </div>
        <ClipState state={cached ? "imported" : clip.pipeline.state} />
      </header>
      <div className="grid items-start gap-4 sm:grid-cols-[minmax(0,1fr)_12rem] xl:grid-cols-[minmax(0,1fr)_15.75rem]">
        <Card
          aria-labelledby="processing-stages-heading"
          className="min-w-0 space-y-2 p-3 sm:p-4"
        >
          <h2 id="processing-stages-heading" className="text-lg font-bold">
            Processing stages
          </h2>
          {clip.pipeline.errorCode && (
            <p className="rounded-md bg-danger-soft p-2 text-sm text-danger">
              <code>{clip.pipeline.errorCode}</code>
            </p>
          )}
          {run ? (
            <RecipeStageList
              stages={stages}
              recipe={run}
              recordingId={clip.recordingId}
              reuse={run.reuse}
            />
          ) : cached ? (
            <ImportedStages cached={cached} showReuse />
          ) : (
            <p className="text-muted">Stage records unavailable.</p>
          )}
        </Card>
        <Card
          aria-labelledby="run-details-heading"
          className="min-w-0 p-3 sm:p-4"
        >
          <h2 id="run-details-heading" className="mb-3 text-lg font-bold">
            Run details
          </h2>
          <dl className="grid gap-3">
            <div>
              <dt className="text-xs text-muted">Job ID</dt>
              <dd>
                <code className="text-xs wrap-break-word">
                  {clip.liveJobId ?? clip.selectedJobId ?? "Unavailable"}
                </code>
              </dd>
            </div>
            {run && (
              <div>
                <dt className="text-xs text-muted">Recipe</dt>
                <dd>
                  <code className="text-xs wrap-break-word">
                    {run.recipeId}
                  </code>
                </dd>
              </div>
            )}
            <div>
              <dt className="text-xs text-muted">Estimated cost</dt>
              <dd>
                {cached
                  ? "Cached import"
                  : clip.pipeline.estimatedCostUsd === null
                    ? "Unavailable"
                    : formatUsd(clip.pipeline.estimatedCostUsd)}
              </dd>
            </div>
          </dl>
          <div className="mt-3 grid gap-2">
            <Link
              href={from === null ? originalHref : `${originalHref}?t=${from}`}
              className="font-semibold text-brand-ink underline"
            >
              {from === null || !clip.canReadOriginal
                ? "Recording"
                : `Open original at ${fmtClock(from)}`}
            </Link>
            {clip.reviewStatus === "not_ready" ? (
              <span className="text-xs text-muted">
                Review unavailable for this run.
              </span>
            ) : (
              <Link
                href={`/review/${clip.recordingId}`}
                className="font-semibold text-brand-ink underline"
              >
                Review clip
              </Link>
            )}
          </div>
        </Card>
      </div>
    </>
  );
}
