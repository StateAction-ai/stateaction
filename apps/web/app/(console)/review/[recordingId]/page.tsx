import Link from "next/link";
import { notFound } from "next/navigation";
import { serverConfig } from "@stateaction/server";
import {
  pipelineReads,
  failedStageNote,
  shortRecordingId,
  stageHasFailures,
  stageReason,
} from "@stateaction/server/pipeline";
import { StatusBadge } from "../../../../components/pipeline/status-badge";
import { fixtureEnabled } from "../../../../lib/review/fixture-gate";
import { requireConsoleSession } from "../../../../lib/server-session";
import { ReviewPage } from "../../../../components/review/review-page";
import { reviewLoader } from "../../../../lib/review/loader";
import { ReviewDataUnavailable } from "../../../../lib/review/types";

export const metadata = { title: "Review · StateAction.ai" };
export const dynamic = "force-dynamic";

const pipeline = pipelineReads();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ReviewRecordingPage({
  params,
}: {
  params: Promise<{ recordingId: string }>;
}) {
  const session = await requireConsoleSession(["staff"]);
  const { recordingId } = await params;
  if (!UUID.test(recordingId)) notFound();
  const loader = reviewLoader();
  try {
    const [bundle, recordings, detail] = await Promise.all([
      loader.load(session.userId, recordingId),
      loader.listRecordings(session.userId),
      fixtureEnabled(process.env)
        ? null
        : pipeline.detail(session.userId, recordingId),
    ]);
    if (!bundle) {
      if (!detail?.failedStages.length) notFound();
      return (
        <>
          <h1 className="text-2xl font-bold">
            {detail.title} · {shortRecordingId(recordingId)}
          </h1>
          <StatusBadge status={detail.status} />
          <p role="alert">
            {failedStageNote(detail.failedStages)}. Review data is unavailable.
          </p>
          <Link
            href={"/pipeline/" + recordingId}
            className="text-brand underline"
          >
            Open Pipeline run
          </Link>
        </>
      );
    }
    const annotations = bundle.annotations;
    const nodes = annotations.dag_run?.stages ?? [];
    const matched = detail?.jobId === annotations.job_id ? detail : null;
    const failedStages = new Set(matched?.failedStages ?? []);
    for (const stage of nodes) {
      if (stageHasFailures(stage)) failedStages.add(stage.stage);
    }
    if (annotations.segments?.windows.failed.length)
      failedStages.add("segment");
    if (annotations.captions?.rows.some((row) => row.status === "failed"))
      failedStages.add("caption");
    const segmentFailure = nodes.find(
      (stage) => stage.stage === "segment" && stage.state === "failed",
    );
    let mediaOrigin: string | null = null;
    try {
      mediaOrigin = new URL(serverConfig().publicEndpoint).origin;
    } catch {
      mediaOrigin = null;
    }
    return (
      <ReviewPage
        key={recordingId}
        bundle={bundle}
        recordings={recordings}
        mediaOrigin={mediaOrigin}
        status={
          failedStages.size
            ? "needs_attention"
            : (matched?.status ?? "completed")
        }
        failureNote={failedStageNote([...failedStages])}
        segmentationFailure={
          segmentFailure
            ? (stageReason(segmentFailure.errorCode) ??
              "No explanation was recorded.")
            : null
        }
      />
    );
  } catch (error) {
    if (error instanceof ReviewDataUnavailable)
      return <Unavailable message={error.message} />;
    throw error;
  }
}

function Unavailable({ message }: { message: string }) {
  return (
    <>
      <Link href="/pipeline" className="text-[13px] text-brand">
        ← Pipeline
      </Link>
      <p role="alert" className="mt-6 text-sm text-danger">
        Review data is not available yet. {message}
      </p>
    </>
  );
}
