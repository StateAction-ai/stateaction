"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Card, LaneSpan, ReviewModel } from "../../lib/review/types";
import {
  fmtClock,
  fmtPrecise,
  niceStep,
  packSegmentRows,
  rulerTicks,
  rowFocusIndex,
  tOf,
  xOf,
  type View,
} from "../../lib/review/timeline";
import { HAND_COLORS, HAND_ORDER } from "./palette";

interface Tip {
  cardIndex?: number;
  x: number;
  y: number;
  title: string;
  sub: string;
  body?: string;
  bad?: boolean;
}

export function Tiers({
  model,
  view,
  t,
  selected,
  dimmed,
  onSelect,
  onSeek,
  onZoom,
  onPan,
  onFit,
  onView,
}: {
  model: ReviewModel;
  view: View;
  t: number;
  selected: number | null;
  /** Card indexes hidden by the text filter. */
  dimmed: ReadonlySet<number>;
  onSelect: (index: number) => void;
  onSeek: (t: number) => void;
  onZoom: (factor: number, center: number) => void;
  onPan: (deltaS: number) => void;
  onFit: () => void;
  onView: (view: View) => void;
}) {
  const tooltipId = useId();
  const track = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [pointerTip, setPointerTip] = useState<Tip | null>(null);
  const [focusTip, setFocusTip] = useState<Tip | null>(null);
  const tip = focusTip ?? pointerTip;
  const [focusedByRow, setFocusedByRow] = useState<Record<number, number>>({});
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = track.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Wheel: scroll pans, ctrl/cmd+scroll zooms. Needs a non-passive listener.
  const latest = useRef({ view, onZoom, onPan });
  latest.current = { view, onZoom, onPan };
  useEffect(() => {
    const el = track.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (
        !e.ctrlKey &&
        !e.metaKey &&
        !e.shiftKey &&
        Math.abs(e.deltaY) >= Math.abs(e.deltaX)
      )
        return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const { view: v, onZoom: zoom, onPan: pan } = latest.current;
      if (e.ctrlKey || e.metaKey)
        zoom(
          Math.exp(e.deltaY * 0.0022),
          tOf(e.clientX - rect.left, v, rect.width),
        );
      else {
        const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        pan((d / rect.width) * (v[1] - v[0]));
      }
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, []);

  const span = view[1] - view[0];
  const x = (s: number) => xOf(s, view, width);
  const visible = (a: number, b: number) => b > view[0] && a < view[1];
  const step = niceStep(span);
  const ticks = useMemo(() => rulerTicks(view, step), [view, step]);
  const rows = useMemo(() => packSegmentRows(model.cards), [model.cards]);
  const visibleRows = rows.map((row) =>
    row.filter((c) => visible(c.startS, c.endS)),
  );
  const segmentHeight = Math.max(1, rows.length) * 44;

  const showTip = (e: React.MouseEvent, next: Omit<Tip, "x" | "y">) =>
    setPointerTip({ x: e.clientX, y: e.clientY, ...next });

  const cardTip = (c: Card): Omit<Tip, "x" | "y"> => ({
    cardIndex: c.index,
    title:
      c.caption.state === "complete"
        ? `${fmtClock(c.startS)} · ${c.caption.label} · ${c.caption.hand}`
        : `${fmtClock(c.startS)} · ${c.kind === "failed_window" ? "Segmentation failed" : "Caption unavailable"}`,
    sub: `#${c.index + 1}/${model.cards.length} · ${(c.endS - c.startS).toFixed(1)} s · open to show details`,
    body:
      c.caption.state === "complete"
        ? c.caption.text
        : `Error code: ${c.caption.code}`,
    bad: c.caption.state === "failed",
  });

  const lane = (spans: LaneSpan[], color: string) =>
    spans
      .filter((s) => visible(s.startS, s.endS))
      .map((s, i) => {
        const l = x(s.startS);
        const w = Math.max(1, x(s.endS) - l);
        return s.state === "present" ? (
          <div
            key={i}
            className="absolute top-[11px] bottom-[11px] rounded"
            style={{ left: l, width: w, background: color }}
          />
        ) : (
          <div
            key={i}
            title="hand pose produced no result for these frames"
            className="absolute top-[11px] bottom-[11px] rounded border border-dashed border-danger"
            style={{ left: l, width: w }}
          />
        );
      });

  return (
    <section
      aria-label="Annotation tiers"
      className="mt-5 rounded-2xl border border-line bg-paper pb-3 shadow-[0_6px_25px_#21332a06]"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-6 py-4">
        <h2 className="m-0 text-base font-bold">Annotation tiers</h2>
        <span
          data-testid="hand-legend"
          className="flex min-w-0 flex-wrap gap-x-3.5 gap-y-1 text-[11.5px] text-muted"
        >
          {HAND_ORDER.map((h) => (
            <span key={h} className="inline-flex items-center gap-1.5">
              <i
                className="inline-block h-2.5 w-2.5 rounded-[3px]"
                style={{
                  background: HAND_COLORS[h].bg,
                  boxShadow: `inset 0 0 0 1px ${HAND_COLORS[h].sat}`,
                }}
              />
              {h} {model.handCounts[h].toLocaleString()}
            </span>
          ))}
          <span>Segments by hand presence</span>
        </span>
        <span className="flex-1" />
        <div className="flex gap-1.5">
          <ZoomButton
            label="Zoom in"
            onClick={() => onZoom(0.5, (view[0] + view[1]) / 2)}
          >
            +
          </ZoomButton>
          <ZoomButton
            label="Zoom out"
            onClick={() => onZoom(2, (view[0] + view[1]) / 2)}
          >
            −
          </ZoomButton>
          <ZoomButton label="Fit" onClick={onFit}>
            Fit
          </ZoomButton>
        </div>
      </div>
      <div className="grid grid-cols-[88px_minmax(0,1fr)] select-none md:grid-cols-[128px_minmax(0,1fr)]">
        <div className="text-xs font-semibold text-[#3d4a45]">
          <LabelCell h="h-[26px]" first>
            <span className="text-[11px] text-muted">time</span>
          </LabelCell>
          <LabelCell height={segmentHeight}>
            <span className="flex flex-col leading-tight whitespace-normal">
              Segments
              <small className="hidden text-[10.5px] font-medium text-muted md:block">
                Color shows hand presence
              </small>
            </span>
          </LabelCell>
          <LabelCell h="h-[34px]">Hand · left</LabelCell>
          <LabelCell h="h-[34px]">Hand · right</LabelCell>
          <LabelCell h="h-[34px]">Failures</LabelCell>
        </div>
        <div
          ref={track}
          data-testid="tiers-track"
          className="relative mr-3 cursor-crosshair md:mr-6 overflow-hidden rounded-br-lg bg-field"
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setHover(e.clientX - rect.left);
            const el = (e.target as HTMLElement).closest<HTMLElement>(
              "[data-tip]",
            );
            if (!el) {
              setPointerTip({
                x: e.clientX,
                y: e.clientY,
                title: "",
                sub: fmtPrecise(tOf(e.clientX - rect.left, view, rect.width)),
              });
            }
          }}
          onMouseLeave={() => {
            setPointerTip(null);
            setHover(null);
          }}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const el = (e.target as HTMLElement).closest<HTMLElement>(
              "[data-card]",
            );
            if (el) {
              onSelect(Number(el.dataset.card));
              return;
            }
            const seek = (e.target as HTMLElement).closest<HTMLElement>(
              "[data-seek]",
            );
            onSeek(
              seek
                ? Number(seek.dataset.seek)
                : tOf(e.clientX - rect.left, view, rect.width),
            );
          }}
        >
          <div className="relative h-[26px]" data-lane="ruler">
            {ticks.map(({ s, major }) =>
              major ? (
                <div
                  key={s}
                  data-seek={s}
                  className="absolute top-0 h-full border-l border-line pl-1 font-mono text-[10px] leading-4 text-muted"
                  style={{ left: x(s) }}
                >
                  {fmtClock(s)}
                </div>
              ) : (
                <div
                  key={s}
                  className="absolute top-5 h-1.5 border-l border-line"
                  style={{ left: x(s) }}
                />
              ),
            )}
          </div>
          <div
            className="relative border-t border-line"
            style={{ height: segmentHeight }}
            id="lSeg"
            data-lane="segments"
          >
            {visibleRows.map((row, rowIndex) => {
              const focusable =
                row.find((c) => c.index === focusedByRow[rowIndex]) ??
                row.find((c) => c.index === selected) ??
                row[0];
              return (
                <div
                  key={rowIndex}
                  role="group"
                  aria-label={`Segment row ${rowIndex + 1}`}
                  data-testid="segment-row"
                  className="relative h-11 border-b border-line/50"
                >
                  {row.map((c, position) => {
                    const left = Math.max(0, xOf(c.startS, view, 100));
                    const right = Math.min(100, xOf(c.endS, view, 100));
                    const size = right - left;

                    const on = selected === c.index;
                    const dim = dimmed.has(c.index);
                    const ok = c.caption.state === "complete";
                    const gap = c.kind === "failed_window";
                    const hc =
                      c.caption.state === "complete"
                        ? HAND_COLORS[c.caption.hand]
                        : null;
                    return (
                      <button
                        key={c.segmentId}
                        type="button"
                        data-card={c.index}
                        tabIndex={focusable === c ? 0 : -1}
                        aria-label={`Segment ${c.index + 1}`}
                        aria-pressed={on}
                        aria-describedby={
                          tip?.cardIndex === c.index ? tooltipId : undefined
                        }
                        onFocus={(e) => {
                          setFocusedByRow((current) => ({
                            ...current,
                            [rowIndex]: c.index,
                          }));
                          const bounds =
                            e.currentTarget.getBoundingClientRect();
                          setFocusTip({
                            ...cardTip(c),
                            x: bounds.left,
                            y: bounds.bottom,
                          });
                        }}
                        onBlur={() => setFocusTip(null)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") {
                            setFocusTip(null);
                            setPointerTip(null);
                          }
                          const destination = rowFocusIndex(
                            e.key,
                            position,
                            row.length,
                          );
                          if (destination === null) return;
                          e.preventDefault();
                          e.currentTarget.parentElement
                            ?.querySelector<HTMLButtonElement>(
                              `[data-card="${row[destination]!.index}"]`,
                            )
                            ?.focus();
                        }}
                        data-testid={
                          gap ? "block-failed-window" : "block-segment"
                        }
                        data-selected={on ? "true" : undefined}
                        data-tip="1"
                        className={[
                          "absolute top-1.5 bottom-1.5 flex cursor-pointer items-center overflow-hidden rounded-md text-[11px] font-semibold whitespace-nowrap focus-visible:z-10 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ink",
                          gap
                            ? "border border-dashed border-[#edc8cc] text-danger [background-image:repeating-linear-gradient(135deg,rgba(173,57,65,.10)_0_5px,transparent_5px_10px)]"
                            : "shadow-[inset_0_0_0_1px_rgba(25,38,35,.18)]",
                          !ok && !gap
                            ? "bg-danger-soft text-danger [background-image:repeating-linear-gradient(135deg,rgba(173,57,65,.18)_0_4px,transparent_4px_8px)]"
                            : "",
                          on
                            ? "z-[2] shadow-[0_0_0_2px_#192623,inset_0_0_0_1px_rgba(0,0,0,.2)]"
                            : "",
                          dim && !on
                            ? "outline outline-dashed -outline-offset-2 outline-muted"
                            : "",
                        ].join(" ")}
                        style={{
                          left: `${left}%`,
                          width: `${size}%`,
                          ...(hc
                            ? {
                                background: on ? hc.sat : hc.bg,
                                color: on ? "#16201d" : hc.ink,
                              }
                            : {}),
                        }}
                        onMouseMove={(e) => {
                          showTip(e, cardTip(c));
                        }}
                      >
                        {(size * width) / 100 >= 34 ? (
                          <span className="min-w-0 truncate px-1.5">
                            {c.caption.state === "complete"
                              ? c.caption.label
                              : gap
                                ? "window failed"
                                : "caption failed"}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
          <div
            className="relative h-[34px] border-t border-line"
            id="lHL"
            data-lane="hand-left"
          >
            {model.presence === "absent" ? (
              <Unavailable note={model.presenceNote} />
            ) : null}
            {lane(model.lanes.left, "#55b6ff")}
          </div>
          <div
            className="relative h-[34px] border-t border-line"
            id="lHR"
            data-lane="hand-right"
          >
            {model.presence === "absent" ? (
              <Unavailable note={model.presenceNote} />
            ) : null}
            {lane(model.lanes.right, "#f472b6")}
          </div>
          <div
            className="relative h-[34px] border-t border-line"
            id="lFail"
            data-lane="failures"
          >
            {model.failures
              .filter((f) => visible(f.startS, f.endS))
              .map((f, i) => {
                const l = x(f.startS);
                const w = Math.max(f.kind === "window" ? 3 : 4, x(f.endS) - l);
                const title =
                  f.kind === "window"
                    ? "No segments could be produced for this time range."
                    : "No caption is available for this segment.";
                return (
                  <div
                    key={`${f.kind}-${i}`}
                    data-testid={`failure-${f.kind}`}
                    data-card={f.cardIndex ?? undefined}
                    data-seek={f.cardIndex === null ? f.startS : undefined}
                    data-tip="1"
                    className="absolute top-[7px] bottom-[7px] flex cursor-pointer items-center overflow-hidden rounded-[5px] border border-[#edc8cc] bg-danger-soft px-1.5 text-[10px] font-bold whitespace-nowrap text-danger"
                    style={{ left: l, width: w }}
                    onMouseMove={(e) => {
                      showTip(e, {
                        title,
                        sub: `${fmtClock(f.startS)} – ${fmtClock(f.endS)}`,
                        body: `Error code: ${f.code}`,
                        bad: true,
                      });
                    }}
                  >
                    {w > 70
                      ? f.kind === "window"
                        ? "✕ window"
                        : "✕ caption"
                      : "✕"}
                  </div>
                );
              })}
          </div>
          {hover !== null ? (
            <div
              className="pointer-events-none absolute inset-y-0 z-[4] w-px bg-ink opacity-25"
              style={{ left: hover }}
            />
          ) : null}
          {t >= view[0] && t <= view[1] ? (
            <div
              data-testid="playhead"
              className="pointer-events-none absolute inset-y-0 z-[5] w-0.5 bg-brand"
              style={{ left: x(t) }}
            >
              <span className="absolute top-0 -left-[5px] border-[6px] border-transparent border-t-[8px] border-t-brand" />
            </div>
          ) : null}
        </div>
      </div>
      <Overview model={model} view={view} t={t} onView={onView} />
      <div className="flex flex-wrap gap-x-3.5 gap-y-1.5 px-6 pt-2.5 text-[11.5px] text-muted md:pl-[152px]">
        <LegendItem style={{ background: "#55b6ff" }}>
          left hand present
        </LegendItem>
        <LegendItem style={{ background: "#f472b6" }}>
          right hand present
        </LegendItem>
        <LegendItem
          style={{
            background: "#fff0f0",
            boxShadow: "inset 0 0 0 1px #edc8cc",
          }}
        >
          caption failed
        </LegendItem>
        <LegendItem style={{ border: "1px dashed #ad3941" }}>
          failed window · no segments
        </LegendItem>
        <span>Gaps in hand rows mean no hand was detected.</span>
        <span className="hidden md:inline">
          Shift + scroll to pan. Ctrl + scroll to zoom. Arrow keys move within a
          segment row.
        </span>
      </div>
      {tip ? (
        <div
          role="tooltip"
          id={tooltipId}
          data-testid="tier-tooltip"
          className="pointer-events-none fixed z-50 max-w-[280px] rounded-lg border border-line bg-white px-3 py-2 text-xs shadow-[0_8px_28px_#21332a22]"
          style={{
            left: Math.min(
              (typeof window === "undefined" ? 1200 : window.innerWidth) - 290,
              tip.x + 14,
            ),
            top: tip.y > window.innerHeight / 2 ? tip.y - 12 : tip.y + 12,
            transform:
              tip.y > window.innerHeight / 2 ? "translateY(-100%)" : undefined,
          }}
        >
          {tip.title ? <b className="mb-0.5 block">{tip.title}</b> : null}
          <span className="font-mono text-[11px] text-muted">{tip.sub}</span>
          {tip.body ? (
            <div
              className={tip.bad ? "mt-1 text-danger" : "mt-1 text-[#3d4a45]"}
            >
              {tip.body}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function Unavailable({ note }: { note: string | null }) {
  return (
    <div
      data-testid="hand-unavailable"
      className="absolute inset-x-0 top-[7px] bottom-[7px] flex items-center justify-center rounded border border-dashed border-line text-[11px] text-muted"
    >
      hand pose unavailable{note ? ` (${note})` : ""}
    </div>
  );
}

function LabelCell({
  h,
  height,
  first,
  children,
}: {
  h?: string;
  height?: number;
  first?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{ height }}
      className={`flex items-center gap-2 pr-2 pl-3 whitespace-nowrap md:pr-3.5 md:pl-6 ${h ?? ""} ${first ? "" : "border-t border-line"}`}
    >
      {children}
    </div>
  );
}

function ZoomButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg border border-line bg-white px-2.5 text-xs font-semibold hover:bg-field"
    >
      {children}
    </button>
  );
}

function LegendItem({
  style,
  children,
}: {
  style: React.CSSProperties;
  children: React.ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <i className="inline-block h-2.5 w-2.5 rounded-[3px]" style={style} />
      {children}
    </span>
  );
}

/** Whole-recording overview with the zoom window; click or drag recentres it. */
function Overview({
  model,
  view,
  t,
  onView,
}: {
  model: ReviewModel;
  view: View;
  t: number;
  onView: (v: View) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const pct = (s: number) => `${(s / model.durationS) * 100}%`;
  const recentre = (e: React.PointerEvent) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const span = view[1] - view[0];
    const c = ((e.clientX - rect.left) / rect.width) * model.durationS;
    onView([c - span / 2, c + span / 2]);
  };
  return (
    <div
      ref={ref}
      data-testid="overview"
      className="relative mx-6 mt-2.5 h-[18px] cursor-pointer touch-none overflow-hidden rounded-md border border-line bg-field md:ml-[152px]"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        recentre(e);
      }}
      onPointerMove={(e) => {
        if (e.buttons === 1) recentre(e);
      }}
    >
      <i className="absolute inset-0 bg-[#d7e3fb] opacity-80" />
      {model.failures.map((f, i) => (
        <i
          key={i}
          className="absolute inset-y-0 bg-danger"
          style={{
            left: pct(f.startS),
            width: `max(3px, ${((f.endS - f.startS) / model.durationS) * 100}%)`,
          }}
        />
      ))}
      <div
        data-testid="overview-window"
        className="absolute inset-y-0 rounded-[5px] border-[1.5px] border-brand bg-brand-soft opacity-80"
        style={{
          left: pct(view[0]),
          width: `max(4px, ${((view[1] - view[0]) / model.durationS) * 100}%)`,
        }}
      />
      <div
        className="absolute inset-y-0 w-0.5 bg-brand"
        style={{ left: pct(t) }}
      />
    </div>
  );
}
