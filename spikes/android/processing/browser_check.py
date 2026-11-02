#!/usr/bin/env python3
"""Load a probe RRD in the real self-hosted @rerun-io/web-viewer 0.41.0 and check the data path.

Loopback HTTP only (no app.rerun.io, no HTML/SVG stand-in). Requires agent-browser and Chrome.
Checks: WASM/JS asset hashes, RRD fetch, H.264 WebCodecs configure/decode, paused forward and
backward seeks to exact frame-map times on a frame with hands and a frame without hands, playback
cursor advance + pause, error-free viewer logs/reports, an allowlisted entity set, JS heap, and
viewer.stop() canvas cleanup. Screenshots still need visual readback before claiming overlays.
"""

from __future__ import annotations

import argparse
import functools
import hashlib
import http.server
import json
import subprocess
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
VIEWER = HERE / "node_modules/@rerun-io/web-viewer"
ALLOWED = ("/rgb", "/model_relative_3d", "/notes")
SDK_OWNED = ("/", "/__properties")


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def webcodecs_timestamp(row: dict) -> int:
    # Mirror pinned Rerun 0.41 Time::into_micros + `as u64` (f64 seconds -> us, truncating).
    # https://github.com/rerun-io/rerun/blob/0.41.0/crates/utils/re_video/src/time.rs
    ts = int(int(row["clip_time_ns"]) / 1e9 * 1e6)
    assert abs(ts - int(row["clip_pts"])) <= 1, "unexpected_viewer_precision_loss"
    return ts


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("clip", type=Path)
    ap.add_argument("--chrome", type=Path, default=Path("/usr/bin/google-chrome"))
    ap.add_argument("--session", default="stateaction-sa61-viewer-probe")
    a = ap.parse_args()
    clip = a.clip.resolve()
    clip.relative_to(HERE)
    rows = [json.loads(s) for s in (clip / "frame-map.jsonl").read_text().splitlines()]
    assert len(rows) >= 3
    assert len({webcodecs_timestamp(r) for r in rows}) == len(rows), (
        "ambiguous_viewer_frame_identity"
    )
    with_hands = [r for r in rows[1:] if r["hands_detected"]]
    without = [r for r in rows[1:] if not r["hands_detected"]]
    # Forward to a later frame (prefer one with hands), then backward to an earlier frame (prefer none).
    fwd = (with_hands or rows[1:])[len(with_hands or rows[1:]) * 2 // 3]
    back = next(
        (r for r in reversed(without) if r["source_index"] < fwd["source_index"]),
        rows[1],
    )
    if back["source_index"] >= fwd["source_index"]:
        back = rows[1]
    handler = functools.partial(
        http.server.SimpleHTTPRequestHandler, directory=str(HERE)
    )
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_port}/viewer.html?file={clip.relative_to(HERE)}/viewer.rrd"
    base = ["agent-browser", "--session", a.session, "--executable-path", str(a.chrome),
            "--args", "--no-sandbox,--enable-unsafe-swiftshader"]  # fmt: skip

    def run(*args: str) -> str:
        return subprocess.run(
            [*base, *args], cwd=HERE, text=True, check=True, capture_output=True
        ).stdout.strip()

    def snapshot() -> dict:
        return json.loads(
            run(
                "eval",
                "(async () => JSON.parse(window.safeJson(await window.snapshotEvidence())))()",
            )
        )

    def wait(pred, seconds: float, code: str):
        deadline = time.monotonic() + seconds
        while True:
            data = snapshot()
            if pred(data):
                return data
            assert time.monotonic() < deadline, code
            time.sleep(0.1)

    start = time.monotonic()
    ev: dict = {
        "status": "running", "clip": str(clip.relative_to(HERE)), "viewer_version": "0.41.0",
        "rrd_bytes": (clip / "viewer.rrd").stat().st_size, "rrd_sha256": digest(clip / "viewer.rrd"),
        "viewer_js_sha256": digest(VIEWER / "index.js"), "viewer_wasm_sha256": digest(VIEWER / "re_viewer_bg.wasm"),
        "viewer_wasm_bytes": (VIEWER / "re_viewer_bg.wasm").stat().st_size,
        "browser": {"chrome": str(a.chrome), "flags": ["--no-sandbox", "--enable-unsafe-swiftshader"],
                    "render_backend": "webgl", "headless": True},
        "screenshots_visually_inspected": False, "snapshots": [],
    }  # fmt: skip
    try:
        run("open", url)
        run("wait", "--fn", "window.telemetry?.ready")
        wait(
            lambda d: d["state"]["recordings"] and not d["state"]["loading"],
            60,
            "viewer_load_timeout",
        )
        ev["initial_load_seconds"] = round(time.monotonic() - start, 3)
        for name, row in (("forward", fwd), ("backward", back)):
            target, web_ts = int(row["clip_time_ns"]), webcodecs_timestamp(row)
            run(
                "eval",
                f"(async () => {{ await window.seekNs({target}); return true; }})()",
            )
            data = wait(
                lambda d: web_ts in {v["timestamp"] for v in d["telemetry"]["decoded"]},
                60,
                "webcodecs_decode_timeout",
            )
            cur = data["state"]["recordings"][0]["current_time"]
            assert cur["timeline"] == "clip_time" and cur["time"] == str(target), cur
            t = data["telemetry"]
            assert t["decodeCalls"] > 0 and not t["errors"], t["errors"]
            assert web_ts in t["decodeInputs"], "decoder_input_output_identity_mismatch"
            assert all(c["codec"].startswith("avc1.") for c in t["configs"]), t[
                "configs"
            ]
            assert {(d["width"], d["height"]) for d in t["decoded"]} == {
                tuple(row["raster"])
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
                e for e in entities if e not in SDK_OWNED and not e.startswith(ALLOWED)
            ]
            assert not extra, f"non_allowlisted_entities: {extra}"
            shot = clip / f"browser-{name}.png"
            run("screenshot", str(shot))
            ev["snapshots"].append({
                "direction": name, "source_frame_id": row["source_frame_id"], "hands_detected": row["hands_detected"],
                "handedness": row["handedness"], "source_clip_pts_us": row["clip_pts"], "clip_time_ns": str(target),
                "webcodecs_timestamp_us": web_ts, "webcodecs_source_delta_us": web_ts - int(row["clip_pts"]),
                "decoder_configs": t["configs"], "decode_calls": t["decodeCalls"], "decoded_frames": len(t["decoded"]),
                "js_heap": data["memory"], "entities": entities, "screenshot": shot.name, "screenshot_sha256": digest(shot),
            })  # fmt: skip
        ev["resource_loads"] = json.loads(
            run(
                "eval",
                "performance.getEntriesByType('resource').map(e=>({name:new URL(e.name).pathname,bytes:e.transferSize,decodedBytes:e.decodedBodySize}))",
            )
        )
        assert any(r["name"].endswith("/viewer.rrd") for r in ev["resource_loads"]), (
            "rrd_not_fetched"
        )
        assert any(
            r["name"].endswith("re_viewer_bg.wasm") for r in ev["resource_loads"]
        ), "wasm_not_fetched"
        run(
            "eval",
            "(async () => { await window.viewer.set_time({timeline: 'clip_time', duration_nanos: 0n, play_state: 'playing'}); return true; })()",
        )
        playing = wait(
            lambda d: int(d["state"]["recordings"][0]["current_time"]["time"]) > 0,
            15,
            "playback_cursor_did_not_advance",
        )
        run(
            "eval",
            "(async () => { await window.viewer.set_time({play_state: 'paused'}); return true; })()",
        )
        paused = snapshot()
        ev["playback"] = {"cursor_advanced_to_ns": playing["state"]["recordings"][0]["current_time"]["time"],
                          "pause_state": paused["state"]["recordings"][0].get("play_state"),
                          "errors_after_playback": paused["telemetry"]["errors"], "js_heap_after_playback": paused["memory"]}  # fmt: skip
        assert (
            ev["playback"]["pause_state"] == "paused"
            and not paused["telemetry"]["errors"]
        )
        run("eval", "window.viewer.stop(); true")
        assert (
            json.loads(run("eval", "document.querySelectorAll('canvas').length")) == 0
        )
        ev.update(status="passed", stop_removed_canvas=True, seconds=round(time.monotonic() - start, 3),
                  limitations=["Headless Linux Chrome with software WebGL only; no Safari/Firefox/handset browser.",
                               "Loopback HTTP; no signed URL expiry, auth, R2, React remount or Next.js bundle.",
                               "performance.memory is JS heap only, not WASM/GPU memory.",
                               "Overlay alignment requires visual readback of the saved screenshots."])  # fmt: skip
    finally:
        (clip / "browser-check.json").write_text(
            json.dumps(ev, indent=2, sort_keys=True) + "\n"
        )
        subprocess.run([*base, "close"], cwd=HERE, capture_output=True)
        server.shutdown()
        server.server_close()
    print(
        json.dumps(
            {"status": ev["status"], "receipt": str(clip / "browser-check.json")}
        )
    )


if __name__ == "__main__":
    main()
