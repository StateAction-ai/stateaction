import assert from "node:assert/strict";
import { test } from "node:test";
import {
  captionStepList,
  handOf,
  shortLabel,
} from "../lib/review/short-label.ts";

// [caption, label, hand]: expected values were produced by running the
// reference rule script (flora-work/scripts/short_label.py, caption_rule@1) on
// each caption, so the TypeScript port is checked case for case against it.
const CASES = [
  ["pick up knife with right hand", "pick up knife", "right"],
  [
    "hold onion with left hand, cut onion with knife in right hand",
    "cut onion",
    "right",
  ],
  [
    "wipe shelf with cloth in right hand, shift book on shelf with left hand",
    "wipe shelf",
    "right",
  ],
  [
    "hold cloth with right hand, rotate pitcher with both hands, tighten pitcher lid with right hand",
    "rotate pitcher",
    "both",
  ],
  ["pick up pitcher with right hand", "pick up pitcher", "right"],
  ["put down the cup on the table using the left hand", "put down cup", "left"],
  ["turn on the faucet with right hand", "turn on faucet", "right"],
  ["open the drawer, take out a spoon with both hands", "open drawer", "none"],
  ["keep lid steady with left hand", "keep lid steady", "left"],
  ["grip handle while pulling door with left hand", "grip handle", "none"],
  [
    "stir soup in the pot with a wooden spoon in the right hand",
    "stir soup",
    "right",
  ],
  [
    "slide the plate across the counter toward the sink with the left hand",
    "slide plate",
    "left",
  ],
  [
    "place the box of cereal and the milk carton on the shelf by both hands",
    "place box of cereal",
    "both",
  ],
  ["fold towel", "fold towel", "none"],
  [
    "pour water into the glass with left hand and right hand",
    "pour water",
    "left",
  ],
  [
    "support bowl with left hand, stir mixture with right hand",
    "stir mixture",
    "right",
  ],
  [
    "take out trash bag from the bin with both hands",
    "take out trash bag",
    "both",
  ],
  ["hold cup with left hand and right hand", "hold cup", "left"],
  [
    "wipe table with the cloth side of the sponge in right hand",
    "wipe table",
    "right",
  ],
  [
    "press the button with the right hand, turn knob with left hand",
    "press button",
    "right",
  ],
  ["", "", "none"],
  ["  ,  ", "", "none"],
  [
    "cut the long green onion into small pieces on board with knife of the chef in right hand",
    "cut long green onion",
    "right",
  ],
  ["Pick Up The Bottle With Right Hand", "pick up bottle", "right"],
];

test("shortLabel and handOf agree with the caption_rule@1 reference script", () => {
  for (const [caption, label, hand] of CASES) {
    assert.equal(shortLabel(caption), label, `label for: ${caption}`);
    assert.equal(handOf(caption), hand, `hand for: ${caption}`);
  }
});

test("captionStepList splits on commas and trims spaces and tabs", () => {
  assert.deepEqual(
    captionStepList(" hold cup with left hand,,\tpour water ,"),
    ["hold cup with left hand", "pour water"],
  );
});
