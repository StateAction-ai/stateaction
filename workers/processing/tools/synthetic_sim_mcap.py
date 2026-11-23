#!/usr/bin/env python3
"""Write a synthetic `h264_mcap_simulation_v1` MCAP for dev stacks (SA-96): moving test pattern, no people.

    uv run --project workers/processing python workers/processing/tools/synthetic_sim_mcap.py OUT.mcap [--seconds 12]

Generates an H.264 MP4 (no B-frames) of a generated pattern with PyAV, then converts it with
`mp4_to_sim_mcap.py` (labelled simulation_only, camera label `synthetic-test-pattern`). It never
contains hands, so hand pose reports a truthful no-hand result. Never a real recording.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

import av
import numpy as np

FPS = 30


def write_mp4(path: Path, seconds: int) -> None:
    out = av.open(str(path), "w")
    stream = out.add_stream("libx264", rate=FPS)
    stream.width, stream.height, stream.pix_fmt = 320, 240, "yuv420p"
    stream.options = {"bf": "0"}
    for i in range(seconds * FPS):
        img = np.zeros((240, 320, 3), dtype=np.uint8)
        img[:, :, 0] = (i * 2) % 255
        img[:, :, 1] = (255 - i * 2) % 255
        x = (i * 3) % 260
        img[60:120, x : x + 40] = 255
        for packet in stream.encode(av.VideoFrame.from_ndarray(img, format="rgb24")):
            out.mux(packet)
    for packet in stream.encode():
        out.mux(packet)
    out.close()


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("out", type=Path)
    p.add_argument("--seconds", type=int, default=12)
    a = p.parse_args()
    if not 1 <= a.seconds <= 120:
        p.error("--seconds must be 1..120")
    converter = Path(__file__).with_name("mp4_to_sim_mcap.py")
    with tempfile.TemporaryDirectory() as tmp:
        mp4 = Path(tmp) / "pattern.mp4"
        write_mp4(mp4, a.seconds)
        run = subprocess.run(
            [
                sys.executable,
                str(converter),
                str(mp4),
                str(a.out),
                "--camera-label",
                "synthetic-test-pattern",
            ],
            capture_output=True,
            text=True,
        )
    if run.returncode != 0:
        print(run.stderr[-500:], file=sys.stderr)
        return run.returncode
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
