import { CatalogError, mediaReadOrigin } from "@stateaction/server";
import { reviewDatasetReads } from "@stateaction/server/datasets";
import { pipelineReads } from "@stateaction/server/pipeline";
import { notFound } from "next/navigation";
import { requireConsoleSession } from "../../../lib/server-session";
import {
  browserHref,
  parseBrowserQuery,
} from "../../../lib/data-browser-query";
import { reviewBrowseOptions } from "../../../lib/review-browse-options";
import {
  ClipBrowser,
  DatasetIndex,
} from "../../../components/data-browser/data-browser";
import { BrowserLoadError } from "../../../components/data-browser/controls";

export const metadata = { title: "Data browser · StateAction.ai" };
export const dynamic = "force-dynamic";

export default async function DataBrowserPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireConsoleSession();
  const staff = session.role === "staff";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const item of typeof value === "string" ? [value] : (value ?? []))
      params.append(key, item);
  }
  let query;
  try {
    query = parseBrowserQuery(params, session.role);
  } catch {
    notFound();
  }
  if (query.cursor || query.reviewCursor || query.reviewStatus) notFound();

  const reads = reviewDatasetReads();
  const load = async <T,>(pending: Promise<T>): Promise<T | null> => {
    try {
      return await pending;
    } catch (error) {
      if (error instanceof CatalogError && error.code !== "conflict")
        notFound();
      console.error(
        "[data-browser] catalog unavailable",
        error instanceof Error ? error.name : "unknown",
      );
      return null;
    }
  };

  const { userId } = session;
  if (query.mode === "datasets") {
    const datasets = await load(reads.list(userId));
    if (!datasets) return <BrowserLoadError />;
    const search = query.q?.toLowerCase() ?? "";
    return (
      <DatasetIndex
        datasets={datasets
          .filter(({ name }) => name.toLowerCase().includes(search))
          .map(({ datasetId, name, clipCount, shareState }) => ({
            datasetId,
            name,
            clipCount,
            ...(staff && shareState ? { shareState } : {}),
          }))}
        query={query}
        staff={staff}
      />
    );
  }

  const { filters, selectedSort } = reviewBrowseOptions(query, staff);
  const { datasetId } = filters;
  const hasFilters = Boolean(
    filters.q ||
      filters.labels?.length ||
      filters.problems?.length ||
      filters.minDurationNs ||
      filters.maxDurationNs,
  );
  const result = await load(
    reads.clips(userId, {
      ...filters,
      limit: query.size ?? 12,
      page: query.page ?? 1,
    }),
  );
  if (!result) return <BrowserLoadError />;

  let name = "All clips";
  let totalCount = result.totalCount;
  if (query.datasetId) {
    const datasets = await load(reads.list(userId));
    if (!datasets) return <BrowserLoadError />;
    const dataset = datasets.find((row) => row.datasetId === query.datasetId);
    if (!dataset) notFound();
    name = dataset.name;
  } else if (query.recordingId) {
    const recording = await pipelineReads().recordingOperations(
      userId,
      query.recordingId,
    );
    if (!recording) notFound();
    name = recording.title;
    if (hasFilters) {
      const unfiltered = await load(
        reads.clips(userId, {
          datasetId,
          recordingIds: [query.recordingId],
          limit: 1,
        }),
      );
      if (!unfiltered) return <BrowserLoadError />;
      totalCount = unfiltered.filteredCount;
    } else {
      totalCount = result.filteredCount;
    }
  }

  let mediaOrigin: string | null = null;
  try {
    mediaOrigin = mediaReadOrigin();
  } catch {
    // The catalog remains usable when media is unavailable.
  }

  return (
    <ClipBrowser
      key={browserHref(query)}
      name={name}
      query={query}
      selectedSort={selectedSort}
      mediaOrigin={mediaOrigin}
      page={{
        page: result.page,
        limit: result.limit,
        totalCount,
        filteredCount: result.filteredCount,
        lastUpdatedAt: result.lastUpdatedAt,
        labels: result.facets.labels,
        items: result.items.map((item) => ({
          clipId: item.clipId,
          title: item.title,
          ordinal: item.ordinal,
          taskLabel: item.taskLabel,
          capturedAt: item.capturedAt,
          sortDate: item.sortDate,
          durationNs: item.durationNs,
          hasPoster: item.hasPoster,
          ...(staff ? { hasVideo: item.hasVideo } : {}),
          captionMatch:
            item.captionMatch &&
            (staff || !item.captionMatch.alsoMatchesOriginal)
              ? {
                  segmentId: item.captionMatch.segmentId,
                  offsetNs: item.captionMatch.offsetNs,
                  highlights:
                    "highlights" in item.captionMatch
                      ? item.captionMatch.highlights
                      : [],
                  ...(staff && item.captionMatch.alsoMatchesOriginal
                    ? { alsoMatchesOriginal: true }
                    : {}),
                }
              : null,
          ...(staff
            ? {
                staff: {
                  reviewStatus: item.reviewStatus,
                  proposedLabel: item.proposedLabel,
                  correctedCount: item.correctedCount,
                  problems: item.problems,
                  rejection: item.rejection,
                },
              }
            : {}),
        })),
      }}
      {...(staff
        ? {
            staff: {
              recordings: result.facets.recordings ?? [],
              problems: result.facets.problems ?? [],
              ...(result.shareState ? { shareState: result.shareState } : {}),
            },
          }
        : {})}
    />
  );
}
