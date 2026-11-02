#!/usr/bin/env python3
"""Bundle a probe run into one non-sensitive tracked receipt (no imagery, arrays or RRD bytes)."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("run", type=Path)
    ap.add_argument("output", type=Path)
    ap.add_argument("--provenance", type=Path)
    ap.add_argument(
        "--visual-readback",
        action="append",
        default=[],
        help="CLIP:DIRECTION:observation",
    )
    a = ap.parse_args()
    receipt = json.loads((a.run / "receipt.json").read_text())
    browser = {}
    for clip in sorted(a.run.glob("clip-*")):
        check = clip / "browser-check.json"
        if check.exists():
            browser[clip.name] = json.loads(check.read_text())
    for note in a.visual_readback:
        clip, direction, text = note.split(":", 2)
        browser[clip]["screenshots_visually_inspected"] = True
        for snap in browser[clip]["snapshots"]:
            if snap["direction"] == direction:
                snap["visual_readback"] = text
    out = {"probe_receipt": receipt, "browser_checks": browser}
    if a.provenance:
        out["input_provenance"] = json.loads(a.provenance.read_text())
    a.output.parent.mkdir(parents=True, exist_ok=True)
    a.output.write_text(json.dumps(out, indent=2, sort_keys=True) + "\n")


if __name__ == "__main__":
    main()
