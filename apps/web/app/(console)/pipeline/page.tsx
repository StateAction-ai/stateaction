import Link from "next/link";
import { recipeHref } from "../../../lib/recipe-view";
import { Search } from "lucide-react";
import {
  PIPELINE_STATUSES,
  PIPELINE_STATUS_LABEL,
  PIPELINE_MAX_SEARCH,
  parsePipelineQuery,
  pipelineQueryString,
  pipelineReads,
  shortRecordingId,
  type PipelineList,
} from "@stateaction/server/pipeline";
import { requireConsoleSession } from "../../../lib/server-session";
import { Card, CardBody, CardHeader } from "../../../components/ui/card";
import { Button } from "../../../components/ui/button";
import { StatusBadge } from "../../../components/pipeline/status-badge";

export const metadata = { title: "Pipeline · StateAction.ai" };
export const dynamic = "force-dynamic";

const reads = pipelineReads();

export default async function PipelinePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireConsoleSession(["staff"]);
  const query = parsePipelineQuery(await searchParams);
  let list: PipelineList | null = null;
  try {
    list = await reads.list(session.userId, query);
  } catch (error) {
    console.error(
      "[pipeline] list unavailable:",
      error instanceof Error ? error.message : error,
    );
  }
  const backQuery = pipelineQueryString(query);
  const pageHref = (page: number) => {
    const qs = pipelineQueryString({ ...query, page });
    return qs ? `/pipeline?${qs}` : "/pipeline";
  };
  return (
    <>
      <p className="m-0 text-[10px] font-bold tracking-[0.14em] text-muted uppercase">
        Upload and processing
      </p>
      <h1 className="m-0 mt-1 text-[32px] font-bold tracking-[-0.03em]">
        Pipeline
      </h1>
      <p className="mt-2 mb-6 text-muted">
        Track recording uploads, processing progress and failures.
      </p>

      {list ? (
        <dl className="m-0 mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {(
            [
              ["Queued", list.counts.queued],
              [
                "Uploading or processing",
                list.counts.uploading + list.counts.processing,
              ],
              [
                "Failed or needs attention",
                list.counts.needs_attention + list.counts.failed,
              ],
              ["Completed", list.counts.completed],
            ] as const
          ).map(([label, value]) => (
            <Card key={label} className="px-5 py-4">
              <dt className="text-[13px] text-muted">{label}</dt>
              <dd className="m-0 mt-1 text-[28px] font-bold tracking-[-0.02em]">
                {value}
              </dd>
            </Card>
          ))}
        </dl>
      ) : null}

      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="m-0 text-base font-bold">Recording activity</h2>
          <span className="text-xs text-muted">
            Open a recording for details and actions
          </span>
        </CardHeader>
        <form
          method="get"
          action="/pipeline"
          role="search"
          className="flex flex-wrap gap-3 border-b border-line px-5 py-4 sm:px-6"
        >
          <label className="relative min-w-[200px] flex-1">
            <span className="sr-only">Search recordings</span>
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-3.5 left-3 h-4 w-4 text-muted"
            />
            <input
              type="search"
              name="q"
              defaultValue={query.q}
              maxLength={PIPELINE_MAX_SEARCH}
              placeholder="Search by recording ID, date or collector"
              className="block min-h-11 w-full rounded-lg border border-line bg-white py-2 pr-3 pl-9 text-sm text-ink"
            />
          </label>
          <label>
            <span className="sr-only">Status</span>
            <select
              name="status"
              defaultValue={query.status ?? ""}
              className="block min-h-11 rounded-lg border border-line bg-white px-3 py-2 text-sm text-ink"
            >
              <option value="">All statuses</option>
              {PIPELINE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {PIPELINE_STATUS_LABEL[s]}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" variant="outline" className="min-h-11">
            Apply
          </Button>
          {query.q || query.status ? (
            <Button asChild variant="ghost" className="min-h-11">
              <Link href="/pipeline">Reset</Link>
            </Button>
          ) : null}
        </form>

        {!list ? (
          <CardBody role="alert" className="text-sm text-danger">
            Pipeline data is temporarily unavailable. Try again in a moment.
          </CardBody>
        ) : list.items.length === 0 ? (
          <CardBody className="text-sm text-muted">
            {query.q || query.status
              ? "No recordings match these filters."
              : "No recordings have been uploaded yet."}
          </CardBody>
        ) : (
          <table className="w-full border-collapse text-left text-[13px] max-md:block">
            <caption className="sr-only">Recordings and their status</caption>
            <thead className="max-md:sr-only">
              <tr className="bg-field text-[11px] tracking-[0.08em] text-muted uppercase">
                <th scope="col" className="px-6 py-3 font-semibold">
                  Recording
                </th>
                <th scope="col" className="px-3 py-3 font-semibold">
                  Collector
                </th>
                <th scope="col" className="px-3 py-3 font-semibold">
                  Source
                </th>
                <th scope="col" className="px-6 py-3 font-semibold">
                  Status
                </th>
                <th scope="col" className="px-3 py-3 font-semibold">
                  Segments
                </th>
                <th scope="col" className="px-3 py-3 font-semibold">
                  Captions
                </th>
                <th scope="col" className="px-3 py-3 font-semibold">
                  Team checks
                </th>
                <th scope="col" className="px-6 py-3 font-semibold">
                  Review state
                </th>
              </tr>
            </thead>
            <tbody className="max-md:block">
              {list.items.map((item) => (
                <tr
                  key={item.id}
                  className="relative border-t border-line align-top hover:bg-field max-md:block max-md:px-5 max-md:py-4"
                >
                  <td className="px-6 py-4 max-md:block max-md:p-0">
                    <Link
                      href={`/pipeline/${item.id}${backQuery ? `?${backQuery}` : ""}`}
                      className="font-semibold text-ink after:absolute after:inset-0 after:content-['']"
                    >
                      {item.title}
                      <span className="block font-mono text-xs font-normal text-muted">
                        {shortRecordingId(item.id)}
                      </span>
                    </Link>
                    {item.recipe ? (
                      <Link
                        href={recipeHref(item.recipe.id, item.recipe.jobId)}
                        aria-label={`Recipe ${item.recipe.id} for ${item.title}`}
                        className="relative z-10 mt-1 block w-fit break-all text-xs text-brand underline underline-offset-2"
                      >
                        {item.recipe.id}
                      </Link>
                    ) : (
                      <p className="m-0 mt-1 text-xs text-muted">
                        Recipe not recorded
                      </p>
                    )}
                  </td>
                  <td
                    data-label="Collector"
                    className="px-3 py-4 max-md:mt-1 max-md:block max-md:p-0 max-md:before:mr-2 max-md:before:text-muted max-md:before:content-[attr(data-label)]"
                  >
                    {item.collector}
                  </td>
                  <td
                    data-label="Source"
                    className="px-3 py-4 text-muted max-md:block max-md:p-0 max-md:before:mr-2 max-md:before:content-[attr(data-label)]"
                  >
                    {item.source ?? "Unknown"}
                    {item.sourceKind === "imported" ? (
                      <span className="ml-1 text-xs text-muted">Imported</span>
                    ) : null}
                  </td>
                  <td className="px-6 py-4 max-md:mt-2 max-md:block max-md:p-0">
                    <StatusBadge status={item.status} />
                    {item.note ? (
                      <p className="m-0 mt-1 text-xs break-words text-muted">
                        {item.note}
                      </p>
                    ) : null}
                    {item.uploadPercent !== null ? (
                      <div
                        role="progressbar"
                        aria-label="Confirmed upload"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={item.uploadPercent}
                        className="mt-1.5 h-1.5 w-32 max-w-full overflow-hidden rounded bg-[#e6eae4]"
                      >
                        <div
                          className="h-full bg-brand"
                          style={{ width: `${item.uploadPercent}%` }}
                        />
                      </div>
                    ) : null}
                  </td>
                  <td
                    data-label="Segments"
                    data-testid="count-segments"
                    className="px-3 py-4 font-mono max-md:inline-block max-md:p-0 max-md:pr-4 max-md:before:mr-2 max-md:before:font-sans max-md:before:text-muted max-md:before:content-[attr(data-label)]"
                  >
                    {item.counts.segments === null ? (
                      "—"
                    ) : (
                      <>
                        {item.counts.segments}
                        {item.counts.failedWindows ? (
                          <span className="block font-sans text-xs text-danger max-md:inline">
                            {" "}
                            {item.counts.failedWindows} failed windows
                          </span>
                        ) : null}
                      </>
                    )}
                  </td>
                  <td
                    data-label="Captions"
                    data-testid="count-captions"
                    className="px-3 py-4 font-mono max-md:inline-block max-md:p-0 max-md:pr-4 max-md:before:mr-2 max-md:before:font-sans max-md:before:text-muted max-md:before:content-[attr(data-label)]"
                  >
                    {item.counts.captions === null ? (
                      "—"
                    ) : (
                      <>
                        {item.counts.captions} ok
                        {item.counts.captionsFailed ? (
                          <span className="block font-sans text-xs text-danger max-md:inline">
                            {" "}
                            {item.counts.captionsFailed} failed
                          </span>
                        ) : null}
                      </>
                    )}
                  </td>
                  <td
                    data-label="Team checks"
                    data-testid="count-checks"
                    className="px-3 py-4 font-mono max-md:inline-block max-md:p-0 max-md:pr-4 max-md:before:mr-2 max-md:before:font-sans max-md:before:text-muted max-md:before:content-[attr(data-label)]"
                  >
                    {item.counts.teamChecks === 0
                      ? "—"
                      : item.counts.teamChecks}
                    <span className="block font-sans text-[11px] text-muted max-md:inline">
                      {" "}
                      {item.counts.teamChecks === 0
                        ? "none recorded yet"
                        : `checked${item.counts.teamIssues ? `, ${item.counts.teamIssues} issue` : ""}`}
                    </span>
                  </td>
                  <td className="relative z-10 px-6 py-4 max-md:mt-2 max-md:block max-md:p-0">
                    {item.reviewable || item.failedStages.length > 0 ? (
                      <Link
                        href={"/review/" + item.id}
                        aria-label={
                          "Open review for recording " +
                          shortRecordingId(item.id)
                        }
                        className="font-medium text-brand underline"
                      >
                        Open review
                      </Link>
                    ) : (
                      <span className="text-muted">
                        Review data unavailable
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {list && (query.page > 1 || list.hasNext) ? (
          <nav
            aria-label="Pagination"
            className="flex justify-between border-t border-line px-5 py-3 text-sm sm:px-6"
          >
            {query.page > 1 ? (
              <Link href={pageHref(query.page - 1)} className="text-brand">
                ← Newer
              </Link>
            ) : (
              <span />
            )}
            {list.hasNext ? (
              <Link href={pageHref(query.page + 1)} className="text-brand">
                Older →
              </Link>
            ) : null}
          </nav>
        ) : null}
        <p className="m-0 border-t border-line px-5 py-3 text-xs text-muted sm:px-6">
          Processing completion is separate from human review.
        </p>
      </Card>
    </>
  );
}
