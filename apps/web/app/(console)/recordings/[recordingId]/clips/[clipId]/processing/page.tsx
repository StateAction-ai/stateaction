import Link from "next/link";
import { notFound } from "next/navigation";
import type { Stage } from "@stateaction/contracts";
import {
  parseRecordingId,
  pipelineReads,
  RECIPE_STAGE_LABEL,
} from "@stateaction/server/pipeline";
import {
  EstimatedCost,
  ProcessingStage,
  ProcessingStatus,
  processingReason,
} from "../../../../../../../components/recordings/processing-stage";
import {
  RecordingPreview,
  rangeLabel,
} from "../../../../../../../components/recordings/recording-preview";
import { RetryAction } from "../../../../../../../components/recordings/retry-actions";
import { SelectClipResult } from "../../../../../../../components/recordings/select-clip-result";
import { Button } from "../../../../../../../components/ui/button";
import { recipeHref, recipeLabel } from "../../../../../../../lib/recipe-view";
import { requireConsoleSession } from "../../../../../../../lib/server-session";

export const metadata = { title: "Clip processing · StateAction.ai" };
export const dynamic = "force-dynamic";

const retryLabel: Record<Stage, string> = {
  segment: "Retry segmentation and captions",
  caption: "Retry captions",
  hand_pose: "Retry hand pose",
};

export default async function ClipProcessingPage({
  params,
  searchParams,
}: {
  params: Promise<{ recordingId: string; clipId: string }>;
  searchParams: Promise<{ run?: string | string[] }>;
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
  const run = (await searchParams).run;
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

  function action(
    stage: Stage,
    stages: Stage[],
    label: string,
    blocked: string | null,
    hint: string,
  ) {
    if (!clip.latestJobId) return null;
    return (
      <RetryAction
        key={`${clip.latestJobId}:${stage}:${label}`}
        recordingId={recording.id}
        label={label}
        action={{
          request: {
            schemaVersion: 2,
            scope: "clip",
            clipId: clip.id,
            parentJobId: clip.latestJobId,
            stages,
          },
        }}
        ranges={ranges}
        hint={hint}
        disabledReason={
          !canRetry
            ? "This environment is read-only."
            : handOnly && stages.some((candidate) => candidate !== "hand_pose")
              ? "This canary allows hand pose retries only."
              : blocked
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
              href={recipeHref(recipe.id, recipe.jobId ?? undefined)}
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

      <RecordingPreview
        recordingId={recordingId}
        range={range}
        capturedAt={recording.startedAt}
        metadata={recording.metadata}
        clipId={clipId}
      />

      {stages.map(
        (
          {
            stage,
            latest,
            attempts,
            reusedFromJobId,
            reusableOutput,
            enabled,
            importedEvidence,
          },
          index,
        ) => {
          if (stage === "clip_plan") return null;
          const needsRetry =
            enabled === true &&
            !reusableOutput &&
            Boolean(
              latest?.error ||
                latest?.state === "partially_complete" ||
                result.error?.stage === stage ||
                job?.state === "cancelled",
            );
          const fromHere = stages
            .slice(index)
            .flatMap(({ stage, enabled }) =>
              stage !== "clip_plan" && enabled ? [stage] : [],
            );
          const label =
            stage === "segment" &&
            !stages.some((entry) => entry.stage === "caption" && entry.enabled)
              ? "Retry segmentation"
              : retryLabel[stage];
          return (
            <ProcessingStage
              key={stage}
              title={RECIPE_STAGE_LABEL[stage]}
              current={latest}
              runs={attempts}
              reusedFromJobId={reusedFromJobId}
              pathname={pathname}
              selectedRun={selectedRun}
              recipeId={recipe?.id}
              hasEarlierOutput={importedEvidence !== null}
              action={
                needsRetry &&
                (terminal || active) &&
                clip.latestJobId && (
                  <div className="flex flex-wrap items-start gap-2">
                    {action(
                      stage,
                      [stage],
                      label,
                      blocked,
                      label === retryLabel.segment
                        ? "Captions must follow segmentation."
                        : "Retry this stage only.",
                    )}
                    {fromHere.length > 1 &&
                      action(
                        stage,
                        fromHere,
                        "Retry from here",
                        blocked,
                        "Retry this stage and everything after it.",
                      )}
                  </div>
                )
              }
            />
          );
        },
      )}
    </div>
  );
}
