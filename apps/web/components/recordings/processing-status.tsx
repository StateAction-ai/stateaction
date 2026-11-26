const STATUS: Record<string, string> = {
  reused: "Reused",
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

export function statusLabel(state: string) {
  return STATUS[state] ?? state.replaceAll("_", " ");
}

export function statusTone(state: string) {
  if (
    [
      "failed",
      "partially_failed",
      "partially_complete",
      "cancelled",
      "timed_out",
      "needs_attention",
    ].includes(state)
  )
    return "danger";
  if (state === "reused") return "reused";
  if (["succeeded", "completed", "output_available"].includes(state))
    return "good";
  if (
    [
      "queued",
      "running",
      "processing",
      "submitting",
      "result_pending",
    ].includes(state)
  )
    return "running";
  if (state === "needs_setup" || state === "choose_recipe") return "held";
  return "waiting";
}

export function ProcessingStatus({ state }: { state: string }) {
  const tone = statusTone(state);
  return (
    <span
      className={`inline-flex w-fit items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold ${tone === "danger" ? "bg-danger-soft text-danger" : tone === "good" || tone === "reused" ? "bg-[#e8f4ec] text-good" : "bg-brand-soft text-brand-ink"}`}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      {statusLabel(state)}
    </span>
  );
}
