#!/usr/bin/env python3
"""Write the SA-50 golden `valid.mcap` re-framed as an indexed/chunked MCAP (SA-100 gate e2e).

    uv run --project workers/processing python workers/processing/tools/golden_indexed_mcap.py OUT.mcap

The worker's MCAP reader needs the indexed form; the committed golden is flat. The bytes of every
record are copied from the committed golden (tests/indexed_fixture.py), no media is generated.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tests"))

from indexed_fixture import chunked  # noqa: E402

GOLDEN = ROOT.parents[1] / "packages/contracts/capture/golden/valid.mcap"


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("usage: golden_indexed_mcap.py OUT.mcap")
    Path(sys.argv[1]).write_bytes(chunked(GOLDEN.read_bytes()))


if __name__ == "__main__":
    main()
