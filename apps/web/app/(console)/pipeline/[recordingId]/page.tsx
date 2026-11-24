import Link from "next/link";
import { notFound } from "next/navigation";
import {
  parsePipelineQuery,
  parseRecordingId,
  pipelineQueryString,
  pipelineReads,
  CACHED_IMPORT_EVIDENCE_ID,
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
import { RERUN_STAGE_LABEL, rerunReason } from "../../../../lib/stage-rerun";
import { SelectResult } from "../../../../components/pipeline/select-result";
import { Card, CardBody, CardHeader } from "../../../../components/ui/card";
import { Button } from "../../../../components/ui/button";
import { StatusBadge } from "../../../../components/pipeline/status-badge";
import { StageList } from "../../../../components/pipeline/stage-list";
import { JobControls } from "../../../../components/pipeline/job-controls";
import { RecipeStageList } from "../../../../components/pipeline/recipe-stage-list";
import { ImportedStages } from "../../../../components/pipeline/imported-stages";
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
  const query = await searchParams;
  const viewedRun =
    typeof query.run === "string" ? parseRecordingId(query.run) : null;
  if (query.run && !viewedRun) notFound();
  const backQuery = pipelineQueryString(parsePipelineQuery(query));
  const back = backQuery ? `/pipeline?${backQuery}` : "/pipeline";

  let detail: PipelineDetail | null;
  try {
    detail = await reads.detail(
      session.userId,
      recordingId,
      viewedRun ?? undefined,
    );
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
  const [actions, history, rerunBlock] = await Promise.all([
    reads.actions(detail),
    reads.history(session.userId, recordingId),
    detail.hasRecipe || detail.cachedImport
      ? reads
          .rerunBlock(session.userId, detail)
          .catch(() => "rerun_unavailable")
      : Promise.resolve(null),
  ]);
  const disabledReason = rerunBlock
    ? rerunReason(
        detail.cachedImport && rerunBlock === "recording_not_processable"
          ? "import_source_unavailable"
          : rerunBlock,
      )
    : undefined;
  const canSelect = reads.selectionEnabled();
  let run: Awaited<ReturnType<typeof reads.recipeRun>> = null;
  try {
    run = await reads.recipeRun(detail);
  } catch (error) {
    console.error(
      "[pipeline] recipe run unavailable:",
      error instanceof Error ? error.message : error,
    );
  }
  const diagnostics =
    run || detail.cachedImport
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
  const reused = (run?.reuse ?? [])
    .filter(({ state }) => state === "succeeded")
    .map(({ stage }) => RERUN_STAGE_LABEL[stage]);
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

      <Link
        href={`/recordings/${detail.id}`}
        className="mb-5 inline-flex min-h-9 items-center font-semibold text-brand-ink underline"
      >
        Original video and clips
      </Link>

      {run?.derivedFromJobId ? (
        <p
          className="mb-5 rounded-lg border border-[#d8e4fa] bg-brand-soft px-4 py-2 text-sm text-brand-ink"
          data-testid="rerun-lineage"
        >
          <strong>Derived from</strong>{" "}
          <Link
            className="text-brand underline"
            href={`/pipeline/${recordingId}?run=${run.derivedFromJobId}`}
          >
            run {run.derivedFromJobId.slice(0, 8)}
          </Link>
          {reused.length ? ` · Reused ${reused.join(", ")}` : null}
        </p>
      ) : null}

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
            <Card key={label} as="div" className="px-5 py-4">
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

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(300px,0.62fr)]">
        <Card className="min-w-0">
          <CardHeader className="flex items-center justify-between gap-3">
            <h2 className="m-0 text-base font-bold">
              {detail.cachedImport
                ? "Imported from cached results"
                : "Processing stages"}
              {detail.cachedImport && detail.jobId ? (
                <Link
                  className="ml-2 text-brand underline"
                  href={recipeHref(CACHED_IMPORT_EVIDENCE_ID, detail.jobId)}
                >
                  View import evidence
                </Link>
              ) : run ? (
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
          <CardBody className="grid grid-cols-1 gap-4">
            {detail.cachedImport ? (
              <ImportedStages
                cached={detail.cachedImport}
                recordingId={recordingId}
                jobId={detail.jobId}
                disabledReason={disabledReason}
              />
            ) : run ? (
              <RecipeStageList
                stages={stages}
                recipe={run}
                recordingId={recordingId}
                jobId={run.jobId}
                rerunDisabledReason={disabledReason}
                handPoseRerunOnly={reads.handPoseRerunOnly()}
                reuse={run.reuse}
              />
            ) : (
              <StageList stages={detail.stages} />
            )}
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
              {detail.reviewable ||
              history.runs.some((entry) => entry.selected) ? (
                <Button asChild>
                  <Link href={"/review/" + detail.id}>Open review</Link>
                </Button>
              ) : null}
              {actions.reviewClipsHref ? (
                <Button asChild>
                  <Link href={actions.reviewClipsHref}>Review clips</Link>
                </Button>
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
        <aside className="grid min-w-0 gap-5">
          {history.runs.length > 0 ? (
            <Card>
              <section aria-labelledby="pipeline-run-history">
                <CardHeader className="flex items-center justify-between gap-3">
                  <h2
                    id="pipeline-run-history"
                    className="m-0 text-base font-bold"
                  >
                    Run history
                  </h2>
                  <span className="text-xs text-muted">This recording</span>
                </CardHeader>
                <CardBody>
                  <ul className="m-0 list-none divide-y divide-line p-0 text-sm">
                    {history.runs.map((item) => (
                      <li
                        key={item.jobId}
                        className="grid gap-1.5 py-3 first:pt-0 last:pb-0"
                        data-run-id={item.jobId}
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <Link
                            className="font-medium text-brand underline underline-offset-2"
                            href={`/pipeline/${recordingId}?run=${item.jobId}`}
                            aria-current={
                              item.jobId === detail.jobId ? "page" : undefined
                            }
                          >
                            Run {item.jobId.slice(0, 8)}
                          </Link>
                          <span className="rounded-full bg-field px-2 py-0.5 text-xs font-medium text-muted">
                            {item.state.replaceAll("_", " ")}
                          </span>
                          {item.selected ? (
                            <strong className="rounded-full bg-[#e9f6ef] px-2 py-0.5 text-xs text-good">
                              Selected
                            </strong>
                          ) : null}
                        </div>
                        {item.parentId ? (
                          <p className="m-0 text-xs text-muted">
                            Derived from {item.parentId.slice(0, 8)}
                          </p>
                        ) : null}
                        {!item.selected &&
                        item.state === "succeeded" &&
                        canSelect ? (
                          <SelectResult
                            recordingId={recordingId}
                            jobId={item.jobId}
                            sequence={history.selectionSeq}
                            inPipeline
                          />
                        ) : null}
                      </li>
                    ))}
                  </ul>
                  {!history.runs.some((entry) => entry.selected) ? (
                    <p className="m-0 mt-3 text-xs text-muted">
                      No accepted result is selected.
                    </p>
                  ) : null}
                  {!canSelect ? (
                    <p className="m-0 mt-3 text-xs text-muted">
                      Result selection is disabled in the read-only preview.
                    </p>
                  ) : null}
                </CardBody>
              </section>
            </Card>
          ) : null}
          {run ? (
            <Card className="min-w-0">
              <DagRunPanel
                json={dagRunJson(run)}
                filename={dagRunFilename(run)}
              />
            </Card>
          ) : null}
        </aside>
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
                ["Duration", formatDuration(detail.source.duration)],
                ["Source size", detail.source.size ?? "Unknown"],
                ["Format", detail.source.format ?? "Unknown"],
                ["Source hash", detail.source.hash ?? "Not recorded"],
              ] as const
            ).map(([label, value]) => (
              <div
                key={label}
                className="flex min-w-0 flex-col gap-1 border-b border-line pb-2 sm:flex-row sm:justify-between sm:gap-4"
              >
                <dt className="text-muted">{label}</dt>
                <dd className="m-0 min-w-0 font-medium wrap-anywhere sm:text-right">
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
