import Link from "next/link";
import { notFound } from "next/navigation";
import { mediaReadOrigin } from "@stateaction/server";
import {
  pipelineReads,
  failedStageNote,
  shortRecordingId,
  stageHasFailures,
  stageReason,
} from "@stateaction/server/pipeline";
import { StatusBadge } from "../../../../components/pipeline/status-badge";
import { fixtureEnabled } from "../../../../lib/review/fixture-gate";
import { SelectResult } from "../../../../components/pipeline/select-result";
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
  searchParams,
}: {
  params: Promise<{ recordingId: string }>;
  searchParams: Promise<{ run?: string }>;
}) {
  const session = await requireConsoleSession(["staff"]);
  const { recordingId } = await params;
  if (!UUID.test(recordingId)) notFound();
  const { run } = await searchParams;
  if (run && !UUID.test(run)) notFound();
  const loader = reviewLoader();
  try {
    const fixture = fixtureEnabled(process.env);
    const [bundle, recordings, detail, history] = await Promise.all([
      loader.load(session.userId, recordingId, run),
      loader.listRecordings(session.userId),
      fixture ? null : pipeline.detail(session.userId, recordingId, run),
      fixture
        ? { runs: [], selectionSeq: 0 }
        : pipeline.history(session.userId, recordingId),
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
      mediaOrigin = mediaReadOrigin();
    } catch {
      mediaOrigin = null;
    }
    return (
      <>
        {annotations.source === "imported" ? (
          <p className="mb-4 rounded-md border bg-surface p-3 text-sm">
            Imported from cached results ·{" "}
            <Link
              className="text-brand underline"
              href={"/pipeline/" + recordingId}
            >
              Source and model provenance
            </Link>
          </p>
        ) : null}
        {history.runs.length > 1 ? (
          <details className="mb-4 rounded-lg border border-line px-4 py-2 text-sm">
            <summary className="font-semibold">Run history</summary>
            <ul className="m-0 mt-2 grid list-none gap-2 p-0">
              {history.runs.map((item) => (
                <li
                  key={item.jobId}
                  className="flex flex-wrap items-center gap-2"
                >
                  <Link
                    className="text-brand underline"
                    href={
                      item.state === "succeeded"
                        ? `/review/${recordingId}?run=${item.jobId}`
                        : `/pipeline/${recordingId}?run=${item.jobId}`
                    }
                  >
                    Run {item.jobId.slice(0, 8)}
                  </Link>
                  <span>{item.state.replaceAll("_", " ")}</span>
                  {item.selected ? (
                    <strong>Selected</strong>
                  ) : item.state === "succeeded" &&
                    pipeline.selectionEnabled() ? (
                    <SelectResult
                      recordingId={recordingId}
                      jobId={item.jobId}
                      sequence={history.selectionSeq}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
        <ReviewPage
          key={bundle.annotations.job_id}
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
                (segmentFailure.errorCode
                  ? `Recorded reason code ${segmentFailure.errorCode}.`
                  : "No explanation was recorded."))
              : null
          }
        />
      </>
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
