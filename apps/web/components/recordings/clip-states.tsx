import type { ClipPipelineState, DagRunNode } from "@stateaction/contracts";
import { stageHasFailedOutputs } from "@stateaction/server/pipeline";
import { cn } from "../../lib/utils";

const LABELS = {
  queued: "Queued",
  processing: "Processing",
  succeeded: "Succeeded",
  partially_failed: "Partially failed",
  failed: "Failed",
  imported: "Imported",
  reused: "Reused",
  pending: "Pending",
  running: "Running",
  submitting: "Submitting",
  cancelled: "Cancelled",
  submit_unknown: "Submission unknown",
  not_run: "Not run",
  needs_attention: "Needs attention",
} as const;

export function stageDisplayState(stage: DagRunNode): keyof typeof LABELS {
  return stage.state === "succeeded" &&
    stageHasFailedOutputs(stage.stage, stage.counts)
    ? "partially_failed"
    : stage.state;
}

export function ClipState({
  state,
}: {
  state: ClipPipelineState | keyof typeof LABELS;
}) {
  const danger =
    state === "failed" ||
    state === "partially_failed" ||
    state === "needs_attention";
  return (
    <span
      className={cn(
        "inline-flex w-fit shrink-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-semibold whitespace-nowrap",
        danger
          ? "bg-danger-soft text-danger"
          : state === "succeeded"
            ? "bg-[#e8f4ec] text-good"
            : "bg-brand-soft text-brand-ink",
      )}
    >
      <span
        aria-hidden="true"
        className="size-1.5 shrink-0 rounded-full bg-current"
      />
      {LABELS[state]}
    </span>
  );
}
