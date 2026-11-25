import type { ConsoleRole } from "./console-session";

export type BrowserQuery = {
  mode: "datasets" | "clips";
  datasetId?: string;
  recordingId?: string;
  q?: string;
  label?: string;
  reviewStatus?: "pending" | "approved" | "rejected";
  cursor?: string;
  reviewCursor?: string;
  task?: string[] | undefined;
  recording?: string[] | undefined;
  problem?: BrowserProblem[] | undefined;
  duration?: DurationPreset | undefined;
  minDuration?: string | undefined;
  maxDuration?: string | undefined;
  sort?: BrowserSort | undefined;
  layout?: "grid" | "list" | undefined;
  page?: number | undefined;
  size?: number | undefined;
};
export const browserProblems = {
  window: "Failed action window",
  caption: "Caption failed",
  hand: "No hand detected",
} as const;
export type BrowserProblem = keyof typeof browserProblems;
export type BrowserSort = "match" | "newest" | "oldest" | "added";
export const durationPresets = {
  short: { label: "Under 5 s", max: "4999999999" },
  medium: { label: "5–30 s", min: "5000000000", max: "30000000000" },
  long: { label: "Over 30 s", min: "30000000001" },
} as const;
type DurationPreset = keyof typeof durationPresets;
export const browserPageSizes = [12, 24, 48, 96];
export const isBuiltInDataset = (id: string) =>
  id === "pending-review" || id === "recycle-bin";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FIELDS = new Set([
  "view",
  "datasetId",
  "recordingId",
  "q",
  "label",
  "reviewStatus",
  "cursor",
  "reviewCursor",
  "task",
  "recording",
  "problem",
  "duration",
  "minDuration",
  "maxDuration",
  "sort",
  "layout",
  "page",
  "size",
]);
const REPEATED = ["task", "recording", "problem"] as const;
const validText = (value: string, length: number) =>
  value.length <= length && !/[\u0000-\u001f\u007f]/.test(value);

function secondsToNs(value: string): string {
  if (!/^\d{1,10}(?:\.\d{1,3})?$/.test(value))
    throw new Error("Invalid duration");
  const [seconds = "0", fraction = ""] = value.split(".");
  const nanos = BigInt(seconds) * 1000000000n + BigInt(fraction.padEnd(9, "0"));
  if (nanos > 9223372036854775807n) throw new Error("Invalid duration");
  return nanos.toString();
}

export function browserDurationBounds(query: BrowserQuery): {
  min?: string;
  max?: string;
} {
  if (query.duration) return durationPresets[query.duration];
  return {
    ...(query.minDuration ? { min: secondsToNs(query.minDuration) } : {}),
    ...(query.maxDuration ? { max: secondsToNs(query.maxDuration) } : {}),
  };
}

/** A malformed or inaccessible context never broadens into an unfiltered catalog. */
export function parseBrowserQuery(
  params: URLSearchParams,
  role: ConsoleRole,
): BrowserQuery {
  const values: Record<string, string> = {};
  const repeated: Record<(typeof REPEATED)[number], string[]> = {
    task: [],
    recording: [],
    problem: [],
  };
  if (params.toString().length > 5900) throw new Error("Invalid search");
  for (const [key, value] of params) {
    if (key === "task" || key === "recording" || key === "problem") {
      const choices = repeated[key];
      if (choices.length >= 50 || !value.trim() || choices.includes(value))
        throw new Error("Invalid filter");
      choices.push(value);
      continue;
    }
    if (!FIELDS.has(key) || key in values)
      throw new Error("Unsupported filter");
    values[key] = value;
  }
  for (const field of ["datasetId", "recordingId"] as const) {
    const value = values[field];
    if (
      value !== undefined &&
      !UUID.test(value) &&
      !(field === "datasetId" && role === "staff" && isBuiltInDataset(value))
    )
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
  if (
    (repeated.task.length || values.label !== undefined) &&
    (values.datasetId === "pending-review" ||
      (repeated.task.length &&
        (mode !== "clips" || values.label !== undefined)))
  )
    throw new Error("Invalid task filter");
  if (
    repeated.task.some((task) => !validText(task, 200)) ||
    repeated.recording.some((id) => !UUID.test(id)) ||
    repeated.problem.some((key) => !Object.hasOwn(browserProblems, key))
  )
    throw new Error("Invalid filter");
  if (
    (repeated.recording.length ||
      repeated.problem.length ||
      values.duration !== undefined ||
      values.minDuration !== undefined ||
      values.maxDuration !== undefined) &&
    (role !== "staff" || mode !== "clips")
  )
    throw new Error("Unavailable filters");
  if (values.recordingId && repeated.recording.length)
    throw new Error("Incompatible recording filter");
  const { duration, minDuration, maxDuration, sort, layout } = values;
  if (
    duration !== undefined &&
    (!Object.hasOwn(durationPresets, duration) ||
      minDuration !== undefined ||
      maxDuration !== undefined)
  )
    throw new Error("Invalid duration");
  const min = minDuration === undefined ? null : secondsToNs(minDuration);
  const max = maxDuration === undefined ? null : secondsToNs(maxDuration);
  if (min !== null && max !== null && BigInt(min) > BigInt(max))
    throw new Error("Invalid duration");
  if (
    sort !== undefined &&
    (mode !== "clips" ||
      values.datasetId === "recycle-bin" ||
      !["newest", "oldest", "match", "added"].includes(sort) ||
      (sort === "match" && !values.q?.trim()) ||
      (role === "customer" && sort !== "newest" && sort !== "oldest"))
  )
    throw new Error("Invalid sort");
  if (
    layout !== undefined &&
    (mode !== "clips" || !["grid", "list"].includes(layout))
  )
    throw new Error("Invalid layout");
  const page = values.page === undefined ? undefined : Number(values.page);
  const size = values.size === undefined ? undefined : Number(values.size);
  if (
    (page !== undefined &&
      (!/^\d+$/.test(values.page!) ||
        !Number.isSafeInteger(page) ||
        page < 1 ||
        (page - 1) * (size ?? 12) > 2147483647)) ||
    (size !== undefined &&
      (!/^\d+$/.test(values.size!) || !browserPageSizes.includes(size))) ||
    ((page !== undefined || size !== undefined) &&
      (mode !== "clips" ||
        values.cursor !== undefined ||
        values.reviewCursor !== undefined))
  )
    throw new Error("Invalid page");
  for (const field of ["q", "label"] as const) {
    if (values[field] !== undefined && !validText(values[field], 160))
      throw new Error("Invalid search");
  }
  if (
    values.cursor !== undefined &&
    (!values.cursor || values.cursor.length > 300)
  )
    throw new Error("Invalid page");
  if (
    values.reviewCursor !== undefined &&
    (!values.datasetId ||
      role !== "staff" ||
      !values.reviewCursor ||
      values.reviewCursor.length > 300)
  )
    throw new Error("Invalid review clip page");
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
    ...(values.reviewCursor ? { reviewCursor: values.reviewCursor } : {}),
    ...(repeated.task.length ? { task: repeated.task } : {}),
    ...(repeated.recording.length ? { recording: repeated.recording } : {}),
    ...(repeated.problem.length
      ? { problem: repeated.problem as BrowserProblem[] }
      : {}),
    ...(duration ? { duration: duration as DurationPreset } : {}),
    ...(minDuration ? { minDuration } : {}),
    ...(maxDuration ? { maxDuration } : {}),
    ...(sort ? { sort: sort as BrowserSort } : {}),
    ...(layout ? { layout: layout as "grid" | "list" } : {}),
    ...(page ? { page } : {}),
    ...(size ? { size } : {}),
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
    "reviewCursor",
    "duration",
    "minDuration",
    "maxDuration",
    "sort",
    "layout",
    "page",
    "size",
  ] as const) {
    if (query[key]) params.set(key, String(query[key]));
  }
  for (const key of REPEATED)
    for (const value of query[key] ?? []) params.append(key, value);
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
