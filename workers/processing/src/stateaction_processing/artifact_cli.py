"""Local artifact CLI: export a capture into clip artifacts, or read/verify an exported prefix.

    python -m stateaction_processing.artifact_cli export SOURCE.mcap --out PREFIX \
        --source-manifest-sha256 HEX [--job-id UUID] [--expected-source-sha256 HEX]
    python -m stateaction_processing.artifact_cli read PREFIX [--verify-mp4] [--json]

`export` writes into a new output prefix (never overwrites). It is the real local implementation of
the output step; it does not claim atomic backend acceptance (SA-28). Exit 0 only for a complete,
manifest-sealed result; failures exit 2 with a stable error code and leave no manifest.
"""

from __future__ import annotations

import argparse
import dataclasses
import getpass
import hashlib
import json
import os
import socket
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any

from .artifact_reader import ArtifactError, open_result
from .artifact_types import ExportContext, ExportError, ExportLimits, LocalDirectorySink

WORKER_ROOT = Path(__file__).resolve().parents[2]


def _code_revision() -> str:
    env = os.environ.get("STATEACTION_CODE_REVISION")
    if env:
        return env
    try:
        rev = subprocess.run(
            ["git", "rev-parse", "--short=12", "HEAD"],
            cwd=WORKER_ROOT, capture_output=True, text=True, check=True, timeout=10,
        ).stdout.strip()  # fmt: skip
        return rev or "local-dev"
    except Exception:
        return "local-dev"


def _image_spec_sha256() -> str:
    lock = WORKER_ROOT / "uv.lock"
    if not lock.is_file():
        raise ExportError("E_IMAGE_SPEC_UNAVAILABLE", "pass --image-spec-sha256")
    return hashlib.sha256(lock.read_bytes()).hexdigest()


def cmd_export(a: argparse.Namespace) -> int:
    from .artifact_export import export_artifacts

    if a.source_manifest:
        manifest_sha = hashlib.sha256(Path(a.source_manifest).read_bytes()).hexdigest()
    else:
        manifest_sha = a.source_manifest_sha256
    if not manifest_sha:
        print("export failed: E_SOURCE_MANIFEST_REQUIRED", file=sys.stderr)
        return 2
    forbidden = {
        str(Path.home()), getpass.getuser(), socket.gethostname(),
        str(a.source.resolve()), str(Path(a.out).resolve()),
    }  # fmt: skip
    ctx = ExportContext(
        job_id=a.job_id or str(uuid.uuid4()),
        source_manifest_sha256=manifest_sha,
        code_revision=a.code_revision or _code_revision(),
        image_spec_sha256=a.image_spec_sha256 or _image_spec_sha256(),
        profile_revision=a.profile_revision,
        recording_id=a.recording_id,
        expected_source_sha256=a.expected_source_sha256,
        forbidden_strings=tuple(sorted(forbidden)),
        fixture_identities=True,  # offline CLI: deterministic fixture identities, labelled in the manifest
    )
    limits = ExportLimits()
    if a.clip_target_seconds is not None:
        limits = dataclasses.replace(limits, clip_target_seconds=a.clip_target_seconds)
    if a.clip_target_frames is not None:
        limits = dataclasses.replace(limits, clip_target_frames=a.clip_target_frames)
    sink = LocalDirectorySink(Path(a.out), job_id=ctx.job_id)
    try:
        with a.source.open("rb") as raw:
            result = export_artifacts(raw, sink, ctx, model=a.model, limits=limits)
    except Exception as e:
        print(f"export failed: {getattr(e, 'code', type(e).__name__)}", file=sys.stderr)
        return 2
    print(
        json.dumps(
            {
                "manifest_sha256": result.manifest_sha256,
                "job_id": ctx.job_id,
                "source_sha256": result.source_sha256,
                "source_bytes": result.source_bytes,
                "native_capture_recording_id": result.native_capture_recording_id,
                "frames": result.frames,
                "clips": [
                    {
                        k: m[k]
                        for k in (
                            "ordinal",
                            "clip_id",
                            "frame_count",
                            "frames_with_hands",
                            "raster",
                        )
                    }
                    | {
                        "rrd_bytes": m["rrd"]["bytes"],
                        "rrd_reencoded": m["rrd"]["reencoded"],
                    }
                    for m in result.clips
                ],
                "missingness": dataclasses.asdict(result.missingness),
                "inference_ms_mean": round(result.inference_ms_mean, 3),
                "observations_sha256": result.observations_sha256,
            },
            indent=2,
            sort_keys=True,
        )
    )
    return 0


def cmd_read(a: argparse.Namespace) -> int:
    try:
        res = open_result(a.prefix, require_contracts=True)
        report: list[dict[str, Any]] = []
        for clip in res.clips:
            item: dict[str, Any] = {
                "clip_id": clip.clip_id,
                "roundtrip": clip.verify_roundtrip(),
            }
            if a.verify_mp4:
                item["mp4"] = clip.verify_mp4()
            report.append(item)
    except (ArtifactError, OSError, ValueError, KeyError) as e:
        print(f"read failed: {getattr(e, 'code', type(e).__name__)}", file=sys.stderr)
        return 2
    out = {
        "manifest_sha256": res.manifest_sha256,
        "contract_validated": res.contract_validated,
        "provenance": res.provenance,
        "clips": report,
    }
    print(
        json.dumps(out, indent=2, sort_keys=True)
        if a.json
        else f"ok {res.manifest_sha256} clips={len(report)}"
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="command", required=True)
    e = sub.add_parser("export")
    e.add_argument("source", type=Path)
    e.add_argument("--out", type=Path, required=True)
    g = e.add_mutually_exclusive_group()
    g.add_argument(
        "--source-manifest",
        type=Path,
        help="sealed source_manifest file; its bytes are hashed",
    )
    g.add_argument("--source-manifest-sha256")
    e.add_argument("--job-id")
    e.add_argument("--recording-id")
    e.add_argument("--code-revision")
    e.add_argument("--image-spec-sha256")
    e.add_argument("--profile-revision", default="h264_mcap_v1")
    e.add_argument("--expected-source-sha256")
    e.add_argument("--model", type=Path)
    e.add_argument(
        "--clip-target-seconds",
        type=float,
        help="cut at the first IDR at/after this age (<= 60)",
    )
    e.add_argument("--clip-target-frames", type=int)
    r = sub.add_parser("read")
    r.add_argument("prefix", type=Path)
    r.add_argument("--verify-mp4", action="store_true")
    r.add_argument("--json", action="store_true")
    a = p.parse_args(argv)
    return cmd_export(a) if a.command == "export" else cmd_read(a)


if __name__ == "__main__":
    raise SystemExit(main())
