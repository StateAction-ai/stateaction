// caption_rule@1: the deterministic short label and hand derived from a model
// caption. TypeScript port of the reference rule script (short_label.py); the
// two must agree case for case (see test/review-short-label.test.mjs). The
// server stores `derived` with every complete caption; this port exists for
// fixtures and for display fallbacks only. It never feeds back into model text.

export type Hand = "left" | "right" | "both" | "none";

const HAND_PHRASE =
  /\s+(with|using|in|by)\s+(the\s+)?(left|right|both)\s+hands?\b.*$/;
const HAND_WORD =
  /\s+(with|using|in|by)\s+(the\s+)?(left|right|both)\s+hands?\b/;
// Stabilising actions, skipped when another action exists.
const STOP = new Set(["hold", "keep", "grip", "support"]);
const ARTICLES = new Set(["the", "a", "an"]);
const PREPOSITIONS = new Set([
  "on",
  "into",
  "onto",
  "from",
  "to",
  "in",
  "at",
  "under",
  "over",
  "off",
  "with",
  "inside",
  "toward",
  "towards",
  "near",
  "against",
  "around",
  "through",
  "across",
  "behind",
  "along",
]);
const PHRASAL = new Set([
  "pick up",
  "put down",
  "turn on",
  "turn off",
  "take out",
]);
const TRAILING = new Set(["of", "and", "or", "with", "while", "side", "the"]);

const words = (text: string): string[] => text.split(/\s+/).filter(Boolean);
const firstWord = (text: string): string => words(text)[0] ?? "";

function actions(caption: string): string[] {
  return caption
    .split(",")
    .filter((a) => a.trim())
    .map((a) => a.replace(HAND_PHRASE, "").trim());
}

/** Verb and object of the main action, at most `maxWords` (one more for phrasal verbs). */
export function shortLabel(caption: string, maxWords = 4): string {
  const acts = actions(caption).filter(Boolean);
  if (acts.length === 0) return "";
  const lowered = acts.map((a) =>
    (a.toLowerCase().split(" while ")[0] ?? "").trim(),
  );
  const main =
    lowered.find((a) => a && !STOP.has(firstWord(a))) ?? lowered[0] ?? "";
  let tokens = words(main).filter((w) => !ARTICLES.has(w));
  for (let i = 2; i < tokens.length; i++) {
    if (PREPOSITIONS.has(tokens[i]!)) {
      tokens = tokens.slice(0, i);
      break;
    }
  }
  const two = PHRASAL.has(tokens.slice(0, 2).join(" "));
  tokens = tokens.slice(0, maxWords + (two ? 1 : 0));
  while (tokens.length > 2 && TRAILING.has(tokens[tokens.length - 1]!))
    tokens = tokens.slice(0, -1);
  return tokens.join(" ");
}

/** Hand of the main action (the same action the label uses). */
export function handOf(caption: string): Hand {
  const raw = caption
    .split(",")
    .filter((a) => a.trim())
    .map((a) => a.trim().toLowerCase().split(" while ")[0] ?? "");
  if (raw.length === 0) return "none";
  const found = raw.findIndex((a) => !STOP.has(firstWord(a)));
  const main = raw[found < 0 ? 0 : found]!;
  const m = HAND_WORD.exec(main);
  if (m) return m[3] as Hand;
  const left = main.includes("left hand");
  const right = main.includes("right hand");
  return left && right ? "both" : left ? "left" : right ? "right" : "none";
}

/** Caption split on commas, steps trimmed of spaces and tabs, empty steps dropped. */
export function captionStepList(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.replace(/^[ \t]+|[ \t]+$/g, ""))
    .filter(Boolean);
}
