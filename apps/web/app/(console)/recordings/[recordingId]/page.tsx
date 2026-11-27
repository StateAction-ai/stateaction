import Link from "next/link";
import { notFound } from "next/navigation";
import {
  parseRecordingId,
  pipelineReads,
  RECIPE_STAGE_LABEL,
} from "@stateaction/server/pipeline";
import { CaptureHold } from "../../../../components/recordings/capture-hold";
import { ClipTable } from "../../../../components/recordings/clip-table";
import { RecipeFlow } from "../../../../components/recipes/recipe-flow";
import {
  EstimatedCost,
  ProcessingStepDetails,
  ProcessingStatus,
  processingReason,
} from "../../../../components/recordings/processing-stage";
import {
  exactRangeLabel,
  RecordingPreview,
  rangeLabel,
} from "../../../../components/recordings/recording-preview";
import { RetryAction } from "../../../../components/recordings/retry-actions";
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
  const cannotRetryPlanning =
    retryTarget?.kind === "clip_plan"
      ? retryTarget.available
        ? null
        : (retryTarget.reason ?? "Clip planning cannot be retried.")
      : recording.status === "processing" || recording.status === "queued"
        ? "Processing is already in progress."
        : "No failed steps.";
  const planningAction =
    retryTarget?.kind === "clip_plan"
      ? ({
          planning: {
            jobId: retryTarget.jobId,
            expectedState: retryTarget.expectedState,
            estimate: planningJob?.costUsd,
          },
        } as const)
      : null;
  const bulk =
    retryTarget?.kind === "failed_clips"
      ? retryTarget.clips.some(({ graph }) => graph)
        ? ({ graph: { scope: "failed_clips" } } as const)
        : null
      : planningAction;

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
              href={recipeHref(recipe.id)}
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

      <RecipeFlow
        nodes={recording.graph}
        initialStep={
          typeof query.step === "string"
            ? query.step
            : typeof query.t === "string"
              ? "$source"
              : undefined
        }
        retry={
          <RetryAction
            key={
              retryTarget?.kind === "failed_clips"
                ? retryTarget.clips.map(({ jobId }) => jobId).join(",")
                : retryTarget?.jobId
            }
            recordingId={recordingId}
            label="Retry failed steps"
            action={bulk}
            ranges={Object.fromEntries(
              clips.map((clip) => [
                clip.id,
                exactRangeLabel(clip.startSeconds, clip.endSeconds),
              ]),
            )}
            disabledReason={
              !reads.selectionEnabled()
                ? "This environment is read-only."
                : retryTarget?.kind === "failed_clips"
                  ? null
                  : cannotRetryPlanning
            }
          />
        }
        details={{
          $source: (
            <div className="grid gap-3">
              <RecordingPreview
                recordingId={recordingId}
                initialTime={sourceTime(query.t)}
                spans={planTimeline(recording.plan)}
                capturedAt={recording.startedAt}
                metadata={recording.metadata}
              />
              <ProcessingStepDetails
                stepId="source"
                pathname={pathname}
                current={null}
                runs={[]}
              />
            </div>
          ),
          clip_plan: (
            <ProcessingStepDetails
              stepId="clip_plan"
              pathname={pathname}
              current={planningJob}
              runs={clipPlanning.attempts}
              selectedRun={selectedRun}
              recipeId={recipe?.id}
              note={
                recording.plan ? (
                  <p className="text-sm text-muted">
                    {recording.plan.state === "failed"
                      ? "Planning failed. The plan covers the whole recording."
                      : recording.plan.mode === "passthrough"
                        ? "The clip covers the whole recording."
                        : "Clip ranges are available."}
                  </p>
                ) : (
                  !planningJob && (
                    <p className="text-sm text-muted">No clip plan recorded.</p>
                  )
                )
              }
              action={
                planningAction && (
                  <RetryAction
                    key={planningAction.planning.jobId}
                    recordingId={recordingId}
                    label="Retry this step"
                    action={planningAction}
                    disabledReason={
                      !reads.selectionEnabled()
                        ? "This environment is read-only."
                        : cannotRetryPlanning
                    }
                  />
                )
              }
            />
          ),
          $clips: (
            <ClipTable
              clips={clips.map((clip) => ({
                href: `${pathname}/clips/${clip.id}/processing`,
                label: `Clip ${clip.ordinal + 1}`,
                range: ranges[clip.id]!,
                status: clip.status,
              }))}
            />
          ),
        }}
      />
    </div>
  );
}
