// Builds the review view model from the annotations document. Pure and
// deterministic. Times are seconds from the first decoded frame (the video's
// time zero). Failures stay failures: a failed window, a failed caption, a
// missing caption row and a hand-pose frame without a result are each surfaced
// with their code, never folded into an empty or "no hand" result.

import type {
  CaptionsV1,
  DagRunV1,
  EndFrameRef,
  FrameRef,
  HandPresenceSpan,
  Producer,
} from "@stateaction/contracts";
import { captionStepList, handOf, shortLabel } from "./short-label.ts";
import type {
  Card,
  CardCaption,
  ClipSpan,
  FailureSpan,
  Hand,
  LaneSpan,
  ProvenanceBadge,
  RecordingAnnotations,
  ReviewModel,
} from "./types.ts";

const NS = 1e9;

function minNs(values: (string | null | undefined)[]): bigint {
  let min: bigint | null = null;
  for (const v of values) {
    if (v == null) continue;
    const n = BigInt(v);
    if (min === null || n < min) min = n;
  }
  return min ?? 0n;
}

export function originOf(a: RecordingAnnotations): bigint {
  return minNs([
    a.hand_presence?.lanes.left[0]?.start.timestamp_ns,
    a.hand_presence?.lanes.right[0]?.start.timestamp_ns,
    a.segments?.rows[0]?.start.timestamp_ns,
  ]);
}

export function buildReviewModel(
  annotations: RecordingAnnotations,
  clips: readonly ClipSpan[],
  durationS: number,
): ReviewModel {
  const origin = originOf(annotations);
  const originKnown =
    annotations.hand_presence !== null ||
    (annotations.segments?.rows.length ?? 0) > 0;
  const sec = (ref: FrameRef | EndFrameRef | null | undefined): number =>
    ref && ref.timestamp_ns !== null
      ? Number(BigInt(ref.timestamp_ns) - origin) / NS
      : durationS;
  const nsToS = (ns: string) => Number(BigInt(ns) - origin) / NS;

  const captions = new Map(
    (annotations.captions?.rows ?? []).map((r) => [r.segment_id, r]),
  );
  const captionNode = annotations.dag_run?.stages.find(
    (s) => s.stage === "caption",
  );
  // No invented codes: the dag-run node's code when it has one, else unknown.
  const missingCode = captionNode?.errorCode ?? null;
  const windowErrors = new Map(
    (annotations.segments?.windows.failed ?? []).map((w) => [
      w.core_start.source_frame_id,
      w.error_code,
    ]),
  );

  const presence = (spans: HandPresenceSpan[] | undefined) =>
    (spans ?? []).map((s) => ({
      startS: sec(s.start),
      endS: sec(s.end),
      state: s.state,
    }));
  const leftSpans = presence(annotations.hand_presence?.lanes.left);
  const rightSpans = presence(annotations.hand_presence?.lanes.right);
  // Percentage over covered time only (present + no_hand). Failed or
  // uncovered time is excluded, never counted as 0 %; no coverage is unknown.
  const share = (
    spans: { startS: number; endS: number; state: string }[],
    a: number,
    b: number,
  ): { pct: number | null; partial: boolean } => {
    if (spans.length === 0 || b <= a) return { pct: null, partial: false };
    let present = 0;
    let covered = 0;
    for (const s of spans) {
      const o = Math.max(0, Math.min(b, s.endS) - Math.max(a, s.startS));
      if (s.state === "present") present += o;
      if (s.state === "present" || s.state === "no_hand") covered += o;
    }
    if (covered <= 1e-9) return { pct: null, partial: false };
    return {
      pct: Math.round((present / covered) * 100),
      partial: b - a - covered > 1e-6,
    };
  };

  const cards: Card[] = (annotations.segments?.rows ?? []).map((row, index) => {
    const startS = sec(row.start);
    const endS = sec(row.end);
    let caption: CardCaption;
    let derivedLocally = false;
    if (row.status === "failed_window") {
      const code =
        windowErrors.get(row.start.source_frame_id) ??
        (captions.get(row.segment_id)?.error_code as string | undefined) ??
        "unknown";
      caption = { state: "failed", code, message: `window failed: ${code}` };
    } else {
      const c = captions.get(row.segment_id);
      if (c && c.status === "complete") {
        derivedLocally = !c.derived;
        caption = {
          state: "complete",
          text: c.text,
          steps: c.derived?.steps ?? captionStepList(c.text),
          label: c.derived?.short_label ?? shortLabel(c.text),
          hand: c.derived?.hand ?? handOf(c.text),
        };
      } else if (c) {
        const verb = c.status === "failed" ? "caption failed" : "not captioned";
        caption = {
          state: "failed",
          code: c.error_code,
          message: `${verb}: ${c.error_code}`,
        };
      } else {
        caption = missingCode
          ? {
              state: "failed",
              code: missingCode,
              message: `caption failed: ${missingCode}`,
            }
          : {
              state: "failed",
              code: "unknown",
              message: "caption missing: no caption row",
            };
      }
    }
    return {
      index,
      segmentId: row.segment_id,
      startS,
      endS,
      startFrameId: row.start.source_frame_id,
      endFrameId: row.end.source_frame_id,
      kind: row.status === "failed_window" ? "failed_window" : "segment",
      caption,
      handsLR: (() => {
        const l = share(leftSpans, startS, endS);
        const r = share(rightSpans, startS, endS);
        return { left: l.pct, right: r.pct, partial: l.partial || r.partial };
      })(),
      derivedLocally,
    };
  });

  const failures: FailureSpan[] = [];
  for (const w of annotations.segments?.windows.failed ?? []) {
    const startS = sec(w.core_start);
    const endS = sec(w.core_end);
    failures.push({
      kind: "window",
      startS,
      endS,
      code: w.error_code,
      cardIndex:
        cards.find((c) => c.kind === "failed_window" && c.startS === startS)
          ?.index ?? null,
    });
  }
  for (const c of cards)
    if (c.kind === "segment" && c.caption.state === "failed")
      failures.push({
        kind: "caption",
        startS: c.startS,
        endS: c.endS,
        code: c.caption.code,
        cardIndex: c.index,
      });
  failures.sort((a, b) => a.startS - b.startS);

  const handCounts: Record<Hand, number> = {
    left: 0,
    right: 0,
    both: 0,
    none: 0,
  };
  for (const c of cards)
    if (c.caption.state === "complete") handCounts[c.caption.hand]++;

  const lane = (spans: ReturnType<typeof presence>): LaneSpan[] =>
    spans
      .filter((s) => s.state !== "no_hand")
      .map((s) => ({
        startS: s.startS,
        endS: s.endS,
        state: s.state === "failed" ? "failed" : "present",
      }));

  return {
    durationS,
    originNs: origin.toString(),
    cards,
    lanes: { left: lane(leftSpans), right: lane(rightSpans) },
    presence: annotations.hand_presence ? "available" : "absent",
    presenceNote: annotations.hand_presence ? null : presenceNote(annotations),
    derivedRule:
      (
        annotations.captions?.rows.find(
          (r) => r.status === "complete" && r.derived,
        ) as { derived?: { rule: string } } | undefined
      )?.derived?.rule ?? null,
    failures,
    handCounts,
    // Without a first-frame reference (no hand presence, no segment row) a clip window
    // cannot be placed on the axis: it is left out, never shown at an epoch offset.
    clips: (originKnown ? clips : []).map((c) => ({
      clipId: c.clipId,
      startS: nsToS(c.startNs),
      endS: nsToS(c.endNs),
    })),
    provenance: provenanceBadges(annotations),
    summary: {
      segments: cards.filter((c) => c.kind === "segment").length,
      failedWindows: annotations.segments?.windows.failed.length ?? 0,
      failedCaptions: cards.filter(
        (c) => c.kind === "segment" && c.caption.state === "failed",
      ).length,
    },
  };
}

const STAGE_LABEL = {
  segment: "segment",
  caption: "caption",
  hand_pose: "hand pose",
} as const;

export function provenanceBadges(a: RecordingAnnotations): ProvenanceBadge[] {
  const producers: [ProvenanceBadge["stage"], Producer | null][] = [
    ["segment", a.segments?.producer ?? null],
    ["caption", (a.captions as CaptionsV1 | null)?.producer ?? null],
    ["hand_pose", a.hand_presence?.producer ?? null],
  ];
  return producers.map(([stage, p]) => {
    if (!p) {
      const node = (a.dag_run as DagRunV1 | null)?.stages.find(
        (s) => s.stage === stage,
      );
      const why = node
        ? `${node.state}${node.errorCode ? `: ${node.errorCode}` : ""}`
        : "no output";
      return {
        stage,
        text: `${STAGE_LABEL[stage]}: ${why}`,
        detail: `${STAGE_LABEL[stage]} stage produced no document (${why}).`,
        tone: "absent",
      };
    }
    const tone =
      p.engine.name === "replay"
        ? "replay"
        : p.engine.name === "stub"
          ? "stub"
          : "model";
    const rev = p.model_revision ? p.model_revision.slice(0, 7) : null;
    const gpu = p.gpu.observed_type ?? "no GPU";
    const parts = [
      `${p.module_id}@${p.module_version}${rev ? ` ${rev}` : ""}`,
      `${p.engine.name} ${p.engine.version}${p.quant ? ` ${p.quant.method}` : ""}`,
      gpu,
    ];
    const label = tone === "model" ? "" : `${tone} · `;
    return {
      stage,
      text: `${label}${parts.join(" · ")}`,
      detail: [
        `${STAGE_LABEL[stage]}: ${p.model_name}${p.model_revision ? ` @ ${p.model_revision}` : ""}`,
        `module ${p.module_id}@${p.module_version}`,
        `engine ${p.engine.name} ${p.engine.version}${p.quant ? `, quant ${p.quant.method}` : ""}`,
        `weights ${p.weights_sha256 ?? "none"}`,
        `prompt ${p.prompt_sha256 ?? "none"}`,
        `params ${p.params_sha256}`,
        `GPU requested ${p.gpu.requested_type}, observed ${p.gpu.observed_type ?? "none"}`,
      ].join("\n"),
      tone,
    };
  });
}

function presenceNote(a: RecordingAnnotations): string {
  const node = a.dag_run?.stages.find((s) => s.stage === "hand_pose");
  return node
    ? `${node.state}${node.errorCode ? `: ${node.errorCode}` : ""}`
    : "no hand-presence document";
}
