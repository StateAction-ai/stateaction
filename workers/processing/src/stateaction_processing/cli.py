"""A bounded stdio boundary; media adapters import only on explicit request."""
from __future__ import annotations
import argparse
import json
import platform
import sys
import uuid
from pathlib import Path
from . import __version__


def parse_request(value: object) -> str:
    if not isinstance(value, dict) or set(value) != {"requestId"}:
        raise ValueError("Expected only requestId")
    identifier = value["requestId"]
    if not isinstance(identifier, str):
        raise ValueError("Expected string requestId")
    parsed = uuid.UUID(identifier)
    if str(parsed) != identifier or parsed.version not in (1, 2, 3, 4, 5) or parsed.variant != uuid.RFC_4122:
        raise ValueError("Expected canonical requestId UUID")
    return identifier


def main() -> None:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("health")
    cpu = commands.add_parser("process-local")
    cpu.add_argument("source", type=Path)
    cpu.add_argument("output", type=Path)
    cpu.add_argument("--expected-sha256", required=True)
    cpu.add_argument("--model", type=Path, default=Path.home() / ".cache/mediapipe/hand_landmarker.task")
    cpu.add_argument("--allow-simulation-profile", action="store_true")
    args = parser.parse_args()
    try:
        if args.command == "health":
            raw = sys.stdin.buffer.read(4097)
            if len(raw) > 4096:
                raise ValueError("Request exceeds 4096 bytes")
            request_id = parse_request(json.loads(raw))
            result = {"protocolVersion": 1, "requestId": request_id, "status": "ok", "python": platform.python_version(), "workerVersion": __version__}
        else:
            from .compat import process_local
            result = process_local(args.source, args.output, args.expected_sha256, args.model, args.allow_simulation_profile)
        print(json.dumps(result, sort_keys=True))
    except Exception as error:
        # No credentials, source paths, URL queries or raw provider errors in output.
        print(f"Worker failed: {type(error).__name__}", file=sys.stderr)
        raise SystemExit(1) from None
