"""`caption_rule@1` golden triples. Synthetic captions in FLORA's style (decision H2: no HomER text).

The expected `(short_label, hand)` values were produced by the reference script `short_label.py`
(`label`, `hand`) and pasted here as plain strings, so the port is checked against the original.
"""

import unittest

from stateaction_processing import caption_rule

GOLDEN = [
    ("pick up knife with right hand", "pick up knife", "right"),
    ("hold knife with right hand, pick up onion with left hand", "pick up onion", "left"),
    ("hold onion with left hand, cut onion with knife in right hand", "cut onion", "right"),
    ("pick up the pan using both hands, move pan onto stove", "pick up pan", "both"),
    ("turn on faucet with left hand while holding cup in right hand", "turn on faucet", "left"),
    ("put down bowl on counter with right hand", "put down bowl", "right"),
    ("open drawer with right hand, take out spoon with right hand", "open drawer", "right"),
    ("hold lid with left hand, stir sauce with spoon in right hand", "stir sauce", "right"),
    ("grip handle with left hand, pour water into cup with right hand", "pour water", "right"),
    ("wipe table with cloth in right hand", "wipe table", "right"),
    ("keep jar with left hand, unscrew lid of the jar with right hand", "unscrew lid of jar", "right"),
    ("take out plate from cabinet with both hands", "take out plate", "both"),
    ("close fridge door with left hand", "close fridge door", "left"),
    ("support bowl with left hand, crack egg into bowl with right hand", "crack egg", "right"),
    ("put down knife on cutting board", "put down knife", "none"),
]  # fmt: skip


class CaptionRuleTests(unittest.TestCase):
    def test_golden_triples(self) -> None:
        self.assertEqual(len(GOLDEN), 15)
        for text, short, side in GOLDEN:
            with self.subTest(text):
                self.assertEqual(caption_rule.label(text), short)
                self.assertEqual(caption_rule.hand(text), side)

    def test_derive_is_the_contract_block(self) -> None:
        derived = caption_rule.derive(GOLDEN[1][0])
        self.assertEqual(derived["rule"], "caption_rule@1")
        self.assertEqual(
            derived["steps"],
            ["hold knife with right hand", "pick up onion with left hand"],
        )
        self.assertEqual(
            (derived["short_label"], derived["hand"]), ("pick up onion", "left")
        )

    def test_underivable_text_is_an_error_not_a_guess(self) -> None:
        for text in (",", " , ,"):
            with self.subTest(text), self.assertRaises(caption_rule.DerivationError):
                caption_rule.derive(text)


if __name__ == "__main__":
    unittest.main()
