"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import type { Stage } from "@stateaction/contracts";
import { RECIPE_STAGE_LABEL } from "@stateaction/server/pipeline-model";
import { submitJobControl } from "../../lib/client-api";
import { Button } from "../ui/button";
import { ConfirmDialog } from "./confirm-dialog";
import { postRecordingCommand } from "./commands";

type RetryRequest =
  | { schemaVersion: 2; scope: "failed_clips" }
  | {
      schemaVersion: 2;
      scope: "clip";
      clipId: string;
      parentJobId: string;
      stages: Stage[];
    };

type RetryPlan = {
  planSha256: string;
  maxGpuCostUsd: string;
  maxComputeCostUsd: string;
  estimatedComputeCostUsd: string | null;
  clips: {
    clipId: string;
    ordinal: number;
    execute: { stage: Stage }[];
    reuse: { stage: Stage; sourceJobId: string; state: string }[];
    estimatedComputeCostUsd: string | null;
  }[];
};

type RetryAction =
  | { request: RetryRequest; planning?: never }
  | {
      request?: never;
      planning: {
        jobId: string;
        expectedState: string;
        estimate?: string | null | undefined;
      };
    };

type Prepared = { requestId: string; plan?: RetryPlan };

function estimate(amount: string | null | undefined) {
  return amount == null ? "Unavailable" : `$${amount} USD`;
}

export function RetryAction({
  recordingId,
  label,
  action,
  ranges,
  disabledReason,
  hint,
}: {
  recordingId: string;
  label: string;
  action: RetryAction;
  ranges?: Readonly<Record<string, string>> | undefined;
  disabledReason?: string | null;
  hint?: string;
}) {
  const router = useRouter();
  const descriptionId = useId();
  const description = disabledReason ?? hint;
  const endpoint = `/api/v2/recordings/${recordingId}/stage-reruns`;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [error, setError] = useState("");
  const [outcome, setOutcome] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const plan = prepared?.plan;

  async function prepare() {
    setOpen(true);
    setError("");
    if (prepared) return;
    if (action.planning) {
      setPrepared({ requestId: crypto.randomUUID() });
      return;
    }
    setBusy(true);
    try {
      const plan = await postRecordingCommand<RetryPlan>(
        `${endpoint}/plan`,
        action.request,
      );
      setPrepared({ requestId: crypto.randomUUID(), plan });
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!prepared || busy) return;
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
      } else if (plan) {
        await postRecordingCommand(endpoint, {
          ...action.request,
          requestId: prepared.requestId,
          expectedPlanSha256: plan.planSha256,
          expectedMaxComputeCostUsd: plan.maxComputeCostUsd,
          expectedMaxGpuCostUsd: plan.maxGpuCostUsd,
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
        variant="outline"
        disabled={Boolean(disabledReason || outcome)}
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
          {action.planning && (
            <div className="mb-4 grid gap-2 text-sm">
              <p>Start a new clip planning run from the same sealed source.</p>
              <p className="text-muted">
                Earlier run <code>{action.planning.jobId.slice(0, 8)}</code>
              </p>
              <p>New run estimate unavailable.</p>
              {action.planning.estimate != null && (
                <p>
                  Earlier run estimated cost{" "}
                  {estimate(action.planning.estimate)}
                </p>
              )}
            </div>
          )}
          {plan && (
            <>
              <ul className="mb-4 grid gap-2">
                {plan.clips.map((clip) => (
                  <li
                    key={clip.clipId}
                    className="grid gap-1 rounded-lg border border-line bg-field p-3 text-sm"
                  >
                    <strong>
                      Clip {clip.ordinal + 1}
                      {ranges?.[clip.clipId] ? ` · ${ranges[clip.clipId]}` : ""}
                    </strong>
                    <p>
                      Runs{" "}
                      {clip.execute
                        .map(({ stage }) => RECIPE_STAGE_LABEL[stage])
                        .join(", ")}
                    </p>
                    {clip.execute.some(({ stage }) => stage === "segment") &&
                      clip.execute.some(({ stage }) => stage === "caption") && (
                        <p className="text-muted">
                          Captions must follow segmentation.
                        </p>
                      )}
                    {clip.reuse.map((output) => (
                      <p key={output.stage} className="text-muted">
                        {output.state === "succeeded"
                          ? "Keeps"
                          : "Carries forward"}{" "}
                        {RECIPE_STAGE_LABEL[output.stage]} from{" "}
                        <code>{output.sourceJobId.slice(0, 8)}</code>
                        {output.state !== "succeeded" &&
                          ` (${output.state.replaceAll("_", " ")})`}
                      </p>
                    ))}
                    <p>
                      Estimated cost {estimate(clip.estimatedComputeCostUsd)}
                    </p>
                  </li>
                ))}
              </ul>
              <p className="mb-4 text-sm">
                Total estimated cost {estimate(plan.estimatedComputeCostUsd)}
              </p>
            </>
          )}
          {error && (
            <p role="alert" className="mb-3 text-sm text-danger">
              {error}
            </p>
          )}
          {prepared && (
            <Button disabled={busy} onClick={() => void confirm()}>
              {busy ? "Queuing retry…" : "Confirm retry"}
            </Button>
          )}
        </ConfirmDialog>
      )}
    </div>
  );
}
