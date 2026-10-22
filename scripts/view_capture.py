#!/usr/bin/env python3
"""Open a processed capture in Rerun without requiring a file-system watcher.

Usage:
    python3 scripts/view_capture.py
    python3 scripts/view_capture.py /absolute/path/to/visualization.rrd
    python3 scripts/view_capture.py --check

An explicit '-' makes Rerun read stdin instead of attaching an inotify watch.
The viewer uses a free local port, so an existing viewer can remain open.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("recording", nargs="?", type=Path, help="Defaults to the newest processed session")
    parser.add_argument("--check", action="store_true", help="Verify viewer ingestion and exit without opening a window")
    args = parser.parse_args()

    if args.recording is None:
        recordings = []
        for receipt in (ROOT / "captures").glob("session_*/stera_processed*/receipt.json"):
            try:
                run = json.loads(receipt.read_text())
            except (OSError, ValueError):
                continue
            recording = receipt.parent / "episode" / "visualization.rrd"
            if run.get("status") == "complete" and run.get("default_viewer_eligible", True) and recording.is_file():
                recordings.append((receipt.parent.parent.name,
                                   run.get("finished_utc", ""), recording))
        if not recordings:
            parser.error("No completed processed recording found; run scripts/process_capture.py first")
        recording = max(recordings)[2]
    else:
        recording = args.recording.expanduser().resolve()

    viewer = ROOT / ".venv-stera" / "bin" / "rerun"
    if not viewer.is_file():
        parser.error(f"Rerun is not installed at {viewer}; install requirements-stera.txt in .venv-stera")
    try:
        stream = recording.open("rb")
    except OSError as error:
        parser.error(f"Cannot read recording {recording}: {error}")

    options = [str(viewer), "--bind", "127.0.0.1", "--port", "0"]
    if args.check:
        options.append("--test-receive")
    options.append("-")
    print(f"{'Checking' if args.check else 'Opening'} {recording}", flush=True)
    with stream:
        os.dup2(stream.fileno(), 0)
        os.execv(str(viewer), options)


if __name__ == "__main__":
    main()
