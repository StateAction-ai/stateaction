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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("clip", type=Path)
    parser.add_argument("--chrome", type=Path, required=True)
    args = parser.parse_args()
    clip = args.clip.resolve(); clip.relative_to(HERE)
    rows = [json.loads(s) for s in (clip / "frame-map.jsonl").read_text().splitlines()]
    assert len(rows) >= 3
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
            command(*base, "eval", f"(async () => {{ await window.seekNs({target}); return true; }})()")
            deadline = time.monotonic() + 40
            while True:
                data = snapshot()
                timestamps = {v["timestamp"] for v in data["telemetry"]["decoded"]}
                if int(row["clip_pts"]) in timestamps:
                    break
                assert time.monotonic() < deadline, "webcodecs_decode_timeout"
                time.sleep(0.1)
            assert data["state"]["recordings"][0]["current_time"]["time"] == str(target)
            assert data["state"]["recordings"][0]["current_time"]["timeline"] == "clip_time"
            assert data["telemetry"]["decodeCalls"] > 0 and not data["telemetry"]["errors"]
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
                                          "clip_time_ns": str(target), "screenshot": screenshot.name,
                                          "screenshot_sha256": digest(screenshot), "data": data})
        evidence["resource_loads"] = json.loads(command(*base, "eval", "performance.getEntriesByType('resource').map(e=>({name:e.name,bytes:e.transferSize,decodedBytes:e.decodedBodySize}))"))
        command(*base, "eval", "window.viewer.stop(); true")
        assert json.loads(command(*base, "eval", "document.querySelectorAll('canvas').length")) == 0
        evidence.update(status="passed", stop_removed_canvas=True, seconds=time.monotonic() - start,
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
