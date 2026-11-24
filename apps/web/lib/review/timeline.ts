// Pure helpers for the review time axis: view window, ticks, navigation,
// filtering. No DOM; unit tested.

import { passesMarkFilter, type MarkMap } from "./marks.ts";
import type { Card } from "./types.ts";

export type View = readonly [number, number];

export const MIN_SPAN_S = 2;

export function fmtClock(seconds: number): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

export function fmtPrecise(seconds: number): string {
  const s = Math.max(0, seconds);
  const frac = Math.floor((s % 1) * 10);
  return `${fmtClock(s)}.${frac}`;
}

/** A readable tick step (1, 2, 5, 10 ... seconds) giving about 6-10 major ticks. */
export function niceStep(span: number): number {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
  return steps.find((s) => span / s <= 9) ?? 7200;
}

export function rulerTicks(view: View, step: number) {
  const minor = step / 5;
  const ticks: { s: number; major: boolean }[] = [];
  const first = Math.ceil((view[0] * 5) / step);
  const last = Math.floor((view[1] * 5) / step);
  for (let index = first; index <= last; index++) {
    const major = index % 5 === 0;
    ticks.push({ s: major ? (index / 5) * step : index * minor, major });
  }
  return ticks;
}

/** Cards are ordered by start time. A row can be reused at the previous span's end. */
export function packSegmentRows(cards: readonly Card[]): Card[][] {
  const rows: Card[][] = [];
  for (const card of cards) {
    const row = rows.find((row) => row.at(-1)!.endS <= card.startS);
    if (row) row.push(card);
    else rows.push([card]);
  }
  return rows;
}

export function rowFocusIndex(
  key: string,
  current: number,
  length: number,
): number | null {
  switch (key) {
    case "Home":
      return 0;
    case "End":
      return length - 1;
    case "ArrowLeft":
      return Math.max(0, current - 1);
    case "ArrowRight":
      return Math.min(length - 1, current + 1);
    default:
      return null;
  }
}

export function clampView(start: number, end: number, duration: number): View {
  const span = Math.min(duration, Math.max(MIN_SPAN_S, end - start));
  const a = Math.min(Math.max(0, start), Math.max(0, duration - span));
  return [a, a + span];
}

export function fitView(duration: number): View {
  return [0, Math.max(duration, MIN_SPAN_S)];
}

/** factor < 1 zooms in. The point `center` keeps its screen position. */
export function zoomView(
  view: View,
  factor: number,
  center: number,
  duration: number,
): View {
  const span = view[1] - view[0];
  const next = Math.min(duration, Math.max(MIN_SPAN_S, span * factor));
  const k = span > 0 ? (center - view[0]) / span : 0.5;
  return clampView(center - k * next, center - k * next + next, duration);
}

export function panView(view: View, delta: number, duration: number): View {
  return clampView(view[0] + delta, view[1] + delta, duration);
}

/** Keeps `t` inside the view (follows the playhead while zoomed). */
export function followView(view: View, t: number, duration: number): View {
  if (t >= view[0] && t <= view[1]) return view;
  const span = view[1] - view[0];
  return clampView(t - span * 0.2, t - span * 0.2 + span, duration);
}

export function xOf(t: number, view: View, width: number): number {
  return ((t - view[0]) / (view[1] - view[0])) * width;
}

export function tOf(x: number, view: View, width: number): number {
  return view[0] + (x / width) * (view[1] - view[0]);
}

/** Index of the card whose span contains t, or -1. Cards are ordered. */
export function activeCardIndex(cards: readonly Card[], t: number): number {
  let lo = 0;
  let hi = cards.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cards[mid]!.startS <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  for (let index = found; index >= 0; index--) {
    if (t < cards[index]!.endS) return index;
  }
  return -1;
}

/** Previous card start (more than 0.5 s back, so a second press goes further) or next card start. */
export function neighborStart(
  cards: readonly Card[],
  t: number,
  dir: -1 | 1,
): number | null {
  if (dir === 1) return cards.find((c) => c.startS > t + 1e-6)?.startS ?? null;
  for (let i = cards.length - 1; i >= 0; i--)
    if (cards[i]!.startS < t - 0.5) return cards[i]!.startS;
  return null;
}

export type CardFilter = "all" | "failed" | "issue" | "unchecked";

export function cardText(card: Card): string {
  return card.caption.state === "complete"
    ? `${card.caption.label} ${card.caption.hand} ${card.caption.text}`
    : card.caption.message;
}

export function filterCards(
  cards: readonly Card[],
  query: string,
  mode: CardFilter,
  /** SA-99 team marks; without them the Issue and Unchecked chips cannot narrow. */
  marks: MarkMap = new Map(),
): Card[] {
  const q = query.trim().toLowerCase();
  const chip = (c: Card) =>
    mode === "all"
      ? true
      : mode === "failed"
        ? c.caption.state === "failed"
        : passesMarkFilter(c.segmentId, mode, marks);
  return cards.filter(
    (c) => chip(c) && (q === "" || cardText(c).toLowerCase().includes(q)),
  );
}

export function clipAt<T extends { startS: number; endS: number }>(
  clips: readonly T[],
  t: number,
): T | null {
  return clips.find((c) => t >= c.startS && t < c.endS) ?? null;
}
