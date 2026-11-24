import { fmtClock } from "./review/timeline.ts";

export function formatMediaDuration(nanoseconds: string): string {
  const seconds = Number(BigInt(nanoseconds)) / 1e9;
  return fmtClock(Math.round(seconds));
}
