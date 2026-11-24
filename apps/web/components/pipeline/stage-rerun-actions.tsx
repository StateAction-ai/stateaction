"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "../ui/button";
import { RERUN_STAGE_LABEL, rerunReason } from "../../lib/stage-rerun";

type Stage = "segment" | "caption" | "hand_pose";
type Scope = "only" | "from_here";
type Request = {
  parentJobId: string;
  stage: Stage;
  scope: Scope;
  module?: string;
  params?: Record<string, unknown>;
};
type Plan = {
  planSha256: string;
  maxGpuCostUsd: string;
  maxComputeCostUsd: string;
  estimatedComputeCostUsd: string | null;
  estimatedSeconds: number | null;
  execute: {
    stage: Stage;
    module: string;
    resources: { gpu: string; budgetSeconds: number };
  }[];
  reuse: {
    stage: Stage;
    state: string;
    copyBytes: string;
    receiptSha256: string | null;
    importJobId: string | null;
    errorCode: string | null;
  }[];
};

class RejectedRequest extends Error {}

function timeEstimate(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${seconds % 60} s`;
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-stateaction-client": "web",
    },
    body: JSON.stringify(body),
  });
  const document = await res.json();
  if (!res.ok) {
    const detail = document.error?.message ?? "Request failed";
    if (res.status >= 400 && res.status < 500)
      throw new RejectedRequest(detail);
    throw new Error(detail);
  }
  if (!document.data) throw new Error("The acknowledgement was incomplete.");
  return document.data as T;
}

export function StageRerunActions({
  recordingId,
  jobId,
  stage,
  module,
  disabledReason,
  onlyReason,
}: {
  recordingId: string;
  jobId: string;
  stage: Stage;
  module: string;
  disabledReason?: string | undefined;
  onlyReason?: string;
}) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const [scope, setScope] = useState<Scope>("only");
  const [version, setVersion] = useState(module);
  const [params, setParams] = useState("");
  const [reason, setReason] = useState("");
  const [preview, setPreview] = useState<{
    request: Request;
    plan: Plan;
    requestId: string;
  }>();
  const [confirmBody, setConfirmBody] = useState<
    Request & {
      requestId: string;
      reason: string;
      expectedPlanSha256: string;
      expectedMaxGpuCostUsd: string;
    }
  >();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const url = `/api/v1/recordings/${recordingId}/stage-reruns`;
  const message = (cause: unknown) => {
    const detail = cause instanceof Error ? cause.message : "Request failed";
    setError(rerunReason(detail));
  };
  async function plan(
    nextScope: Scope,
    nextModule: string,
    nextParams: string,
  ) {
    setBusy(true);
    setError("");
    setPreview(undefined);
    setConfirmBody(undefined);
    try {
      const parsed: unknown = nextParams.trim()
        ? JSON.parse(nextParams)
        : undefined;
      if (
        parsed !== undefined &&
        (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      )
        throw new Error("Parameters must be a JSON object.");
      const request: Request = {
        parentJobId: jobId,
        stage,
        scope: nextScope,
        ...(nextModule !== module ? { module: nextModule } : {}),
        ...(parsed ? { params: parsed as Record<string, unknown> } : {}),
      };
      const result = await post<Plan>(`${url}/plan`, request);
      setPreview({ request, plan: result, requestId: crypto.randomUUID() });
    } catch (cause) {
      message(cause);
    } finally {
      setBusy(false);
    }
  }
  function open(nextScope: Scope) {
    dialog.current?.showModal();
    if (confirmBody) return;
    setScope(nextScope);
    setVersion(module);
    setParams("");
    setReason("");
    void plan(nextScope, module, "");
  }
  async function confirm() {
    if (!preview) return;
    setBusy(true);
    setError("");
    const body = confirmBody ?? {
      ...preview.request,
      requestId: preview.requestId,
      reason: reason.trim(),
      expectedPlanSha256: preview.plan.planSha256,
      expectedMaxGpuCostUsd: preview.plan.maxGpuCostUsd,
    };
    setConfirmBody(body);
    try {
      await post(url, body);
      setConfirmBody(undefined);
      setPreview(undefined);
      dialog.current?.close();
      router.replace(`/pipeline/${recordingId}`);
      router.refresh();
    } catch (cause) {
      if (cause instanceof RejectedRequest) {
        setConfirmBody(undefined);
        setPreview(undefined);
      }
      message(cause);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-3">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          className="px-2.5 py-1 text-xs"
          disabled={!!(disabledReason || onlyReason)}
          onClick={() => open("only")}
        >
          Re-run this stage
        </Button>
        <Button
          type="button"
          variant="outline"
          className="px-2.5 py-1 text-xs"
          disabled={!!disabledReason}
          onClick={() => open("from_here")}
        >
          Re-run from here
        </Button>
      </div>
      {disabledReason || onlyReason ? (
        <p className="m-0 mt-1.5 text-xs text-muted">
          {disabledReason ?? onlyReason}
        </p>
      ) : null}
      {!disabledReason ? (
        <dialog
          ref={dialog}
          aria-label="Confirm stage rerun"
          onCancel={(event) => {
            if (busy) event.preventDefault();
          }}
          className="m-auto max-h-[calc(100dvh-1.5rem)] w-[min(35rem,calc(100vw-1.5rem))] overflow-y-auto rounded-xl border border-line bg-white p-0 text-ink shadow-xl backdrop:bg-black/55"
        >
          <div className="grid gap-3 p-4 sm:px-5">
            <div>
              <h2 className="m-0 text-xl font-bold tracking-tight">
                {scope === "from_here" ? "Re-run from " : "Re-run "}
                {RERUN_STAGE_LABEL[stage].toLowerCase()}
              </h2>
              <p className="m-0 mt-1 text-xs text-muted">
                Parent run{" "}
                <span className="font-mono">{jobId.slice(0, 8)}</span>
              </p>
            </div>
            {error ? (
              <p
                role="alert"
                className="m-0 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger"
              >
                {error}
              </p>
            ) : null}
            {busy && !preview ? (
              <p role="status" className="m-0 text-sm text-muted">
                Checking the parent outputs…
              </p>
            ) : null}
            {preview ? (
              <div data-testid="rerun-plan" className="grid gap-3">
                <dl className="m-0 grid grid-cols-2 gap-x-3 gap-y-2 rounded-lg border border-[#d8e4fa] bg-brand-soft px-3 py-2 text-sm sm:grid-cols-3">
                  <div>
                    <dt className="text-xs text-muted">Estimated time</dt>
                    <dd className="m-0 font-semibold">
                      {preview.plan.estimatedSeconds === null
                        ? "Unavailable"
                        : timeEstimate(preview.plan.estimatedSeconds)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">Estimated compute</dt>
                    <dd className="m-0 font-semibold">
                      {preview.plan.estimatedComputeCostUsd === null
                        ? "Unavailable"
                        : `$${preview.plan.estimatedComputeCostUsd}`}
                    </dd>
                    <p className="m-0 text-xs text-muted">
                      Cap {"$"}
                      {preview.plan.maxComputeCostUsd}
                    </p>
                  </div>
                  <div>
                    <dt className="text-xs text-muted">GPU cap</dt>
                    <dd className="m-0 font-semibold">
                      {"$"}
                      {preview.plan.maxGpuCostUsd}
                    </dd>
                  </div>
                </dl>
                <ul
                  aria-label="Planned stages"
                  className="m-0 list-none divide-y divide-line p-0 text-sm"
                >
                  {(Object.keys(RERUN_STAGE_LABEL) as Stage[]).map((key) => {
                    const next = preview.plan.execute.find(
                      (item) => item.stage === key,
                    );
                    const prior = preview.plan.reuse.find(
                      (item) => item.stage === key,
                    );
                    if (!next && !prior) return null;
                    const retained = prior?.state === "succeeded";
                    return (
                      <li key={key} className="py-1.5" data-plan-stage={key}>
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs font-semibold ${next || retained ? "bg-brand-soft text-brand-ink" : "bg-field text-muted"}`}
                          >
                            {next
                              ? "Execute"
                              : retained
                                ? prior?.importJobId
                                  ? "Reuse · imported"
                                  : "Reuse"
                                : prior?.state === "failed"
                                  ? "Keep failed"
                                  : prior?.state.replaceAll("_", " ")}
                          </span>
                          <strong>{RERUN_STAGE_LABEL[key]}</strong>
                        </div>
                        {next ? (
                          <p className="m-0 mt-1 break-all font-mono text-xs text-muted">
                            {next.module} ·{" "}
                            {next.resources.gpu === "none"
                              ? "CPU"
                              : next.resources.gpu}
                          </p>
                        ) : prior?.receiptSha256 ? (
                          <p
                            className="m-0 mt-1 font-mono text-xs text-muted"
                            title={prior.receiptSha256}
                          >
                            receipt {prior.receiptSha256.slice(0, 12)}…
                          </p>
                        ) : prior?.errorCode ? (
                          <p className="m-0 mt-1 text-xs text-muted">
                            {prior.errorCode.replaceAll("_", " ")}
                          </p>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
            <details className="border-y border-line py-2 text-sm">
              <summary className="cursor-pointer font-medium text-brand">
                Module version and parameters
              </summary>
              <div className="mt-2 grid gap-2">
                <label className="grid gap-1">
                  Module version
                  <input
                    value={version}
                    disabled={busy || !!confirmBody}
                    onChange={(event) => {
                      setVersion(event.target.value);
                      setPreview(undefined);
                    }}
                    className="min-w-0 rounded border border-line px-2 py-1"
                  />
                </label>
                <label className="grid gap-1">
                  Parameter overrides (JSON)
                  <textarea
                    value={params}
                    disabled={busy || !!confirmBody}
                    rows={3}
                    placeholder="{}"
                    onChange={(event) => {
                      setParams(event.target.value);
                      setPreview(undefined);
                    }}
                    className="min-w-0 rounded border border-line px-2 py-1 font-mono text-xs"
                  />
                </label>
              </div>
            </details>
            <label className="grid gap-1 text-sm">
              Reason
              <input
                value={reason}
                disabled={busy || !!confirmBody}
                maxLength={512}
                onChange={(event) => setReason(event.target.value)}
                className="min-w-0 rounded border border-line px-2 py-1"
              />
            </label>
          </div>
          <div className="sticky bottom-0 flex flex-wrap justify-end gap-2 border-t border-line bg-white px-4 py-3 sm:px-5">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => dialog.current?.close()}
            >
              Cancel
            </Button>
            {!confirmBody && !preview ? (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => void plan(scope, version, params)}
              >
                Preview plan
              </Button>
            ) : null}
            <Button
              type="button"
              disabled={busy || !preview || !reason.trim()}
              onClick={() => void confirm()}
            >
              {busy
                ? "Working…"
                : confirmBody
                  ? "Retry confirmation"
                  : "Confirm rerun"}
            </Button>
          </div>
        </dialog>
      ) : null}
    </div>
  );
}
