import type { ClipPlanV1 } from "@stateaction/contracts";

export type TimelineSpan = {
  kind: "clip" | "excluded";
  label: string;
  start: number;
  end: number | null;
};

const REASON = {
  walking: "Walking",
  idle: "Idle",
  no_hand: "No hand detected",
  talking: "Talking",
  judge_no_action: "No action detected",
} as const;

export function sourceTime(value: string | string[] | undefined): number {
  if (typeof value !== "string" || !/^\d{1,9}(?:\.\d{1,9})?$/.test(value))
    return 0;
  return Number(value);
}

export function elapsedSeconds(ns: string): number {
  return Number(BigInt(ns)) / 1e9;
}

export function planTimeline(plan: ClipPlanV1 | null): TimelineSpan[] {
  if (!plan) return [];
  const origin = BigInt(plan.origin_ts_ns);
  const offset = (ts: string) => Number(BigInt(ts) - origin) / 1e9;
  let clipNumber = 0;
  return plan.spans.map((span, index) => {
    const next = plan.spans[index + 1];
    return {
      kind: span.kind,
      label:
        span.kind === "clip"
          ? "Clip " + ++clipNumber
          : "Excluded · " + REASON[span.reason],
      start: offset(span.start_ts_ns),
      end: next ? offset(next.start_ts_ns) : null,
    };
  });
}
