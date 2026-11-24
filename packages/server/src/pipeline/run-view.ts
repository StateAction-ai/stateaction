/**
 * Pure display model for the recipe run (SA-97). It turns one rendered
 * `http.dag-run.v1` document plus accepted annotation counts into rows and
 * summary cards. Nothing here reads the database; nothing is invented:
 * a missing duration, cost, rate or count is `null` and rendered as unknown,
 * and failed counts stay separate from the totals they are not part of.
 */
import type { DagRunNode, DagRunV1 } from "@stateaction/contracts";
import { RECIPE_STAGE_LABEL, stageHasFailedOutputs } from "./model.js";
import type { GpuRateType } from "../ops/cost.js";

/** Accelerator memory by type: hardware facts for display, never prices. */
export const GPU_VRAM_GB: Record<GpuRateType, number> = {
  T4: 16,
  L4: 24,
  A10G: 24,
  L40S: 48,
  "A100-40GB": 40,
  "A100-80GB": 80,
  "RTX-PRO-6000": 96,
  H100: 80,
  H200: 141,
  B200: 180,
};

export type RunStageState = DagRunNode["state"] | "needs_attention";

export const RUN_STATE_LABEL: Record<RunStageState, string> = {
  pending: "Pending",
  submitting: "Starting",
  submit_unknown: "Start unconfirmed",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
  not_run: "Not run",
  needs_attention: "Needs attention",
};

export const STAGE_TITLE = RECIPE_STAGE_LABEL;

const STAGE_REASON: Readonly<Record<string, string>> = {
  stage_disabled: "Disabled in this recipe",
  not_spawned: "The job ended before this stage started",
  upstream_failed: "A stage it depends on failed.",
  no_segments: "There were no segments to caption.",
  terminated_before_start: "The worker stopped before starting this stage.",
  stage_timeout: "The stage exceeded its time limit.",
  budget_exceeded: "The stage exceeded its time limit.",
  receipt_missing: "The worker did not return a stage receipt.",
  receipt_rejected: "The server could not verify the stage receipt.",
  receipt_invalid:
    "The worker returned a stage receipt that could not be verified.",
  worker_failed: "The worker ended with an error.",
};

export function stageReason(code: string | null): string | null {
  return code && Object.hasOwn(STAGE_REASON, code) ? STAGE_REASON[code]! : null;
}

export type GpuView = {
  kind: "gpu";
  requestedType: string;
  observedType: string | null;
  vramGb: number | null;
  /** From the operator rate card only; null = unknown. */
  usdPerHour: number | null;
};

export type CountView = {
  key: string;
  label: string;
  value: number;
  failed: boolean;
};
export type DiagnosticLink = { name: string; href: string };

export type RunStageView = {
  stage: DagRunNode["stage"];
  title: string;
  /** `name@version`, as recorded. */
  module: string;
  moduleName: string;
  state: DagRunNode["state"];
  displayState: RunStageState;
  stateLabel: string;
  enabled: boolean;
  errorCode: string | null;
  /** Human reason for not_run and failed nodes. */
  reason: string | null;
  durationSeconds: number | null;
  costUsd: string | null;
  gpu: GpuView | null;
  counts: CountView[];
  receiptSha256: string | null;
  /** Staff-presigned diagnostic_blob links; empty until SA-96 wires them. */
  diagnostics: DiagnosticLink[];
};

export type RunSummary = {
  jobState: string;
  wallSeconds: number | null;
  costUsd: string | null;
  maxJobCostUsd: string;
  segments: number | null;
  failedWindows: number | null;
  captions: number | null;
  captionsFailed: number | null;
};

/** Accepted counts; captions are null when not accepted (never a zero). */
export type AnnotationCounts = {
  segments: number;
  failedWindows: number | null;
  captions: number | null;
  captionsFailed: number | null;
} | null;

const COUNT_LABEL: Record<string, string> = {
  segments: "segments",
  failed_windows: "failed windows",
  captions_complete: "captions ok",
  captions_failed: "captions failed",
  failed_captions: "captions failed",
  clips: "clips",
};
const labelOf = (key: string) => COUNT_LABEL[key] ?? key.replace(/_/g, " ");

export function parseModule(ref: string): { name: string; version: string } {
  const at = ref.lastIndexOf("@");
  return at < 0
    ? { name: ref, version: "" }
    : { name: ref.slice(0, at), version: ref.slice(at + 1) };
}

export function nodeDurationSeconds(node: DagRunNode): number | null {
  if (!node.startedAt || !node.finishedAt) return null;
  const ms = Date.parse(node.finishedAt) - Date.parse(node.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms / 1000 : null;
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function formatUsd(amount: string | null): string {
  return amount === null ? "Not recorded" : `$${amount}`;
}

export function formatRate(usdPerHour: number | null): string {
  return usdPerHour === null ? "Rate unknown" : `$${usdPerHour.toFixed(2)}/h`;
}

/**
 * Operator rate (per GPU-second, from the rate card) for one accelerator,
 * converted to dollars per hour for display; null when the card has no rate.
 */
export function gpuUsdPerHour(
  gpuType: string,
  rates: Partial<Record<string, { amount: number }>> | undefined,
): number | null {
  const r = rates?.[`gpu_second:${gpuType}`];
  return r ? r.amount * 3600 : null;
}

export function buildRunStages(
  run: DagRunV1,
  rates?: Partial<Record<string, { amount: number }>>,
  diagnostics: Partial<Record<DagRunNode["stage"], DiagnosticLink[]>> = {},
  accepted: AnnotationCounts = null,
): RunStageView[] {
  return run.stages.map((node) => {
    const gpuType = node.gpu.requestedType;
    const gpu: GpuView | null =
      gpuType === "none"
        ? null
        : {
            kind: "gpu",
            requestedType: gpuType,
            observedType: node.gpu.observedType,
            vramGb: GPU_VRAM_GB[gpuType as GpuRateType] ?? null,
            usdPerHour: gpuUsdPerHour(gpuType, rates),
          };
    const counts = Object.entries(node.counts).map(([key, value]) => ({
      key,
      label: labelOf(key),
      value,
      failed: key.includes("failed"),
    }));
    const acceptedFailure =
      node.stage === "segment"
        ? accepted?.failedWindows
        : node.stage === "caption"
          ? accepted?.captionsFailed
          : null;
    const displayState =
      node.state === "succeeded" &&
      (stageHasFailedOutputs(node.stage, node.counts) ||
        (acceptedFailure ?? 0) > 0)
        ? "needs_attention"
        : node.state;
    return {
      stage: node.stage,
      title: STAGE_TITLE[node.stage],
      module: node.module,
      moduleName: parseModule(node.module).name,
      state: node.state,
      displayState,
      stateLabel: RUN_STATE_LABEL[displayState],
      enabled: node.enabled,
      errorCode: node.errorCode,
      reason: stageReason(node.errorCode),
      durationSeconds: nodeDurationSeconds(node),
      costUsd: node.estimatedCostUsd,
      gpu,
      counts,
      receiptSha256: node.receiptSha256,
      diagnostics: diagnostics[node.stage] ?? [],
    };
  });
}

/** Wall time spans the earliest start to the latest finish of recorded stages. */
export function runWallSeconds(run: DagRunV1): number | null {
  const starts = run.stages.flatMap((n) =>
    n.startedAt ? [Date.parse(n.startedAt)] : [],
  );
  const ends = run.stages.flatMap((n) =>
    n.finishedAt ? [Date.parse(n.finishedAt)] : [],
  );
  if (starts.length === 0 || ends.length === 0) return null;
  const ms = Math.max(...ends) - Math.min(...starts);
  return Number.isFinite(ms) && ms >= 0 ? ms / 1000 : null;
}

/**
 * Summary cards. Counts prefer the job's accepted annotation counts, then the
 * stage receipts; failed counts are separate fields, never added to totals.
 */
export function buildRunSummary(
  run: DagRunV1,
  accepted: AnnotationCounts,
): RunSummary {
  const seg = run.stages.find((n) => n.stage === "segment");
  const cap = run.stages.find((n) => n.stage === "caption");
  const pick = (a: number | undefined, b: number | undefined) =>
    a !== undefined ? a : b !== undefined ? b : null;
  return {
    jobState: run.jobState,
    wallSeconds: runWallSeconds(run),
    costUsd: run.estimatedCostUsd,
    maxJobCostUsd: run.maxJobCostUsd,
    segments: accepted
      ? accepted.segments
      : pick(seg?.counts.segments, undefined),
    failedWindows: accepted
      ? accepted.failedWindows
      : pick(seg?.counts.failed_windows, undefined),
    captions: accepted
      ? accepted.captions
      : pick(cap?.counts.captions_complete, undefined),
    captionsFailed: accepted
      ? accepted.captionsFailed
      : pick(cap?.counts.failed_captions, cap?.counts.captions_failed),
  };
}

/** Pretty JSON for the dag-run panel, Copy and Download (the exact document). */
export const dagRunJson = (run: DagRunV1): string =>
  JSON.stringify(run, null, 2);
export const dagRunFilename = (run: DagRunV1): string =>
  `dag-run-${run.jobId}.json`;

/** List-page annotation counts; null fields render as an em dash. */
export type ListCounts = {
  segments: number | null;
  failedWindows: number | null;
  captions: number | null;
  captionsFailed: number | null;
  /** Segments with a team mark (SA-99), and those whose newest mark is an issue. */
  teamChecks: number;
  teamIssues: number;
};
