#!/usr/bin/env python3
"""Correct Stera Android report clock labels without changing sensor timestamps.

The upstream HTML and serialized metrics are retained byte-for-byte. Only
Android recorder metadata matching the reported native bounds activates this
adapter; a date near 1970 alone is never treated as evidence of uptime.
"""

from __future__ import annotations

import argparse
from datetime import datetime
import hashlib
import html
import json
import math
from pathlib import Path
import re
import shutil


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def clock_provenance(recording: dict, metadata: dict) -> dict | None:
    if not metadata.get("android_version") or "session_start_timestamp_ns" not in metadata:
        return None
    start_ns = metadata["session_start_timestamp_ns"]
    end_fields = {k: metadata[k] for k in (
        "rgb_end_ns", "depth_end_ns", "pose_end_ns", "imu_end_ns", "pointcloud_end_ns"
    ) if isinstance(metadata.get(k), int) and metadata[k] > 0}
    if not isinstance(start_ns, int) or start_ns <= 0 or not end_fields:
        raise ValueError("Android metadata lacks usable native timestamp bounds")
    end_ns = max(end_fields.values())
    for key, native in (("start_time", start_ns), ("end_time", end_ns)):
        if not math.isclose(recording[key], native / 1e9, rel_tol=0, abs_tol=1e-6):
            raise ValueError(f"Android metadata does not match SDK recording.{key}")
    if end_ns < start_ns:
        raise ValueError("Android native timestamps have reversed bounds")

    # Android MCAPDatasetWriter formats Date() for the directory before writer
    # initialization. It saves no timezone or paired wall/native clock sample.
    storage_path = metadata.get("storage", {}).get("path", "")
    match = re.fullmatch(r"session_(\d{8}_\d{6})", Path(storage_path).name)
    local_hint = None
    if match:
        try:
            local_hint = datetime.strptime(match[1], "%Y%m%d_%H%M%S").isoformat()
        except ValueError:
            pass
    return {
        "domain": "android_monotonic",
        "timestamp_units": "seconds",
        "classification": "Stera Android recorder metadata matched to SDK native bounds",
        "native_start_ns": start_ns,
        "native_end_ns": end_ns,
        "elapsed_s": (end_ns - start_ns) / 1e9,
        "metadata_start_field": "session_start_timestamp_ns",
        "metadata_end_fields": end_fields,
        "wallclock_anchor": None,
        "utc_offset": None,
        "session_name_local_clock_hint": local_hint,
        "session_name_hint_source": "metadata.storage.path" if local_hint else None,
        "session_name_hint_limit": (
            "Directory-creation local clock, before writer setup; timezone, device clock "
            "accuracy and offset to first sensor sample are unrecorded. Not a UTC anchor."
        ),
        "upstream_calendar_fields": {k: recording.get(k) for k in (
            "start_iso", "end_iso", "weekday"
        )},
    }


def replace_once(document: str, old: str, new: str) -> str:
    if document.count(old) != 1:
        raise ValueError(f"Expected exactly one SDK HTML field: {old[:90]}")
    return document.replace(old, new, 1)


def corrected_html(document: str, recording: dict, clock: dict) -> str:
    def row(label: str, value: str) -> str:
        return f"<tr><th>{html.escape(label)}</th><td>{html.escape(value)}</td></tr>"

    for key, label in (("start_iso", "Start (ISO)"), ("end_iso", "End (ISO)"),
                       ("weekday", "Weekday")):
        value = "Not recorded" if key == "weekday" else "Not recorded — device uptime"
        document = replace_once(document, row(label, recording.get(key) or "—"), row(label, value))
    summary = (
        f"Device uptime {recording['start_time']:.9f}–{recording['end_time']:.9f} s; "
        f"elapsed {clock['elapsed_s']:.9f} s"
    )
    document = replace_once(
        document,
        f"<p class='filesub'>{html.escape(recording.get('start_iso') or '')}</p>",
        f"<p class='filesub'>{html.escape(summary)}</p>",
    )
    details = [
        row("Timestamp clock", "Android device uptime; seconds, not Unix epoch"),
        row("Native start (ns)", str(clock["native_start_ns"])),
        row("Native end (ns)", str(clock["native_end_ns"])),
        row("Elapsed native time", f"{clock['elapsed_s']:.9f} s"),
        row("Wall-clock mapping", "Not recorded; UTC start and end cannot be recovered"),
    ]
    if clock["session_name_local_clock_hint"]:
        details.extend([
            row("Session name time (local hint)", clock["session_name_local_clock_hint"]),
            row("Local hint limits", clock["session_name_hint_limit"]),
        ])
    anchor = row("Start (ISO)", "Not recorded — device uptime")
    return replace_once(document, anchor, "\n".join(details) + "\n" + anchor)


def write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")


def apply_report_clock(output: Path, metadata_path: Path) -> dict:
    output, metadata_path = Path(output), Path(metadata_path)
    metrics_path = output / "evaluation_metrics.json"
    report_path = output / "evaluation.html"
    upstream_metrics = output / "evaluation_metrics.upstream.json"
    upstream_report = output / "evaluation.upstream.html"
    for upstream, current in ((upstream_metrics, metrics_path), (upstream_report, report_path)):
        if not upstream.exists():
            shutil.copyfile(current, upstream)
    metrics = json.loads(upstream_metrics.read_text())
    document = upstream_report.read_text()
    metadata = json.loads(metadata_path.read_text()) if metadata_path.exists() else {}
    clock = clock_provenance(metrics["recording"], metadata)
    if clock:
        document = corrected_html(document, metrics["recording"], clock)
        metrics["recording"] = dict(metrics["recording"], start_iso=None, end_iso=None,
                                    weekday=None, clock=clock)
    provenance = {
        "applied": clock is not None,
        "adapter": "stera_android_report_clock_v1",
        "adapter_sha256": sha256(Path(__file__)),
        "metadata_path": str(metadata_path.resolve()),
        "metadata_sha256": sha256(metadata_path) if metadata_path.exists() else None,
        "clock": clock,
        "native_timestamp_values_changed": False,
        "model_processing_rerun": False,
        "upstream": {p.name: {"sha256": sha256(p), "bytes": p.stat().st_size}
                     for p in (upstream_metrics, upstream_report)},
    }
    if clock:
        write_json(metrics_path, metrics)
        report_path.write_text(document)
    else:
        shutil.copyfile(upstream_metrics, metrics_path)
        shutil.copyfile(upstream_report, report_path)
    provenance["outputs"] = {
        p.name: {"sha256": sha256(p), "bytes": p.stat().st_size}
        for p in (metrics_path, report_path)
    }
    write_json(output / "evaluation_clock.json", provenance)
    return provenance


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--metadata", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(apply_report_clock(args.output, args.metadata), indent=2))


if __name__ == "__main__":
    main()
