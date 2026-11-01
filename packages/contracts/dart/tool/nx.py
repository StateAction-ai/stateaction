#!/usr/bin/env python3
"""Nx adapter for the pure-Dart contracts package; fails closed on an unpinned SDK."""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

PACKAGE = Path(__file__).resolve().parents[1]
ROOT = PACKAGE.parents[2]


def run(*command: str) -> None:
    subprocess.run(command, cwd=PACKAGE, check=True)


def main() -> None:
    target = sys.argv[1] if len(sys.argv) == 2 else ""
    toolchain = json.loads((ROOT / "config/mobile-toolchain.json").read_text())
    version = subprocess.run(
        ["dart", "--version"], capture_output=True, text=True, check=True
    )
    found = re.search(r"Dart SDK version: (\S+)", version.stdout + version.stderr)
    if not found or found.group(1) != toolchain["dart"]:
        raise SystemExit(
            f"Use pinned Dart {toolchain['dart']}; found {found and found.group(1)}"
        )
    if target == "prepare":
        run("dart", "pub", "get", "--enforce-lockfile")
    elif target == "typecheck":
        run("dart", "analyze", "--fatal-infos")
    elif target == "test":
        report = PACKAGE / "build" / "conformance-report.json"
        report.parent.mkdir(exist_ok=True)
        run("dart", "run", "tool/conformance.dart", str(report))
    elif target == "format":
        run(
            "dart",
            "format",
            "--output=none",
            "--set-exit-if-changed",
            f"--language-version={toolchain['dartFormatLanguageVersion']}",
            "lib",
            "tool",
        )
    else:
        raise SystemExit("usage: nx.py prepare|typecheck|test|format")


if __name__ == "__main__":
    main()
