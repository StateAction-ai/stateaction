import Link from "next/link";
import type { ReactNode } from "react";
import {
  formatDuration,
  formatUsd,
  stageReason,
  pipelineErrorSummary,
  type StageAttempt,
  type OperationCost,
} from "@stateaction/server/pipeline";
import { DiagnosticLink } from "./diagnostic-link";
import { Card } from "../ui/card";

const STATUS: Record<string, string> = {
  succeeded: "Succeeded",
  completed: "Succeeded",
  failed: "Failed",
  partially_failed: "Partially complete",
  partially_complete: "Partially complete",
  cancelled: "Cancelled",
  timed_out: "Timed out",
  queued: "Queued",
  pending: "Pending",
  processing: "Processing",
  running: "Running",
  submitting: "Starting",
  submit_unknown: "Start unconfirmed",
  result_pending: "Finalizing",
  cancel_requested: "Cancellation requested",
  needs_attention: "Needs attention",
  needs_setup: "Needs setup",
  choose_recipe: "Choose a recipe",
  not_run: "Not run",
  not_started: "Not started",
  uploading: "Uploading",
  output_available: "Output available",
};

export function ProcessingStatus({ state }: { state: string }) {
  const bad = [
    "failed",
    "partially_failed",
    "partially_complete",
    "cancelled",
    "timed_out",
    "needs_attention",
  ].includes(state);
  const ready = state === "succeeded" || state === "completed";
  return (
    <span
      className={`inline-flex w-fit items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold whitespace-nowrap ${bad ? "bg-danger-soft text-danger" : ready ? "bg-[#e8f4ec] text-good" : "bg-brand-soft text-brand-ink"}`}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      {STATUS[state] ?? state.replaceAll("_", " ")}
    </span>
  );
}

export function processingReason(code: string | null | undefined) {
  if (!code) return null;
  if (code === "dispatch_lost")
    return "Processing did not start within the dispatch window.";
  if (code === "controller_exhausted")
    return "The processing controller stopped before the worker started.";
  if (code === "stage_timeout" || code === "timeout")
    return "The stage exceeded its time limit.";
  return stageReason(code) ?? pipelineErrorSummary(code);
}

function attemptState(run: StageAttempt) {
  if (
    run.error?.code &&
    ["stage_timeout", "deadline_exceeded", "execution_timeout"].includes(
      run.error.code,
    )
  )
    return "timed_out";
  if (run.error?.code === "failed_outputs") return "partially_complete";
  return run.state;
}

function resources(run: StageAttempt) {
  return [
    [
      "Compute",
      run.compute?.kind === "cpu"
        ? "CPU"
        : (run.compute?.observedGpu ??
          (run.compute?.requestedGpu
            ? run.compute.requestedGpu + " (requested)"
            : "Not recorded")),
    ],
    [
      "Duration",
      run.durationSeconds == null
        ? "Not recorded"
        : formatDuration(run.durationSeconds),
    ],
    ["Est. cost", formatUsd(run.costUsd ?? null)],
  ];
}

export function ProcessingStage({
  title,
  current,
  runs,
  reusedFromJobId,
  selectedRun,
  pathname,
  recipeId,
  action,
  note,
  hasEarlierOutput,
}: {
  title: string;
  current: StageAttempt | null;
  runs: readonly StageAttempt[];
  reusedFromJobId?: string | null;
  selectedRun?: string | null;
  pathname: string;
  recipeId?: string | undefined;
  action?: ReactNode;
  hasEarlierOutput?: boolean;
  note?: ReactNode;
}) {
  function runLink(jobId: string) {
    return (
      <Link
        href={`${pathname}?run=${jobId}`}
        scroll={false}
        className="font-mono text-brand underline"
        title={jobId}
      >
        {jobId.slice(0, 8)}
      </Link>
    );
  }

  function runRow(run: StageAttempt) {
    const runRecipe = run.recipeId;
    return (
      <li
        key={run.jobId}
        className={`rounded-lg border p-3 text-sm ${selectedRun === run.jobId ? "border-brand bg-brand-soft" : "border-line bg-field"}`}
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {runLink(run.jobId)}
          <span className="font-semibold">
            {run.kind === "stage_rerun"
              ? "Stage rerun"
              : run.kind === "retry"
                ? "Retry"
                : "Full run"}
          </span>
          <ProcessingStatus state={attemptState(run)} />
          {runRecipe && runRecipe !== recipeId && (
            <span className="text-xs text-muted">{runRecipe}</span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
          {run.parentJobId && <span>Parent {runLink(run.parentJobId)}</span>}
          <span>{run.trigger ?? "Trigger not recorded"}</span>
          {run.startedAt && (
            <time dateTime={run.startedAt}>
              {new Date(run.startedAt).toLocaleString("en-CA", {
                timeZone: "UTC",
              })}{" "}
              UTC
            </time>
          )}
          {resources(run).map(([label, value]) => (
            <span key={label}>
              {label} {value}
            </span>
          ))}
        </div>
        <details className="mt-2">
          <summary className="w-fit cursor-pointer text-xs font-semibold text-brand">
            View logs
          </summary>
          <div className="mt-2 grid gap-1 text-xs text-muted">
            {run.kind === "cached_import" && <p>Seeded from an earlier run</p>}
            {run.error && (
              <p className="wrap-anywhere">
                {run.error.code && <code>{run.error.code} </code>}
                {run.error.summary}
              </p>
            )}
            {run.diagnostics?.map(({ href, name }) => (
              <DiagnosticLink key={href} href={href} name={name} />
            ))}
            {!run.diagnostics?.length && <p>Provider logs unavailable.</p>}
          </div>
        </details>
      </li>
    );
  }

  const earlier = runs.slice(3);
  const reason =
    processingReason(current?.error?.code) ?? current?.error?.summary;
  return (
    <Card className="grid min-w-0 gap-3 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold">{title}</h2>
        <ProcessingStatus
          state={
            current
              ? attemptState(current)
              : hasEarlierOutput
                ? "output_available"
                : "not_run"
          }
        />
      </div>
      {reason && <p className="text-sm text-muted">{reason}</p>}
      {current?.error?.code && (
        <code className="w-fit max-w-full text-xs wrap-anywhere text-muted">
          {current.error.code}
        </code>
      )}
      {note}
      {current && (current.counts.frames_no_hand ?? 0) > 0 && (
        <p className="text-sm text-muted">
          No hand detected in {current.counts.frames_no_hand}{" "}
          {current.counts.frames_no_hand === 1 ? "frame" : "frames"}.
        </p>
      )}
      {current && (current.counts.failed_windows ?? 0) > 0 && (
        <p className="text-sm text-muted">
          Failed action windows: {current.counts.failed_windows}
        </p>
      )}
      {current &&
        (current.counts.failed_captions ??
          current.counts.captions_failed ??
          0) > 0 && (
          <p className="text-sm text-muted">
            Failed captions:{" "}
            {current.counts.failed_captions ?? current.counts.captions_failed}
          </p>
        )}
      {reusedFromJobId && (
        <p
          className="text-sm text-muted"
          title="This stage used an earlier result and did not run again."
        >
          Output from run {runLink(reusedFromJobId)}
        </p>
      )}
      {current && (
        <dl className="flex flex-wrap gap-x-6 gap-y-2">
          {resources(current).map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs text-muted">{label}</dt>
              <dd className="text-sm font-semibold">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {action}
      <div className="grid gap-2 border-t border-line pt-3">
        <h3 className="text-sm font-bold">Runs ({runs.length})</h3>
        {runs.length ? (
          <ul className="grid gap-2">{runs.slice(0, 3).map(runRow)}</ul>
        ) : (
          <p className="text-sm text-muted">No executions recorded.</p>
        )}
        {earlier.length > 0 && (
          <details
            open={
              earlier.some(({ jobId }) => jobId === selectedRun) || undefined
            }
          >
            <summary className="w-fit cursor-pointer text-sm font-semibold text-brand">
              Show all
            </summary>
            <ul className="mt-2 grid gap-2">{earlier.map(runRow)}</ul>
          </details>
        )}
      </div>
    </Card>
  );
}

export function EstimatedCost({
  cost,
  scope,
}: {
  cost: OperationCost;
  scope: string;
}) {
  return (
    <span className="text-sm text-muted">
      {scope} estimated cost {formatUsd(cost.estimatedUsd)}
      {cost.estimatedUsd !== null && !cost.complete
        ? " (recorded estimates only)"
        : ""}
    </span>
  );
}
