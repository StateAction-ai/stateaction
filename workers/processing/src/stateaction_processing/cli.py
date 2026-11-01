"""A bounded stdio boundary for the foundation health worker."""

from __future__ import annotations

import argparse
import json
import platform
import sys
import uuid

from . import __version__


def parse_request(value: object) -> str:
    if not isinstance(value, dict) or set(value) != {"requestId"}:
        raise ValueError("Expected only requestId")
    identifier = value["requestId"]
    if not isinstance(identifier, str):
        raise TypeError("Expected string requestId")
    parsed = uuid.UUID(identifier)
    if (
        str(parsed) != identifier
        or parsed.version not in (1, 2, 3, 4, 5)
        or parsed.variant != uuid.RFC_4122
    ):
        raise ValueError("Expected canonical requestId UUID")
    return identifier


def main() -> None:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("health")
    parser.parse_args()
    try:
        raw = sys.stdin.buffer.read(4097)
        if len(raw) > 4096:
            raise ValueError("Request exceeds 4096 bytes")
        request_id = parse_request(json.loads(raw))
        result = {
            "protocolVersion": 1,
            "requestId": request_id,
            "status": "ok",
            "python": platform.python_version(),
            "workerVersion": __version__,
        }
        print(json.dumps(result, sort_keys=True))
    except Exception as error:
        # No credentials, source paths, URL queries or raw provider errors in output.
        print(f"Worker failed: {type(error).__name__}", file=sys.stderr)
        raise SystemExit(1) from None
