"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import type {
  Card,
  RecordingAnnotations,
  ReviewModel,
} from "../../lib/review/types";
import { fmtClock, type CardFilter } from "../../lib/review/timeline";
import { cn } from "../../lib/utils";
import type { MarksState } from "../../lib/review/use-marks";
import type { MarkChoice, SegmentMarkRow } from "../../lib/review/marks";
import { MarkBadge, MarkBar } from "./mark-bar";
import { recipeHref } from "../../lib/recipe-view";

export type SideTab = "segs" | "decision";

export function SidePanel({
  embedded = false,
  model,
  staff,
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
  onSelect,
  seekCount,
  queryRef,
  marks,
  checkedCount,
  issueCount,
  onChoose,
  onNextUnchecked,
  decision,
  captionEditor,
}: {
  embedded?: boolean;
  model: ReviewModel;
  staff?: RecordingAnnotations | undefined;
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
  onSelect: (index: number) => void;
  seekCount: number;
  queryRef: React.RefObject<HTMLInputElement | null>;
  /** SA-99 team check. */
  marks: MarksState;
  checkedCount: number;
  issueCount: number;
  onChoose: ((card: Card, choice: MarkChoice) => void) | undefined;
  onNextUnchecked: () => void;
  decision?: React.ReactNode;
  captionEditor?: ((card: Card) => React.ReactNode) | undefined;
}) {
  const [suspendedAtSeek, setSuspendedAtSeek] = useState<number | null>(null);
  const following = suspendedAtSeek !== seekCount;
  const suspendFollow = useCallback(
    () => setSuspendedAtSeek(seekCount),
    [seekCount],
  );
  const tabs: { id: SideTab; label: string }[] = [
    { id: "segs", label: "Segments" },
  ];
  if (decision) tabs.push({ id: "decision", label: "Review actions" });
  const failedTotal = model.cards.filter(
    (c) => c.caption.state === "failed",
  ).length;
  return (
    <section
      aria-label="Review side panel"
      className={cn(
        "flex min-w-0 flex-col rounded-2xl border border-line bg-paper shadow-[0_6px_25px_#21332a06]",
        !embedded &&
          "xl:sticky xl:top-5 xl:h-[max(560px,calc(100vh-40px))] xl:overflow-hidden",
      )}
    >
      <div
        role="tablist"
        aria-label="Review panes"
        className="flex shrink-0 flex-wrap gap-1 rounded-t-2xl border-b border-line bg-paper px-3"
      >
        {tabs.map((x, index) => (
          <button
            key={x.id}
            type="button"
            role="tab"
            id={`tab-${x.id}`}
            aria-selected={tab === x.id}
            tabIndex={tab === x.id ? 0 : -1}
            aria-controls={`pane-${x.id}`}
            onKeyDown={(e) => {
              const next =
                e.key === "Home"
                  ? 0
                  : e.key === "End"
                    ? tabs.length - 1
                    : e.key === "ArrowLeft"
                      ? (index + tabs.length - 1) % tabs.length
                      : e.key === "ArrowRight"
                        ? (index + 1) % tabs.length
                        : null;
              if (next === null) return;
              e.preventDefault();
              const id = tabs[next]!.id;
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
      {tabs
        .filter((pane) => pane.id !== tab && pane.id !== "decision")
        .map((pane) => (
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
            {(staff
              ? (["all", "failed", "issue", "unchecked"] as const)
              : (["all"] as const)
            ).map((f) => (
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
            <button
              type="button"
              aria-pressed={following}
              onClick={() => setSuspendedAtSeek(following ? seekCount : null)}
              className={cn(
                "min-h-11 rounded-lg border border-line bg-white px-2.5 text-xs font-semibold text-muted hover:bg-field",
                following && "border-transparent bg-brand-soft text-brand-ink",
              )}
            >
              Follow playback
            </button>
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
              ? staff
                ? "Select a segment to review it."
                : "Select a segment to play it."
              : `Segment ${selected + 1} of ${total.toLocaleString()} selected`}
          </p>
          <Rail
            embedded={embedded}
            cards={cards}
            emptyText={
              segmentationFailure
                ? "Segmentation failed. " + segmentationFailure
                : staff && !staff.segments
                  ? "No segmentation results were recorded."
                  : total === 0
                    ? "No segments were found."
                    : "No segments match."
            }
            selected={selected}
            activeIndex={activeIndex}
            following={following}
            seekCount={seekCount}
            onManualScroll={suspendFollow}
            onSelect={onSelect}
            marks={marks}
            onChoose={onChoose}
            onNextUnchecked={onNextUnchecked}
            staff={Boolean(staff)}
            captionEditor={captionEditor}
          />
        </div>
      ) : null}

      {decision ? (
        <div
          role="tabpanel"
          id="pane-decision"
          aria-labelledby="tab-decision"
          hidden={tab !== "decision"}
          className="min-h-0 flex-1 overflow-auto"
        >
          {decision}
        </div>
      ) : null}

      {staff && model.provenance.length ? (
        <div
          data-testid="provenance"
          className="flex shrink-0 flex-wrap gap-1.5 rounded-b-2xl border-t border-line bg-field px-3 py-2.5"
        >
          {model.provenance.map((badge) => {
            const run = linkProvenance ? staff.dag_run : null;
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
                href={recipeHref(run.recipeId, staff.job_id, {
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
        </div>
      ) : null}
    </section>
  );
}

function Rail({
  embedded,
  cards,
  emptyText,
  selected,
  activeIndex,
  following,
  seekCount,
  onManualScroll,
  onSelect,
  marks,
  onChoose,
  onNextUnchecked,
  staff,
  captionEditor,
}: {
  embedded?: boolean;
  cards: Card[];
  emptyText: string;
  selected: number | null;
  activeIndex: number;
  following: boolean;
  seekCount: number;
  onManualScroll: () => void;
  onSelect: (index: number) => void;
  marks: MarksState;
  onChoose: ((card: Card, choice: MarkChoice) => void) | undefined;
  onNextUnchecked: () => void;
  staff: boolean;
  captionEditor: ((card: Card) => React.ReactNode) | undefined;
}) {
  const list = useRef<HTMLDivElement>(null);
  const followPosition = useRef(0);
  const pageFollowPosition = useRef<number | null>(null);

  useEffect(() => {
    const rail = list.current;
    if (!following || !rail) return;
    const card = rail.querySelector<HTMLElement>(
      '[data-index="' + activeIndex + '"]',
    );
    if (!card) return;
    const desktop = getComputedStyle(rail).overflowY === "auto";
    if (!desktop && !railIsInView(rail)) return;

    const align = () => {
      const cardTop = card.getBoundingClientRect().top;
      if (desktop) {
        rail.scrollTop += cardTop - rail.getBoundingClientRect().top - 12;
        followPosition.current = rail.scrollTop;
      } else {
        window.scrollBy({ top: cardTop - pageRailTop(), behavior: "instant" });
        pageFollowPosition.current = window.scrollY;
      }
    };
    align();
    if (desktop) {
      // Offscreen cards use estimated heights until they enter the desktop viewport.
      const settle = requestAnimationFrame(align);
      return () => cancelAnimationFrame(settle);
    }
  }, [activeIndex, cards, following, seekCount]);

  useEffect(() => {
    const rail = list.current;
    if (!rail || !following) return;
    const onPageScroll = () => {
      if (getComputedStyle(rail).overflowY === "auto") return;
      if (window.scrollY === pageFollowPosition.current || !railIsInView(rail))
        return;
      pageFollowPosition.current = null;
      onManualScroll();
    };
    window.addEventListener("scroll", onPageScroll, { passive: true });
    return () => window.removeEventListener("scroll", onPageScroll);
  }, [following, onManualScroll]);
  return (
    <div
      ref={list}
      data-testid="rail-list"
      tabIndex={0}
      role="region"
      aria-label="Caption list"
      onScroll={(e) => {
        if (e.currentTarget.scrollTop !== followPosition.current)
          onManualScroll();
      }}
      className={cn(
        "min-h-0 flex-1 px-3 pt-3 pb-5 [overflow-anchor:none]",
        embedded ? "max-h-[30rem] overflow-auto" : "xl:overflow-auto",
      )}
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
            staff={staff}
            showDetails={staff || Boolean(embedded)}
            captionEditor={captionEditor}
          />
        ))
      )}
    </div>
  );
}

function pageRailTop() {
  const player = document.querySelector<HTMLElement>(
    '[data-testid="review-player"]',
  );
  const sticky = player && getComputedStyle(player).position === "sticky";
  return sticky ? Math.max(12, player.getBoundingClientRect().bottom + 12) : 12;
}

function railIsInView(rail: HTMLElement) {
  const bounds = rail.getBoundingClientRect();
  return bounds.top < window.innerHeight - 48 && bounds.bottom > pageRailTop();
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
  staff,
  showDetails,
  captionEditor,
}: {
  card: Card;
  selected: boolean;
  active: boolean;
  onSelect: (index: number) => void;
  mark: SegmentMarkRow | undefined;
  marks: MarksState;
  onChoose: ((card: Card, choice: MarkChoice) => void) | undefined;
  onNextUnchecked: () => void;
  staff: boolean;
  showDetails: boolean;
  captionEditor: ((card: Card) => React.ReactNode) | undefined;
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
      className={cn(
        "relative mb-2.5 grid grid-cols-[62px_minmax(0,1fr)] gap-x-2.5 rounded-lg border border-line bg-field px-3 py-2.5 hover:border-[#cdd6cf] hover:bg-white focus-within:border-brand xl:[contain-intrinsic-size:auto_96px] xl:[content-visibility:auto]",
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
      {staff ? (
        <div className="mt-1 font-mono text-xs leading-tight">
          <MarkBadge mark={mark} />
        </div>
      ) : null}
      <div className={cn("min-w-0", !staff && "col-span-full")}>
        {c.caption.state === "complete" ? (
          <p className="m-0 text-[13px] leading-snug text-ink">
            {c.caption.text}
          </p>
        ) : c.caption.state === "omitted" ? (
          <p className="m-0 text-xs text-muted">Caption not needed</p>
        ) : (
          <p
            data-testid="rail-failed"
            className="m-0 rounded-md bg-danger-soft px-2 py-1 text-xs font-semibold text-danger"
            title={staff ? c.caption.code : undefined}
          >
            {c.kind === "failed_window"
              ? "No segments could be produced for this time range."
              : "No caption is available for this segment."}
          </p>
        )}
      </div>
      {selected && showDetails ? (
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
      {selected && c.kind === "segment" ? captionEditor?.(c) : null}
      {selected && onChoose ? (
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
