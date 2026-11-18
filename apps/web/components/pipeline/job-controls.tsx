"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Button } from "../ui/button";
import { submitJobControl, type JobControlOutcome } from "../../lib/client-api";

export type JobControl = {
  kind:
    | "cancel"
    | "check_cancellation"
    | "retry"
    | "reupload_guidance"
    | "reconcile";
  jobId: string;
  expectedState: string;
};

const LABEL: Record<JobControl["kind"], string> = {
  cancel: "Cancel job",
  check_cancellation: "Check cancellation",
  retry: "Retry as new job",
  reupload_guidance: "Source needs correction",
  reconcile: "Re-check job",
};
const ACTION = {
  cancel: "cancel",
  check_cancellation: "reconcile",
  retry: "retry",
  reconcile: "reconcile",
} as const;

/**
 * Real, server-fenced controls for the current attempt. A cancel is a request,
 * never a stop; the server names the exact job and state seen here, so a stale
 * page cannot mutate newer work. Retry sends one stable requestId per job shown, which becomes the new job's ID, so repeating after a lost response is
 * safe. The re-upload entry is guidance only (the original upload is immutable).
 */
export function JobControls({
  controls,
  instruction,
}: {
  controls: readonly JobControl[];
  instruction: string | null;
}) {
  const router = useRouter();
  const requestId = React.useRef(crypto.randomUUID());
  const [busy, setBusy] = React.useState(false);
  const [outcome, setOutcome] = React.useState<JobControlOutcome | null>(null);

  async function run(control: JobControl) {
    if (busy || control.kind === "reupload_guidance") return;
    if (
      control.kind === "cancel" &&
      !window.confirm(
        "Request cancellation? The job is not stopped until the system confirms the execution has ended.",
      )
    )
      return;
    setBusy(true);
    const result = await submitJobControl({
      requestId: requestId.current,
      action: ACTION[control.kind],
      jobId: control.jobId,
      expectedState: control.expectedState,
    });
    setOutcome(result);
    setBusy(false);
    if (result.ok || result.code === "stale") router.refresh();
  }

  return (
    <div className="grid gap-3" data-testid="job-controls">
      <div className="flex flex-wrap items-center gap-3">
        {controls
          .filter((c) => c.kind !== "reupload_guidance")
          .map((c) => (
            <Button
              key={c.kind}
              variant={c.kind === "cancel" ? "danger" : "outline"}
              disabled={busy}
              onClick={() => void run(c)}
            >
              {LABEL[c.kind]}
            </Button>
          ))}
      </div>
      {instruction ? (
        <p className="m-0 text-xs text-muted" data-testid="job-guidance">
          {instruction}
        </p>
      ) : null}
      <div role="status" aria-live="polite" className="text-sm">
        {outcome?.ok ? (
          <p className="m-0" data-testid="job-control-ok">
            {outcome.replayed ? "Already done. " : ""}
            State: {outcome.state}.
            {outcome.retryJobId ? " A new job was created." : ""}{" "}
            {outcome.instruction}
          </p>
        ) : outcome ? (
          <p className="m-0 text-danger" data-testid="job-control-error">
            {outcome.code === "stale"
              ? "This page is out of date; the job changed. Refreshed."
              : outcome.message}
          </p>
        ) : null}
      </div>
    </div>
  );
}
