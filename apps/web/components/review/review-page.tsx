"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Download } from "lucide-react";
import {
  shortRecordingId,
  type PipelineStatus,
} from "@stateaction/server/pipeline-model";
import { StatusBadge } from "../pipeline/status-badge";
import { buildReviewModel } from "../../lib/review/model";
import {
  isTextEntryTarget,
  markCounts,
  markKey,
  markSummary,
  nextUnchecked,
  type MarkChoice,
} from "../../lib/review/marks";
import { apiMarksStore, memoryMarksStore } from "../../lib/review/marks-store";
import { useMarks } from "../../lib/review/use-marks";
import type {
  Card,
  ReviewBundle,
  ReviewRecordingSummary,
} from "../../lib/review/types";
import {
  activeCardIndex,
  filterCards,
  fitView,
  followView,
  neighborStart,
  clampView,
  panView,
  zoomView,
  type CardFilter,
  type View,
} from "../../lib/review/timeline";
import { Player } from "./player";
import { annotationsJson, SidePanel, type SideTab } from "./side-panel";
import { Tiers } from "./tiers";
import { usePlayback } from "./use-playback";

export function ReviewPage({
  bundle,
  recordings,
  mediaOrigin,
  status,
  failureNote,
  segmentationFailure,
}: {
  bundle: ReviewBundle;
  recordings: ReviewRecordingSummary[];
  mediaOrigin: string | null;
  status: PipelineStatus;
  failureNote: string | null;
  segmentationFailure: string | null;
}) {
  const router = useRouter();
  const { annotations, recording } = bundle;
  // The axis is the estimate until the video reports its own length (never shorter than it).
  const [mediaDurationS, setMediaDurationS] = useState(0);
  const durationS = Math.max(recording.durationS, mediaDurationS);
  const model = useMemo(
    () => buildReviewModel(annotations, bundle.clips, durationS),
    [annotations, bundle.clips, durationS],
  );
  const playback = usePlayback(
    model.durationS,
    bundle.video,
    setMediaDurationS,
  );
  // Team marks: the API for real results, memory for labelled fixture data.
  const store = useMemo(
    () =>
      bundle.origin === "api"
        ? apiMarksStore(recording.recordingId)
        : memoryMarksStore(
            annotations.job_id,
            annotations.captions?.segments_sha256 ?? "0".repeat(64),
          ),
    [bundle.origin, recording.recordingId, annotations],
  );
  const marks = useMarks(store, annotations.job_id);
  const segmentIds = useMemo(
    () => model.cards.map((c) => c.segmentId),
    [model.cards],
  );
  const counts = useMemo(
    () => markCounts(segmentIds, marks.marks),
    [segmentIds, marks.marks],
  );
  const { t } = playback;
  const [selected, setSelected] = useState<number | null>(null);
  const [view, setView] = useState<View>(() => fitView(model.durationS));
  const [tab, setTab] = useState<SideTab>("segs");
  const [filter, setFilter] = useState<CardFilter>("all");
  const [query, setQuery] = useState("");
  const queryRef = useRef<HTMLInputElement>(null);

  const activeIndex = activeCardIndex(model.cards, t);
  const active = activeIndex >= 0 ? (model.cards[activeIndex] ?? null) : null;
  const shown = useMemo(
    () => filterCards(model.cards, query, filter, marks.marks),
    [model.cards, query, filter, marks.marks],
  );
  const dimmed = useMemo(() => {
    const keep = new Set(shown.map((c) => c.index));
    return new Set(
      model.cards.filter((c) => !keep.has(c.index)).map((c) => c.index),
    );
  }, [shown, model.cards]);

  // The axis grows when the video reports a longer length: a full-width view follows it.
  const lastDuration = useRef(model.durationS);
  useEffect(() => {
    const was = lastDuration.current;
    lastDuration.current = model.durationS;
    if (model.durationS === was) return;
    setView((v) =>
      v[0] <= 0 && v[1] >= was - 1e-6
        ? fitView(model.durationS)
        : clampView(v[0], v[1], model.durationS),
    );
  }, [model.durationS]);

  // Keep the playhead inside a zoomed window.
  useEffect(() => {
    setView((v) => followView(v, t, model.durationS));
  }, [t, model.durationS]);

  const selectCard = useCallback(
    (index: number) => {
      const card = model.cards[index];
      if (!card) return;
      setSelected(index);
      playback.seek(card.startS);
      setTab((current) => (current === "hand" ? current : "segs"));
    },
    [model.cards, playback],
  );

  const step = useCallback(
    (dir: -1 | 1) => {
      const to = neighborStart(model.cards, playback.t, dir);
      if (to === null) return;
      playback.seek(to);
      setSelected(activeCardIndex(model.cards, to));
    },
    [model.cards, playback],
  );

  const choose = useCallback(
    (card: Card, choice: MarkChoice) => {
      void marks.choose(card.segmentId, choice);
    },
    [marks],
  );
  const gotoNextUnchecked = useCallback(() => {
    const from =
      selected ?? Math.max(0, activeCardIndex(model.cards, playback.t));
    const shownSet = new Set(shown.map((c) => c.index));
    const to = nextUnchecked(segmentIds, marks.marks, from, (i) =>
      shownSet.has(i),
    );
    if (to !== null) selectCard(to);
  }, [
    selected,
    model.cards,
    playback.t,
    shown,
    segmentIds,
    marks.marks,
    selectCard,
  ]);

  // Keyboard: Space play/pause, arrows previous/next segment, "/" focuses the filter,
  // G Good, B Issue and N next unchecked (SA-99).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const action = markKey(e);
      if (action) {
        if (e.repeat) return;
        if (isTextEntryTarget(target)) return;
        if (action === "next") {
          e.preventDefault();
          gotoNextUnchecked();
        } else {
          const card = selected === null ? null : model.cards[selected];
          if (!card) return;
          e.preventDefault();
          choose(card, { verdict: action });
        }
        return;
      }
      if (
        e.metaKey ||
        e.ctrlKey ||
        e.altKey ||
        target?.closest(
          "input, textarea, select, [role=slider], [role=button], button, a",
        )
      )
        return;
      if (e.key === " ") {
        e.preventDefault();
        playback.toggle();
      } else if (e.key === "ArrowLeft") step(-1);
      else if (e.key === "ArrowRight") step(1);
      else if (e.key === "/") {
        e.preventDefault();
        setTab("segs");
        queryRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playback, step, selected, model.cards, choose, gotoNextUnchecked]);

  const [downloadError, setDownloadError] = useState<string | null>(null);
  const download = async () => {
    setDownloadError(null);
    try {
      let blob: Blob;
      if (bundle.origin === "api") {
        const res = await fetch(
          `/api/v1/recordings/${encodeURIComponent(recording.recordingId)}/annotations?download=1`,
          { credentials: "same-origin", cache: "no-store" },
        );
        if (!res.ok) throw new Error(`The server answered ${res.status}.`);
        blob = await res.blob();
      } else
        blob = new Blob([annotationsJson(annotations).text], {
          type: "application/json",
        });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `annotations-${recording.recordingId}.json`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setDownloadError(
        error instanceof Error ? error.message : "The download failed.",
      );
    }
  };

  const { summary } = model;
  const recordedCaptionFailures = annotations.captions?.rows.filter(
    (row) => row.status === "failed",
  ).length;
  const choices = recordings.some(
    (r) => r.recordingId === recording.recordingId,
  )
    ? recordings
    : [recording, ...recordings];

  return (
    <div className="min-w-0">
      <h1 className="sr-only">Review · {recording.title}</h1>
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2 rounded-xl border border-line bg-paper px-3.5 py-2.5 shadow-[0_6px_25px_#21332a06]">
        <select
          aria-label="Recording"
          value={recording.recordingId}
          onChange={(e) => router.push(`/review/${e.target.value}`)}
          className="min-h-[34px] max-w-full rounded-lg border border-line bg-white px-3 text-sm font-semibold text-ink"
        >
          {choices.map((r) => (
            <option key={r.recordingId} value={r.recordingId}>
              {[
                r.title,
                shortRecordingId(r.recordingId),
                r.collector,
                r.sourceSize,
              ]
                .filter(Boolean)
                .join(" · ")}
            </option>
          ))}
        </select>
        <span className="font-mono text-xs text-muted">
          {Math.floor(model.durationS / 60)}:
          {String(Math.floor(model.durationS % 60)).padStart(2, "0")}
        </span>
        <div
          data-testid="review-state"
          className="flex flex-wrap items-center gap-2"
        >
          <StatusBadge status={status} />
          {failureNote ? (
            <Link
              href={"/pipeline/" + recording.recordingId}
              className="text-xs font-medium text-danger underline"
            >
              {failureNote}
            </Link>
          ) : null}
        </div>
        <span data-testid="review-summary" className="text-xs text-muted">
          {annotations.segments
            ? [
                summary.segments.toLocaleString() + " segments",
                summary.failedWindows +
                  (summary.failedWindows === 1
                    ? " failed window"
                    : " failed windows"),
              ].join(" · ")
            : "Segment counts not recorded"}
          {" · "}
          {recordedCaptionFailures === undefined
            ? "Caption counts not recorded"
            : recordedCaptionFailures +
              (recordedCaptionFailures === 1
                ? " caption failed"
                : " captions failed")}
          {model.presence === "absent" ? " · hand pose unavailable" : ""}
        </span>
        <span
          data-testid="mark-summary"
          data-marks-loaded={marks.loaded ? "true" : "false"}
          className="rounded-md bg-[#eef0ec] px-2 py-0.5 text-xs font-semibold text-[#4d5a54]"
        >
          {markSummary(counts)}
          {bundle.origin === "fixture" ? " · not saved" : ""}
        </span>
        {bundle.origin === "fixture" ? (
          <span className="inline-flex items-center rounded-md bg-[#fff4de] px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap text-[#8a5a00]">
            Fixture data
          </span>
        ) : null}
        <span className="flex-1" />
        <Link
          href={`/pipeline/${recording.recordingId}`}
          className="inline-flex min-h-[30px] items-center rounded-lg border border-line bg-white px-2.5 text-xs font-semibold hover:bg-field"
        >
          Pipeline run
        </Link>
        <button
          type="button"
          id="dlBtn"
          data-testid="download-json"
          onClick={download}
          className="inline-flex min-h-[30px] items-center gap-2 rounded-lg border border-brand bg-brand px-2.5 text-xs font-semibold text-white hover:bg-brand-strong"
        >
          <Download aria-hidden="true" size={14} />
          Download JSON
        </button>
        {downloadError ? (
          <span role="alert" className="text-xs text-danger">
            Download failed: {downloadError}
          </span>
        ) : null}
      </div>

      <div className="mt-5 grid items-start gap-5 xl:grid-cols-[minmax(0,72fr)_minmax(340px,28fr)]">
        <div className="min-w-0">
          <Player
            model={model}
            playback={playback}
            active={active}
            videoMessage={
              bundle.video.kind === "none" ? bundle.video.reason : null
            }
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
            onPan={(d) => setView((v) => panView(v, d, model.durationS))}
            onFit={() => setView(fitView(model.durationS))}
            onView={(v) => setView(clampView(v[0], v[1], model.durationS))}
          />
        </div>
        <SidePanel
          model={model}
          annotations={annotations}
          segmentationFailure={segmentationFailure}
          linkProvenance={bundle.origin === "api"}
          tab={tab}
          onTab={setTab}
          cards={shown}
          total={model.cards.length}
          query={query}
          onQuery={setQuery}
          filter={filter}
          onFilter={setFilter}
          selected={selected}
          activeIndex={activeIndex}
          t={t}
          onSelect={selectCard}
          mediaOrigin={mediaOrigin}
          queryRef={queryRef}
          marks={marks}
          checkedCount={counts.checked}
          issueCount={counts.issue}
          onChoose={choose}
          onNextUnchecked={gotoNextUnchecked}
        />
      </div>
    </div>
  );
}
