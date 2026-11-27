"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { submitJobControl } from "../../lib/client-api";
import { Button } from "../ui/button";
import { ConfirmDialog } from "./confirm-dialog";
import { postRecordingCommand } from "./commands";

type RetryAction =
  | {
      planning?: never;
      graph:
        | { clipId: string; parentJobId: string; nodes: string[] }
        | { scope: "failed_clips" };
    }
  | {
      graph?: never;
      planning: {
        jobId: string;
        expectedState: string;
        estimate?: string | null | undefined;
      };
    };

type GraphClipPlan = {
  clipId: string;
  ordinal: number;
  execute: string[];
  reuse: { nodeId: string }[];
};
type GraphRetryPlan = {
  planSha256: string;
  maxComputeCostUsd: string;
  maxGpuCostUsd: string;
} & (GraphClipPlan | { clips: GraphClipPlan[] });
type Prepared = { requestId: string; graphPlan?: GraphRetryPlan };

function estimate(amount: string | null | undefined) {
  return amount == null ? "Unavailable" : `$${amount} USD`;
}

export function RetryAction({
  recordingId,
  label,
  action,
  ranges,
  disabledReason,
}: {
  recordingId: string;
  label: string;
  action: RetryAction | null;
  ranges?: Readonly<Record<string, string>> | undefined;
  disabledReason?: string | null;
}) {
  const router = useRouter();
  const descriptionId = useId();
  const description = disabledReason ?? undefined;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [error, setError] = useState("");
  const [outcome, setOutcome] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const graphPlan = prepared?.graphPlan;
  const graphEndpoint = `/api/v1/recordings/${recordingId}/graph-retries`;

  async function prepare() {
    if (!action) return;
    setOpen(true);
    setError("");
    if (prepared) return;
    if (action.planning) {
      setPrepared({ requestId: crypto.randomUUID() });
      return;
    }
    setBusy(true);
    try {
      const requestId = crypto.randomUUID();
      const graphPlan = await postRecordingCommand<GraphRetryPlan>(
        `${graphEndpoint}/preview`,
        { schemaVersion: 1, ...action.graph },
      );
      setPrepared({ requestId, graphPlan });
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!action || !prepared || busy) return;
    setSubmitted(true);
    setBusy(true);
    setError("");
    try {
      if (action.planning) {
        const result = await submitJobControl({
          action: "retry",
          jobId: action.planning.jobId,
          expectedState: action.planning.expectedState,
          requestId: prepared.requestId,
        });
        if (!result.ok) throw new Error(result.message);
      } else if (action.graph && graphPlan) {
        await postRecordingCommand(`${graphEndpoint}/confirm`, {
          schemaVersion: 1,
          ...action.graph,
          requestId: prepared.requestId,
          expectedPlanSha256: graphPlan.planSha256,
          reason: label,
        });
      }
      setOpen(false);
      setOutcome("Retry queued.");
      router.refresh();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid justify-items-start gap-1">
      <Button
        variant={
          label === "Retry failed steps" && !disabledReason && action
            ? "default"
            : "outline"
        }
        disabled={Boolean(!action || disabledReason || outcome)}
        aria-describedby={description ? descriptionId : undefined}
        onClick={() => void prepare()}
      >
        {label}
      </Button>
      {description && (
        <p id={descriptionId} className="text-sm text-muted">
          {description}
        </p>
      )}
      {outcome && (
        <p className="text-sm text-muted" role="status">
          {outcome}
        </p>
      )}
      {open && (
        <ConfirmDialog
          title={label}
          busy={busy}
          close={() => {
            setOpen(false);
            if (!submitted) setPrepared(null);
          }}
        >
          {busy && !prepared && <p role="status">Checking the retry plan…</p>}
          {action?.planning && (
            <div className="mb-4 grid gap-2 text-sm">
              <p>Start a new clip planning run from the same sealed source.</p>
              <p>New run estimate unavailable.</p>
              {action.planning.estimate != null && (
                <p>
                  Earlier run estimated cost{" "}
                  {estimate(action.planning.estimate)}
                </p>
              )}
            </div>
          )}
          {graphPlan && (
            <div className="mb-4 grid gap-2 text-sm">
              {("clips" in graphPlan ? graphPlan.clips : [graphPlan]).map(
                (clip) => (
                  <div className="grid gap-1" key={clip.clipId}>
                    {"clips" in graphPlan && (
                      <strong>
                        Clip {clip.ordinal + 1}
                        {ranges?.[clip.clipId]
                          ? ` · ${ranges[clip.clipId]}`
                          : ""}
                      </strong>
                    )}
                    <p>
                      Runs{" "}
                      {clip.execute
                        .map((id) => id.replaceAll("_", " "))
                        .join(", ")}
                    </p>
                    {clip.reuse.length > 0 && (
                      <p>
                        Keeps{" "}
                        {clip.reuse
                          .map(({ nodeId }) => nodeId.replaceAll("_", " "))
                          .join(", ")}
                      </p>
                    )}
                  </div>
                ),
              )}
              <p>
                Maximum cost {estimate(graphPlan.maxComputeCostUsd)}, including
                GPU {estimate(graphPlan.maxGpuCostUsd)}
              </p>
            </div>
          )}
          {error && (
            <p role="alert" className="mb-3 text-sm text-danger">
              {error}
            </p>
          )}
          {prepared && (
            <Button disabled={busy} onClick={() => void confirm()}>
              {busy ? "Queuing retry…" : "Start retry"}
            </Button>
          )}
        </ConfirmDialog>
      )}
    </div>
  );
}
