import Link from "next/link";
import {
  PIPELINE_STATUSES,
  PIPELINE_STATUS_LABEL,
  RECIPE_STAGE_LABEL,
  parsePipelineQuery,
  pipelineQueryString,
  pipelineReads,
  type PipelineListItem,
} from "@stateaction/server/pipeline";
import {
  ProcessingStatus,
  processingReason,
} from "../../../components/recordings/processing-stage";
import { RetryAction } from "../../../components/recordings/retry-actions";
import { exactRangeLabel } from "../../../components/recordings/recording-preview";
import { Button } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";
import { requireConsoleSession } from "../../../lib/server-session";

export const metadata = { title: "Recordings · StateAction.ai" };
export const dynamic = "force-dynamic";

const input =
  "min-h-10 w-full rounded-lg border border-line bg-white px-3 py-2 text-sm";

function RowReason({ item }: { item: PipelineListItem }) {
  const failure = item.error;
  const message =
    processingReason(failure?.code) ??
    failure?.summary ??
    item.note ??
    (item.status === "needs_setup"
      ? "This capture needs a supported source and recipe."
      : item.status === "choose_recipe"
        ? "Processing is paused until a recipe is selected."
        : null);
  if (!message) return null;
  const stage =
    failure?.stage === "clip_plan"
      ? "Clip planning"
      : failure?.stage
        ? RECIPE_STAGE_LABEL[failure.stage]
        : null;
  return (
    <p className="text-sm text-muted">
      {stage && <strong>{stage} · </strong>}
      {message}
    </p>
  );
}

export default async function RecordingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const staff = await requireConsoleSession(["staff"]);
  const params = await searchParams;
  const sort =
    params.sort === "oldest" || params.sort === "name" ? params.sort : "newest";
  const query = { ...parsePipelineQuery(params), sort } as const;
  const reads = pipelineReads();
  const { items, hasNext } = await reads.list(staff.userId, query);

  function href(page: number) {
    const next = new URLSearchParams(pipelineQueryString({ ...query, page }));
    if (sort !== "newest") next.set("sort", sort);
    return next.size ? `/recordings?${next}` : "/recordings";
  }

  return (
    <div className="grid gap-4">
      <header>
        <h1 className="text-3xl font-bold tracking-tight">Recordings</h1>
        <p className="mt-1 text-sm text-muted">
          Find recordings and check their processing progress.
        </p>
      </header>
      <Card as="div" className="p-4">
        <form
          action="/recordings"
          className="grid grid-cols-2 items-end gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto]"
        >
          <label className="col-span-2 grid gap-1 text-sm font-semibold md:col-span-1">
            Search recordings
            <input
              name="q"
              type="search"
              defaultValue={query.q}
              placeholder="Name, source, device or ID"
              maxLength={80}
              className={input}
            />
          </label>
          <label className="grid gap-1 text-sm font-semibold">
            Status
            <select
              name="status"
              defaultValue={query.status ?? ""}
              className={input}
            >
              <option value="">All statuses</option>
              {PIPELINE_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {PIPELINE_STATUS_LABEL[status]}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm font-semibold">
            Sort
            <select name="sort" defaultValue={sort} className={input}>
              <option value="newest">Newest added</option>
              <option value="oldest">Oldest added</option>
              <option value="name">Name A–Z</option>
            </select>
          </label>
          <Button type="submit">Search</Button>
        </form>
      </Card>

      <Card aria-labelledby="recordings-list-heading">
        <h2
          id="recordings-list-heading"
          className="border-b border-line px-4 py-3 text-lg font-bold"
        >
          All recordings
        </h2>
        {items.length ? (
          <ul className="divide-y divide-line">
            {items.map((item) => {
              const target = item.retryTarget;
              const ranges =
                target?.kind === "failed_clips"
                  ? Object.fromEntries(
                      target.clips.map((clip) => [
                        clip.clipId,
                        exactRangeLabel(clip.startSeconds, clip.endSeconds),
                      ]),
                    )
                  : undefined;
              return (
                <li key={item.id} className="grid gap-2 px-4 py-3">
                  <div className="grid items-center gap-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto] sm:gap-4">
                    <div className="min-w-0">
                      <Link
                        href={`/recordings/${item.id}`}
                        title={item.title}
                        className="line-clamp-2 w-fit font-semibold text-brand-ink underline decoration-brand/40 underline-offset-2 hover:decoration-brand wrap-anywhere"
                      >
                        {item.title}
                      </Link>
                      <p className="mt-1 text-xs text-muted wrap-anywhere">
                        {[item.device, item.captureSourceId, item.source]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                      <code title={item.id} className="text-xs text-muted">
                        {item.id.slice(0, 8)}
                      </code>
                    </div>
                    {item.clipProgress?.total ? (
                      <div className="grid gap-1 text-xs text-muted">
                        <span>
                          {item.clipProgress.completed} of{" "}
                          {item.clipProgress.total} clips processed
                        </span>
                        <progress
                          aria-label="Clips processed"
                          value={item.clipProgress.completed}
                          max={item.clipProgress.total}
                          className="h-2 w-full accent-brand"
                        />
                      </div>
                    ) : item.uploadPercent !== null ? (
                      <span className="text-xs text-muted">
                        {item.uploadPercent}% uploaded
                      </span>
                    ) : (
                      <span />
                    )}
                    <ProcessingStatus state={item.status} />
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <RowReason item={item} />
                    {target?.kind === "clip_plan" && (
                      <RetryAction
                        key={target.jobId}
                        recordingId={item.id}
                        label="Retry clip planning"
                        action={{
                          planning: {
                            jobId: target.jobId,
                            expectedState: target.expectedState,
                          },
                        }}
                        disabledReason={
                          target.available
                            ? null
                            : (target.reason ??
                              "Clip planning cannot be retried.")
                        }
                      />
                    )}
                    {target?.kind === "failed_clips" &&
                      target.clips.some(({ graph }) => graph) && (
                        <RetryAction
                          key={target.clips.map(({ jobId }) => jobId).join(",")}
                          recordingId={item.id}
                          label="Retry failed clips"
                          action={{ graph: { scope: "failed_clips" } }}
                          ranges={ranges}
                          disabledReason={
                            reads.selectionEnabled()
                              ? null
                              : "This environment is read-only."
                          }
                        />
                      )}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="p-4 text-sm text-muted">
            {query.q || query.status
              ? "No recordings match your search."
              : "No recordings to show."}
          </p>
        )}
      </Card>

      {(query.page > 1 || hasNext) && (
        <nav
          className="flex items-center gap-3 text-sm"
          aria-label="Recording pages"
        >
          {query.page > 1 && (
            <Button asChild variant="outline">
              <Link href={href(query.page - 1)}>Previous</Link>
            </Button>
          )}
          <span className="text-muted">Page {query.page}</span>
          {hasNext && (
            <Button asChild variant="outline">
              <Link href={href(query.page + 1)}>Next</Link>
            </Button>
          )}
        </nav>
      )}
    </div>
  );
}
