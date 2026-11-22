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
    run_job = commands.add_parser("run-job")
    run_job.add_argument("--execution-ref", required=True)
    run_stage = commands.add_parser("run-stage")
    run_stage.add_argument("execution_ref", nargs="?")
    run_stage.add_argument("--io-dir")
    args = parser.parse_args()
    if args.command == "run-job":
        # Stdlib-only until the claim is won; see run_job.py.
        from .run_job import main as run_job_main

        raise SystemExit(run_job_main(args.execution_ref))
    if args.command == "run-stage":
        # Stdlib-only until the stage claim is won; see stage_entry.py.
        from .stage_entry import main as run_stage_main

        if args.execution_ref is None and args.io_dir is None:
            parser.error("execution_ref is required without --io-dir")
        raise SystemExit(run_stage_main(args.execution_ref, args.io_dir))
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
