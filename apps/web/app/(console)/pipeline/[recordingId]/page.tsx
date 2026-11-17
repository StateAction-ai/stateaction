import Link from "next/link";
import { notFound } from "next/navigation";
import {
  parsePipelineQuery,
  parseRecordingId,
  pipelineQueryString,
  pipelineReads,
  type PipelineDetail,
} from "@stateaction/server/pipeline";
import { requireConsoleSession } from "../../../../lib/server-session";
import { Card, CardBody, CardHeader } from "../../../../components/ui/card";
import { Button } from "../../../../components/ui/button";
import { StatusBadge } from "../../../../components/pipeline/status-badge";
import { StageList } from "../../../../components/pipeline/stage-list";

export const metadata = { title: "Recording · StateAction.ai" };
export const dynamic = "force-dynamic";

const reads = pipelineReads();

export default async function PipelineRecordingPage({
  params,
  searchParams,
}: {
  params: Promise<{ recordingId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireConsoleSession(["staff"]);
  const recordingId = parseRecordingId((await params).recordingId);
  if (!recordingId) notFound();
  const backQuery = pipelineQueryString(parsePipelineQuery(await searchParams));
  const back = backQuery ? `/pipeline?${backQuery}` : "/pipeline";

  let detail: PipelineDetail | null;
  try {
    detail = await reads.detail(session.userId, recordingId);
  } catch (error) {
    console.error(
      "[pipeline] detail unavailable:",
      error instanceof Error ? error.message : error,
    );
    return (
      <>
        <Link href={back} className="text-[13px] text-brand">
          ← Pipeline
        </Link>
        <p role="alert" className="mt-6 text-sm text-danger">
          This recording is temporarily unavailable. Try again in a moment.
        </p>
      </>
    );
  }
  if (!detail) notFound();
  const actions = await reads.actions(detail);

  return (
    <>
      <Link href={back} className="text-[13px] text-brand">
        ← Pipeline
      </Link>
      <p className="m-0 mt-6 text-[10px] font-bold tracking-[0.14em] text-muted uppercase">
        Pipeline recording
      </p>
      <h1 className="m-0 mt-1 text-[32px] font-bold tracking-[-0.03em] break-words">
        {detail.title}
      </h1>
      <p className="mt-2 mb-6 text-muted">
        Upload and processing details for this recording.
      </p>

      <Card className="mb-5">
        <CardHeader className="flex items-center justify-between gap-3">
          <h2 className="m-0 text-base font-bold">Processing stages</h2>
          <StatusBadge status={detail.status} />
        </CardHeader>
        <CardBody className="grid gap-4">
          <StageList stages={detail.stages} />
          <p className="m-0 text-xs text-muted">
            Stages are shown only from recorded evidence; a stage with no
            recorded evidence stays unknown. Processing completion is separate
            from human review.
          </p>
          {detail.error ? (
            <div
              role="alert"
              className="rounded-lg border border-[#edc8cc] bg-danger-soft px-4 py-3 text-sm text-[#7b2b31]"
            >
              <p className="m-0 font-semibold">Action required</p>
              <p className="m-0 mt-1 break-words">{detail.error.summary}</p>
            </div>
          ) : detail.statusNote ? (
            <p className="m-0 text-sm text-muted">{detail.statusNote}</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            {actions.reviewClipsHref ? (
              <Button asChild>
                <Link href={actions.reviewClipsHref}>Review clips</Link>
              </Button>
            ) : null}
            {actions.control.length === 0 ? (
              <p className="m-0 text-xs text-muted">
                Cancel, retry and reconcile controls appear here only when the
                job service reports them for this attempt.
              </p>
            ) : null}
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="m-0 text-base font-bold">Source recording</h2>
        </CardHeader>
        <CardBody>
          <dl className="m-0 grid grid-cols-1 gap-x-10 gap-y-3 text-sm sm:grid-cols-2">
            {(
              [
                ["Started", detail.startedLabel],
                ["Collector", detail.collector],
                ["Duration", "Unknown"],
                ["Source size", detail.source.size ?? "Unknown"],
                ["Format", detail.source.format ?? "Unknown"],
                ["Source hash", "Not reported"],
              ] as const
            ).map(([label, value]) => (
              <div
                key={label}
                className="flex justify-between gap-4 border-b border-line pb-2"
              >
                <dt className="text-muted">{label}</dt>
                <dd className="m-0 text-right font-medium break-words">
                  {value}
                </dd>
              </div>
            ))}
          </dl>
          <p className="m-0 mt-4 text-xs text-muted">
            The source hash is established only after the whole source is read
            to its end during processing.
          </p>
        </CardBody>
      </Card>
    </>
  );
}
