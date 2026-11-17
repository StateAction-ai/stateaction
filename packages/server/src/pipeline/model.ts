/**
 * Pure, dependency-free Pipeline model (SA-34): route-safe query parsing,
 * display classification inputs, stage derivation and the action seam. Nothing
 * here touches the database or the network, so the rules are unit-testable.
 *
 * Unknown stays unknown: the catalog stores no worker heartbeat, so stages are
 * derived only from recording/job/file/admission rows that actually exist.
 */

export const PIPELINE_STATUSES = [
  "uploading",
  "queued",
  "processing",
  "needs_attention",
  "failed",
  "cancelled",
  "completed",
] as const;
export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];

export const PIPELINE_STATUS_LABEL: Record<PipelineStatus, string> = {
  uploading: "Uploading",
  queued: "Queued",
  processing: "Processing",
  needs_attention: "Needs attention",
  failed: "Failed",
  cancelled: "Cancelled",
  completed: "Completed",
};

export const PIPELINE_PAGE_SIZE = 25;
export const PIPELINE_MAX_PAGE = 200;
export const PIPELINE_MAX_SEARCH = 80;

export type PipelineQuery = {
  q: string;
  status: PipelineStatus | null;
  page: number;
};
export type SearchParamsLike = Record<string, string | string[] | undefined>;

const first = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : value;

/**
 * Parses untrusted URL parameters into a bounded query. Unknown statuses and
 * out-of-range pages fall back to the defaults instead of failing the page.
 */
export function parsePipelineQuery(params: SearchParamsLike): PipelineQuery {
  const q = (first(params.q) ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, PIPELINE_MAX_SEARCH)
    .trim();
  const rawStatus = first(params.status);
  const status = (PIPELINE_STATUSES as readonly string[]).includes(
    rawStatus ?? "",
  )
    ? (rawStatus as PipelineStatus)
    : null;
  const rawPage = first(params.page);
  const page =
    rawPage !== undefined && /^[0-9]{1,4}$/.test(rawPage)
      ? Math.min(Math.max(Number(rawPage), 1), PIPELINE_MAX_PAGE)
      : 1;
  return { q, status, page };
}

/** Canonical query string (defaults omitted) used by list links and Back. */
export function pipelineQueryString(query: PipelineQuery): string {
  const out = new URLSearchParams();
  if (query.q) out.set("q", query.q);
  if (query.status) out.set("status", query.status);
  if (query.page > 1) out.set("page", String(query.page));
  return out.toString();
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Route-safe recording id: a canonical lowercase UUID or null. */
export function parseRecordingId(value: string | undefined): string | null {
  return value && UUID.test(value) ? value.toLowerCase() : null;
}

/** Link that reviews every generated clip; never sets a review status. */
export function reviewClipsHref(recordingId: string): string {
  return `/data-browser?recordingId=${encodeURIComponent(recordingId)}`;
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
/** `1 Nov 2026, 14:03 UTC`; the same text the search matches against. */
export function formatStart(date: Date): string {
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${p2(date.getUTCHours())}:${p2(date.getUTCMinutes())} UTC`;
}
export function recordingTitle(startedAt: Date): string {
  return `Recording ${formatStart(startedAt)}`;
}

export function formatBytes(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return null;
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${unit === 0 || value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** Curated wording for recognized failures. Callers supply a generic fallback. */
export function pipelineErrorSummary(code: string | null): string | null {
  switch (code) {
    case "source_checksum_mismatch":
      return "Source checksum mismatch";
    case "never_submitted":
      return "Processing could not start";
    case "manifest_too_large":
      return "The source manifest exceeds the size limit";
    case "source_not_closed":
      return "The capture was not finalized";
    case "profile_mismatch":
      return "The source declaration differs from the registered capture profile";
    case "clock_mismatch":
      return "The source declares inconsistent clocks";
    default:
      return null;
  }
}

export type JobState =
  | "queued"
  | "submitting"
  | "submit_unknown"
  | "running"
  | "result_pending"
  | "succeeded"
  | "failed"
  | "cancel_requested"
  | "cancelled"
  | "needs_attention";

export type StageState =
  | "done"
  | "active"
  | "failed"
  | "cancelled"
  | "unknown"
  | "not_started"
  | "blocked";
export const STAGE_STATE_LABEL: Record<StageState, string> = {
  done: "Done",
  active: "In progress",
  failed: "Failed",
  cancelled: "Cancelled",
  unknown: "Unknown",
  not_started: "Not started",
  blocked: "Blocked",
};
export type Stage = {
  key: "upload" | "queued" | "processing" | "quality" | "ready";
  label: string;
  state: StageState;
  /** Evidence-backed text only. */
  detail: string | null;
};

export type StageEvidence = {
  sealed: boolean;
  recordingStatus: string;
  admissionRejected: boolean;
  jobState: JobState | null;
  /** The job row shows it was handed to the executor. */
  jobSubmitted: boolean;
  uploadedBytes: number | null;
  totalBytes: number | null;
  clipCount: number | null;
};

/** The five conceptual stages; not workflow tasks (docs/components/pipeline-monitoring.md). */
export function deriveStages(e: StageEvidence): Stage[] {
  const job = e.jobState;
  const terminalUpstream =
    e.admissionRejected ||
    (!e.sealed &&
      (e.recordingStatus === "failed" || e.recordingStatus === "cancelled"));
  const blockedState: StageState = terminalUpstream ? "blocked" : "not_started";

  // Upload
  let upload: Stage["state"];
  let uploadDetail: string | null = null;
  if (e.sealed) {
    upload = "done";
    uploadDetail = "Source inventory sealed";
  } else if (e.recordingStatus === "cancelled") upload = "cancelled";
  else if (e.recordingStatus === "failed") upload = "failed";
  else {
    upload = "active";
    if (e.uploadedBytes !== null && e.totalBytes)
      uploadDetail = `${formatBytes(e.uploadedBytes)} of ${formatBytes(e.totalBytes)} confirmed`;
    else uploadDetail = "Upload progress not reported";
  }

  // Queued
  let queued: StageState;
  let queuedDetail: string | null = null;
  if (!e.sealed) queued = blockedState;
  else if (e.admissionRejected) {
    queued = "failed";
    queuedDetail = "Source was not admitted for processing";
  } else if (!job) {
    queued = "active";
    queuedDetail = "Waiting for a processing job";
  } else if (job === "queued" || job === "submitting") {
    queued = "active";
    queuedDetail = "Waiting for a processing slot";
  } else if (job === "submit_unknown" || job === "needs_attention") {
    queued = "unknown";
    queuedDetail = "Submission was not confirmed";
  } else if (job === "failed") queued = e.jobSubmitted ? "done" : "unknown";
  else if (job === "cancelled") queued = e.jobSubmitted ? "done" : "cancelled";
  else queued = "done";

  // Processing
  let processing: StageState;
  let processingDetail: string | null = null;
  if (!e.sealed || !job || job === "queued" || job === "submitting")
    processing = blockedState;
  else if (job === "submit_unknown" || job === "needs_attention")
    processing = "unknown";
  else if (job === "running" || job === "result_pending") processing = "active";
  else if (job === "cancel_requested") {
    processing = "active";
    processingDetail = "Cancellation requested";
  } else if (job === "succeeded") processing = "done";
  else if (job === "failed") {
    processing = "failed";
    processingDetail = "Execution ended in failure; the stage is not recorded";
  } else processing = "cancelled";

  // Quality checks: no worker-reported phase is stored, so only an accepted
  // result proves it; anything else is unknown, never assumed passed.
  let quality: StageState;
  let qualityDetail: string | null = null;
  if (job === "succeeded") quality = "done";
  else if (job === "failed") {
    quality = "unknown";
    qualityDetail = "No quality result was recorded";
  } else if (job === "cancelled" || job === "cancel_requested")
    quality = job === "cancelled" ? "blocked" : "unknown";
  else if (
    job === "running" ||
    job === "result_pending" ||
    job === "submit_unknown" ||
    job === "needs_attention"
  ) {
    quality = "unknown";
    qualityDetail = "No worker-reported phase yet";
  } else quality = blockedState;

  // Ready for review
  let ready: StageState;
  let readyDetail: string | null = null;
  if (job === "succeeded") {
    ready = "done";
    readyDetail =
      e.clipCount === null
        ? null
        : e.clipCount === 0
          ? "No clips were generated"
          : `${e.clipCount} ${e.clipCount === 1 ? "clip" : "clips"}`;
  } else if (job === "failed" || job === "cancelled" || terminalUpstream)
    ready = "blocked";
  else ready = "not_started";

  return [
    { key: "upload", label: "Upload", state: upload, detail: uploadDetail },
    { key: "queued", label: "Queued", state: queued, detail: queuedDetail },
    {
      key: "processing",
      label: "Processing",
      state: processing,
      detail: processingDetail,
    },
    {
      key: "quality",
      label: "Quality checks",
      state: quality,
      detail: qualityDetail,
    },
    {
      key: "ready",
      label: "Ready for review",
      state: ready,
      detail: readyDetail,
    },
  ];
}

/**
 * Lifecycle capability seam. Jobs API (SA-27/SA-28) is not implemented, so the
 * only provider shipped reports no capabilities and the UI renders no
 * Cancel/Retry/Reconcile/re-upload control. A real provider must answer for the
 * exact current job and expected state and be re-read on every request.
 */
export type JobControlKind =
  | "cancel"
  | "check_cancellation"
  | "retry"
  | "reupload_guidance"
  | "reconcile";
export type JobControlAction = {
  kind: JobControlKind;
  jobId: string;
  expectedState: JobState;
};
export type JobControlCapabilities = {
  forJob(input: {
    recordingId: string;
    jobId: string;
    state: JobState;
  }): Promise<readonly JobControlAction[]>;
};
export const noJobControl: JobControlCapabilities = {
  async forJob() {
    return [];
  },
};

export type PipelineActions = {
  reviewClipsHref: string | null;
  control: readonly JobControlAction[];
};
