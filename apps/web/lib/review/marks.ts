// Pure model of the team check (SA-99): which segments carry a mark, counts,
// the Issue and Unchecked filters, the next unchecked segment and the G/B/N
// keys. Marks never edit model output; they are a separate append-only layer
// keyed by segment id.

import type {
  SegmentIssueType,
  SegmentMarkCommand,
  SegmentMarkRow,
  SegmentMarkVerdict,
} from "@stateaction/contracts";

export type { SegmentIssueType, SegmentMarkRow, SegmentMarkVerdict };

/** The newest mark per segment id. */
export type MarkMap = ReadonlyMap<string, SegmentMarkRow>;

export const ISSUE_TYPES: readonly {
  id: SegmentIssueType;
  label: string;
}[] = [
  { id: "boundary", label: "Boundary" },
  { id: "caption", label: "Caption" },
  { id: "hand_pose", label: "Hand pose" },
];

export const NOTE_MAX = 2000;

export const markMap = (rows: readonly SegmentMarkRow[]): MarkMap =>
  new Map(rows.map((r) => [r.segmentId, r]));

export type MarkCounts = { checked: number; issue: number };

/** Counts over the recording's segments only (a mark of another segment is ignored). */
export function markCounts(
  segmentIds: readonly string[],
  marks: MarkMap,
): MarkCounts {
  let checked = 0;
  let issue = 0;
  for (const id of segmentIds) {
    const m = marks.get(id);
    if (!m) continue;
    checked += 1;
    if (m.verdict === "issue") issue += 1;
  }
  return { checked, issue };
}

export const markSummary = (c: MarkCounts): string =>
  `${c.checked.toLocaleString()} checked, ${c.issue.toLocaleString()} issue`;

export type MarkFilter = "issue" | "unchecked";

/** Whether a segment passes the Issue or Unchecked chip. */
export function passesMarkFilter(
  segmentId: string,
  mode: MarkFilter,
  marks: MarkMap,
): boolean {
  const m = marks.get(segmentId);
  return mode === "issue" ? m?.verdict === "issue" : m === undefined;
}

/**
 * The next segment after `fromIndex` (wrapping) that has no mark and passes
 * `visible`; null when every visible segment is checked.
 */
export function nextUnchecked(
  segmentIds: readonly string[],
  marks: MarkMap,
  fromIndex: number,
  visible: (index: number) => boolean = () => true,
): number | null {
  const n = segmentIds.length;
  for (let k = 1; k <= n; k += 1) {
    const i = (((fromIndex + k) % n) + n) % n;
    if (!marks.has(segmentIds[i]!) && visible(i)) return i;
  }
  return null;
}

export type MarkKey = "good" | "issue" | "next";

/** G marks Good, B marks Issue, N jumps to the next unchecked segment. */
export function markKey(e: {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}): MarkKey | null {
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  switch (e.key) {
    case "g":
    case "G":
      return "good";
    case "b":
    case "B":
      return "issue";
    case "n":
    case "N":
      return "next";
    default:
      return null;
  }
}

/** What the reviewer chose for one segment. */
export type MarkChoice = {
  verdict: SegmentMarkVerdict;
  issueType?: SegmentIssueType;
  note?: string;
};

/**
 * The append-only command for one choice. `current` is the newest mark the
 * reviewer saw (expectedRevision). An Issue without a chosen type keeps the
 * previous issue type, else starts as "boundary" so the command is complete;
 * the reviewer can pick another type afterwards (a new revision). The note carries
 * over from the newest mark unless the choice sets it (blank clears it).
 */
export function buildMarkCommand(input: {
  markId: string;
  jobId: string;
  segmentsSha256: string;
  current: SegmentMarkRow | undefined;
  choice: MarkChoice;
}): SegmentMarkCommand {
  const { choice, current } = input;
  const base = {
    markId: input.markId,
    jobId: input.jobId,
    segmentsSha256: input.segmentsSha256,
    expectedRevision: current?.revision ?? 0,
    verdict: choice.verdict,
  } as const;
  // The previous note carries into the new revision unless explicitly cleared
  // (a blank string clears it).
  const typed = choice.note === undefined ? current?.note : choice.note;
  const note = typed?.trim() ? typed : undefined;
  const withNote = note ? { note } : {};
  if (choice.verdict === "good") return { ...base, ...withNote };
  const issueType: SegmentIssueType =
    choice.issueType ?? current?.issueType ?? "boundary";
  return { ...base, issueType, ...withNote };
}

/** A stored mark as the row the page keeps (drops the POST-only fields). */
export const rowOf = (m: {
  segmentId: string;
  revision: number;
  verdict: SegmentMarkVerdict;
  issueType: SegmentIssueType | null;
  note: string | null;
  createdAt: string;
}): SegmentMarkRow => ({
  segmentId: m.segmentId,
  revision: m.revision,
  verdict: m.verdict,
  issueType: m.issueType,
  note: m.note,
  createdAt: m.createdAt,
});

/**
 * True only for real text entry (input, textarea, select, contenteditable).
 * G, B and N stay live after a click on a rail card or the Good button.
 */
export function isTextEntryTarget(
  el: { tagName?: string; isContentEditable?: boolean } | null,
): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName?.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select";
}
