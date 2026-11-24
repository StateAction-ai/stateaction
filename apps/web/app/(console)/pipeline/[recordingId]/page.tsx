import Link from "next/link";
import { notFound } from "next/navigation";
import {
  parsePipelineQuery,
  parseRecordingId,
  pipelineQueryString,
  pipelineReads,
  buildRunStages,
  buildRunSummary,
  dagRunFilename,
  dagRunJson,
  formatDuration,
  formatUsd,
  shortRecordingId,
  PIPELINE_STATUS_LABEL,
  type PipelineDetail,
} from "@stateaction/server/pipeline";
import { recipeHref } from "../../../../lib/recipe-view";
import { requireConsoleSession } from "../../../../lib/server-session";
import { Card, CardBody, CardHeader } from "../../../../components/ui/card";
import { Button } from "../../../../components/ui/button";
import { StatusBadge } from "../../../../components/pipeline/status-badge";
import { StageList } from "../../../../components/pipeline/stage-list";
import { JobControls } from "../../../../components/pipeline/job-controls";
import { RecipeStageList } from "../../../../components/pipeline/recipe-stage-list";
import { DagRunPanel } from "../../../../components/pipeline/dag-run-panel";

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
  let run: Awaited<ReturnType<typeof reads.recipeRun>> = null;
  try {
    run = await reads.recipeRun(detail);
  } catch (error) {
    console.error(
      "[pipeline] recipe run unavailable:",
      error instanceof Error ? error.message : error,
    );
  }
  const diagnostics = run
    ? await reads.diagnostics(session.userId, detail).catch((error) => {
        console.error(
          "[pipeline] diagnostics unavailable:",
          error instanceof Error ? error.message : error,
        );
        return {};
      })
    : {};
  const stages = run
    ? buildRunStages(run, reads.rates(), diagnostics, detail.annotations)
    : [];
  const summary = run ? buildRunSummary(run, detail.annotations) : null;
  const count = (n: number | null) => (n === null ? "—" : String(n));
  const guidance =
    actions.control.length > 0
      ? await reads.guidance(detail).catch(() => null)
      : null;

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
        <span className="font-mono">{shortRecordingId(detail.id)}</span>
        {" · "}
        {detail.collector}
        {detail.source.size ? " · " + detail.source.size : ""}
      </p>

      {summary ? (
        <dl
          data-testid="run-summary"
          className="m-0 mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5"
        >
          {(
            [
              [
                "Job",
                PIPELINE_STATUS_LABEL[detail.status],
                detail.error?.summary ?? null,
              ],
              [
                "Wall time",
                formatDuration(summary.wallSeconds),
                summary.wallSeconds === null ? "not recorded" : null,
              ],
              [
                "Cost (estimate)",
                formatUsd(summary.costUsd),
                "Job budget cap " + formatUsd(summary.maxJobCostUsd),
              ],
              [
                "Segments",
                count(summary.segments),
                summary.failedWindows
                  ? `${summary.failedWindows} failed windows`
                  : summary.segments === null
                    ? "not accepted"
                    : null,
              ],
              [
                "Captions",
                count(summary.captions),
                summary.captionsFailed
                  ? `${summary.captionsFailed} failed`
                  : summary.captions === null
                    ? "not accepted"
                    : null,
              ],
            ] as const
          ).map(([label, value, note]) => (
            <Card key={label} className="px-5 py-4">
              <dt className="text-[13px] text-muted">{label}</dt>
              <dd className="m-0 mt-1 text-[26px] font-bold tracking-[-0.02em]">
                {value}
              </dd>
              {note ? (
                <dd className="m-0 mt-0.5 text-xs text-muted">{note}</dd>
              ) : null}
            </Card>
          ))}
        </dl>
      ) : null}

      <div
        className={
          run ? "grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_420px]" : ""
        }
      >
        <Card className="mb-5">
          <CardHeader className="flex items-center justify-between gap-3">
            <h2 className="m-0 text-base font-bold">
              Processing stages
              {run ? (
                <Link
                  className="ml-2 break-all text-brand underline underline-offset-2"
                  href={recipeHref(run.recipeId, run.jobId)}
                >
                  {run.recipeId}
                </Link>
              ) : null}
            </h2>
            <StatusBadge status={detail.status} />
          </CardHeader>
          <CardBody className="grid gap-4">
            {run ? (
              <RecipeStageList stages={stages} recipe={run} />
            ) : (
              <StageList stages={detail.stages} />
            )}
            <p className="m-0 text-xs text-muted">
              {run
                ? "One row per recipe stage from the recorded stage runs. A stage that was never started shows not run with its reason. Failed windows and captions are recorded as failed, never as empty results. Costs are estimates. Processing completion is separate from human review."
                : "Stages are shown only from recorded evidence; a stage with no recorded evidence stays unknown. Processing completion is separate from human review."}
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
              {detail.reviewable || detail.failedStages.length > 0 ? (
                <Button asChild>
                  <Link href={"/review/" + detail.id}>Open review</Link>
                </Button>
              ) : null}
              {actions.reviewClipsHref ? (
                <Button asChild>
                  <Link href={actions.reviewClipsHref}>Review clips</Link>
                </Button>
              ) : null}
              {actions.control.length === 0 ? (
                <p className="m-0 text-xs text-muted">
                  No job action is available for this attempt right now.
                </p>
              ) : null}
            </div>
            {actions.control.length > 0 ? (
              <JobControls
                key={detail.jobId}
                controls={actions.control}
                instruction={guidance}
              />
            ) : null}
          </CardBody>
        </Card>
        {run ? (
          <Card className="mb-5 min-w-0">
            <DagRunPanel
              json={dagRunJson(run)}
              filename={dagRunFilename(run)}
            />
          </Card>
        ) : null}
      </div>

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
