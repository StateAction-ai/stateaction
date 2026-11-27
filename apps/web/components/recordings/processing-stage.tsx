import Link from "next/link";
import type { ReactNode } from "react";
import {
  attemptStatus,
  formatDuration,
  formatUsd,
  stageReason,
  pipelineErrorSummary,
  type StageAttempt,
  type OperationCost,
} from "@stateaction/server/pipeline";
import { DiagnosticLink } from "./diagnostic-link";
import { ProcessingStatus } from "./processing-status";
export { ProcessingStatus } from "./processing-status";
import { recipeLabel } from "../../lib/recipe-view";

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

export function ProcessingStepDetails({
  stepId,
  current,
  runs,
  reusedFromJobId,
  selectedRun,
  pathname,
  recipeId,
  action,
  note,
  importedEvidence,
}: {
  stepId: string;
  current: StageAttempt | null;
  runs: readonly StageAttempt[];
  reusedFromJobId?: string | null;
  selectedRun?: string | null;
  pathname: string;
  recipeId?: string | undefined;
  action?: ReactNode;
  importedEvidence?: {
    model: string | null;
    revision: string | null;
    generator: string | null;
  } | null;
  note?: ReactNode;
}) {
  function runLink(jobId: string, label: string) {
    return (
      <Link
        href={`${pathname}?${new URLSearchParams({ step: stepId, run: jobId })}`}
        scroll={false}
        className="font-semibold text-brand underline"
      >
        {label}
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
          {runLink(
            run.jobId,
            run.kind === "stage_rerun"
              ? "Stage rerun"
              : run.kind === "retry"
                ? "Retry"
                : "Full run",
          )}
          <ProcessingStatus state={attemptStatus(run)} />
          {runRecipe && runRecipe !== recipeId && (
            <span className="text-xs text-muted">{recipeLabel(runRecipe)}</span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
          {run.parentJobId && runLink(run.parentJobId, "Parent run")}
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
  const outputCounts = Object.entries(current?.counts ?? {}).filter(
    ([name, count]) =>
      count > 0 && ["segments", "captions", "frames_with_hand"].includes(name),
  );
  const reason =
    processingReason(current?.error?.code) ?? current?.error?.summary;
  return (
    <div className="grid min-w-0 gap-3">
      {reason && <p className="text-sm text-muted">{reason}</p>}
      {current?.error?.code && (
        <code className="w-fit max-w-full text-xs wrap-anywhere text-muted">
          {current.error.code}
        </code>
      )}
      {note}
      {outputCounts.length > 0 && (
        <p className="text-sm text-muted">
          {outputCounts
            .map(([name, count]) => `${count} ${name.replaceAll("_", " ")}`)
            .join(" · ")}
        </p>
      )}
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
        <p className="text-sm text-muted">
          {current && attemptStatus(current) === "succeeded"
            ? "Reused output from "
            : "Carried forward from "}
          {runLink(reusedFromJobId, "source run")}
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
      {importedEvidence && (
        <p className="text-sm text-muted">
          Imported output
          {importedEvidence.model ? ` · ${importedEvidence.model}` : ""}
          {importedEvidence.revision ? ` · ${importedEvidence.revision}` : ""}
        </p>
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
    </div>
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
