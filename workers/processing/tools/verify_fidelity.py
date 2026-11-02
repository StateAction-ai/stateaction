#!/usr/bin/env python3
"""Independent evidence for an exported prefix against its ORIGINAL source (a second decode on purpose).

    python tools/verify_fidelity.py SOURCE.mcap PREFIX --out receipt.json

For every exported frame: the MP4's decoded pixels equal the pipeline decode of the source access
unit (exact SHA-256), the MP4 PTS equal the frame map, source ids/native timestamps equal the
frame map. Every RRD must pass `rerun rrd verify` and contain only allowlisted entities (the
SDK-owned blueprint paths aside); no workstation string may occur in any output file. RRD video
sample bytes are compressed inside chunks, so RRD frame fidelity is checked in the real viewer
(`viewer_check.py`), not by byte search. Run inside one agent-resource job.
"""

from __future__ import annotations

import argparse
import getpass
import hashlib
import json
import re
import socket
import subprocess
import sys
from pathlib import Path

import av
from stateaction_processing.artifact_reader import open_result
from stateaction_processing.frames import FrameStream


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("source", type=Path)
    ap.add_argument("prefix", type=Path)
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args()
    res = open_result(a.prefix, require_contracts=True)
    clips = list(res.clips)
    rows_by_clip = [c.frame_map() for c in clips]
    flat = [(ci, r) for ci, rows in enumerate(rows_by_clip) for r in rows]
    # Decode each exported MP4 independently (PyAV/FFmpeg, default threading) -> rgb hash per frame.
    mp4_hash: list[str] = []
    mp4_pts: list[list[int]] = []
    for c in clips:
        with av.open(str(c.paths["rgb_mp4"])) as src:
            frames = list(src.decode(video=0))
        mp4_pts.append([int(f.pts) for f in frames])
        mp4_hash += [
            hashlib.sha256(f.to_ndarray(format="rgb24").tobytes()).hexdigest()
            for f in frames
        ]
    rerun_bin = str(Path(sys.executable).with_name("rerun"))
    rrd_entities: list[list[str]] = []
    for c in clips:
        path = str(c.paths["viewer_rrd"])
        subprocess.run(
            [rerun_bin, "rrd", "verify", path], check=True, capture_output=True
        )
        out = subprocess.run(
            [rerun_bin, "rrd", "stats", path],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        rrd_entities.append(sorted(set(re.findall(r"^(/\S+): \d+$", out, re.M))))
    reenc = []
    for c in clips:
        r = c.meta["raster"]
        from stateaction_processing.artifact_rrd import proxy_shape
        from stateaction_processing.artifact_types import ExportLimits

        reenc.append(proxy_shape(r["width"], r["height"], ExportLimits())[2])
    n = pixel_equal = ids_equal = 0
    with a.source.open("rb") as raw:
        stream = FrameStream(raw)
        for i, frame in enumerate(stream):
            ci, row = flat[i]
            au = frame.access_unit
            h = hashlib.sha256(frame.rgb.tobytes()).hexdigest()
            pixel_equal += h == mp4_hash[i]
            ids_equal += (
                au.source_frame_id == row["source_frame_id"]
                and au.native_timestamp_ns == row["timestamp_ns"]
                and au.native_clock_id == row["clock_domain"]
                and str(au.encoder_pts_us) == row["source_pts"]
            )
            n += 1
        stream.require_accepted()
    assert n == len(flat), (n, len(flat))
    pts_ok = all(
        mp4_pts[ci] == [int(r["clip_pts"]) for r in rows]
        for ci, rows in enumerate(rows_by_clip)
    )
    needles = [
        s.encode()
        for s in {
            str(Path.home()),
            getpass.getuser(),
            socket.gethostname(),
            str(a.source.resolve()),
            str(a.prefix.resolve()),
        }
        if len(s) >= 6
    ]
    leaks = [
        p.name
        for p in a.prefix.rglob("*")
        if p.is_file() and any(x in p.read_bytes() for x in needles)
    ]
    sdk = ("/__properties", "/viewport")
    allowed = ("/rgb", "/model_relative_3d", "/notes")
    extra = sorted(
        {
            e
            for es in rrd_entities
            for e in es
            if not e.startswith(sdk + allowed)
            and not e.startswith(("/container/", "/view/"))
        }
    )
    receipt = {
        "frames": n, "mp4_pixels_equal_pipeline_decode": pixel_equal, "mp4_pts_equal_frame_map": pts_ok,
        "ids_clocks_pts_equal_frame_map": ids_equal, "rrd_verify": "all passed", "rrd_entities": sorted({e for es in rrd_entities for e in es if e.startswith(allowed)}),
        "non_allowlisted_rrd_entities": extra, "proxy_reencoded_clips": sum(reenc),
        "files_containing_workstation_strings": leaks, "manifest_sha256": res.manifest_sha256,
        "source_sha256": res.provenance["verified_sources"][0]["sha256"],
    }  # fmt: skip
    ok = pixel_equal == n and pts_ok and ids_equal == n and not extra and not leaks
    receipt["passed"] = ok
    a.out.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
    print(json.dumps(receipt, sort_keys=True))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
