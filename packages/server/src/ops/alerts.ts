import { TERMINAL, type JobFacts } from "./receipt.js";
import type { CostEstimate } from "./cost.js";

/** Explicit, finite thresholds. Nothing is defaulted: an operator states each one. */
export type Thresholds = {
  queuedDelaySeconds: number;
  heartbeatStaleSeconds: number;
  /** Per-run gross estimate that triggers a spend alert (same currency as the rate card). */
  spendAlertAmount?: number;
};

export const MAX_JOBS = 200;

export type AlertRule =
  | "queued_delay"
  | "stuck_or_uncertain"
  | "source_hash_failure"
  | "spend";

export type Alert = {
  rule: AlertRule;
  /** `unknown`: the evidence needed to evaluate the rule is not recorded. */
  status: "triggered" | "unknown";
  jobId: string;
  reason: string;
  observed?: number;
  threshold?: number;
};

export class ThresholdError extends Error {
  constructor(readonly field: string) {
    super(`invalid threshold: ${field}`);
  }
}

export function readThresholds(raw: unknown): Thresholds {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new ThresholdError("thresholds");
  const r = raw as Record<string, unknown>;
  if (
    Object.keys(r).some(
      (k) =>
        ![
          "queuedDelaySeconds",
          "heartbeatStaleSeconds",
          "spendAlertAmount",
        ].includes(k),
    )
  )
    throw new ThresholdError("thresholds");
  const need = (k: string, max: number): number => {
    const v = r[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > max)
      throw new ThresholdError(k);
    return v;
  };
  const out: Thresholds = {
    queuedDelaySeconds: need("queuedDelaySeconds", 7 * 86_400),
    heartbeatStaleSeconds: need("heartbeatStaleSeconds", 86_400),
  };
  if (r.spendAlertAmount !== undefined)
    out.spendAlertAmount = need("spendAlertAmount", 1e9);
  return out;
}

const UNCERTAIN = ["submit_unknown", "needs_attention"];

/**
 * Pure, deterministic and finite: one pass over at most MAX_JOBS facts, an
 * injected clock, no I/O, nothing sent. Alerts are operator-visible records,
 * not billing hard caps.
 */
export function evaluateAlerts(
  jobs: readonly JobFacts[],
  thresholds: Thresholds,
  now: number,
  costs: ReadonlyMap<string, CostEstimate> = new Map(),
): Alert[] {
  const alerts: Alert[] = [];
  for (const j of jobs.slice(0, MAX_JOBS)) {
    const terminal = TERMINAL.includes(j.state);
    if (j.state === "queued") {
      const since = j.admittedAt ?? j.createdAt;
      if (since === undefined)
        alerts.push({
          rule: "queued_delay",
          status: "unknown",
          jobId: j.jobId,
          reason: "queue start time not recorded",
        });
      else if ((now - since) / 1000 > thresholds.queuedDelaySeconds)
        alerts.push({
          rule: "queued_delay",
          status: "triggered",
          jobId: j.jobId,
          reason: "queued longer than threshold",
          observed: Math.floor((now - since) / 1000),
          threshold: thresholds.queuedDelaySeconds,
        });
    }
    if (UNCERTAIN.includes(j.state))
      alerts.push({
        rule: "stuck_or_uncertain",
        status: "triggered",
        jobId: j.jobId,
        reason: `execution is ${j.state}; outcome unproven`,
      });
    else if (
      !terminal &&
      j.executionDeadline !== undefined &&
      now > j.executionDeadline
    )
      alerts.push({
        rule: "stuck_or_uncertain",
        status: "triggered",
        jobId: j.jobId,
        reason: "execution deadline passed without terminal state",
      });
    else if (j.state === "running") {
      const beat = j.lastHeartbeatAt ?? j.claimedAt;
      if (beat === undefined)
        alerts.push({
          rule: "stuck_or_uncertain",
          status: "unknown",
          jobId: j.jobId,
          reason: "running without any recorded heartbeat or claim time",
        });
      else if ((now - beat) / 1000 > thresholds.heartbeatStaleSeconds)
        alerts.push({
          rule: "stuck_or_uncertain",
          status: "triggered",
          jobId: j.jobId,
          reason: "no heartbeat within threshold",
          observed: Math.floor((now - beat) / 1000),
          threshold: thresholds.heartbeatStaleSeconds,
        });
    }
    if (
      j.errorCode === "source_sha_mismatch" ||
      j.errorCode === "source_checksum_mismatch"
    )
      alerts.push({
        rule: "source_hash_failure",
        status: "triggered",
        jobId: j.jobId,
        reason: "source hash did not verify",
      });
    if (thresholds.spendAlertAmount !== undefined) {
      const cost = costs.get(j.jobId);
      if (!cost || cost.grossKnown.status !== "measured")
        alerts.push({
          rule: "spend",
          status: "unknown",
          jobId: j.jobId,
          reason:
            "no computable gross estimate (missing rates or measurements)",
        });
      else if (cost.grossKnown.value > thresholds.spendAlertAmount)
        alerts.push({
          rule: "spend",
          status: "triggered",
          jobId: j.jobId,
          reason: cost.complete
            ? "gross estimate above alert amount (alert only, not a billing cap)"
            : "known part of gross estimate above alert amount; other charges unknown (alert only, not a billing cap)",
          observed: cost.grossKnown.value,
          threshold: thresholds.spendAlertAmount,
        });
    }
  }
  return alerts;
}
