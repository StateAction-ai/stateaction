import {
  browserDurationBounds,
  type BrowserProblem,
  type BrowserQuery,
  type BrowserSort,
} from "./data-browser-query";

const sorts = {
  match: "best_match",
  newest: "capture_newest",
  oldest: "capture_oldest",
  added: "recently_added",
} as const satisfies Record<BrowserSort, string>;

const problems = {
  window: "failed_window",
  caption: "caption_failed",
  hand: "no_hand",
} as const satisfies Record<BrowserProblem, string>;

export function reviewBrowseOptions(query: BrowserQuery, staff: boolean) {
  const datasetId = query.datasetId ?? "all-clips";
  const bounds = browserDurationBounds(query);
  const labels = query.task ?? (query.label ? [query.label] : undefined);
  const recordingIds = query.recordingId
    ? [query.recordingId]
    : query.recording;
  const selectedSort =
    query.sort ??
    (staff && query.q && datasetId !== "recycle-bin"
      ? "match"
      : datasetId === "pending-review"
        ? "oldest"
        : "newest");
  return {
    selectedSort,
    filters: {
      datasetId,
      sort: sorts[selectedSort],
      ...(query.q ? { q: query.q } : {}),
      ...(labels ? { labels } : {}),
      ...(recordingIds ? { recordingIds } : {}),
      ...(bounds.min !== undefined ? { minDurationNs: bounds.min } : {}),
      ...(bounds.max !== undefined ? { maxDurationNs: bounds.max } : {}),
      ...(query.problem
        ? { problems: query.problem.map((key) => problems[key]) }
        : {}),
    },
  };
}
