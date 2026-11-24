import Link from "next/link";
import { notFound } from "next/navigation";
import { CatalogError, datasets, mediaReadOrigin } from "@stateaction/server";
import { authRuntime } from "@stateaction/server/auth";
import {
  failedStageNote,
  pipelineReads,
  stageHasFailures,
  stageReason,
} from "@stateaction/server/pipeline";
import { ReviewRunHistory } from "../../../../../components/review/review-run-history";
import { ReviewPage } from "../../../../../components/review/review-page";
import {
  loadReviewClip,
  loadReviewBundle,
  seconds,
} from "../../../../../lib/review/clip-reads";
import { REVIEW_QUEUE_UUID } from "../../../../../lib/review/queue";
import { ReviewDataUnavailable } from "../../../../../lib/review/types";
import { requireConsoleSession } from "../../../../../lib/server-session";

export const metadata = { title: "Review clip · StateAction.ai" };
export const dynamic = "force-dynamic";

const pipeline = pipelineReads();

export default async function ReviewClipPage({
  params,
}: {
  params: Promise<{ clipId: string }>;
}) {
  const session = await requireConsoleSession(["staff"]);
  const { clipId } = await params;
  if (!REVIEW_QUEUE_UUID.test(clipId)) notFound();
  const clip = await loadReviewClip(session.userId, clipId);
  if (!clip?.selectedResult || clip.selectedResult.selectionRevision === null)
    notFound();
  const selected = clip.selectedResult;
  const selectionRevision = selected.selectionRevision!;
  const reviewPath =
    "/api/v1/review-clips/" +
    clipId +
    "/decision?selection=" +
    selectionRevision;
  try {
    const [bundle, history, decision] = await Promise.all([
      loadReviewBundle(session.userId, clip, selected),
      pipeline.history(session.userId, clip.recordingId),
      datasets.getClipReviewState(authRuntime().pool, {
        viewerUserId: session.userId,
        clipId,
        selectionRevision,
      }),
    ]);
    if (
      !bundle ||
      decision.jobId !== selected.jobId ||
      decision.resultManifestSha256 !== selected.resultManifestSha256
    )
      return (
        <Unavailable message="The selected result changed. Reload this page to see the new result." />
      );
    const nodes = bundle.annotations.dag_run?.stages ?? [];
    const segmentFailure = nodes.find(
      (stage) => stage.stage === "segment" && stage.state === "failed",
    );
    const failed = new Set(
      clip.selectedDag?.stages
        .filter(stageHasFailures)
        .map((node) => node.stage),
    );
    for (const stage of nodes) {
      if (stageHasFailures(stage)) failed.add(stage.stage);
    }
    if (bundle.annotations.segments?.windows.failed.length)
      failed.add("segment");
    if (
      bundle.annotations.captions?.rows.some((row) => row.status === "failed")
    )
      failed.add("caption");
    const sourceStartS = seconds(clip.sourceOffsetNs) ?? 0;
    const durationS = seconds(clip.durationNs);
    let mediaOrigin: string | null = null;
    try {
      mediaOrigin = mediaReadOrigin();
    } catch {}
    return (
      <>
        <ReviewRunHistory
          recordingId={clip.recordingId}
          history={history}
          selectionEnabled={
            clip.sourceRange === null && pipeline.selectionEnabled()
          }
        />
        <ReviewPage
          key={selected.jobId + ":" + selectionRevision}
          bundle={bundle}
          readOnly={!decision.capabilities.canReview}
          recordings={[]}
          mediaOrigin={mediaOrigin}
          status={failed.size ? "needs_attention" : "completed"}
          failureNote={failedStageNote([...failed])}
          segmentationFailure={
            segmentFailure
              ? (stageReason(segmentFailure.errorCode) ??
                (segmentFailure.errorCode
                  ? "Recorded reason code " + segmentFailure.errorCode + "."
                  : "No explanation was recorded."))
              : null
          }
          clipReview={{
            id: clip.id,
            selectionRevision,
            decision: { userId: session.userId, reviewPath, state: decision },
            ordinal: clip.ordinal,
            sourceStartS,
            sourceEndS: durationS === null ? null : sourceStartS + durationS,
            originalHref: clip.canReadOriginal
              ? "/recordings/" + clip.recordingId + "?t=" + sourceStartS
              : null,
          }}
        />
      </>
    );
  } catch (error) {
    if (error instanceof CatalogError && error.code === "conflict")
      return (
        <Unavailable message="The selected result changed. Reload this page to see the new result." />
      );
    if (error instanceof ReviewDataUnavailable)
      return <Unavailable message={error.message} />;
    throw error;
  }
}

function Unavailable({ message }: { message: string }) {
  return (
    <>
      <Link href="/review" className="text-sm text-brand underline">
        ‹ Review queue
      </Link>
      <p role="alert" className="mt-4 text-sm text-danger">
        {message}
      </p>
    </>
  );
}
