import assert from "node:assert/strict";
import test from "node:test";
import { hasNoHandInterval } from "../src/acceptance/review-search.js";
import { reviewSearchTerms } from "../src/datasets/review-catalog.js";

test("both hands must be undetected on the same accepted frame", () => {
  const left = [
    { frames: 3, state: "no_hand" },
    { frames: 2, state: "present" },
  ];
  assert.equal(
    hasNoHandInterval(left, [
      { frames: 3, state: "failed" },
      { frames: 2, state: "no_hand" },
    ]),
    false,
  );
  assert.equal(
    hasNoHandInterval(left, [
      { frames: 2, state: "failed" },
      { frames: 3, state: "no_hand" },
    ]),
    true,
  );
});

test("search parses negative phrases and treats LIKE metacharacters literally", () => {
  assert.deepEqual(reviewSearchTerms('mug -"blue mug" 10%_'), [
    { value: "mug", pattern: "%mug%", excluded: false },
    { value: "blue mug", pattern: "%blue mug%", excluded: true },
    { value: "10%_", pattern: "%10\\%\\_%", excluded: false },
  ]);
});
