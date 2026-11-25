import Link from "next/link";
import { LayoutGrid, List } from "lucide-react";
import {
  browserHref,
  browserPageSizes,
  browserProblems,
  durationPresets,
  isBuiltInDataset,
  type BrowserQuery,
  type BrowserSort,
} from "../../lib/data-browser-query";
import { formatMediaDuration } from "../../lib/media-duration";
import { fmtPrecise } from "../../lib/review/timeline";
import { Button } from "../ui/button";
import {
  CatalogFilters,
  CatalogSelect,
  DatasetEditor,
  PrivateBrowser,
  SearchForm,
  type Facet,
} from "./controls";
import { CaptionDownload } from "./caption-download";
import { ClipThumbnail } from "./thumbnail";

type ShareState = "shared" | "private" | "blocked";
type Dataset = {
  datasetId: string;
  name: string;
  clipCount: number;
  shareState?: ShareState;
};
const problemValues = {
  failed_window: "window",
  caption_failed: "caption",
  no_hand: "hand",
} as const;
type Problem = keyof typeof problemValues;
type Clip = {
  clipId: string;
  title: string | null;
  ordinal: number;
  taskLabel: string | null;
  capturedAt: string | null;
  sortDate: string;
  durationNs: string | null;
  hasPoster: boolean;
  hasVideo?: boolean;
  captionMatch: {
    segmentId: string;
    offsetNs?: string | null;
    highlights: { text: string; highlighted: boolean }[];
    alsoMatchesOriginal?: true;
  } | null;
  staff?: {
    reviewStatus?: "pending" | "approved" | "rejected" | undefined;
    proposedLabel?: string | null | undefined;
    correctedCount?: number | undefined;
    problems?: Problem[] | undefined;
    rejection?:
      | { reason: string | null; reviewerUserId: string; rejectedAt: string }
      | undefined;
  };
};
type ClipPage = {
  page: number;
  limit: number;
  totalCount: number;
  filteredCount: number;
  lastUpdatedAt: string | null;
  labels: Facet[];
  items: Clip[];
};

const count = (value: number) => value.toLocaleString("en-US");
const date = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
});
const shareLabels = {
  shared: "Shared · all clips approved",
  private: "Private",
  blocked:
    "Every clip needs approval on its current result before this dataset can be shared.",
};
const heading = "m-0 break-words text-[32px] font-bold tracking-[-0.03em]";
const panel = "rounded-lg border border-line bg-white";
const textLink = "font-semibold text-brand hover:underline";

function DatasetGroup({
  title,
  datasets,
  staff,
}: {
  title: string;
  datasets: Dataset[];
  staff: boolean;
}) {
  if (!datasets.length) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold">{title}</h2>
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {datasets.map(({ datasetId, name, clipCount, shareState }) => (
          <li key={datasetId} className="min-w-0">
            <Link
              href={browserHref({ mode: "clips", datasetId })}
              prefetch={false}
              className={`${panel} grid min-h-20 content-center gap-1.5 break-words px-3.5 py-3 hover:border-brand`}
            >
              <strong>{name}</strong>
              <span className="text-sm text-muted">
                {staff && isBuiltInDataset(datasetId)
                  ? "Built in · "
                  : staff && shareState
                    ? `${shareState === "blocked" ? "Sharing blocked" : shareLabels[shareState]} · `
                    : ""}
                {count(clipCount)} {clipCount === 1 ? "clip" : "clips"}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function DatasetIndex({
  datasets,
  query,
  staff,
}: {
  datasets: Dataset[];
  query: BrowserQuery;
  staff: boolean;
}) {
  const builtIn = datasets.filter(({ datasetId }) =>
    isBuiltInDataset(datasetId),
  );
  const userDatasets = datasets.filter(
    ({ datasetId }) => !isBuiltInDataset(datasetId),
  );
  return (
    <PrivateBrowser>
      <section className="space-y-4" aria-labelledby="browser-heading">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 id="browser-heading" className={heading}>
              Data browser
            </h1>
            <p className="text-sm text-muted">
              {staff
                ? "Open a dataset to browse or review its clips."
                : "Open a shared dataset to browse its clips."}
            </p>
          </div>
          {staff ? <DatasetEditor /> : null}
        </header>
        <SearchForm key={query.q ?? ""} query={query}>
          {staff ? (
            <Link
              href="/data-browser?view=clips"
              prefetch={false}
              className={`${textLink} inline-flex min-h-10 items-center px-2 text-sm underline`}
            >
              All clips
            </Link>
          ) : null}
        </SearchForm>
        {staff ? (
          <DatasetGroup title="Review queues" datasets={builtIn} staff />
        ) : null}
        <DatasetGroup
          title={staff ? "Your datasets" : "Shared datasets"}
          datasets={userDatasets}
          staff={staff}
        />
        {!datasets.length ? (
          <p className={`${panel} p-4 text-sm text-muted`}>
            {query.q
              ? "No datasets match this search."
              : "No datasets are available."}
          </p>
        ) : null}
      </section>
    </PrivateBrowser>
  );
}

function clipHref(clip: Clip, query: BrowserQuery, match = false) {
  const params = new URLSearchParams({ returnTo: browserHref(query) });
  if (query.datasetId) params.set("datasetId", query.datasetId);
  if (match && clip.captionMatch) {
    const { offsetNs, segmentId } = clip.captionMatch;
    params.set("segment", segmentId);
    if (offsetNs != null) params.set("at", String(Number(offsetNs) / 1e9));
  }
  return `/clips/${clip.clipId}?${params}`;
}

function ClipCard({
  clip,
  query,
  mediaOrigin,
  sort,
}: {
  clip: Clip;
  query: BrowserQuery;
  mediaOrigin: string | null;
  sort: BrowserSort;
}) {
  const list = query.layout === "list";
  const duration =
    clip.durationNs === null ? null : formatMediaDuration(clip.durationNs);
  const title = `${clip.title ? clip.title + " · " : ""}Clip ${clip.ordinal + 1}`;
  const staff = clip.staff;
  const label = clip.taskLabel ?? staff?.proposedLabel;
  const match = clip.captionMatch;
  const matchTime =
    match?.offsetNs == null
      ? "Caption match"
      : fmtPrecise(Number(match.offsetNs) / 1e9);
  const href = clipHref(clip, query);
  return (
    <article
      className={`${panel} min-w-0 overflow-hidden ${list ? "grid grid-cols-[112px_minmax(0,1fr)] items-start gap-2 p-2 sm:grid-cols-[128px_minmax(0,1fr)]" : ""}`}
    >
      <Link href={href} prefetch={false} tabIndex={-1} aria-hidden="true">
        <ClipThumbnail
          clipId={clip.clipId}
          {...(query.datasetId ? { datasetId: query.datasetId } : {})}
          available={clip.hasPoster}
          mediaOrigin={mediaOrigin}
          duration={duration}
          compact={list}
        />
      </Link>
      <div
        className={`grid min-w-0 gap-1.5 break-words ${list ? "py-0.5 pr-1" : "p-3"}`}
      >
        <h2 className="text-sm font-semibold">
          <Link
            href={href}
            prefetch={false}
            className="hover:underline"
            title={title}
          >
            {title}
            {label ? ` · ${label}` : ""}
          </Link>
          {duration ? (
            <span className="sr-only">, duration {duration}</span>
          ) : null}
        </h2>
        {staff && label && !clip.taskLabel ? (
          <span className="text-xs text-muted">Suggested label</span>
        ) : null}
        <p className="text-xs text-muted">
          {query.datasetId === "recycle-bin"
            ? "Rejected"
            : sort === "added" || !clip.capturedAt
              ? "Added"
              : "Captured"}{" "}
          <time dateTime={clip.sortDate}>
            {date.format(new Date(clip.sortDate))}
          </time>
        </p>
        {staff ? (
          <>
            <div className="flex flex-wrap gap-1">
              {staff.reviewStatus === "pending" ? (
                <Badge>Not reviewed</Badge>
              ) : null}
              {staff.reviewStatus === "rejected" ? (
                <Badge>Rejected</Badge>
              ) : null}
              {staff.reviewStatus === "approved" ? (
                <Badge>Approved</Badge>
              ) : null}
              {staff.problems?.map((problem) => (
                <Badge key={problem}>
                  {browserProblems[problemValues[problem]]}
                </Badge>
              ))}
              {staff.correctedCount ? (
                <Badge>
                  {count(staff.correctedCount)} caption{" "}
                  {staff.correctedCount === 1 ? "edit" : "edits"}
                </Badge>
              ) : null}
            </div>
            {staff.rejection ? (
              <p className="text-xs text-muted">
                {staff.rejection.reason ? (
                  <>{staff.rejection.reason} · </>
                ) : null}
                Reviewer {staff.rejection.reviewerUserId}
              </p>
            ) : null}
          </>
        ) : null}
        {match ? (
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-md bg-field px-2 py-1.5 text-xs">
            <Link
              href={clipHref(clip, query, true)}
              prefetch={false}
              className={`${textLink} underline`}
            >
              {matchTime}
            </Link>
            {match.highlights.length ? (
              <p>
                {match.highlights.map((part, index) =>
                  part.highlighted ? (
                    <mark key={index} className="bg-[#fff0a6] px-px text-ink">
                      {part.text}
                    </mark>
                  ) : (
                    part.text
                  ),
                )}
              </p>
            ) : null}
            {staff && match.alsoMatchesOriginal ? (
              <span className="text-muted">Also matches original</span>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function Badge({ children }: { children: string[] | string }) {
  return (
    <span className="rounded border border-line bg-field px-1.5 py-0.5 text-[11px] font-medium">
      {children}
    </span>
  );
}

function Pagination({
  query,
  page,
  limit,
  filteredCount,
}: { query: BrowserQuery } & Pick<
  ClipPage,
  "page" | "limit" | "filteredCount"
>) {
  const last = Math.max(1, Math.ceil(filteredCount / limit));
  const pages = [...new Set([1, page - 1, page, page + 1, last])]
    .filter((number) => number >= 1 && number <= last)
    .sort((a, b) => a - b);
  const pageLink = (number: number, label: string) => (
    <Link
      href={browserHref({ ...query, page: number })}
      prefetch={false}
      aria-current={page === number ? "page" : undefined}
      className={`${panel} inline-flex min-h-9 min-w-9 items-center justify-center px-2 text-sm aria-[current=page]:border-brand aria-[current=page]:bg-brand-soft`}
    >
      {label}
    </Link>
  );
  return (
    <nav
      aria-label="Results pages"
      className="flex flex-wrap items-center gap-2"
    >
      {page > 1 && page <= last ? pageLink(page - 1, "Previous") : null}
      {pages.map((number, index) => (
        <span key={number} className="inline-flex items-center gap-2">
          {number - (pages[index - 1] ?? 0) > 1 ? (
            <span aria-hidden="true">…</span>
          ) : null}
          {pageLink(number, String(number))}
        </span>
      ))}
      {page < last ? pageLink(page + 1, "Next") : null}
      <CatalogSelect
        label="Per page"
        value={String(limit)}
        options={browserPageSizes.map((size) => ({
          value: String(size),
          label: String(size),
          href: browserHref({ ...query, page: undefined, size }),
        }))}
      />
    </nav>
  );
}

function FilterChips({
  query,
  labels,
  recordings,
}: {
  query: BrowserQuery;
  labels: Facet[];
  recordings?: Facet[] | undefined;
}) {
  const { label, ...queryWithoutLabel } = query;
  const tasks = query.task ?? (label ? [label] : []);
  const base = { ...queryWithoutLabel, page: undefined, task: tasks };
  const chips: { text: string; query: BrowserQuery }[] = [];
  if (query.q) {
    const next = { ...base };
    delete next.q;
    if (next.sort === "match") delete next.sort;
    chips.push({ text: `Search ${query.q}`, query: next });
  }
  for (const value of tasks)
    chips.push({
      text: labels.find((item) => item.value === value)?.label ?? value,
      query: { ...base, task: tasks.filter((item) => item !== value) },
    });
  for (const value of query.recording ?? [])
    chips.push({
      text: recordings?.find((item) => item.value === value)?.label ?? value,
      query: {
        ...base,
        recording: query.recording?.filter((item) => item !== value),
      },
    });
  for (const value of query.problem ?? [])
    chips.push({
      text: browserProblems[value],
      query: {
        ...base,
        problem: query.problem?.filter((item) => item !== value),
      },
    });
  if (query.duration)
    chips.push({
      text: durationPresets[query.duration].label,
      query: { ...base, duration: undefined },
    });
  if (query.minDuration)
    chips.push({
      text: `Min ${query.minDuration} s`,
      query: { ...base, minDuration: undefined },
    });
  if (query.maxDuration)
    chips.push({
      text: `Max ${query.maxDuration} s`,
      query: { ...base, maxDuration: undefined },
    });
  if (!chips.length) return null;
  const clear: BrowserQuery = {
    mode: "clips",
    ...(query.datasetId ? { datasetId: query.datasetId } : {}),
    ...(query.recordingId ? { recordingId: query.recordingId } : {}),
    ...(query.sort !== "match" ? { sort: query.sort } : {}),
    layout: query.layout,
    size: query.size,
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chips.map((chip) => (
        <Link
          key={browserHref(chip.query)}
          href={browserHref(chip.query)}
          prefetch={false}
          aria-label={`Remove ${chip.text}`}
          className="max-w-full break-words rounded-md bg-brand-soft px-2 py-1.5 text-xs text-ink hover:underline"
        >
          {chip.text} ×
        </Link>
      ))}
      <Link
        href={browserHref(clear)}
        prefetch={false}
        className={`${textLink} px-1 text-xs underline`}
      >
        Clear all
      </Link>
    </div>
  );
}

export function ClipBrowser({
  name,
  query,
  selectedSort,
  mediaOrigin,
  page,
  staff,
}: {
  name: string;
  query: BrowserQuery;
  selectedSort: BrowserSort;
  mediaOrigin: string | null;
  page: ClipPage;
  staff?: { recordings: Facet[]; problems: Facet[]; shareState?: ShareState };
}) {
  const pending = query.datasetId === "pending-review";
  const recycle = query.datasetId === "recycle-bin";
  const editableDatasetId =
    staff && query.datasetId && !isBuiltInDataset(query.datasetId)
      ? query.datasetId
      : undefined;
  const sortLabels: Record<BrowserSort, string> = {
    match: "Best match",
    newest: staff ? "Newest capture first" : "Newest",
    oldest: staff ? "Oldest capture first" : "Oldest",
    added: "Recently added",
  };
  const sorts: BrowserSort[] = [
    ...(staff && query.q ? ["match" as const] : []),
    "newest",
    "oldest",
    ...(staff ? ["added" as const] : []),
  ];
  const next = pending
    ? (page.items.find((clip) => clip.hasVideo) ?? page.items[0])
    : undefined;
  const list = query.layout === "list";
  const problemOptions = Object.entries(problemValues).map(([value, key]) => ({
    value: key,
    label: browserProblems[key],
    count: staff?.problems.find((facet) => facet.value === value)?.count ?? 0,
  }));

  return (
    <PrivateBrowser>
      <section className="space-y-3" aria-labelledby="browser-heading">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            {staff ? (
              <Link
                href="/data-browser"
                className={`${textLink} mb-1 inline-block text-sm underline`}
              >
                ‹ Datasets
              </Link>
            ) : null}
            <h1 id="browser-heading" className={heading}>
              {name}
            </h1>
            {pending || recycle ? (
              <p className="text-sm text-muted">
                {pending
                  ? "Clips whose selected result needs a decision."
                  : "Rejected clips. Open a clip to restore it."}
              </p>
            ) : null}
            {query.recordingId ? (
              <Link
                href={`/recordings/${query.recordingId}`}
                className={`${textLink} text-sm underline`}
              >
                Open recording
              </Link>
            ) : null}
            {query.datasetId ? (
              <p className="mt-1 text-xs text-muted">
                Last updated{" "}
                {page.lastUpdatedAt ? (
                  <time dateTime={page.lastUpdatedAt}>
                    {date.format(new Date(page.lastUpdatedAt))}
                  </time>
                ) : (
                  "—"
                )}
              </p>
            ) : null}
          </div>
          {editableDatasetId ? (
            <DatasetEditor dataset={{ datasetId: editableDatasetId, name }} />
          ) : null}
        </header>
        {editableDatasetId && staff?.shareState ? (
          <div
            className={`${panel} flex flex-wrap justify-between gap-2 px-3.5 py-2.5 text-sm`}
          >
            <span>{shareLabels[staff.shareState]}</span>
            {staff.shareState === "shared" ? (
              <Link
                href={browserHref({
                  mode: "clips",
                  datasetId: editableDatasetId,
                })}
                prefetch={false}
                className={`${textLink} underline`}
              >
                Open customer link
              </Link>
            ) : null}
          </div>
        ) : null}
        <SearchForm query={query} />
        <div className="grid items-start gap-3 lg:grid-cols-[200px_minmax(0,1fr)]">
          <CatalogFilters
            query={query}
            {...(!pending ? { labels: page.labels } : {})}
            {...(staff
              ? {
                  staff: {
                    ...(!query.recordingId
                      ? { recordings: staff.recordings }
                      : {}),
                    problems: problemOptions,
                  },
                }
              : {})}
          />
          <div className="min-w-0 space-y-2.5">
            <FilterChips
              query={query}
              labels={page.labels}
              recordings={staff?.recordings}
            />
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-field p-2">
              {next ? (
                <Button asChild>
                  <Link href={clipHref(next, query)} prefetch={false}>
                    Review next
                  </Link>
                </Button>
              ) : null}
              <strong role="status" className="text-sm">
                {count(page.filteredCount)}
                {page.filteredCount !== page.totalCount
                  ? ` of ${count(page.totalCount)}`
                  : ""}{" "}
                {page.totalCount === 1 ? "clip" : "clips"}
              </strong>
              {recycle ? (
                <span className="text-xs text-muted">
                  Most recently rejected
                </span>
              ) : (
                <CatalogSelect
                  label="Sort"
                  value={selectedSort}
                  options={sorts.map((sort) => ({
                    value: sort,
                    label: sortLabels[sort],
                    href: browserHref({ ...query, sort, page: undefined }),
                  }))}
                />
              )}
              {query.datasetId && !isBuiltInDataset(query.datasetId) ? (
                <CaptionDownload
                  href={
                    "/api/v2/review-datasets/captions" +
                    browserHref({
                      ...query,
                      page: undefined,
                      size: undefined,
                      layout: undefined,
                    }).slice("/data-browser".length)
                  }
                />
              ) : null}
              <nav aria-label="Clip layout" className="ml-auto flex gap-1">
                {(["grid", "list"] as const).map((layout) => (
                  <Link
                    key={layout}
                    href={browserHref({ ...query, layout })}
                    prefetch={false}
                    aria-current={
                      (query.layout ?? "grid") === layout ? "page" : undefined
                    }
                    className={`${panel} inline-flex min-h-9 items-center gap-1 px-2 text-xs font-medium aria-[current=page]:border-brand aria-[current=page]:bg-brand-soft`}
                  >
                    {layout === "grid" ? (
                      <LayoutGrid size={13} aria-hidden="true" />
                    ) : (
                      <List size={13} aria-hidden="true" />
                    )}
                    {layout === "grid" ? "Grid" : "List"}
                  </Link>
                ))}
              </nav>
            </div>
            {page.items.length ? (
              <>
                {page.filteredCount > page.limit ? (
                  <p className="text-xs text-muted">
                    Showing {count((page.page - 1) * page.limit + 1)}–
                    {count((page.page - 1) * page.limit + page.items.length)}
                  </p>
                ) : null}
                <div className={`grid gap-3 ${list ? "" : "sm:grid-cols-2"}`}>
                  {page.items.map((clip) => (
                    <ClipCard
                      key={clip.clipId}
                      clip={clip}
                      query={query}
                      sort={selectedSort}
                      mediaOrigin={mediaOrigin}
                    />
                  ))}
                </div>
              </>
            ) : (
              <div className={`${panel} p-4 text-sm text-muted`}>
                <p>
                  {!page.totalCount
                    ? query.datasetId
                      ? "This dataset has no clips yet."
                      : "No clips are available."
                    : page.filteredCount
                      ? "This page has no clips."
                      : "No clips match. Try a broader search or clear the filters."}
                </p>
                {!page.totalCount && editableDatasetId ? (
                  <Link
                    href="/data-browser?datasetId=pending-review"
                    className={`${textLink} mt-2 inline-block underline`}
                  >
                    Find clips in Pending Review
                  </Link>
                ) : null}
              </div>
            )}
            <Pagination
              query={query}
              page={page.page}
              limit={page.limit}
              filteredCount={page.filteredCount}
            />
          </div>
        </div>
      </section>
    </PrivateBrowser>
  );
}
