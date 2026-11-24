"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { recipeHref } from "../../lib/recipe-view";
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
  segmentationFailure,
  linkProvenance,
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
  segmentationFailure: string | null;
  linkProvenance: boolean;
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
    <section
      aria-label="Review side panel"
      className="flex min-w-0 flex-col rounded-2xl border border-line bg-paper shadow-[0_6px_25px_#21332a06] xl:sticky xl:top-5 xl:h-[max(560px,calc(100vh-40px))] xl:overflow-hidden"
    >
      <div
        role="tablist"
        aria-label="Review panes"
        className="flex shrink-0 flex-wrap gap-1 rounded-t-2xl border-b border-line bg-paper px-3"
      >
        {TABS.map((x, index) => (
          <button
            key={x.id}
            type="button"
            role="tab"
            id={`tab-${x.id}`}
            aria-selected={tab === x.id}
            aria-controls={`pane-${x.id}`}
            tabIndex={tab === x.id ? 0 : -1}
            onKeyDown={(e) => {
              const next =
                e.key === "Home"
                  ? 0
                  : e.key === "End"
                    ? TABS.length - 1
                    : e.key === "ArrowLeft"
                      ? (index + TABS.length - 1) % TABS.length
                      : e.key === "ArrowRight"
                        ? (index + 1) % TABS.length
                        : null;
              if (next === null) return;
              e.preventDefault();
              const id = TABS[next]!.id;
              onTab(id);
              document.getElementById(`tab-${id}`)?.focus();
            }}
            onClick={() => onTab(x.id)}
            className={cn(
              "-mb-px min-h-[52px] border-0 border-b-2 border-transparent bg-transparent px-2.5 text-[13px] font-semibold whitespace-nowrap text-muted",
              tab === x.id && "border-brand text-brand-ink",
            )}
          >
            {x.label}
          </button>
        ))}
      </div>
      {TABS.filter((pane) => pane.id !== tab).map((pane) => (
        <div
          key={pane.id}
          role="tabpanel"
          id={`pane-${pane.id}`}
          aria-labelledby={`tab-${pane.id}`}
          hidden
        />
      ))}

      {tab === "segs" ? (
        <div
          role="tabpanel"
          id="pane-segs"
          aria-labelledby="tab-segs"
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="px-4 pt-3">
            <label className="flex min-h-11 items-center gap-2 rounded-lg border border-line bg-white px-2.5 text-[13px]">
              <Search aria-hidden="true" size={14} className="text-muted" />
              <input
                ref={queryRef}
                value={query}
                onChange={(e) => onQuery(e.target.value)}
                placeholder="Search captions"
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
                  "rounded-lg border border-line bg-white px-2.5 min-h-11 text-xs font-semibold text-muted hover:bg-field",
                  filter === f &&
                    "border-transparent bg-brand-soft text-brand-ink",
                )}
              >
                {f === "all"
                  ? "All"
                  : f === "failed"
                    ? `Failed ${failedTotal}`
                    : f === "issue"
                      ? `Flagged ${issueCount}`
                      : `Unreviewed ${Math.max(0, total - checkedCount)}`}
              </button>
            ))}
            <span
              data-testid="rail-shown"
              className="ml-auto text-xs text-muted"
            >
              {cards.length.toLocaleString()} of {total.toLocaleString()} shown
            </span>
          </div>
          <p
            className="m-0 px-4 pt-2 text-xs text-muted"
            data-testid="rail-counter"
          >
            {selected === null
              ? "Select a segment to see details and review controls."
              : `Segment ${selected + 1} of ${total.toLocaleString()} selected`}
          </p>
          <Rail
            cards={cards}
            emptyText={
              segmentationFailure
                ? "Segmentation failed. " + segmentationFailure
                : !annotations.segments
                  ? "No segmentation results were recorded."
                  : total === 0
                    ? "No segments were found."
                    : "No segments match."
            }
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
        className="flex shrink-0 flex-wrap gap-1.5 rounded-b-2xl border-t border-line bg-field px-3 py-2.5"
      >
        {model.provenance.map((badge) => {
          const run = linkProvenance ? annotations.dag_run : null;
          const chip = {
            title: badge.detail,
            "data-tone": badge.tone,
            className: cn(
              "rounded-md border bg-white px-1.5 py-px font-mono text-[10.5px] font-semibold text-[#4d5a54]",
              badge.tone === "absent"
                ? "border-[#edc8cc] text-danger"
                : "border-line",
              (badge.tone === "replay" || badge.tone === "stub") &&
                "text-[#8a5a00]",
              run && "underline underline-offset-2",
            ),
          };
          return run ? (
            <Link
              key={badge.stage}
              {...chip}
              href={recipeHref(run.recipeId, annotations.job_id, {
                stage: badge.stage,
              })}
            >
              {badge.text}
            </Link>
          ) : (
            <span key={badge.stage} {...chip}>
              {badge.text}
            </span>
          );
        })}
        <span className="rounded-md border border-line bg-white px-1.5 py-px font-mono text-[10.5px] font-semibold text-[#4d5a54]">
          {model.derivedRule
            ? `derived: ${model.derivedRule}`
            : "no derived fields"}
        </span>
      </div>
    </section>
  );
}

function Rail({
  cards,
  emptyText,
  selected,
  activeIndex,
  onSelect,
  marks,
  onChoose,
  onNextUnchecked,
}: {
  cards: Card[];
  emptyText: string;
  selected: number | null;
  activeIndex: number;
  onSelect: (index: number) => void;
  marks: MarksState;
  onChoose: (card: Card, choice: MarkChoice) => void;
  onNextUnchecked: () => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const reveal = useCallback((index: number | null) => {
    const container = list.current;
    if (
      index === null ||
      !container ||
      container.scrollHeight <= container.clientHeight
    )
      return;
    const element = container.querySelector<HTMLElement>(
      `[data-index="${index}"]`,
    );
    if (!element) return;
    const viewport = container.getBoundingClientRect();
    const card = element.getBoundingClientRect();
    if (card.top < viewport.top || card.height > viewport.height) {
      container.scrollTop += card.top - viewport.top;
    } else if (card.bottom > viewport.bottom) {
      container.scrollTop += card.bottom - viewport.bottom;
    }
  }, []);
  useEffect(() => reveal(activeIndex), [activeIndex, reveal]);
  useEffect(() => reveal(selected), [selected, reveal]);
  return (
    <div
      ref={list}
      data-testid="rail-list"
      className="min-h-0 flex-1 px-3 pt-3 pb-5 xl:overflow-auto"
    >
      {cards.length === 0 ? (
        <p className="p-5 text-center text-xs text-muted">{emptyText}</p>
      ) : (
        cards.map((c) => (
          <RailCard
            key={c.segmentId}
            card={c}
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
  selected,
  active,
  onSelect,
  mark,
  marks,
  onChoose,
  onNextUnchecked,
}: {
  card: Card;
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
    <article
      data-testid="rail-card"
      data-index={c.index}
      data-active={active ? "true" : undefined}
      data-selected={selected ? "true" : undefined}
      data-failed={failed ? "true" : undefined}
      aria-current={active ? "true" : undefined}
      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 96px" }}
      className={cn(
        "relative mb-2.5 grid grid-cols-[62px_minmax(0,1fr)] gap-x-2.5 rounded-lg border border-line bg-field px-3 py-2.5 hover:border-[#cdd6cf] hover:bg-white focus-within:border-brand",
        active &&
          "border-[#f0d9a8] bg-[#fff8e1] before:absolute before:top-2.5 before:bottom-2.5 before:-left-px before:w-[3px] before:rounded before:bg-[#e0a100]",
        selected && "border-brand bg-white shadow-[0_0_0_3px_#eaf0fc]",
      )}
    >
      <button
        type="button"
        id={`review-segment-${c.index}`}
        className="col-span-full mb-2 min-h-11 cursor-pointer rounded-md border border-line bg-white px-2 text-left text-xs font-semibold text-brand-ink hover:bg-brand-soft"
        aria-expanded={selected}
        onClick={() => onSelect(c.index)}
      >
        Segment {c.index + 1} · {fmtClock(c.startS)}
      </button>
      <div className="font-mono text-xs leading-tight font-semibold">
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
            <span
              title={c.caption.code}
              aria-description={`Error code: ${c.caption.code}`}
            >
              {c.kind === "failed_window"
                ? "No segments could be produced for this time range."
                : "No caption is available for this segment."}
            </span>
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
          <dt className="py-[3px] text-muted">Left / right hand</dt>
          <dd className="m-0 py-[3px] text-right font-mono">
            {pctText(c.handsLR.left, c.handsLR.partial)} /{" "}
            {pctText(c.handsLR.right, c.handsLR.partial)}
          </dd>
          {c.handsLR.partial ? (
            <dd className="col-span-full m-0 text-muted">
              * Based on frames with hand pose results.
            </dd>
          ) : null}
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
    </article>
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
              ? `${pctText(card.handsLR.left, card.handsLR.partial)} / ${pctText(card.handsLR.right, card.handsLR.partial)} left / right`
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
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3 text-[13px] text-muted">
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
