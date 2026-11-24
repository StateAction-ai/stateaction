export const REVIEW_QUEUE_STATES = {
  pending: "Pending review",
  all: "All clips",
  approved: "Approved",
  rejected: "Rejected",
  "not-ready": "Not ready",
} as const;

export type ReviewQueueState = keyof typeof REVIEW_QUEUE_STATES;

export type ReviewQueueQuery = {
  state: ReviewQueueState;
  recordingId?: string;
  collectorId?: string;
  recordingSearch?: string;
  collectorSearch?: string;
  after?: string;
};

export const REVIEW_QUEUE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseReviewQueueQuery(
  query: Record<string, string | string[] | undefined>,
): ReviewQueueQuery {
  const state =
    typeof query.state === "string" &&
    Object.hasOwn(REVIEW_QUEUE_STATES, query.state)
      ? (query.state as ReviewQueueState)
      : "pending";
  const recordingId =
    typeof query.recording === "string" &&
    REVIEW_QUEUE_UUID.test(query.recording)
      ? query.recording
      : undefined;
  // Accounts can have non-UUID IDs. Preserve their text for the parameterized query.
  const collectorId =
    typeof query.collector === "string" &&
    query.collector.length > 0 &&
    query.collector.length <= 128 &&
    !query.collector.includes("\0")
      ? query.collector
      : undefined;
  const after =
    typeof query.after === "string" &&
    query.after.length > 0 &&
    query.after.length <= 768 &&
    !query.after.includes("\0")
      ? query.after
      : undefined;
  const recordingSearch = optionSearch(query.recordingSearch);
  const collectorSearch = optionSearch(query.collectorSearch);
  return {
    state,
    ...(recordingId ? { recordingId } : {}),
    ...(collectorId ? { collectorId } : {}),
    ...(after ? { after } : {}),
    ...(recordingSearch ? { recordingSearch } : {}),
    ...(collectorSearch ? { collectorSearch } : {}),
  };
}

function optionSearch(value: string | string[] | undefined): string {
  return typeof value === "string" && !value.includes("\0")
    ? value.trim().slice(0, 160)
    : "";
}

export function reviewQueueHref(query: ReviewQueueQuery): string {
  const params = new URLSearchParams();
  if (query.state !== "pending") params.set("state", query.state);
  if (query.recordingId) params.set("recording", query.recordingId);
  if (query.collectorId) params.set("collector", query.collectorId);
  if (query.after) params.set("after", query.after);
  if (query.recordingSearch)
    params.set("recordingSearch", query.recordingSearch);
  if (query.collectorSearch)
    params.set("collectorSearch", query.collectorSearch);
  return params.size ? "/review?" + params : "/review";
}

export type ReviewQueueClip = {
  id: string;
  title: string;
  ordinal: number;
  sourceStartS: number | null;
  sourceEndS: number | null;
  durationS: number | null;
  pipeline:
    | "queued"
    | "processing"
    | "succeeded"
    | "partially_failed"
    | "needs_attention"
    | "failed"
    | "cancelled";
  failures: number | null;
  failedStageCount: number;
  markedSegments: number;
  segments: number | null;
  state: Exclude<ReviewQueueState, "all">;
};

export type ReviewQueuePage = {
  rows: ReviewQueueClip[];
  recordings: { id: string; label: string }[];
  collectors: { id: string; label: string }[];
  next: string | null;
  recordingsTruncated: boolean;
  collectorsTruncated: boolean;
};
