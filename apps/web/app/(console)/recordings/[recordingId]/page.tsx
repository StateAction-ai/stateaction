import Link from "next/link";
import { notFound } from "next/navigation";
import {
  formatDuration,
  parseRecordingId,
  pipelineReads,
  RECIPE_STAGE_LABEL,
} from "@stateaction/server/pipeline";
import { CaptureHold } from "../../../../components/recordings/capture-hold";
import { ClipPoster } from "../../../../components/recordings/clip-poster";
import {
  EstimatedCost,
  ProcessingStage,
  ProcessingStatus,
  processingReason,
} from "../../../../components/recordings/processing-stage";
import {
  RecordingPreview,
  rangeLabel,
} from "../../../../components/recordings/recording-preview";
import { RetryAction } from "../../../../components/recordings/retry-actions";
import { Button } from "../../../../components/ui/button";
import { Card } from "../../../../components/ui/card";
import { planTimeline, sourceTime } from "../../../../lib/recording-timeline";
import { recipeHref, recipeLabel } from "../../../../lib/recipe-view";
import { requireConsoleSession } from "../../../../lib/server-session";

export const metadata = { title: "Recording · StateAction.ai" };
export const dynamic = "force-dynamic";

export default async function RecordingPage({
  params,
  searchParams,
}: {
  params: Promise<{ recordingId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const staff = await requireConsoleSession(["staff"]);
  const recordingId = parseRecordingId((await params).recordingId);
  if (!recordingId) notFound();
  const reads = pipelineReads();
  const recording = await reads.recordingOperations(staff.userId, recordingId);
  if (!recording) notFound();

  const { clipPlanning, clips, recipe, captureProfile, retryTarget } =
    recording;
  const pathname = `/recordings/${recordingId}`;
  const query = await searchParams;
  const selectedRun = parseRecordingId(
    typeof query.run === "string" ? query.run : undefined,
  );
  const ranges = Object.fromEntries(
    clips.map((clip) => [
      clip.id,
      rangeLabel(clip.startSeconds, clip.endSeconds),
    ]),
  );
  const planningJob = clipPlanning.latest;
  const alternateRecipes =
    captureProfile?.allowedRecipeIds.filter((id) => id !== recipe?.id) ?? [];
  const noAlternateRecipe =
    recipe?.kind === "recipe" && alternateRecipes.length === 0;

  return (
    <div className="grid gap-4">
      <Link href="/recordings" className="w-fit text-sm text-brand underline">
        ← Recordings
      </Link>
      <header>
        <h1 className="text-3xl leading-tight font-bold tracking-tight wrap-anywhere">
          {recording.title}
        </h1>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <ProcessingStatus state={recording.status} />
          <EstimatedCost cost={recording.cost} scope="Recording" />
          {recipe && (
            <Link
              href={recipeHref(recipe.id, recipe.jobId ?? undefined)}
              className="min-w-0 text-sm font-semibold text-brand underline wrap-anywhere"
            >
              {recipeLabel(recipe.id)}
              {captureProfile?.defaultRecipeId === recipe.id &&
              recording.metadata.sourceLabel
                ? " · Default for " + recording.metadata.sourceLabel
                : ""}
            </Link>
          )}
        </div>
        {noAlternateRecipe && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              disabled
              aria-describedby="reprocess-recipe-reason"
            >
              Reprocess with another recipe
            </Button>
            <span id="reprocess-recipe-reason" className="text-sm text-muted">
              No alternate recipe is configured for this capture source.
            </span>
          </div>
        )}
        {recording.error &&
          recording.error.stage !== "clip_plan" &&
          captureProfile?.state !== "held" && (
            <p className="mt-2 text-sm text-muted">
              {recording.error.stage && (
                <strong>{RECIPE_STAGE_LABEL[recording.error.stage]} · </strong>
              )}
              {processingReason(recording.error.code) ??
                recording.error.summary}
            </p>
          )}
        {retryTarget?.kind === "failed_clips" && (
          <div className="mt-3">
            <RetryAction
              key={retryTarget.clips.map(({ jobId }) => jobId).join(",")}
              recordingId={recordingId}
              label="Retry failed clips"
              action={{ request: { schemaVersion: 2, scope: "failed_clips" } }}
              ranges={ranges}
              disabledReason={
                reads.selectionEnabled()
                  ? null
                  : "This environment is read-only."
              }
            />
          </div>
        )}
      </header>

      {captureProfile?.state === "held" && captureProfile.reason && (
        <CaptureHold
          recordingId={recordingId}
          sourceManifestSha256={captureProfile.sourceManifestSha256}
          reason={captureProfile.reason}
          description={
            recording.error?.summary ??
            (captureProfile.reason === "needs_setup"
              ? "This recording needs a supported capture source and recipe before processing can start."
              : "Processing is paused until a recipe is selected.")
          }
          report={`Recording ${recordingId}\n${JSON.stringify(captureProfile.evidence, null, 2)}`}
          allowedRecipeIds={captureProfile.allowedRecipeIds}
          defaultRecipeId={captureProfile.defaultRecipeId}
          readOnly={!reads.selectionEnabled()}
        />
      )}

      <RecordingPreview
        recordingId={recordingId}
        initialTime={sourceTime(query.t)}
        spans={planTimeline(recording.plan)}
        capturedAt={recording.startedAt}
        metadata={recording.metadata}
      />

      <ProcessingStage
        title="Clip planning"
        pathname={pathname}
        current={planningJob}
        runs={clipPlanning.attempts}
        selectedRun={selectedRun}
        recipeId={recipe?.id}
        note={
          recording.plan ? (
            <div className="grid gap-1 text-sm text-muted">
              {recording.plan.state === "failed" ? (
                <p>
                  Clip planning failed. The plan covers the whole recording.{" "}
                  {recording.plan.error_code && (
                    <code>{recording.plan.error_code}</code>
                  )}
                </p>
              ) : recording.plan.mode === "passthrough" ? (
                <p>The clip covers the whole recording.</p>
              ) : null}
              <p>
                Filter <code>{recording.plan.filter_version}</code> ·{" "}
                {recording.plan.mode}
              </p>
            </div>
          ) : (
            !planningJob && (
              <p className="text-sm text-muted">No clip plan recorded.</p>
            )
          )
        }
        action={
          retryTarget?.kind === "clip_plan" && (
            <RetryAction
              key={retryTarget.jobId}
              recordingId={recordingId}
              label="Retry clip planning"
              action={{
                planning: {
                  jobId: retryTarget.jobId,
                  expectedState: retryTarget.expectedState,
                  estimate: planningJob?.costUsd,
                },
              }}
              disabledReason={
                retryTarget.available
                  ? null
                  : (retryTarget.reason ?? "Clip planning cannot be retried.")
              }
            />
          )
        }
      />

      <Card aria-labelledby="recording-clips-heading">
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h2 id="recording-clips-heading" className="text-lg font-bold">
            Clips
          </h2>
          <span className="text-sm text-muted">{clips.length}</span>
        </div>
        {clips.length ? (
          <ul className="divide-y divide-line">
            {clips.map((clip) => (
              <li key={clip.id}>
                <Link
                  href={`${pathname}/clips/${clip.id}/processing`}
                  className="flex min-w-0 items-center gap-3 p-3 hover:bg-field sm:p-4"
                >
                  <ClipPoster
                    clipId={clip.id}
                    duration={
                      clip.startSeconds !== null && clip.endSeconds !== null
                        ? formatDuration(clip.endSeconds - clip.startSeconds)
                        : null
                    }
                  />
                  <div className="grid min-w-0 flex-1 gap-1">
                    <strong className="text-sm text-brand underline underline-offset-2">
                      Clip {clip.ordinal + 1}
                    </strong>
                    <span className="text-xs text-muted tabular-nums">
                      {ranges[clip.id]}
                    </span>
                  </div>
                  <ProcessingStatus state={clip.status} />
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className="p-4 text-sm text-muted">Clips appear after planning.</p>
        )}
      </Card>
    </div>
  );
}
