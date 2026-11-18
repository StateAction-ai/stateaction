import type { ConsoleRole } from "./console-session";

export type BrowserQuery = {
  mode: "datasets" | "clips";
  datasetId?: string;
  recordingId?: string;
  q?: string;
  label?: string;
  reviewStatus?: "pending" | "approved" | "rejected";
  cursor?: string;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FIELDS = new Set([
  "view",
  "datasetId",
  "recordingId",
  "q",
  "label",
  "reviewStatus",
  "cursor",
]);

/** A malformed or inaccessible context never broadens into an unfiltered catalog. */
export function parseBrowserQuery(
  params: URLSearchParams,
  role: ConsoleRole,
): BrowserQuery {
  const values: Record<string, string> = {};
  for (const [key, value] of params) {
    if (!FIELDS.has(key) || key in values)
      throw new Error("Unsupported filter");
    values[key] = value;
  }
  for (const field of ["datasetId", "recordingId"] as const) {
    if (values[field] !== undefined && !UUID.test(values[field]))
      throw new Error("Invalid context");
  }
  if (values.view !== undefined && values.view !== "clips")
    throw new Error("Invalid view");
  if (values.datasetId && (values.recordingId || values.view))
    throw new Error("Incompatible context");
  const mode =
    values.datasetId || values.recordingId || values.view === "clips"
      ? "clips"
      : "datasets";
  if (role === "customer" && mode === "clips" && !values.datasetId)
    throw new Error("Unavailable view");
  if (
    values.reviewStatus !== undefined &&
    (!["pending", "approved", "rejected"].includes(values.reviewStatus) ||
      role !== "staff" ||
      mode !== "clips" ||
      values.datasetId)
  )
    throw new Error("Invalid review filter");
  if (values.label !== undefined && mode !== "clips")
    throw new Error("Invalid task filter");
  for (const field of ["q", "label"] as const) {
    if (
      values[field] !== undefined &&
      (values[field].length > 160 ||
        /[\u0000-\u001f\u007f]/.test(values[field]))
    )
      throw new Error("Invalid search");
  }
  if (
    values.cursor !== undefined &&
    (!values.cursor || values.cursor.length > 300)
  )
    throw new Error("Invalid page");
  return {
    mode,
    ...(values.datasetId ? { datasetId: values.datasetId } : {}),
    ...(values.recordingId ? { recordingId: values.recordingId } : {}),
    ...(values.q?.trim() ? { q: values.q.trim() } : {}),
    ...(values.label?.trim() ? { label: values.label.trim() } : {}),
    ...(values.reviewStatus
      ? {
          reviewStatus: values.reviewStatus as NonNullable<
            BrowserQuery["reviewStatus"]
          >,
        }
      : {}),
    ...(values.cursor ? { cursor: values.cursor } : {}),
  };
}

export function browserHref(query: BrowserQuery): string {
  const params = new URLSearchParams();
  if (query.mode === "clips" && !query.datasetId && !query.recordingId)
    params.set("view", "clips");
  for (const key of [
    "datasetId",
    "recordingId",
    "q",
    "label",
    "reviewStatus",
    "cursor",
  ] as const) {
    if (query[key]) params.set(key, query[key]);
  }
  return `/data-browser${params.size ? `?${params}` : ""}`;
}

export function browserApiPath(query: BrowserQuery): string {
  const base =
    query.mode === "datasets"
      ? "/api/v1/datasets"
      : query.datasetId
        ? `/api/v1/datasets/${query.datasetId}/clips`
        : "/api/v1/clips";
  const params = new URLSearchParams({ limit: "24" });
  for (const key of [
    "recordingId",
    "q",
    "label",
    "reviewStatus",
    "cursor",
  ] as const) {
    if (query[key]) params.set(key, query[key]);
  }
  return `${base}?${params}`;
}
