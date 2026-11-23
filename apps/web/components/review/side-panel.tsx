"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { ClipViewer } from "../rerun/clip-viewer";
import type { ClipViewerState } from "../../lib/rerun/clip-viewer";
import type {
  Card,
  RecordingAnnotations,
  ReviewModel,
} from "../../lib/review/types";
import { clipAt, fmtClock, type CardFilter } from "../../lib/review/timeline";
import { cn } from "../../lib/utils";
import type { MarksState } from "../../lib/review/use-marks";
import type { MarkChoice, SegmentMarkRow } from "../../lib/review/marks";
import { MarkBadge, MarkBar } from "./mark-bar";
import { HAND_COLORS } from "./palette";

export type SideTab = "segs" | "hand" | "json";

const TABS: { id: SideTab; label: string }[] = [
  { id: "segs", label: "Segments" },
  { id: "hand", label: "Hand pose" },
  { id: "json", label: "JSON" },
];

/** JSON shown in the tab is capped; the download always carries the full document. */
export const JSON_VIEW_LIMIT = 200_000;

export function SidePanel({
  model,
  annotations,
  tab,
  onTab,
  cards,
  total,
  query,
  onQuery,
  filter,
  onFilter,
  selected,
  activeIndex,
  t,
  onSelect,
  mediaOrigin,
  queryRef,
  marks,
  checkedCount,
  issueCount,
  onChoose,
  onNextUnchecked,
}: {
  model: ReviewModel;
  annotations: RecordingAnnotations;
  tab: SideTab;
  onTab: (tab: SideTab) => void;
  /** Cards that pass the text filter and chip. */
  cards: Card[];
  total: number;
  query: string;
  onQuery: (q: string) => void;
  filter: CardFilter;
  onFilter: (f: CardFilter) => void;
  selected: number | null;
  activeIndex: number;
  t: number;
  onSelect: (index: number) => void;
  mediaOrigin: string | null;
  queryRef: React.RefObject<HTMLInputElement | null>;
  /** SA-99 team check. */
  marks: MarksState;
  checkedCount: number;
  issueCount: number;
  onChoose: (card: Card, choice: MarkChoice) => void;
  onNextUnchecked: () => void;
}) {
  const failedTotal = model.cards.filter(
    (c) => c.caption.state === "failed",
  ).length;
  return (
    <aside
      aria-label="Review side panel"
      className="flex h-[640px] min-h-[560px] flex-col overflow-hidden rounded-2xl border border-line bg-paper shadow-[0_6px_25px_#21332a06] xl:sticky xl:top-5 xl:h-[calc(100vh-40px)]"
    >
      <div
        role="tablist"
        aria-label="Review panes"
        className="flex gap-1 overflow-x-auto border-b border-line bg-paper px-3"
      >
        {TABS.map((x) => (
          <button
            key={x.id}
            type="button"
            role="tab"
            id={`tab-${x.id}`}
            aria-selected={tab === x.id}
            aria-controls={`pane-${x.id}`}
            onClick={() => onTab(x.id)}
            className={cn(
              "-mb-px min-h-[52px] border-0 border-b-2 border-transparent bg-transparent px-2.5 text-[13px] font-semibold whitespace-nowrap text-muted",
              tab === x.id && "border-brand text-brand-ink",
            )}
          >
            {x.label}
          </button>
        ))}
        <span
          data-testid="rail-counter"
          title="selected / total"
          className="ml-auto self-center rounded-md bg-[#eef0ec] px-2 py-0.5 font-mono text-xs font-semibold text-[#4d5a54]"
        >
          #{selected === null ? "–" : selected + 1}/{total.toLocaleString()}
        </span>
      </div>

      {tab === "segs" ? (
        <div
          role="tabpanel"
          id="pane-segs"
          aria-labelledby="tab-segs"
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="px-4 pt-3">
            <label className="flex min-h-[34px] items-center gap-2 rounded-lg border border-line bg-white px-2.5 text-[13px]">
              <Search aria-hidden="true" size={14} className="text-muted" />
              <input
                ref={queryRef}
                value={query}
                onChange={(e) => onQuery(e.target.value)}
                placeholder="Filter captions  /"
                aria-label="Filter captions by text"
                className="min-w-0 flex-1 border-0 bg-transparent outline-0"
              />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-4 py-3">
            {(["all", "failed", "issue", "unchecked"] as const).map((f) => (
              <button
                key={f}
                type="button"
                data-filter={f}
                aria-pressed={filter === f}
                onClick={() => onFilter(f)}
                className={cn(
                  "rounded-lg border border-line bg-white px-2.5 py-[3px] text-xs font-semibold text-muted hover:bg-field",
                  filter === f &&
                    "border-transparent bg-brand-soft text-brand-ink",
                )}
              >
                {f === "all"
                  ? "All"
                  : f === "failed"
                    ? `Failed ${failedTotal}`
                    : f === "issue"
                      ? `Issue ${issueCount}`
                      : `Unchecked ${Math.max(0, total - checkedCount)}`}
              </button>
            ))}
            <span
              data-testid="rail-shown"
              className="ml-auto text-xs text-muted"
            >
              {cards.length.toLocaleString()} shown
            </span>
          </div>
          <Rail
            cards={cards}
            total={total}
            selected={selected}
            activeIndex={activeIndex}
            onSelect={onSelect}
            marks={marks}
            onChoose={onChoose}
            onNextUnchecked={onNextUnchecked}
          />
        </div>
      ) : null}

      {tab === "hand" ? (
        <div
          role="tabpanel"
          id="pane-hand"
          aria-labelledby="tab-hand"
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4"
        >
          <HandPane
            model={model}
            t={t}
            selected={selected}
            mediaOrigin={mediaOrigin}
          />
        </div>
      ) : null}

      {tab === "json" ? (
        <div
          role="tabpanel"
          id="pane-json"
          aria-labelledby="tab-json"
          className="flex min-h-0 flex-1 flex-col"
        >
          <JsonPane annotations={annotations} selected={selected} />
        </div>
      ) : null}

      <div
        data-testid="provenance"
        className="flex flex-wrap gap-1.5 border-t border-line bg-field px-3 py-2.5"
      >
        {model.provenance.map((b) => (
          <span
            key={b.stage}
            title={b.detail}
            data-tone={b.tone}
            className={cn(
              "rounded-md border bg-white px-1.5 py-px font-mono text-[10.5px] font-semibold text-[#4d5a54]",
              b.tone === "absent"
                ? "border-[#edc8cc] text-danger"
                : "border-line",
              (b.tone === "replay" || b.tone === "stub") && "text-[#8a5a00]",
            )}
          >
            {b.text}
          </span>
        ))}
        <span className="rounded-md border border-line bg-white px-1.5 py-px font-mono text-[10.5px] font-semibold text-[#4d5a54]">
          {model.derivedRule
            ? `derived: ${model.derivedRule}`
            : "no derived fields"}
        </span>
      </div>
    </aside>
  );
}

function Rail({
  cards,
  total,
  selected,
  activeIndex,
  onSelect,
  marks,
  onChoose,
  onNextUnchecked,
}: {
  cards: Card[];
  total: number;
  selected: number | null;
  activeIndex: number;
  onSelect: (index: number) => void;
  marks: MarksState;
  onChoose: (card: Card, choice: MarkChoice) => void;
  onNextUnchecked: () => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  // The active card follows the playhead.
  useEffect(() => {
    if (activeIndex < 0) return;
    const el = list.current?.querySelector<HTMLElement>(
      `[data-index="${activeIndex}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);
  // A card chosen from the tiers scrolls into view as well.
  useEffect(() => {
    if (selected === null) return;
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${selected}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  return (
    <div
      ref={list}
      data-testid="rail-list"
      className="min-h-0 flex-1 overflow-auto px-3 pt-3 pb-5"
    >
      {cards.length === 0 ? (
        <p className="p-5 text-center text-xs text-muted">No segments match.</p>
      ) : (
        cards.map((c) => (
          <RailCard
            key={c.segmentId}
            card={c}
            total={total}
            selected={selected === c.index}
            active={activeIndex === c.index}
            onSelect={onSelect}
            mark={marks.marks.get(c.segmentId)}
            marks={marks}
            onChoose={onChoose}
            onNextUnchecked={onNextUnchecked}
          />
        ))
      )}
    </div>
  );
}

function RailCard({
  card: c,
  total,
  selected,
  active,
  onSelect,
  mark,
  marks,
  onChoose,
  onNextUnchecked,
}: {
  card: Card;
  total: number;
  selected: boolean;
  active: boolean;
  onSelect: (index: number) => void;
  mark: SegmentMarkRow | undefined;
  marks: MarksState;
  onChoose: (card: Card, choice: MarkChoice) => void;
  onNextUnchecked: () => void;
}) {
  const failed = c.caption.state === "failed";
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="rail-card"
      data-index={c.index}
      data-active={active ? "true" : undefined}
      data-selected={selected ? "true" : undefined}
      data-failed={failed ? "true" : undefined}
      aria-current={active ? "true" : undefined}
      aria-expanded={selected}
      onClick={() => onSelect(c.index)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(c.index);
        }
      }}
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 96px" }}
      className={cn(
        "relative mb-2.5 grid cursor-pointer grid-cols-[62px_minmax(0,1fr)] gap-x-2.5 rounded-lg border border-line bg-field px-3 py-2.5 hover:border-[#cdd6cf] hover:bg-white",
        active &&
          "border-[#f0d9a8] bg-[#fff8e1] before:absolute before:top-2.5 before:bottom-2.5 before:-left-px before:w-[3px] before:rounded before:bg-[#e0a100]",
        selected && "border-brand bg-white shadow-[0_0_0_3px_#eaf0fc]",
      )}
    >
      <div className="font-mono text-xs leading-tight font-semibold">
        {fmtClock(c.startS)}
        <small className="block text-[10.5px] font-medium text-muted">
          #{c.index + 1}/{total.toLocaleString()}
        </small>
        <div className="mt-1">
          <MarkBadge mark={mark} />
        </div>
      </div>
      <div className="min-w-0">
        {c.caption.state === "complete" ? (
          <>
            <span
              data-testid="hand-chip"
              className="inline-flex max-w-full items-center truncate rounded-md px-2 py-px text-xs font-bold whitespace-nowrap"
              style={{
                background: HAND_COLORS[c.caption.hand].bg,
                color: HAND_COLORS[c.caption.hand].ink,
              }}
            >
              {c.caption.label} · {c.caption.hand}
            </span>
            {c.derivedLocally ? (
              <span className="ml-1.5 text-[10.5px] text-muted">
                derived locally
              </span>
            ) : null}
            <ul className="m-0 mt-1.5 list-disc pl-4 text-[13px] leading-snug text-ink marker:text-muted">
              {c.caption.steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </>
        ) : (
          <p
            data-testid="rail-failed"
            className="m-0 inline-flex items-center rounded-md bg-danger-soft px-2 py-0.5 text-[13px] font-semibold text-danger"
          >
            {c.caption.message}
          </p>
        )}
      </div>
      {selected ? (
        <dl
          data-testid="rail-detail"
          className="col-span-full m-0 mt-2.5 grid grid-cols-[auto_1fr] gap-x-4 border-t border-dashed border-line pt-2.5 text-xs"
        >
          <dt className="py-[3px] text-muted">Span</dt>
          <dd className="m-0 py-[3px] text-right font-mono">
            {fmtClock(c.startS)}–{fmtClock(c.endS)} ·{" "}
            {(c.endS - c.startS).toFixed(1)} s
          </dd>
          <dt className="py-[3px] text-muted">Source frames</dt>
          <dd className="m-0 py-[3px] text-right font-mono">
            {c.startFrameId} → {c.endFrameId ?? "end of stream"}
          </dd>
          <dt className="py-[3px] text-muted">Hands L/R</dt>
          <dd className="m-0 py-[3px] text-right font-mono">
            {pctText(c.handsLR.left, c.handsLR.partial)} /{" "}
            {pctText(c.handsLR.right, c.handsLR.partial)}
          </dd>
        </dl>
      ) : null}
      {selected ? (
        <MarkBar
          mark={mark}
          busy={marks.busy}
          loaded={marks.loaded}
          error={marks.error}
          onChoose={(choice) => onChoose(c, choice)}
          onNext={onNextUnchecked}
        />
      ) : null}
    </div>
  );
}

/** null is unknown (no hand-pose coverage), never 0 %; * marks failed or uncovered time left out. */
const pctText = (v: number | null, partial = false) =>
  v === null ? "unknown" : `${v}%${partial ? "*" : ""}`;

function HandPane({
  model,
  t,
  selected,
  mediaOrigin,
}: {
  model: ReviewModel;
  t: number;
  selected: number | null;
  mediaOrigin: string | null;
}) {
  // The clip containing the playhead. Only the clip id changes the viewer, so
  // playback inside one clip never reloads it.
  const clip = useMemo(() => clipAt(model.clips, t), [model.clips, t]);
  const card = selected === null ? null : model.cards[selected];
  const [phase, setPhase] = useState<ClipViewerState["phase"]>("idle");
  return (
    <>
      {clip ? (
        <>
          <ClipViewer
            key={clip.clipId}
            clipId={clip.clipId}
            allowedOrigins={mediaOrigin ? [mediaOrigin] : []}
            onStateChange={(s) => setPhase(s.phase)}
          />
          <output
            data-testid="hand-viewer-phase"
            data-clip-id={clip.clipId}
            className="sr-only"
          >
            {phase}
          </output>
        </>
      ) : (
        <div
          role="status"
          data-testid="hand-no-clip"
          className="grid min-h-60 place-items-center rounded-lg border border-line bg-field p-6 text-center text-sm text-muted"
        >
          No clip at this time
        </div>
      )}
      <p className="m-0 text-xs leading-normal text-muted">
        <b className="text-ink">Clip under the playhead.</b> Hand pose is
        previewed per clip; no-hand frames show no hand, never a filled-in pose.
      </p>
      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 text-[13px]">
        <HandRow k="Clip">
          <span className="font-mono">
            {clip ? `${fmtClock(clip.startS)}–${fmtClock(clip.endS)}` : "none"}
          </span>
        </HandRow>
        <HandRow k="Left / right now">
          {model.presence === "absent"
            ? `unavailable${model.presenceNote ? ` (${model.presenceNote})` : ""}`
            : `${state(model.lanes.left, t)} / ${state(model.lanes.right, t)}`}
        </HandRow>
        <HandRow k="This segment">
          <span className="font-mono">
            {card
              ? `L ${pctText(card.handsLR.left, card.handsLR.partial)} · R ${pctText(card.handsLR.right, card.handsLR.partial)}`
              : "select a segment"}
          </span>
        </HandRow>
      </dl>
    </>
  );
}

function state(spans: ReviewModel["lanes"]["left"], t: number) {
  const s = spans.find((x) => t >= x.startS && t < x.endS);
  return s ? (s.state === "present" ? "present" : "no result") : "no hand";
}

function HandRow({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="border-b border-line py-1.5 text-muted">{k}</dt>
      <dd className="m-0 border-b border-line py-1.5 text-right font-medium">
        {children}
      </dd>
    </>
  );
}

export function annotationsJson(
  annotations: RecordingAnnotations,
  limit = Infinity,
): { text: string; truncated: boolean } {
  const full = JSON.stringify(annotations, null, 2);
  return full.length > limit
    ? { text: full.slice(0, limit), truncated: true }
    : { text: full, truncated: false };
}

function JsonPane({
  annotations,
  selected,
}: {
  annotations: RecordingAnnotations;
  selected: number | null;
}) {
  const [mode, setMode] = useState<"segment" | "recording">("recording");
  const [copied, setCopied] = useState(false);
  const view = useMemo(() => {
    if (mode === "segment" && selected !== null) {
      const row = annotations.segments?.rows[selected];
      const caption = annotations.captions?.rows.find(
        (c) => c.segment_id === row?.segment_id,
      );
      const text = JSON.stringify(
        { segment: row ?? null, caption: caption ?? null },
        null,
        2,
      );
      return { text, truncated: false };
    }
    return annotationsJson(annotations, JSON_VIEW_LIMIT);
  }, [annotations, mode, selected]);
  return (
    <>
      <div className="flex items-center gap-2 border-b border-line px-5 py-3 text-[13px] text-muted">
        <div className="flex gap-0.5 rounded-lg border border-line bg-white p-[3px]">
          {(["segment", "recording"] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
              className={cn(
                "rounded-md border-0 bg-transparent px-3 py-1 text-xs font-semibold text-muted hover:bg-field",
                mode === m && "bg-brand-soft text-brand-ink",
              )}
            >
              {m === "segment" ? "Segment" : "Recording"}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard
              ?.writeText(view.text)
              .then(() => setCopied(true))
              .catch(() => undefined);
          }}
          className="ml-auto min-h-[30px] rounded-lg border border-line bg-white px-2.5 text-xs font-semibold text-ink hover:bg-field"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {view.truncated ? (
        <p className="m-0 border-b border-line bg-[#fff4de] px-5 py-2 text-xs text-[#8a5a00]">
          Showing the first {JSON_VIEW_LIMIT.toLocaleString()} characters.
          Download JSON saves the full document.
        </p>
      ) : null}
      <pre
        data-testid="json-view"
        className="m-0 min-h-0 flex-1 overflow-auto bg-field px-5 py-4 font-mono text-xs leading-relaxed whitespace-pre text-[#3d4a45]"
      >
        {view.text}
      </pre>
    </>
  );
}
