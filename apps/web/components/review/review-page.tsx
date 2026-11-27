"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download } from "lucide-react";
import type {
  CaptionCorrection,
  ClipReviewStateV2,
} from "@stateaction/server/datasets";
import { browserApi } from "../data-browser/client";
import {
  applyCaptionOverrides,
  type CaptionOverride,
} from "../../lib/review/effective-captions";
import {
  isTextEntryTarget,
  markCounts,
  markKey,
  markSummary,
  nextUnchecked,
} from "../../lib/review/marks";
import { apiMarksStore, memoryMarksStore } from "../../lib/review/marks-store";
import { withMeasuredVideoDuration } from "../../lib/review/model";
import { useMarks } from "../../lib/review/use-marks";
import type {
  Card,
  RecordingAnnotations,
  ReviewModel,
  VideoSource,
} from "../../lib/review/types";
import {
  activeCardIndex,
  filterCards,
  fitView,
  fmtClock,
  fmtPrecise,
  followView,
  neighborStart,
  clampView,
  panView,
  zoomView,
  type CardFilter,
  type View,
} from "../../lib/review/timeline";
import { CaptionEditor } from "./caption-editor";
import { Player } from "./player";
import { ReviewActions } from "./review-actions";
import { SidePanel, type SideTab } from "./side-panel";
import { Tiers } from "./tiers";
import { usePlayback } from "./use-playback";

type StaffReview = {
  userId: string;
  actorName: string;
  state: ClipReviewStateV2;
  annotations: RecordingAnnotations;
  overrides: CaptionOverride[];
  labels: string[];
  sourceStartS: number;
  sourceEndS: number | null;
  processingHref: string;
  segmentationFailure: string | null;
  handPoseFailed: boolean;
  pending: boolean;
  openActions: boolean;
  currentHref: string;
  advanceHref: string | null;
};

export type ReviewPageProps = {
  model: ReviewModel;
  title: string;
  suggested: boolean;
  backHref: string;
  backLabel: string;
  previousHref: string | null;
  nextHref: string | null;
  source: VideoSource;
  posterPath: string | null;
  handFramesPath: string | null;
  startAt: number | null;
  initialSegmentId: string | null;
  staff?: StaffReview;
  embedded?: boolean;
};

const linkClass =
  "inline-flex min-h-11 items-center rounded-lg border border-line bg-white px-3 text-sm font-semibold hover:bg-field";

export function ReviewPage(props: ReviewPageProps) {
  const { embedded = false, staff, source } = props;
  const workspace = useRef<HTMLDivElement>(null);
  const state = staff?.state;
  const [localOverride, setLocalOverride] = useState<
    Map<string, string | null | undefined>
  >(() => new Map());
  const [mediaDuration, setMediaDuration] = useState(0);
  const [clipState, setClipState] = useState(state?.review ?? null);
  useEffect(() => {
    setClipState(state?.review ?? null);
  }, [state?.review]);

  const model = useMemo(() => {
    const corrected = new Map(
      staff?.overrides.map(({ segmentId, text }) => [segmentId, text]),
    );
    for (const [id, text] of localOverride) {
      if (text === undefined) corrected.delete(id);
      else corrected.set(id, text);
    }
    return applyCaptionOverrides(
      withMeasuredVideoDuration(props.model, mediaDuration),
      [...corrected].map(([segmentId, text]) => ({ segmentId, text })),
    );
  }, [localOverride, props.model, mediaDuration, staff?.overrides]);

  const playback = usePlayback(model.durationS, source, setMediaDuration);
  const { t } = playback;
  const [poster, setPoster] = useState<string>();
  useEffect(() => {
    if (!props.posterPath) return;
    const controller = new AbortController();
    browserApi<{ url: string }>(props.posterPath, { signal: controller.signal })
      .then(({ url }) => {
        if (!controller.signal.aborted) setPoster(url);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [props.posterPath]);

  const store = useMemo(
    () =>
      state
        ? apiMarksStore(state.recordingId, state.jobId, {
            clipId: state.clipId,
            revision: state.selectionRevision,
          })
        : memoryMarksStore("", ""),
    [state?.recordingId, state?.jobId, state?.clipId, state?.selectionRevision],
  );
  const marks = useMarks(store, state?.jobId ?? null);
  const writable = Boolean(state?.capabilities.canReview);
  const ids = useMemo(
    () => model.cards.map((card) => card.segmentId),
    [model.cards],
  );
  const counts = useMemo(
    () => markCounts(ids, marks.marks),
    [ids, marks.marks],
  );
  const [selected, setSelected] = useState<number | null>(() => {
    const match = props.model.cards.find(
      (card) => card.segmentId === props.initialSegmentId,
    );
    return match?.index ?? null;
  });
  const [view, setView] = useState<View>(() => fitView(model.durationS));
  const [tab, setTab] = useState<SideTab>(
    staff?.openActions ? "decision" : "segs",
  );
  const [filter, setFilter] = useState<CardFilter>("all");
  const [query, setQuery] = useState("");
  const queryRef = useRef<HTMLInputElement>(null);
  const dirtyCaption = useRef(false);
  const captionDirty = useCallback((dirty: boolean) => {
    dirtyCaption.current = dirty;
  }, []);
  const keepEditing = () =>
    dirtyCaption.current &&
    !window.confirm("Discard the unsaved caption changes?");
  const changeTab = (next: SideTab) => {
    if (next !== tab && !keepEditing()) setTab(next);
  };
  const activeIndex = activeCardIndex(model.cards, t);
  const active = model.cards[activeIndex] ?? null;
  const shown = useMemo(
    () => filterCards(model.cards, query, filter, marks.marks),
    [model.cards, query, filter, marks.marks],
  );
  const dimmed = useMemo(() => {
    const keep = new Set(shown.map((card) => card.index));
    return new Set(
      model.cards
        .filter((card) => !keep.has(card.index))
        .map((card) => card.index),
    );
  }, [shown, model.cards]);
  const correctedCount = useMemo(() => {
    const corrected = new Set(
      staff?.overrides.map(({ segmentId }) => segmentId),
    );
    for (const [id, text] of localOverride) {
      if (text === undefined) corrected.delete(id);
      else corrected.add(id);
    }
    return corrected.size;
  }, [localOverride, staff?.overrides]);

  const initial = useRef(false);
  useEffect(() => {
    if (initial.current || playback.status === "loading") return;
    initial.current = true;
    const start =
      props.startAt ??
      (selected === null ? null : (model.cards[selected]?.startS ?? null));
    if (start !== null) playback.seek(start);
  }, [playback, model.cards, props.startAt, selected]);
  const lastDuration = useRef(model.durationS);
  useEffect(() => {
    const previous = lastDuration.current;
    lastDuration.current = model.durationS;
    if (model.durationS !== previous)
      setView((v) =>
        v[0] <= 0 && v[1] >= previous - 1e-6
          ? fitView(model.durationS)
          : clampView(v[0], v[1], model.durationS),
      );
  }, [model.durationS]);
  useEffect(() => {
    setView((v) => followView(v, t, model.durationS));
  }, [t, model.durationS]);

  const selectCard = useCallback(
    (index: number, play = false) => {
      const card = model.cards[index];
      if (!card) return;
      if (
        selected !== index &&
        dirtyCaption.current &&
        !window.confirm("Discard the unsaved caption changes?")
      )
        return;
      setSelected(index);
      setTab("segs");
      playback.seek(card.startS, play);
    },
    [model.cards, playback, selected],
  );

  const step = useCallback(
    (direction: -1 | 1) => {
      const position = neighborStart(model.cards, playback.t, direction);
      if (position === null) return;
      if (
        dirtyCaption.current &&
        !window.confirm("Discard the unsaved caption changes?")
      )
        return;
      playback.seek(position);
      setSelected(activeCardIndex(model.cards, position));
    },
    [model.cards, playback],
  );

  const gotoNextUnchecked = useCallback(() => {
    const start = selected ?? Math.max(0, activeIndex);
    const shownSet = new Set(shown.map((card) => card.index));
    const index = nextUnchecked(ids, marks.marks, start, (candidate) =>
      shownSet.has(candidate),
    );
    if (index !== null) selectCard(index);
  }, [selected, activeIndex, shown, ids, marks.marks, selectCard]);

  useEffect(() => {
    function handle(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const action = writable ? markKey(event) : null;
      if (action) {
        if (event.repeat || isTextEntryTarget(target)) return;
        if (action === "next") {
          event.preventDefault();
          gotoNextUnchecked();
        } else if (selected !== null) {
          const card = model.cards[selected];
          if (!card) return;
          event.preventDefault();
          void marks.choose(card.segmentId, { verdict: action });
        }
        return;
      }
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        target?.closest(
          "input, textarea, select, [role=slider], [role=button], button, a, [data-testid=rail-list]",
        )
      )
        return;
      if (event.key === " ") {
        event.preventDefault();
        playback.toggle();
      } else if (event.key === "ArrowLeft") step(-1);
      else if (event.key === "ArrowRight") step(1);
      else if (event.key === "/") {
        event.preventDefault();
        setTab("segs");
        requestAnimationFrame(() => queryRef.current?.focus());
      }
    }
    const target = embedded ? workspace.current : window;
    target?.addEventListener("keydown", handle as EventListener);
    return () =>
      target?.removeEventListener("keydown", handle as EventListener);
  }, [
    embedded,
    playback,
    step,
    selected,
    model.cards,
    marks,
    gotoNextUnchecked,
    writable,
  ]);

  function captionSaved(row: CaptionCorrection) {
    setLocalOverride((previous) =>
      new Map(previous).set(
        row.segmentId,
        row.text ?? (row.notNeeded ? null : undefined),
      ),
    );
    void marks.reload().catch(() => undefined);
  }

  function download() {
    const captions = model.cards
      .filter((card) => card.kind === "segment")
      .map((card) => ({
        startSeconds: card.startS,
        endSeconds:
          card.endsAtVideoEnd && card.endS <= card.startS ? null : card.endS,
        ...(staff
          ? {
              segmentId: card.segmentId,
              sourceStartFrameId: card.startFrameId,
              sourceEndFrameId: card.endFrameId,
            }
          : {}),
        status: card.caption.state,
        caption: card.caption.state === "complete" ? card.caption.text : null,
      }));
    const url = URL.createObjectURL(
      new Blob([JSON.stringify({ title: props.title, captions }, null, 2)], {
        type: "application/json",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "clip-captions.json";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function editCaption(card: Card) {
    if (!staff || !state) return null;
    const original = props.model.cards[card.index]?.caption;
    const corrected = localOverride.has(card.segmentId)
      ? localOverride.get(card.segmentId) !== undefined
      : staff.overrides.some(({ segmentId }) => segmentId === card.segmentId);
    return (
      <CaptionEditor
        state={state}
        card={card}
        original={original?.state === "complete" ? original.text : null}
        provenance={
          model.provenance.find((badge) => badge.stage === "caption")?.text ??
          null
        }
        corrected={corrected}
        markRevision={marks.marks.get(card.segmentId)?.revision ?? 0}
        segmentsSha256={marks.loaded ? marks.segmentsSha256 : null}
        onCorrect={() => void marks.choose(card.segmentId, { verdict: "good" })}
        onSaved={captionSaved}
        onDirty={captionDirty}
      />
    );
  }

  const { summary } = model;
  return (
    <div
      ref={workspace}
      className="min-w-0"
      onClickCapture={(event) => {
        if (
          event.target instanceof HTMLElement &&
          event.target.closest("a[href^='/']") &&
          keepEditing()
        ) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      {embedded ? null : (
        <header className="mb-4 space-y-2">
          <Link
            href={props.backHref}
            className="inline-flex min-h-11 items-center text-sm text-brand-ink underline"
          >
            ‹ {props.backLabel}
          </Link>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h1 className="min-w-0 text-[clamp(1.375rem,3vw,1.75rem)] leading-tight font-bold [overflow-wrap:anywhere]">
              {props.title}
            </h1>
            <div className="flex gap-2">
              {props.previousHref ? (
                <Link href={props.previousHref} className={linkClass}>
                  Previous clip
                </Link>
              ) : null}
              {props.nextHref ? (
                <Link href={props.nextHref} className={linkClass}>
                  Next clip
                </Link>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
            {staff && staff.sourceEndS !== null ? (
              <span>
                {fmtPrecise(staff.sourceStartS)}–{fmtPrecise(staff.sourceEndS)}{" "}
                ·
              </span>
            ) : null}
            <span>{fmtClock(model.durationS)}</span>
            {props.suggested ? (
              <span
                title="From the model caption"
                className="rounded bg-field px-2 py-1 text-xs"
              >
                Suggested
              </span>
            ) : null}
            {staff && clipState?.decision !== "approved" ? (
              <span className="rounded bg-brand-soft px-2 py-1 text-xs font-semibold text-brand-ink">
                {clipState?.decision === "rejected"
                  ? "Rejected"
                  : "Not reviewed"}
              </span>
            ) : null}
            {staff && correctedCount > 0 ? (
              <span className="rounded bg-field px-2 py-1 text-xs">
                {correctedCount}{" "}
                {correctedCount === 1
                  ? "caption corrected"
                  : "captions corrected"}
              </span>
            ) : null}
            {staff &&
            clipState?.reviewerName &&
            clipState?.reviewedAt &&
            (clipState.decision === "approved" ||
              clipState.decision === "rejected") ? (
              <span className="text-xs">
                {clipState.decision === "approved" ? "Approved" : "Rejected"} by{" "}
                {clipState.reviewerName}
                {" · "}
                {new Date(clipState.reviewedAt).toISOString().slice(0, 10)}
              </span>
            ) : null}
          </div>
        </header>
      )}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-paper px-3.5 py-2">
        <span data-testid="review-summary" className="text-xs text-muted">
          {summary.segments.toLocaleString()}{" "}
          {summary.segments === 1 ? "segment" : "segments"}
          {staff && summary.failedWindows > 0
            ? " · " +
              summary.failedWindows +
              " failed window" +
              (summary.failedWindows === 1 ? "" : "s")
            : ""}
          {staff && summary.failedCaptions > 0
            ? " · " +
              summary.failedCaptions +
              " caption failure" +
              (summary.failedCaptions === 1 ? "" : "s")
            : ""}
        </span>
        {staff ? (
          <span
            data-testid="mark-summary"
            data-marks-loaded={marks.loaded}
            className="rounded-md bg-field px-2 py-0.5 text-xs"
          >
            {markSummary(counts)}
          </span>
        ) : null}
        <span className="flex-1" />
        {staff ? (
          <Link href={staff.processingHref} className={linkClass}>
            Clip processing
          </Link>
        ) : null}
        {staff && state ? (
          <button
            type="button"
            className={linkClass}
            onClick={() => {
              changeTab("decision");
              requestAnimationFrame(() =>
                document.getElementById("tab-decision")?.focus(),
              );
            }}
          >
            {clipState?.decision === "rejected"
              ? "Review actions"
              : "Add to dataset"}
          </button>
        ) : null}
        <button
          type="button"
          data-testid="download-json"
          onClick={download}
          className={linkClass + " gap-2"}
        >
          <Download aria-hidden="true" size={14} />
          Download captions
        </button>
      </div>

      <div
        className={
          embedded
            ? "mt-3 grid items-start gap-3 min-[850px]:grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)]"
            : "mt-5 grid items-start gap-5 xl:grid-cols-[minmax(0,72fr)_minmax(340px,28fr)]"
        }
      >
        <div className={embedded ? "min-w-0" : "min-w-0 max-md:contents"}>
          <Player
            model={model}
            playback={playback}
            active={active}
            videoMessage={source.kind === "none" ? source.reason : null}
            handFramesPath={props.handFramesPath}
            handPoseFailed={staff?.handPoseFailed ?? false}
            embedded={embedded}
            mediaOffsetS={
              source.kind === "none" ? 0 : (source.range?.startS ?? 0)
            }
            poster={poster}
            onPrev={() => step(-1)}
            onNext={() => step(1)}
          />
          <Tiers
            model={model}
            view={view}
            t={t}
            selected={selected}
            dimmed={dimmed}
            onSelect={selectCard}
            onSeek={playback.seek}
            onZoom={(factor, center) =>
              setView((v) => zoomView(v, factor, center, model.durationS))
            }
            onPan={(distance) =>
              setView((v) => panView(v, distance, model.durationS))
            }
            onFit={() => setView(fitView(model.durationS))}
            onView={(v) => setView(clampView(v[0], v[1], model.durationS))}
          />
          {tab === "segs" && selected !== null && !dimmed.has(selected) ? (
            <a
              href={"#review-segment-" + selected}
              className="mt-2 inline-flex min-h-11 items-center text-sm font-semibold text-brand underline xl:hidden"
            >
              Jump to segment {selected + 1} details
            </a>
          ) : null}
        </div>
        <SidePanel
          embedded={embedded}
          model={model}
          staff={staff?.annotations}
          segmentationFailure={staff?.segmentationFailure ?? null}
          linkProvenance={Boolean(staff)}
          tab={tab}
          onTab={changeTab}
          cards={shown}
          total={model.cards.length}
          query={query}
          onQuery={setQuery}
          filter={filter}
          onFilter={setFilter}
          selected={selected}
          activeIndex={activeIndex}
          onSelect={selectCard}
          seekCount={playback.seekCount}
          queryRef={queryRef}
          marks={marks}
          checkedCount={counts.checked}
          issueCount={counts.issue}
          onChoose={
            writable
              ? (card, choice) => void marks.choose(card.segmentId, choice)
              : undefined
          }
          onNextUnchecked={gotoNextUnchecked}
          captionEditor={writable ? editCaption : undefined}
          decision={
            staff && state ? (
              <ReviewActions
                userId={staff.userId}
                state={state}
                labels={staff.labels}
                suggested={
                  props.suggested ? props.title.replace(/^.*#\d+\s*/, "") : ""
                }
                pending={
                  staff.pending &&
                  clipState?.decision !== "approved" &&
                  clipState?.decision !== "rejected"
                }
                focusPicker={staff.openActions}
                currentHref={staff.currentHref}
                advanceHref={staff.advanceHref}
                onUpdated={(receipt) => {
                  if (receipt.review)
                    setClipState({
                      ...receipt.review,
                      reviewerName: staff.actorName,
                    });
                }}
              />
            ) : undefined
          }
        />
      </div>
    </div>
  );
}
