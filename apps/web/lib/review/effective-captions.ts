import { captionStepList, handOf, shortLabel } from "./short-label.ts";
import type { Card, ReviewModel } from "./types.ts";

export type CaptionOverride = { segmentId: string; text: string | null };

export function effectiveCaption(card: Card, text: string | null): Card {
  return {
    ...card,
    caption:
      text === null
        ? { state: "omitted" }
        : {
            state: "complete",
            text,
            label: shortLabel(text),
            steps: captionStepList(text),
            hand: handOf(text),
          },
    derivedLocally: false,
  };
}

export function applyCaptionOverrides(
  model: ReviewModel,
  overrides: readonly CaptionOverride[],
): ReviewModel {
  const replacements = new Map(
    overrides.map((row) => [row.segmentId, row.text]),
  );
  if (replacements.size === 0) return model;
  const cards = model.cards.map((card) => {
    const text = replacements.get(card.segmentId);
    return text === undefined ? card : effectiveCaption(card, text);
  });
  const failures = model.failures.filter(
    (span) =>
      span.kind === "window" ||
      span.cardIndex === null ||
      cards[span.cardIndex]?.caption.state === "failed",
  );
  return {
    ...model,
    cards,
    failures,
    summary: {
      ...model.summary,
      failedCaptions: failures.filter((span) => span.kind === "caption").length,
    },
  };
}

/** This is the only model passed from server to customer playback. */
export function customerReviewModel(model: ReviewModel): ReviewModel {
  const hands = { left: 0, right: 0, both: 0, none: 0 };
  for (const card of model.cards) {
    if (card.caption.state === "complete") hands[card.caption.hand]++;
  }
  return {
    durationS: model.durationS,
    originNs: model.originNs,
    cards: model.cards.map((card, index) => ({
      index: card.index,
      segmentId: String(index),
      startS: card.startS,
      endS: card.endS,
      ...(card.endsAtVideoEnd ? { endsAtVideoEnd: card.endsAtVideoEnd } : {}),
      startFrameId: "",
      endFrameId: null,
      kind: card.kind,
      caption:
        card.caption.state === "failed"
          ? { state: "failed", code: "", message: "" }
          : card.caption.state === "omitted"
            ? { state: "omitted" }
            : {
                state: "complete",
                text: card.caption.text,
                label: card.caption.label,
                steps: card.caption.steps,
                hand: card.caption.hand,
              },
      handsLR: card.handsLR,
      derivedLocally: false,
    })),
    lanes: model.lanes,
    presence: model.presence,
    presenceNote: null,
    derivedRule: null,
    failures: model.failures.map((span) => ({ ...span, code: "" })),
    handCounts: hands,
    clips: model.clips,
    provenance: [],
    summary: model.summary,
  };
}
