"""`caption_rule@1`: short label, hand and steps derived from caption text, outside the model.

`label` and `hand` are ported verbatim (code and constants) from the reference script
`scripts/short_label.py`; `steps` is the shared contract helper. The output never feeds back into
model output and carries only text derived from the caption itself.
"""

from __future__ import annotations

import re
from typing import Any

RULE = "caption_rule@1"

HAND = re.compile(r"\s+(with|using|in|by)\s+(the\s+)?(left|right|both)\s+hands?\b.*$")
STOP = {
    "hold",
    "keep",
    "grip",
    "support",
}  # stabilising actions, skipped when another action exists
HANDRX = re.compile(r"\s+(with|using|in|by)\s+(the\s+)?(left|right|both)\s+hands?\b")
_PREPOSITIONS = {
    "on", "into", "onto", "from", "to", "in", "at", "under", "over", "off", "with",
    "inside", "toward", "towards", "near", "against", "around", "through", "across",
    "behind", "along",
}  # fmt: skip
_PHRASAL = {"pick up", "put down", "turn on", "turn off", "take out"}
_TRAILING = {"of", "and", "or", "with", "while", "side", "the"}


def actions(caption: str) -> list[str]:
    return [HAND.sub("", a).strip() for a in caption.split(",") if a.strip()]


def label(caption: str, max_words: int = 4) -> str:
    acts = [a for a in actions(caption) if a]
    if not acts:
        return ""
    acts = [a.lower().split(" while ")[0] for a in acts]
    main = next((a for a in acts if a.split()[0] not in STOP), acts[0])
    words = [w for w in main.split() if w not in {"the", "a", "an"}]
    # cut at a trailing prepositional phrase once we have verb + object
    for i, w in enumerate(words[2:], 2):
        if w in _PREPOSITIONS:
            words = words[:i]
            break
    two = " ".join(words[:2]) in _PHRASAL
    words = words[: max_words + (1 if two else 0)]
    while len(words) > 2 and words[-1] in _TRAILING:
        words = words[:-1]
    return " ".join(words)


def hand(caption: str) -> str:
    """Hand of the main action (same action the label uses)."""
    raw = [
        a.strip().lower().split(" while ")[0] for a in caption.split(",") if a.strip()
    ]
    if not raw:
        return "none"
    k = next((i for i, a in enumerate(raw) if a.split()[0] not in STOP), 0)
    m = HANDRX.search(raw[k])
    if m:
        return m.group(3)
    left, right = "left hand" in raw[k], "right hand" in raw[k]
    return (
        "both" if left and right else "left" if left else "right" if right else "none"
    )


class DerivationError(ValueError):
    """The rule cannot produce a contract-valid derived block for this text."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def derive(text: str) -> dict[str, Any]:
    """The `derived` block of a complete caption row, or `DerivationError` (never a guess)."""
    from stateaction_contracts import caption_steps

    short = label(text)
    steps = caption_steps(text)
    if not short or len(short) > 64 or not steps:
        raise DerivationError("caption_rule_underivable")
    return {"rule": RULE, "short_label": short, "hand": hand(text), "steps": steps}
