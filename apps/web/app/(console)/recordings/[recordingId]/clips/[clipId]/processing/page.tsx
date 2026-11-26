import Link from "next/link";
import { notFound } from "next/navigation";
import type { Stage } from "@stateaction/contracts";
import { parseRecordingId, pipelineReads } from "@stateaction/server/pipeline";
import {
  EstimatedCost,
  ProcessingStepDetails,
  ProcessingStatus,
  processingReason,
} from "../../../../../../../components/recordings/processing-stage";
import {
  exactRangeLabel,
  RecordingPreview,
  rangeLabel,
} from "../../../../../../../components/recordings/recording-preview";
import { RecipeFlow } from "../../../../../../../components/recipes/recipe-flow";
import { RetryAction } from "../../../../../../../components/recordings/retry-actions";
import { SelectClipResult } from "../../../../../../../components/recordings/select-clip-result";
import { Button } from "../../../../../../../components/ui/button";
import { recipeHref, recipeLabel } from "../../../../../../../lib/recipe-view";
import { requireConsoleSession } from "../../../../../../../lib/server-session";

export const metadata = { title: "Clip processing · StateAction.ai" };
export const dynamic = "force-dynamic";

export default async function ClipProcessingPage({
  params,
  searchParams,
}: {
  params: Promise<{ recordingId: string; clipId: string }>;
  searchParams: Promise<{ run?: string | string[]; step?: string | string[] }>;
}) {
  const staff = await requireConsoleSession(["staff"]);
  const ids = await params;
  const recordingId = parseRecordingId(ids.recordingId);
  const clipId = parseRecordingId(ids.clipId);
  if (!recordingId || !clipId) notFound();

  const reads = pipelineReads();
  const result = await reads.clipOperations(staff.userId, recordingId, clipId);
  if (!result) notFound();
  const { clip, recording, stages, recipe } = result;
  const pathname = `/recordings/${recordingId}/clips/${clipId}/processing`;
  const { run, step } = await searchParams;
  const selectedRun = parseRecordingId(
    typeof run === "string" ? run : undefined,
  );
  const ready = clip.selectedJobId !== null;
  const range =
    clip.startSeconds !== null &&
    clip.endSeconds !== null &&
    clip.endSeconds >= clip.startSeconds
      ? { start: clip.startSeconds, end: clip.endSeconds }
      : undefined;
  const ranges = { [clipId]: rangeLabel(clip.startSeconds, clip.endSeconds) };
  const canRetry = reads.selectionEnabled();
  const alternateResults = result.jobs
    .filter((job) => job.state === "succeeded" && job.id !== clip.selectedJobId)
    .map((job) => ({
      id: job.id,
      started:
        new Date(job.startedAt ?? job.createdAt)
          .toISOString()
          .slice(0, 16)
          .replace("T", " ") + " UTC",
    }));
  const handOnly = reads.handPoseRerunOnly();
  const job = result.jobs.find(({ id }) => id === clip.latestJobId);
  const active = result.status === "processing" || result.status === "queued";
  const terminal =
    job && ["succeeded", "failed", "cancelled"].includes(job.state);
  const reupload = [
    "source_sha_mismatch",
    "source_checksum_mismatch",
    "source_digest_mismatch",
  ].includes(job?.error?.code ?? "");
  const blocked = active
    ? "Processing is already in progress."
    : reupload
      ? "The source needs to be uploaded again."
      : null;

  const retryable = stages.flatMap(
    ({ stage, latest, enabled, reusableOutput }): Stage[] =>
      stage !== "clip_plan" &&
      result.retryStages.includes(stage) &&
      enabled === true &&
      !reusableOutput &&
      (latest?.error ||
        latest?.state === "partially_complete" ||
        result.error?.stage === stage ||
        job?.state === "cancelled")
        ? [stage]
        : [],
  );
  function action(requested: Stage[], label: string) {
    return (
      <RetryAction
        key={`${clip.latestJobId}:${requested.join(",")}:${label}`}
        recordingId={recording.id}
        label={label}
        ranges={{
          [clip.id]: exactRangeLabel(clip.startSeconds, clip.endSeconds),
        }}
        action={
          clip.latestJobId && requested.length
            ? {
                request: {
                  schemaVersion: 2,
                  scope: "clip",
                  clipId: clip.id,
                  parentJobId: clip.latestJobId,
                  stages: requested,
                },
              }
            : null
        }
        disabledReason={
          !canRetry
            ? "This environment is read-only."
            : (blocked ??
              (handOnly &&
              requested.some((candidate) => candidate !== "hand_pose")
                ? "This canary allows hand pose retries only."
                : !terminal || !requested.length
                  ? "No failed steps."
                  : null))
        }
      />
    );
  }

  return (
    <div className="grid gap-4">
      <Link
        href={`/recordings/${recordingId}`}
        className="w-fit text-sm text-brand underline"
      >
        ← Recording
      </Link>
      <header>
        <h1 className="text-3xl leading-tight font-bold tracking-tight">
          Clip {clip.ordinal + 1} · Processing
        </h1>
        <p className="mt-1 text-sm text-muted wrap-anywhere">
          {recording.title} · {ranges[clipId]}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <ProcessingStatus state={result.status} />
          <EstimatedCost cost={result.cost} scope="Clip" />
          {recipe && (
            <Link
              href={recipeHref(recipe.id)}
              className="text-sm font-semibold text-brand underline wrap-anywhere"
            >
              {recipeLabel(recipe.id)}
            </Link>
          )}
          {ready ? (
            <Button asChild>
              <Link
                href={
                  "/clips/" +
                  clipId +
                  "?" +
                  new URLSearchParams({
                    returnTo: "/data-browser?recordingId=" + recordingId,
                  })
                }
              >
                Open processed clip
              </Link>
            </Button>
          ) : (
            <Button
              disabled
              variant="outline"
              aria-describedby="processed-clip-reason"
            >
              Open processed clip
            </Button>
          )}
        </div>
        {!ready && (
          <p id="processed-clip-reason" className="mt-2 text-sm text-muted">
            {processingReason(result.error?.code) ??
              result.error?.summary ??
              "The processed clip is not available yet."}
          </p>
        )}
      </header>

      {canRetry && alternateResults.length > 0 ? (
        <SelectClipResult
          key={result.selectionRevision}
          clipId={clipId}
          expectedSelectionSeq={result.selectionRevision}
          candidates={alternateResults}
        />
      ) : null}

      <RecipeFlow
        nodes={result.graph}
        initialStep={typeof step === "string" ? step : undefined}
        retry={action(result.retryStages, "Retry failed steps")}
        details={{
          $input: (
            <div className="grid gap-3">
              <RecordingPreview
                recordingId={recordingId}
                range={range}
                capturedAt={recording.startedAt}
                metadata={recording.metadata}
              />
              <ProcessingStepDetails
                stepId="$input"
                pathname={pathname}
                current={null}
                runs={[]}
              />
            </div>
          ),
          ...Object.fromEntries(
            stages.map(
              ({
                stage,
                latest,
                attempts,
                reusedFromJobId,
                importedEvidence,
              }) => [
                stage,
                <ProcessingStepDetails
                  key={stage}
                  stepId={stage}
                  current={latest}
                  runs={attempts}
                  reusedFromJobId={reusedFromJobId}
                  pathname={pathname}
                  selectedRun={selectedRun}
                  recipeId={recipe?.id}
                  importedEvidence={importedEvidence}
                  action={
                    stage !== "clip_plan" &&
                    retryable.includes(stage) &&
                    action([stage], "Retry this step")
                  }
                />,
              ],
            ),
          ),
        }}
      />
    </div>
  );
}
