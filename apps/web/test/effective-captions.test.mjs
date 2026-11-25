import { strict as assert } from "node:assert";
import test from "node:test";
import {
  applyCaptionOverrides,
  customerReviewModel,
} from "../lib/review/effective-captions.ts";

test("caption edits and omissions never expose original text or private metadata to a customer", () => {
  const model = {
    durationS: 4,
    originNs: "0",
    cards: [
      {
        index: 0,
        segmentId: "private-segment",
        startS: 0,
        endS: 2,
        startFrameId: "private-frame",
        endFrameId: "private-frame-end",
        kind: "segment",
        caption: {
          state: "complete",
          text: "Private original text",
          steps: ["Private step"],
          label: "Private label",
          hand: "none",
        },
        handsLR: { left: null, right: null, partial: false },
        derivedLocally: true,
      },
      {
        index: 1,
        segmentId: "omitted",
        startS: 2,
        endS: 4,
        startFrameId: "private-frame",
        endFrameId: null,
        kind: "segment",
        caption: {
          state: "failed",
          code: "private-failure",
          message: "Private failure details",
        },
        handsLR: { left: null, right: null, partial: false },
        derivedLocally: false,
      },
    ],
    lanes: { left: [], right: [] },
    presence: "absent",
    presenceNote: "Private provider issue",
    derivedRule: "private-rule",
    failures: [
      {
        kind: "caption",
        startS: 2,
        endS: 4,
        code: "private-failure",
        cardIndex: 1,
      },
    ],
    handCounts: { none: 1 },
    clips: [],
    provenance: [
      {
        stage: "caption",
        text: "Private model",
        detail: "Private model revision",
        tone: "model",
      },
    ],
    summary: { segments: 2, failedWindows: 0, failedCaptions: 1 },
  };
  const effective = applyCaptionOverrides(model, [
    { segmentId: "private-segment", text: "Turn the block." },
    { segmentId: "omitted", text: null },
  ]);
  const customer = customerReviewModel(effective);
  assert.equal(model.cards[0].caption.text, "Private original text");
  assert.equal(customer.cards[0].caption.text, "Turn the block.");
  assert.deepEqual(customer.cards[1].caption, { state: "omitted" });
  assert.doesNotMatch(JSON.stringify(customer), /private/i);
});
