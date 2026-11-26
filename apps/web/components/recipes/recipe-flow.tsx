"use client";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { X } from "lucide-react";
import type { RecipeGraphNode } from "@stateaction/server/pipeline";
import styles from "./recipe-flow.module.css";
import {
  ProcessingStatus,
  statusLabel,
  statusTone,
} from "../recordings/processing-status";

const width = 122;
const height = 84;
const columnGap = 22;
const rowGap = 20;
const pad = 14;
const mark = {
  danger: "!",
  good: "✓",
  running: "↻",
  held: "Ⅱ",
  reused: "↪",
  waiting: "–",
};

function layout(nodes: readonly RecipeGraphNode[]) {
  const levels = new Map<string, number>();
  const columns: RecipeGraphNode[][] = [];
  for (const node of nodes) {
    const level =
      Math.max(-1, ...node.parents.map((parent) => levels.get(parent) ?? -1)) +
      1;
    levels.set(node.id, level);
    (columns[level] ??= []).push(node);
  }
  const rows = Math.max(...columns.map((column) => column.length));
  return {
    width: columns.length * (width + columnGap) - columnGap + 2 * pad,
    height: rows * (height + rowGap) - rowGap + 2 * pad,
    positions: new Map(
      columns.flatMap((column, level) =>
        column.map(
          (node, row) =>
            [
              node.id,
              {
                x: pad + level * (width + columnGap),
                y: pad + (row + (rows - column.length) / 2) * (height + rowGap),
              },
            ] as const,
        ),
      ),
    ),
  };
}

export function RecipeFlow({
  nodes,
  retry,
  details,
  initialStep,
}: {
  nodes: readonly RecipeGraphNode[];
  retry?: ReactNode;
  details?: Record<string, ReactNode> | undefined;
  initialStep?: string | undefined;
}) {
  const id = useId();
  const [selected, setSelected] = useState(initialStep);
  const panel = useRef<HTMLElement>(null);
  const focusSelection = useRef(false);
  useLayoutEffect(() => {
    if (!focusSelection.current) return;
    focusSelection.current = false;
    const element = panel.current;
    element?.focus({ preventScroll: true });
    element?.scrollIntoView({
      block: "nearest",
      inline: "nearest",
      behavior: "instant",
    });
  }, [selected]);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const scroll = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  const canvas = nodes.length > 0 ? layout(nodes) : null;
  const canvasWidth = canvas?.width ?? 0;
  useEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setOverflow(element.clientWidth < canvasWidth),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [canvasWidth]);
  const chosen = nodes.find((node) => selected === node.id);
  const blockedBy =
    chosen?.status === "not_run"
      ? nodes.find(
          (node) =>
            chosen.parents.includes(node.id) &&
            node.status &&
            statusTone(node.status) === "danger",
        )
      : undefined;

  function close() {
    setSelected(undefined);
    if (selected) buttons.current.get(selected)?.focus();
  }

  return (
    <section
      aria-labelledby={id + "-heading"}
      className="grid min-w-0 gap-3"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !chosen || event.defaultPrevented) return;
        if (
          event.target instanceof Element &&
          event.target.closest('[role="dialog"], dialog')
        )
          return;
        event.preventDefault();
        close();
      }}
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <h2 id={id + "-heading"} className="text-lg font-bold">
          Processing flow
        </h2>
        {retry}
      </header>
      {canvas ? (
        <div className="min-w-0 overflow-hidden rounded-lg border border-line bg-paper">
          <div
            ref={scroll}
            className={`min-w-0 overflow-x-auto focus-visible:-outline-offset-2 focus-visible:outline-brand ${styles.graph}`}
            role="region"
            aria-label="Recipe graph"
            tabIndex={overflow ? 0 : -1}
          >
            <div
              className="relative mx-auto"
              style={{ width: canvas.width, height: canvas.height }}
            >
              <svg
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 text-muted"
                width={canvas.width}
                height={canvas.height}
              >
                <defs>
                  <marker
                    id={id + "-arrow"}
                    markerWidth="5"
                    markerHeight="5"
                    viewBox="0 0 5 5"
                    refX="5"
                    refY="2.5"
                    orient="auto"
                  >
                    <path d="M0 0 5 2.5 0 5z" fill="currentColor" />
                  </marker>
                </defs>
                {nodes.flatMap((node) =>
                  node.parents.map((parent) => {
                    const from = canvas.positions.get(parent);
                    const to = canvas.positions.get(node.id)!;
                    if (!from) return null;
                    const x = from.x + width;
                    const y = from.y + height / 2;
                    const end = to.x - 2;
                    const finish = to.y + height / 2;
                    return (
                      <path
                        key={JSON.stringify([parent, node.id])}
                        d={`M${x} ${y} C${x + columnGap / 2} ${y} ${end - columnGap / 2} ${finish} ${end} ${finish}`}
                        fill="none"
                        stroke="currentColor"
                        markerEnd={`url(#${id}-arrow)`}
                      />
                    );
                  }),
                )}
              </svg>
              {nodes.map((node) => {
                const tone = node.status ? statusTone(node.status) : undefined;
                return (
                  <button
                    key={node.id}
                    type="button"
                    data-step={node.id}
                    data-tone={tone}
                    ref={(element) => {
                      if (element) buttons.current.set(node.id, element);
                      else buttons.current.delete(node.id);
                    }}
                    onClick={() => {
                      if (selected === node.id) close();
                      else {
                        focusSelection.current = true;
                        setSelected(node.id);
                      }
                    }}
                    aria-expanded={selected === node.id}
                    aria-controls={
                      selected === node.id ? id + "-details" : undefined
                    }
                    className={`${styles.node} absolute flex cursor-pointer flex-col items-start justify-center gap-1.5 rounded-lg border p-2 text-left text-[13px] leading-tight shadow-xs focus-visible:outline-2 focus-visible:outline-brand ${selected === node.id ? "border-brand ring-1 ring-brand" : "border-line hover:border-brand"}`}
                    style={{
                      left: canvas.positions.get(node.id)!.x,
                      top: canvas.positions.get(node.id)!.y,
                      width,
                      height,
                    }}
                  >
                    <span
                      className="line-clamp-2 font-semibold"
                      title={node.label}
                    >
                      {node.label}
                    </span>
                    {node.status && tone && (
                      <span className={styles.status}>
                        <span className={styles.statusIcon} aria-hidden="true">
                          {mark[tone]}
                        </span>
                        {statusLabel(node.status)}
                      </span>
                    )}
                    {(!node.status || node.summary) && (
                      <span className="text-[11px] text-muted">
                        {node.summary ??
                          (node.id === "$clips"
                            ? "One run per clip"
                            : node.scope === "clip"
                              ? "Each clip"
                              : "Recording")}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
          {overflow && (
            <p className="border-t border-line px-3 py-2 text-xs text-muted">
              Scroll sideways to see more steps.
            </p>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted">Recipe definition unavailable.</p>
      )}
      {chosen && (
        <section
          id={id + "-details"}
          data-step-details={chosen.id}
          aria-labelledby={id + "-step"}
          ref={panel}
          tabIndex={-1}
          className="min-w-0 rounded-lg border border-line bg-paper p-4 outline-none sm:p-5"
        >
          <header className="mb-3 flex items-center justify-between gap-3">
            <h3 id={id + "-step"} className="text-lg font-bold wrap-anywhere">
              {chosen.label}
            </h3>
            <button
              type="button"
              aria-label="Close step details"
              onClick={close}
              className="shrink-0 cursor-pointer rounded p-2 hover:bg-field focus-visible:outline-brand"
            >
              <X size={18} />
            </button>
          </header>
          <dl className="mb-3 flex flex-wrap gap-x-5 gap-y-2 text-sm">
            {[
              ["Scope", chosen.scope === "clip" ? "Clip" : "Recording"],
              ["Model", chosen.model],
              ["Compute", chosen.compute],
              ["Licence", chosen.licence],
              [
                "Inputs",
                chosen.inputs?.length
                  ? chosen.inputs.join(", ")
                  : nodes
                      .filter((node) => chosen.parents.includes(node.id))
                      .map(({ label }) => label)
                      .join(", "),
              ],
              ["Outputs", chosen.outputs?.join(", ")],
            ].map(
              ([label, value]) =>
                value && (
                  <div key={label} className="min-w-0">
                    <dt className="text-xs text-muted">{label}</dt>
                    <dd className="wrap-anywhere">{value}</dd>
                  </div>
                ),
            )}
          </dl>
          {chosen.status && (
            <div className="mb-3">
              <ProcessingStatus state={chosen.status} />
            </div>
          )}
          {blockedBy && (
            <p className="mb-3 text-sm text-muted">
              Waiting for {blockedBy.label.toLowerCase()}.
            </p>
          )}
          {details?.[chosen.id]}
        </section>
      )}
    </section>
  );
}
