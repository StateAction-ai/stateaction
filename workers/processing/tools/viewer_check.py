#!/usr/bin/env python3
"""Load an exported clip RRD in the real @rerun-io/web-viewer 0.41.0 (real Chrome) and check it.

    python tools/viewer_check.py PREFIX [--clip N] [--out receipt.json] [--screenshots DIR]

Reuses the SA-61 spike's pinned viewer page and its locally installed npm package (run
`npm ci --ignore-scripts` in spikes/android/processing first; not a pnpm workspace dependency). The
exported prefix is read with the portable reader (every byte verified against the manifest), then
only that clip's `viewer.rrd` is served from a loopback HTTP server together with the viewer
assets. Nothing is fetched from app.rerun.io or any other host and no workstation path is part of
the loaded bytes. The seek targets come from the exported frame map (never recomputed). Run the
ENTIRE driver inside one agent-resource job: it starts and stops the browser itself.
"""

from __future__ import annotations

import argparse
import functools
import hashlib
import http.server
import json
import os
import subprocess
import tempfile
import threading
import time
from pathlib import Path

from stateaction_processing.artifact_reader import open_result
from stateaction_processing.artifact_rrd import proxy_shape
from stateaction_processing.artifact_types import ExportLimits

SPIKE = Path(__file__).resolve().parents[3] / "spikes/android/processing"
VIEWER = SPIKE / "node_modules/@rerun-io/web-viewer"
ALLOWED = ("/rgb", "/model_relative_3d", "/notes")
SDK_OWNED = ("/", "/__properties")


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def webcodecs_ts(clip_pts_us: int) -> int:
    # Pinned Rerun 0.41 maps f64 seconds -> us with truncation (see SA-61 browser_check.py).
    return int(int(clip_pts_us * 1000) / 1e9 * 1e6)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("prefix", type=Path)
    ap.add_argument("--clip", type=int, default=0)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--screenshots", type=Path, required=True)
    ap.add_argument("--chrome", type=Path, default=Path("/usr/bin/google-chrome"))
    ap.add_argument("--session", default="stateaction-sa31-viewer-check")
    a = ap.parse_args()
    result = open_result(a.prefix, require_contracts=True)
    clip = result.clips[a.clip]
    rows = clip.frame_map()
    assert len(rows) >= 3, "need at least three frames"
    obs = {f["frame_index"]: f["hands"] for f in clip.hand_observations()["frames"]}
    r0 = clip.meta["raster"]
    pw, ph, _ = proxy_shape(r0["width"], r0["height"], ExportLimits())
    with_hands = [r for r in rows[1:] if obs[r["frame_index"]]]
    without = [r for r in rows[1:] if not obs[r["frame_index"]]]
    pool = with_hands or rows[1:]
    fwd = pool[len(pool) * 2 // 3]
    back = next(
        (r for r in reversed(without) if r["frame_index"] < fwd["frame_index"]), rows[1]
    )
    if back["frame_index"] >= fwd["frame_index"]:
        back = rows[1]
    assert len({webcodecs_ts(int(r["clip_pts"])) for r in rows}) == len(rows), (
        "ambiguous_viewer_frame_identity"
    )
    a.screenshots.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="sa31-viewer-") as serve:
        serve_dir = Path(serve)
        os.symlink(SPIKE / "viewer.html", serve_dir / "viewer.html")
        os.symlink(SPIKE / "node_modules", serve_dir / "node_modules")
        os.symlink(clip.paths["viewer_rrd"], serve_dir / "viewer.rrd")
        handler = functools.partial(
            http.server.SimpleHTTPRequestHandler, directory=str(serve_dir)
        )
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        url = f"http://127.0.0.1:{server.server_port}/viewer.html?file=viewer.rrd"
        base = ["agent-browser", "--session", a.session, "--executable-path", str(a.chrome),
                "--args", "--no-sandbox,--enable-unsafe-swiftshader"]  # fmt: skip

        def run(*args: str) -> str:
            return subprocess.run(
                [*base, *args],
                cwd=serve_dir,
                text=True,
                check=True,
                capture_output=True,
                timeout=120,
            ).stdout.strip()

        def snapshot() -> dict:
            return json.loads(
                run(
                    "eval",
                    "(async () => JSON.parse(window.safeJson(await window.snapshotEvidence())))()",
                )
            )

        def wait(pred, seconds: float, code: str) -> dict:
            deadline = time.monotonic() + seconds
            while True:
                data = snapshot()
                if pred(data):
                    return data
                assert time.monotonic() < deadline, code
                time.sleep(0.1)

        start = time.monotonic()
        ev: dict = {"status": "running", "clip_id": clip.clip_id, "viewer_version": "0.41.0",
                    "rrd_bytes": clip.paths["viewer_rrd"].stat().st_size, "rrd_sha256": digest(clip.paths["viewer_rrd"]),
                    "viewer_js_sha256": digest(VIEWER / "index.js"), "viewer_wasm_sha256": digest(VIEWER / "re_viewer_bg.wasm"),
                    "manifest_sha256": result.manifest_sha256, "proxy_raster": [pw, ph],
                    "browser": {"chrome": str(a.chrome), "flags": ["--no-sandbox", "--enable-unsafe-swiftshader"],
                                "render_backend": "webgl", "headless": True},
                    "screenshots_visually_inspected": False, "snapshots": []}  # fmt: skip
        try:
            run("open", url)
            run("wait", "--fn", "window.telemetry?.ready")
            wait(
                lambda d: d["state"]["recordings"] and not d["state"]["loading"],
                90,
                "viewer_load_timeout",
            )
            ev["initial_load_seconds"] = round(time.monotonic() - start, 3)
            for name, row in (("forward", fwd), ("backward", back)):
                target, web_ts = (
                    int(row["clip_pts"]) * 1000,
                    webcodecs_ts(int(row["clip_pts"])),
                )
                run(
                    "eval",
                    f"(async () => {{ await window.seekNs({target}); return true; }})()",
                )
                data = wait(
                    lambda d: (
                        web_ts in {v["timestamp"] for v in d["telemetry"]["decoded"]}
                    ),
                    90,
                    "webcodecs_decode_timeout",
                )
                cur = data["state"]["recordings"][0]["current_time"]
                assert cur["timeline"] == "clip_time" and cur["time"] == str(target), (
                    cur
                )
                t = data["telemetry"]
                assert t["decodeCalls"] > 0 and not t["errors"], t["errors"]
                assert web_ts in t["decodeInputs"], (
                    "decoder_input_output_identity_mismatch"
                )
                assert all(c["codec"].startswith("avc1.") for c in t["configs"]), t[
                    "configs"
                ]
                assert {(d["width"], d["height"]) for d in t["decoded"]} == {
                    (pw, ph)
                }, "decoded_raster_mismatch"
                assert not [
                    r
                    for v in data["state"]["views"]
                    for r in v["reports"]
                    if r["severity"] == "error"
                ]
                assert not [x for x in data["logs"] if x["level"] == "ERROR"]
                assert data["state"]["viewer_version"].startswith("0.41.0")
                entities = [e["entity_path"] for e in data["schema"]["entities"]]
                assert "/rgb" in entities
                extra = [
                    e
                    for e in entities
                    if e not in SDK_OWNED and not e.startswith(ALLOWED)
                ]
                assert not extra, f"non_allowlisted_entities: {extra}"
                shot = a.screenshots / f"viewer-{name}.png"
                # WebCodecs output precedes texture upload and canvas painting.
                # Capture after the browser presents the decoded target frame.
                run(
                    "eval",
                    "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))).then(() => true)",
                )
                time.sleep(0.5)
                run("screenshot", str(shot))
                ev["snapshots"].append({"direction": name, "frame_index": row["frame_index"], "source_frame_id": row["source_frame_id"],
                                        "hands_in_exported_frame": len(obs[row["frame_index"]]), "clip_pts_us": row["clip_pts"],
                                        "webcodecs_timestamp_us": web_ts, "decoder_configs": t["configs"], "decode_calls": t["decodeCalls"],
                                        "decoded_frames": len(t["decoded"]), "js_heap": data["memory"], "entities": entities,
                                        "screenshot": shot.name, "screenshot_sha256": digest(shot)})  # fmt: skip
            ev["resource_loads"] = json.loads(
                run(
                    "eval",
                    "performance.getEntriesByType('resource').map(e=>({name:new URL(e.name).pathname,host:new URL(e.name).host,bytes:e.transferSize}))",
                )
            )
            assert all(
                r["host"].startswith("127.0.0.1:") for r in ev["resource_loads"]
            ), "non_loopback_fetch"
            assert any(
                r["name"].endswith("/viewer.rrd") for r in ev["resource_loads"]
            ), "rrd_not_fetched"
            assert any(
                r["name"].endswith("re_viewer_bg.wasm") for r in ev["resource_loads"]
            ), "wasm_not_fetched"
            run(
                "eval",
                "(async () => { await window.viewer.set_time({timeline: 'clip_time', duration_nanos: 0n, play_state: 'playing'}); return true; })()",
            )
            playing = wait(
                lambda d: int(d["state"]["recordings"][0]["current_time"]["time"]) > 0,
                20,
                "playback_cursor_did_not_advance",
            )
            run(
                "eval",
                "(async () => { await window.viewer.set_time({play_state: 'paused'}); return true; })()",
            )
            paused = snapshot()
            ev["playback"] = {"cursor_advanced_to_ns": playing["state"]["recordings"][0]["current_time"]["time"],
                              "pause_state": paused["state"]["recordings"][0].get("play_state"),
                              "errors_after_playback": paused["telemetry"]["errors"]}  # fmt: skip
            assert (
                ev["playback"]["pause_state"] == "paused"
                and not paused["telemetry"]["errors"]
            )
            run("eval", "window.viewer.stop(); true")
            assert (
                json.loads(run("eval", "document.querySelectorAll('canvas').length"))
                == 0
            )
            ev.update(status="passed", seconds=round(time.monotonic() - start, 3),
                      limitations=["Headless Linux Chrome, software WebGL; no Safari/Firefox/handset browser.",
                                   "Loopback HTTP; no signed-URL expiry, auth, R2, React remount or Next.js bundle.",
                                   "Overlay alignment requires visual readback of the saved screenshots."])  # fmt: skip
        finally:
            a.out.write_text(json.dumps(ev, indent=2, sort_keys=True) + "\n")
            subprocess.run([*base, "close"], cwd=serve_dir, capture_output=True)
            server.shutdown()
            server.server_close()
    print(json.dumps({"status": ev["status"], "receipt": a.out.name}))
    return 0 if ev["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
