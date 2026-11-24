import Link from "next/link";
import type { ReactNode } from "react";
import {
  REVIEW_QUEUE_STATES,
  reviewQueueHref,
  type ReviewQueueClip,
  type ReviewQueuePage,
  type ReviewQueueQuery,
} from "../../lib/review/queue";
import { fmtClock } from "../../lib/review/timeline";
import { Button } from "../ui/button";

const PIPELINE = {
  queued: ["Queued", "bg-field text-muted"],
  processing: ["Processing", "bg-brand-soft text-brand-ink"],
  succeeded: ["Succeeded", "bg-[#e9f6ef] text-good"],
  partially_failed: ["Needs attention", "bg-[#fff4de] text-[#8a5a00]"],
  needs_attention: ["Needs attention", "bg-[#fff4de] text-[#8a5a00]"],
  failed: ["Failed", "bg-danger-soft text-danger"],
  cancelled: ["Cancelled", "bg-field text-muted"],
} satisfies Record<ReviewQueueClip["pipeline"], [string, string]>;

const REVIEW = {
  pending: "bg-brand-soft text-brand-ink",
  approved: "bg-[#e9f6ef] text-good",
  rejected: "bg-danger-soft text-danger",
  "not-ready": "bg-field text-muted",
} satisfies Record<ReviewQueueClip["state"], string>;

const COLUMNS = ["Clip", "Duration", "Pipeline", "Failures", "Marks", "Review"];
const grid =
  "grid grid-cols-3 gap-3 lg:grid-cols-[minmax(0,3fr)_repeat(5,minmax(0,1fr))]";
const filterClass =
  "block min-h-11 w-full min-w-0 rounded-lg border border-line bg-paper px-3 text-sm text-ink";

export function ReviewQueue({
  page,
  query,
}: {
  page: ReviewQueuePage;
  query: ReviewQueueQuery;
}) {
  const { after: _after, ...filters } = query;
  return (
    <section aria-labelledby="review-queue-heading">
      <h1
        id="review-queue-heading"
        className="mb-4 text-[clamp(1.375rem,3vw,1.75rem)] leading-tight font-bold"
      >
        Review queue
      </h1>
      <div className="overflow-hidden rounded-xl border border-line bg-paper">
        <form
          aria-label="Filter the review queue"
          method="get"
          action="/review"
          className="grid grid-cols-2 items-end gap-2 border-b border-line px-4 py-3 lg:grid-cols-[auto_minmax(10rem,24rem)_auto_auto_minmax(0,1fr)]"
        >
          <label className="block min-w-0 text-xs font-semibold">
            <span className="mb-1 block">Review state</span>
            <select
              name="state"
              className={filterClass}
              defaultValue={query.state}
            >
              {Object.entries(REVIEW_QUEUE_STATES).map(([state, text]) => (
                <option key={state} value={state}>
                  {text}
                </option>
              ))}
            </select>
          </label>
          <QueueFilter
            label="Recording"
            name="recording"
            any="All recordings"
            selected={query.recordingId}
            options={page.recordings}
            searchName="recordingSearch"
            search={query.recordingSearch}
            truncated={page.recordingsTruncated}
          />
          <QueueFilter
            label="Collector"
            name="collector"
            any="All collectors"
            selected={query.collectorId}
            options={page.collectors}
            searchName="collectorSearch"
            search={query.collectorSearch}
            truncated={page.collectorsTruncated}
          />
          <Button type="submit" variant="outline" className="min-h-11">
            Apply filters
          </Button>
          <span className="col-span-full pb-1 text-right text-xs text-muted lg:col-span-1">
            {page.rows.length} {page.rows.length === 1 ? "clip" : "clips"}
          </span>
        </form>
        {page.rows.length ? (
          <div
            role="table"
            aria-label="Clips, oldest first"
            className="text-[13px]"
          >
            <div
              role="row"
              className={
                grid +
                " sr-only border-b border-line bg-field px-4 py-3 text-xs font-semibold text-muted lg:not-sr-only"
              }
            >
              {COLUMNS.map((column) => (
                <span key={column} role="columnheader">
                  {column}
                </span>
              ))}
            </div>
            {page.rows.map((clip) => (
              <ClipRow key={clip.id} clip={clip} />
            ))}
          </div>
        ) : (
          <p className="m-0 px-4 py-5 text-sm text-muted">
            No clips match these filters.
          </p>
        )}
        {query.after || page.next ? (
          <nav
            aria-label="Review queue pagination"
            className="flex justify-between gap-3 border-t border-line px-4 py-3 text-sm text-brand"
          >
            {query.after ? (
              <Link href={reviewQueueHref(filters)}>First page</Link>
            ) : (
              <span />
            )}
            {page.next ? (
              <Link href={reviewQueueHref({ ...query, after: page.next })}>
                Next page
              </Link>
            ) : null}
          </nav>
        ) : null}
      </div>
    </section>
  );
}

function QueueFilter({
  label,
  name,
  any,
  selected,
  options,
  searchName,
  search,
  truncated,
}: {
  label: string;
  name: string;
  any: string;
  selected: string | undefined;
  options: { id: string; label: string }[];
  searchName: string;
  search: string | undefined;
  truncated: boolean;
}) {
  return (
    <div className="min-w-0">
      {truncated || search ? (
        <label className="mb-2 block text-xs font-semibold">
          <span className="mb-1 block">
            Find {name === "recording" ? "recordings" : "collectors"}
          </span>
          <input
            type="search"
            name={searchName}
            defaultValue={search}
            maxLength={160}
            className={filterClass}
          />
        </label>
      ) : null}
      <label className="block min-w-0 text-xs font-semibold">
        <span className="mb-1 block">{label}</span>
        <select
          name={name}
          className={filterClass}
          defaultValue={selected ?? ""}
        >
          <option value="">{any}</option>
          {selected && !options.some(({ id }) => id === selected) ? (
            <option value={selected}>Unavailable {name}</option>
          ) : null}
          {options.map(({ id, label: optionLabel }) => (
            <option value={id} key={id}>
              {optionLabel}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function ClipRow({ clip }: { clip: ReviewQueueClip }) {
  const [pipelineText, pipelineTone] = PIPELINE[clip.pipeline];
  return (
    <div
      role="row"
      className={
        grid +
        " items-start border-b border-line px-4 py-4 last:border-b-0 lg:items-center"
      }
    >
      <div role="cell" className="col-span-3 min-w-0 lg:col-span-1">
        {clip.state === "not-ready" ? (
          <span className="font-semibold [overflow-wrap:anywhere]">
            {clip.title}
          </span>
        ) : (
          <Link
            href={"/review/clips/" + clip.id}
            className="font-semibold text-brand underline underline-offset-2 [overflow-wrap:anywhere]"
          >
            {clip.title}
            <span className="sr-only">, clip {clip.ordinal + 1}</span>
          </Link>
        )}
        <span className="mt-1 block text-xs text-muted">
          Clip {clip.ordinal + 1}
          {clip.sourceStartS !== null && clip.sourceEndS !== null
            ? " · Source " +
              fmtClock(clip.sourceStartS) +
              "–" +
              fmtClock(clip.sourceEndS)
            : null}
        </span>
      </div>
      <Cell label="Duration">
        {clip.durationS === null ? (
          <Unknown />
        ) : (
          <span className="font-mono">{fmtClock(clip.durationS)}</span>
        )}
      </Cell>
      <Cell label="Pipeline">
        <Badge tone={pipelineTone}>{pipelineText}</Badge>
      </Cell>
      <Cell label="Failures">
        {clip.failures ?? <Unknown />}
        {clip.failedStageCount ? (
          <span className="block text-xs text-danger">
            {clip.failedStageCount}{" "}
            {clip.failedStageCount === 1 ? "stage" : "stages"} with failures
          </span>
        ) : null}
      </Cell>
      <Cell label="Marks">
        {clip.segments === null ? (
          <Unknown />
        ) : (
          clip.markedSegments + " / " + clip.segments
        )}
      </Cell>
      <Cell label="Review">
        <Badge tone={REVIEW[clip.state]}>
          {REVIEW_QUEUE_STATES[clip.state]}
        </Badge>
      </Cell>
    </div>
  );
}

function Badge({ tone, children }: { tone: string; children: ReactNode }) {
  return (
    <span
      className={
        "inline-block rounded-md px-2 py-0.5 text-[11px] font-semibold " + tone
      }
    >
      {children}
    </span>
  );
}

function Cell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div role="cell" className="min-w-0">
      <span
        aria-hidden="true"
        className="mb-0.5 block text-[11px] text-muted lg:hidden"
      >
        {label}
      </span>
      {children}
    </div>
  );
}

function Unknown() {
  return (
    <span className="text-muted" aria-label="Not recorded">
      —
    </span>
  );
}
