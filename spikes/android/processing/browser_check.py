#!/usr/bin/env python3
"""Run the real self-hosted WASM viewer, seek both ways, and inspect its decoder.

Requires agent-browser on PATH and installed Chrome. This is local HTTP only;
no app.rerun.io, proxy viewer, fabricated screenshot, or GPU service is used.
"""
import argparse
import functools
import http.server
import json
import subprocess
import threading
import time
from pathlib import Path

from spike import HERE, digest, dump


def command(*args):
    return subprocess.run(args, cwd=HERE, text=True, check=True, capture_output=True).stdout.strip()


def webcodecs_timestamp(row):
    # Mirror pinned Rerun 0.41 Time::into_micros + `as u64`, not source PTS.
    # https://github.com/rerun-io/rerun/blob/0.41.0/crates/utils/re_video/src/time.rs
    # https://github.com/rerun-io/rerun/blob/0.41.0/crates/utils/re_video/src/decode/webcodecs.rs
    timestamp = int(int(row["clip_time_ns"]) / 1e9 * 1e6)
    assert abs(timestamp - int(row["clip_pts"])) <= 1, "unexpected_viewer_precision_loss"
    return timestamp


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("clip", type=Path)
    parser.add_argument("--chrome", type=Path, required=True)
    args = parser.parse_args()
    clip = args.clip.resolve(); clip.relative_to(HERE)
    rows = [json.loads(s) for s in (clip / "frame-map.jsonl").read_text().splitlines()]
    assert len(rows) >= 3
    assert len({webcodecs_timestamp(row) for row in rows}) == len(rows), "ambiguous_viewer_frame_identity"
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(HERE))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{server.server_port}/viewer.html?file={clip.relative_to(HERE)}/viewer.rrd"
    base = ["agent-browser", "--session", "stateaction-android-processing-proof", "--executable-path", str(args.chrome),
            "--args", "--no-sandbox,--enable-unsafe-swiftshader"]
    start = time.monotonic()
    evidence = {"status": "running", "clip": str(clip.relative_to(HERE)), "url": url,
                "viewer_version": "0.41.0", "rrd_sha256": digest(clip / "viewer.rrd"),
                "viewer_js_sha256": digest(HERE / "node_modules/@rerun-io/web-viewer/index.js"),
                "viewer_wasm_sha256": digest(HERE / "node_modules/@rerun-io/web-viewer/re_viewer_bg.wasm"),
                "screenshots_visually_inspected": False, "snapshots": []}
    def snapshot():
        return json.loads(command(*base, "eval", "(async () => JSON.parse(window.safeJson(await window.snapshotEvidence())))()"))
    try:
        command(*base, "open", url)
        command(*base, "wait", "--fn", "window.telemetry?.ready")
        deadline = time.monotonic() + 40
        while True:
            state = snapshot()
            if state["state"]["recordings"] and not state["state"]["loading"]:
                break
            assert time.monotonic() < deadline, "viewer_load_timeout"
            time.sleep(0.1)
        evidence["initial_load_seconds"] = time.monotonic() - start
        for name, row in [("forward", rows[(len(rows) * 2) // 3]), ("backward", rows[1])]:
            target = int(row["clip_time_ns"])
            expected_web_timestamp = webcodecs_timestamp(row)
            command(*base, "eval", f"(async () => {{ await window.seekNs({target}); return true; }})()")
            deadline = time.monotonic() + 40
            while True:
                data = snapshot()
                timestamps = {v["timestamp"] for v in data["telemetry"]["decoded"]}
                if expected_web_timestamp in timestamps:
                    break
                assert time.monotonic() < deadline, "webcodecs_decode_timeout"
                time.sleep(0.1)
            assert data["state"]["recordings"][0]["current_time"]["time"] == str(target)
            assert data["state"]["recordings"][0]["current_time"]["timeline"] == "clip_time"
            assert data["telemetry"]["decodeCalls"] > 0 and not data["telemetry"]["errors"]
            assert expected_web_timestamp in data["telemetry"]["decodeInputs"], "decoder_input_output_identity_mismatch"
            assert not [r for v in data["state"]["views"] for r in v["reports"] if r["severity"] == "error"]
            assert not [l for l in data["logs"] if l["level"] == "ERROR"]
            assert data["state"]["viewer_version"].startswith("0.41.0")
            entities = [e["entity_path"] for e in data["schema"]["entities"]]
            assert "/rgb" in entities
            # /__properties is SDK-owned recording metadata, not a source entity.
            assert not [e for e in entities if not (e in ("/", "/__properties", "/model_estimate_note") or e.startswith("/rgb") or e.startswith("/model_local"))]
            screenshot = clip / f"browser-{name}.png"
            command(*base, "screenshot", str(screenshot))
            evidence["snapshots"].append({"direction": name, "source_frame_id": row["source_frame_id"],
                                          "source_clip_pts_us": row["clip_pts"],
                                          "webcodecs_timestamp_us": expected_web_timestamp,
                                          "webcodecs_source_delta_us": expected_web_timestamp - int(row["clip_pts"]),
                                          "clip_time_ns": str(target), "screenshot": screenshot.name,
                                          "screenshot_sha256": digest(screenshot), "data": data})
        evidence["resource_loads"] = json.loads(command(*base, "eval", "performance.getEntriesByType('resource').map(e=>({name:e.name,bytes:e.transferSize,decodedBytes:e.decodedBodySize}))"))
        command(*base, "eval", "(async () => { await window.viewer.set_time({timeline: 'clip_time', duration_nanos: 0n, play_state: 'playing'}); return true; })()")
        deadline = time.monotonic() + 10
        while True:
            playing = snapshot()
            cursor = playing["state"]["recordings"][0]["current_time"]
            if cursor["timeline"] == "clip_time" and int(cursor["time"]) > 0:
                break
            assert time.monotonic() < deadline, "playback_cursor_did_not_advance"
            time.sleep(0.05)
        command(*base, "eval", "(async () => { await window.viewer.set_time({play_state: 'paused'}); return true; })()")
        evidence["playback"] = {"cursor_advanced": True, "advanced_to_ns": cursor["time"],
                                "pause_state": snapshot()["state"]["recordings"][0].get("play_state")}
        assert evidence["playback"]["pause_state"] == "paused"
        command(*base, "eval", "window.viewer.stop(); true")
        assert json.loads(command(*base, "eval", "document.querySelectorAll('canvas').length")) == 0
        evidence.update(status="passed", stop_removed_canvas=True, seconds=time.monotonic() - start,
                        timestamp_contract="Exact source/MP4 PTS and nanosecond cursor; WebCodecs uses pinned Rerun f64 conversion/truncation, independently checked within 1us.",
                        limitations=["Headless Linux Chromium + software WebGL only; no Safari/Firefox or handset browser qualification.",
                                     "No signed URL, expiry, API, auth, React remount or production Next.js bundle test.",
                                     "Screenshots require human/agent visual readback before recording inspection as passed."])
    finally:
        dump(clip / "browser-check.json", evidence)
        command(*base, "close")
        server.shutdown(); server.server_close()
    print(json.dumps({"status": evidence["status"], "receipt": str(clip / "browser-check.json")}))


if __name__ == "__main__":
    main()
