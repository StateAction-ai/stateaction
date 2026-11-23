"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Card, LaneSpan, ReviewModel } from "../../lib/review/types";
import {
  fmtClock,
  fmtPrecise,
  niceStep,
  tOf,
  xOf,
  type View,
} from "../../lib/review/timeline";
import { HAND_COLORS, HAND_ORDER } from "./palette";

interface Tip {
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
  const track = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [tip, setTip] = useState<Tip | null>(null);
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
  const minor = step / 5;
  const ticks = useMemo(() => {
    const out: { s: number; major: boolean }[] = [];
    for (let s = Math.ceil(view[0] / minor) * minor; s <= view[1]; s += minor)
      out.push({ s, major: Math.abs(s / step - Math.round(s / step)) < 1e-6 });
    return out;
  }, [view, minor, step]);

  const showTip = (e: React.MouseEvent, next: Omit<Tip, "x" | "y">) =>
    setTip({ x: e.clientX, y: e.clientY, ...next });

  const cardTip = (c: Card): Omit<Tip, "x" | "y"> => ({
    title:
      c.caption.state === "complete"
        ? `${fmtClock(c.startS)} · ${c.caption.label} · ${c.caption.hand}`
        : `${fmtClock(c.startS)} · ${c.kind === "failed_window" ? "failed window" : "caption failed"}`,
    sub: `#${c.index + 1}/${model.cards.length} · ${(c.endS - c.startS).toFixed(1)} s · click to open it in the rail`,
    body: c.caption.state === "complete" ? c.caption.text : c.caption.message,
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
          <span>derived</span>
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
          <LabelCell h="h-11">
            <span className="flex flex-col leading-tight whitespace-normal">
              Segments
              <small className="hidden text-[10.5px] font-medium text-muted md:block">
                color = hand (derived)
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
          className="relative mr-6 cursor-crosshair overflow-hidden rounded-br-lg bg-field"
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setHover(e.clientX - rect.left);
            const el = (e.target as HTMLElement).closest<HTMLElement>(
              "[data-tip]",
            );
            if (!el) {
              setTip({
                x: e.clientX,
                y: e.clientY,
                title: "",
                sub: fmtPrecise(tOf(e.clientX - rect.left, view, rect.width)),
              });
            }
          }}
          onMouseLeave={() => {
            setTip(null);
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
            className="relative h-11 border-t border-line"
            id="lSeg"
            data-lane="segments"
          >
            {model.cards.map((c) => {
              if (!visible(c.startS, c.endS)) return null;
              const l = x(c.startS);
              const w = Math.max(2, x(c.endS) - l - 1);
              const on = selected === c.index;
              const dim = dimmed.has(c.index);
              const ok = c.caption.state === "complete";
              const gap = c.kind === "failed_window";
              const hc =
                c.caption.state === "complete"
                  ? HAND_COLORS[c.caption.hand]
                  : null;
              return (
                <div
                  key={c.segmentId}
                  data-card={c.index}
                  role="button"
                  tabIndex={0}
                  aria-label={`Segment ${c.index + 1}`}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelect(c.index);
                    }
                  }}
                  data-testid={gap ? "block-failed-window" : "block-segment"}
                  data-selected={on ? "true" : undefined}
                  data-tip="1"
                  className={[
                    "absolute top-1.5 bottom-1.5 flex cursor-pointer items-center overflow-hidden rounded-md px-1.5 text-[11px] font-semibold whitespace-nowrap",
                    gap
                      ? "border border-dashed border-[#edc8cc] text-danger [background-image:repeating-linear-gradient(135deg,rgba(173,57,65,.10)_0_5px,transparent_5px_10px)]"
                      : "shadow-[inset_0_0_0_1px_rgba(25,38,35,.18)]",
                    !ok && !gap
                      ? "bg-danger-soft text-danger [background-image:repeating-linear-gradient(135deg,rgba(173,57,65,.18)_0_4px,transparent_4px_8px)]"
                      : "",
                    on
                      ? "z-[2] shadow-[0_0_0_2px_#192623,inset_0_0_0_1px_rgba(0,0,0,.2)]"
                      : "",
                    dim ? "opacity-20" : "",
                  ].join(" ")}
                  style={{
                    left: l,
                    width: w,
                    ...(hc
                      ? {
                          background: on ? hc.sat : hc.bg,
                          color: on ? "#fff" : hc.ink,
                        }
                      : {}),
                  }}
                  onMouseMove={(e) => {
                    showTip(e, cardTip(c));
                  }}
                >
                  {w > 64 ? (
                    <span className="min-w-0 truncate">
                      {c.caption.state === "complete"
                        ? c.caption.label
                        : gap
                          ? "window failed"
                          : "caption failed"}
                    </span>
                  ) : null}
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
                    ? `Failed window · ${f.code}`
                    : `Caption failed · ${f.code}`;
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
        <span className="hidden md:inline">
          scroll to pan · ctrl+scroll to zoom · click a block to open it in the
          rail
        </span>
      </div>
      {tip ? (
        <div
          role="tooltip"
          data-testid="tier-tooltip"
          className="pointer-events-none fixed z-50 max-w-[280px] rounded-lg border border-line bg-white px-3 py-2 text-xs shadow-[0_8px_28px_#21332a22]"
          style={{
            left: Math.min(
              (typeof window === "undefined" ? 1200 : window.innerWidth) - 290,
              tip.x + 14,
            ),
            top: tip.y + 16,
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
  first,
  children,
}: {
  h: string;
  first?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`flex items-center gap-2 pr-2 pl-3 whitespace-nowrap md:pr-3.5 md:pl-6 ${h} ${first ? "" : "border-t border-line"}`}
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
      className="inline-flex min-h-[30px] items-center justify-center rounded-lg border border-line bg-white px-2.5 text-xs font-semibold hover:bg-field"
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
