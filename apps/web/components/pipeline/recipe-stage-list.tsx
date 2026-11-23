import {
  AlertCircle,
  CheckCircle2,
  CircleDashed,
  HelpCircle,
  Loader2,
  OctagonX,
} from "lucide-react";
import {
  formatDuration,
  formatRate,
  formatUsd,
  type RunStageView,
} from "@stateaction/server/pipeline";
import { cn } from "../../lib/utils";

type State = RunStageView["state"];
const ICON: Record<State, typeof CheckCircle2> = {
  succeeded: CheckCircle2,
  running: Loader2,
  submitting: Loader2,
  pending: CircleDashed,
  failed: AlertCircle,
  cancelled: OctagonX,
  submit_unknown: HelpCircle,
  not_run: CircleDashed,
};
const TONE: Record<State, string> = {
  succeeded: "text-good",
  running: "text-brand",
  submitting: "text-brand",
  pending: "text-muted",
  failed: "text-danger",
  cancelled: "text-muted",
  submit_unknown: "text-[#8a5a00]",
  not_run: "text-muted",
};
const BADGE: Record<State, string> = {
  succeeded: "bg-[#e9f6ef] text-good",
  running: "bg-brand-soft text-brand-ink",
  submitting: "bg-brand-soft text-brand-ink",
  pending: "bg-[#eef0ec] text-[#4d5a54]",
  failed: "bg-danger-soft text-danger",
  cancelled: "bg-[#eef0ec] text-[#4d5a54]",
  submit_unknown: "bg-[#fff4de] text-[#8a5a00]",
  not_run: "bg-[#eef0ec] text-[#4d5a54]",
};

const short = (sha: string) => `${sha.slice(0, 8)}…${sha.slice(-4)}`;

/**
 * One row per recipe stage from the recorded stage runs. State is text plus an
 * icon; failed counts are shown as failed and never folded into totals; a
 * stage that was not run states its reason.
 */
export function RecipeStageList({ stages }: { stages: RunStageView[] }) {
  return (
    <ol
      data-testid="recipe-stages"
      className="m-0 grid list-none gap-0 p-0"
      aria-label="Recipe stages"
    >
      {stages.map((s) => {
        const Icon = ICON[s.state];
        return (
          <li
            key={s.stage}
            data-stage={s.stage}
            data-state={s.state}
            className="grid gap-2 border-t border-line px-1 py-4 first:border-t-0 sm:grid-cols-[1fr_auto]"
          >
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Icon
                  aria-hidden="true"
                  className={cn("h-4 w-4 shrink-0", TONE[s.state])}
                />
                <span className="font-mono text-[13px] font-bold">
                  {s.stage}
                </span>
                <span className="rounded bg-brand-soft px-1.5 py-0.5 font-mono text-[11px] text-brand-ink">
                  {s.module}
                </span>
                <span className="text-sm">{s.title}</span>
                <span
                  className={cn(
                    "rounded-md px-2 py-0.5 text-xs font-semibold",
                    BADGE[s.state],
                  )}
                >
                  {s.stateLabel}
                </span>
                {s.gpu ? (
                  <span className="rounded bg-field px-1.5 py-0.5 text-[11px] font-semibold text-muted">
                    GPU
                  </span>
                ) : null}
              </div>
              {s.state === "not_run" ? (
                <p className="m-0 mt-1.5 text-[13px] text-muted">
                  Not run: {s.reason ?? "no reason recorded"}
                  {s.errorCode ? (
                    <span className="font-mono text-[11px]">
                      {" "}
                      ({s.errorCode})
                    </span>
                  ) : null}
                </p>
              ) : null}

              {s.gpu ? (
                <dl className="m-0 mt-2.5 grid grid-cols-2 gap-x-5 gap-y-2 rounded-lg border border-line bg-field px-3 py-2.5 sm:grid-cols-4">
                  {(
                    [
                      ["Requested", s.gpu.requestedType],
                      ["Observed", s.gpu.observedType ?? "Not reported"],
                      [
                        "VRAM",
                        s.gpu.vramGb === null
                          ? "Unknown"
                          : `${s.gpu.vramGb} GB`,
                      ],
                      ["Rate", formatRate(s.gpu.usdPerHour)],
                    ] as const
                  ).map(([k, v]) => (
                    <div key={k} className="min-w-0">
                      <dt className="text-[10px] font-bold tracking-[0.08em] text-muted uppercase">
                        {k}
                      </dt>
                      <dd className="m-0 font-mono text-xs font-semibold break-words">
                        {v}
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : null}

              {s.counts.length > 0 ? (
                <ul className="m-0 mt-2 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-xs">
                  {s.counts.map((c) => (
                    <li
                      key={c.key}
                      className={c.failed && c.value > 0 ? "text-danger" : ""}
                    >
                      <span className="font-mono font-semibold">{c.value}</span>{" "}
                      {c.label}
                    </li>
                  ))}
                </ul>
              ) : null}

              {s.state === "failed" || s.state === "cancelled" ? (
                <p
                  role="alert"
                  className="m-0 mt-2 rounded-lg border border-[#edc8cc] bg-danger-soft px-3 py-2 text-[13px] text-[#7b2b31] break-words"
                >
                  <span className="font-mono font-semibold">
                    {s.errorCode ?? "unknown_error"}
                  </span>{" "}
                  {s.state === "failed"
                    ? "This stage failed; its output is recorded as failed, not empty."
                    : "This stage was cancelled."}
                </p>
              ) : null}
              {s.state === "submit_unknown" ? (
                <p className="m-0 mt-2 text-[13px] text-[#8a5a00]">
                  Whether this stage started is not confirmed. Use the job
                  actions to reconcile.
                </p>
              ) : null}

              <p className="m-0 mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                {s.receiptSha256 ? (
                  <span className="text-muted">
                    Stage receipt{" "}
                    <span
                      className="font-mono"
                      title={s.receiptSha256}
                      data-testid="receipt-sha"
                    >
                      {short(s.receiptSha256)}
                    </span>
                  </span>
                ) : (
                  <span className="text-muted">No stage receipt recorded</span>
                )}
                {s.diagnostics.map((d) => (
                  <a
                    key={d.name}
                    href={d.href}
                    className="text-brand"
                    rel="noreferrer"
                  >
                    {d.name}
                  </a>
                ))}
              </p>
            </div>
            <div className="text-left text-sm sm:text-right">
              <div className="font-bold">
                {formatDuration(s.durationSeconds)}
              </div>
              <div className="text-muted" data-testid="stage-cost">
                {formatUsd(s.costUsd)}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
