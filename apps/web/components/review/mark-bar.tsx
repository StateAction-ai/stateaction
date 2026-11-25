"use client";

import { useState } from "react";
import { Check, Flag } from "lucide-react";
import {
  ISSUE_TYPES,
  NOTE_MAX,
  type MarkChoice,
  type SegmentMarkRow,
} from "../../lib/review/marks";
import { cn } from "../../lib/utils";

/** The mark a segment card shows: Good, or the issue type. */
export function MarkBadge({ mark }: { mark: SegmentMarkRow | undefined }) {
  if (!mark)
    return (
      <span
        data-testid="mark-badge"
        data-mark="none"
        className="text-[11px] font-semibold text-muted"
      >
        Unchecked
      </span>
    );
  const issue = ISSUE_TYPES.find((t) => t.id === mark.issueType)?.label;
  const origin =
    mark.originJobId && mark.revision === 0 ? (
      <span className="font-normal text-muted">
        Marked on run {mark.originJobId.slice(0, 8)}
      </span>
    ) : null;
  return mark.verdict === "good" ? (
    <span
      data-testid="mark-badge"
      data-mark="good"
      className="inline-flex items-center gap-1 text-[11px] font-bold text-good"
    >
      <Check aria-hidden="true" size={12} /> Good {origin}
    </span>
  ) : (
    <span
      data-testid="mark-badge"
      data-mark="issue"
      className="inline-flex items-center gap-1 text-[11px] font-bold text-[#8a5a00]"
    >
      <Flag aria-hidden="true" size={12} /> {issue ?? "Issue"} {origin}
    </span>
  );
}

/**
 * Good (G), Issue (B) with an issue-type picker and an optional note, and Next
 * unchecked (N) for the selected segment. Every click appends a new mark
 * revision; nothing here edits a segment, caption or hand pose.
 */
export function MarkBar({
  mark,
  busy,
  loaded,
  error,
  onChoose,
  onNext,
}: {
  mark: SegmentMarkRow | undefined;
  busy: boolean;
  loaded: boolean;
  error: string | null;
  onChoose: (choice: MarkChoice) => void;
  onNext: () => void;
}) {
  const [draft, setDraft] = useState<{ for: string; text: string } | null>(
    null,
  );
  const key = `${mark?.segmentId ?? ""}:${mark?.revision ?? 0}`;
  const note = draft && draft.for === key ? draft.text : (mark?.note ?? "");
  const btn =
    "inline-flex min-h-[30px] items-center gap-1.5 rounded-lg border border-line bg-white px-2.5 text-xs font-semibold hover:bg-field disabled:opacity-60 max-md:min-h-[44px]";
  return (
    <div
      data-testid="mark-bar"
      className="col-span-full mt-2.5 border-t border-dashed border-line pt-2.5"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          data-testid="mark-good"
          aria-pressed={mark?.verdict === "good"}
          disabled={busy || !loaded}
          onClick={() => onChoose({ verdict: "good" })}
          className={cn(
            btn,
            mark?.verdict === "good" &&
              "border-[#bfe0cd] bg-[#e9f6ef] text-good",
          )}
        >
          Good <kbd className="font-mono text-[10px] text-muted">G</kbd>
        </button>
        <button
          type="button"
          data-testid="mark-issue"
          aria-pressed={mark?.verdict === "issue"}
          disabled={busy || !loaded}
          onClick={() => onChoose({ verdict: "issue" })}
          className={cn(
            btn,
            mark?.verdict === "issue" &&
              "border-[#f0d9a8] bg-[#fff4de] text-[#8a5a00]",
          )}
        >
          Issue <kbd className="font-mono text-[10px] text-muted">B</kbd>
        </button>
        <button
          type="button"
          data-testid="mark-next"
          onClick={onNext}
          className={cn(btn, "ml-auto")}
        >
          Next unchecked{" "}
          <kbd className="font-mono text-[10px] text-muted">N</kbd>
        </button>
      </div>
      {mark?.verdict === "issue" ? (
        <div
          className="mt-2 flex flex-wrap items-center gap-1.5"
          role="group"
          aria-label="What is wrong?"
        >
          <span className="text-xs text-muted">What is wrong?</span>
          {ISSUE_TYPES.filter((type) => type.id !== "caption").map((t) => (
            <button
              key={t.id}
              type="button"
              data-issue-type={t.id}
              aria-pressed={mark.issueType === t.id}
              disabled={busy}
              onClick={() => onChoose({ verdict: "issue", issueType: t.id })}
              className={cn(
                "rounded-lg border border-line bg-white px-2.5 py-[3px] text-xs font-semibold text-muted hover:bg-field max-md:min-h-[44px]",
                mark.issueType === t.id &&
                  "border-transparent bg-brand-soft text-brand-ink",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      ) : null}
      {mark ? (
        <form
          className="mt-2 flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            onChoose(
              mark.verdict === "issue"
                ? {
                    verdict: "issue",
                    ...(mark.issueType ? { issueType: mark.issueType } : {}),
                    note,
                  }
                : { verdict: "good", note },
            );
          }}
        >
          <input
            data-testid="mark-note"
            aria-label="Note"
            maxLength={NOTE_MAX}
            value={note}
            onChange={(e) => setDraft({ for: key, text: e.target.value })}
            placeholder="Optional note"
            className="min-h-[30px] min-w-0 flex-1 rounded-lg border border-line bg-white px-2 text-xs"
          />
          <button
            type="submit"
            disabled={busy || note === (mark.note ?? "")}
            className={btn}
          >
            Save note
          </button>
        </form>
      ) : null}
      {error ? (
        <p
          role="alert"
          data-testid="mark-error"
          className="m-0 mt-2 text-xs text-danger"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
