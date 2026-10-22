"""Report versioned capture evidence without combining unrelated native clocks.

SDK evaluation files remain separate upstream diagnostics. No SDK health score
is promoted into pose accuracy, and no native timestamp is interpreted as epoch.
"""
from __future__ import annotations

import html
import json
from numbers import Integral
from pathlib import Path

from capture_geometry import VERSION, VERSION_V2

STREAM_CLOCKS = {
    "arcore_frame": ("frame_timestamp_ns", "ARCore frame native clock"),
    "android_camera": ("android_camera_timestamp_ns", "Android camera native clock"),
    "rgb_image": ("rgb_timestamp_ns", "ARCore CPU image source-specific native clock"),
    "depth_image": ("depth_timestamp_ns", "Depth image native clock; relation to other clocks unverified"),
}


def _clock_summary(rows, field, domain, *, allow_span=False):
    values = []
    for row in rows:
        value = row.get(field)
        if value is None:
            continue
        if isinstance(value, bool) or not isinstance(value, Integral) or value < 0:
            raise ValueError(f"Invalid native timestamp in {field}")
        values.append(int(value))
    result = {
        "source_field": field, "clock_domain": domain, "units": "nanoseconds",
        "count": len(values), "missing_count": len(rows) - len(values),
        "unique_count": len(set(values)),
        "minimum_ns": min(values) if values else None,
        "maximum_ns": max(values) if values else None,
        "calendar_mapping_available": False,
    }
    if allow_span:
        result["span_s_within_rgb_clock"] = (max(values) - min(values)) / 1e9 if len(values) >= 2 else None
    return result


def write_geometry_report(output, geometry, timestamps, summary):
    """Write standalone evaluation HTML/JSON, leaving upstream files untouched.

    ``geometry`` is the list of frame.geometry dictionaries. Native integer
    timestamps come only from each original source row. ``timestamps`` is used
    to validate frame count; its floats are not used to reconstruct raw clocks.
    Returns the written metrics dictionary.
    """
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    if len(geometry) != len(timestamps) or summary.get("frames", len(geometry)) != len(geometry):
        raise ValueError("Geometry, RGB timestamp and summary frame counts disagree")
    rows = [frame["source"] for frame in geometry]
    version = rows[0].get("capture_geometry_version") if rows else VERSION
    if version not in (VERSION_V2, VERSION) or any(row.get("capture_geometry_version") != version for row in rows):
        raise ValueError("Standalone geometry report requires one supported v2/v3 capture contract")
    clocks = {name: _clock_summary(rows, field, domain, allow_span=name == "rgb_image")
              for name, (field, domain) in STREAM_CLOCKS.items()}
    counts = {key: int(summary.get(key, 0)) for key in (
        "detected_hands", "geometry_consistent_hands", "fully_observed_consistent_hands")}
    if any(value < 0 for value in counts.values()):
        raise ValueError("Negative hand counts cannot describe a capture")
    count = len(rows)
    metrics = {
        "schema_version": "local_geometry_report_v2",
        "capture_geometry_version": version,
        "status": "capture_evidence_report" if count else "no_encoded_rgb_frames",
        "summary": {"frames": count, **counts, "metric_accuracy_validated": False},
        "stream_counts": {
            "encoded_rgb_frames": count,
            "depth_available_frames": sum(bool(row.get("depth_available")) for row in rows),
            "tracked_frame_events": sum(bool(g.get("tracking")) for g in geometry),
            "calibration_contract_verified_frames": sum(bool(g.get("calibration_contract_verified")) for g in geometry),
        },
        "native_clocks": clocks,
        "cross_stream_clock_verified": False,
        "cross_stream_elapsed_s": None,
        "rgb_depth_age_s": None,
        "absolute_time_mapping_available": False,
        "metric_accuracy_validated": False,
        "visibility": {
            "independent_joint_visibility_supplied": False,
            "status": "unknown; hidden fingers are not validated by the model or handedness score",
        },
        "upstream_evaluation": {
            "metrics_file": "evaluation_metrics.upstream.json",
            "html_file": "evaluation.upstream.html",
            "status": "separate unvalidated SDK diagnostics; aggregated timing and health are not geometry accuracy",
        },
        "limitations": [
            "Native clock bounds are separate; no minimum/maximum is combined across streams.",
            "RGB and camera pose are associated by the acquiring ARCore Frame; image and camera timestamp values need not be equal.",
            "Only RGB span is calculated, within its own clock; it is not a cross-stream recording duration.",
            "Calibration contract consistency is not independently measured metric accuracy.",
            "Model predictions and candidate joints remain estimates; unknown visibility cannot become accepted supervision.",
        ],
    }
    (output / "evaluation_metrics.json").write_text(json.dumps(metrics, indent=2, allow_nan=False) + "\n")

    def cell(value):
        return html.escape("Unavailable" if value is None else str(value))

    clock_rows = ''.join(
        '<tr>' + ''.join('<td>' + cell(value) + '</td>' for value in (
            name, clock['clock_domain'], clock['count'], clock['missing_count'],
            clock['minimum_ns'], clock['maximum_ns'])) + '</tr>'
        for name, clock in clocks.items())
    stream_rows = ''.join('<tr><th>' + cell(key.replace('_', ' ')) + '</th><td>' + cell(value)
                          + '</td></tr>' for key, value in metrics['stream_counts'].items())
    hand_rows = ''.join('<tr><th>' + cell(key.replace('_', ' ')) + '</th><td>' + cell(value)
                        + '</td></tr>' for key, value in counts.items())
    span = clocks['rgb_image']['span_s_within_rgb_clock']
    document = '''<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Capture geometry evidence</title>
<style>body{max-width:1050px;margin:32px auto;padding:0 20px;font:16px/1.5 sans-serif;color:#17202a}
table{border-collapse:collapse;width:100%;margin:16px 0}th,td{border:1px solid #ccd1d1;padding:8px;text-align:left}
.notice{padding:16px;background:#fff1dc;border-left:5px solid #b85c00}code{overflow-wrap:anywhere}</style>
<body><h1>Capture geometry evidence</h1>
<p class="notice"><strong>Metric hand accuracy remains unvalidated.</strong>
The SDK health score is not hand-pose accuracy. Its upstream evaluation is preserved separately;
aggregated timing and health values do not validate this capture's geometry.</p>
<h2>Recorded evidence</h2><table>''' + stream_rows + '''</table>
<h2>Hand estimates</h2><table>''' + hand_rows + '''</table>
<p>Independent joint visibility is unknown in this processing run. Model detections and
handedness scores cannot establish where occluded fingers actually are. Passing internal
consistency checks does not establish ground-truth metric accuracy.</p>
<h2>Separate native clocks</h2>
<p>All bounds below are raw integer nanoseconds in the stated clock. There is no verified
cross-stream clock mapping, RGB/depth age or absolute calendar-time mapping. Bounds are
never combined across streams.</p>
<table><tr><th>Stream</th><th>Clock</th><th>Samples</th><th>Missing</th><th>Minimum (ns)</th><th>Maximum (ns)</th></tr>''' + clock_rows + '''</table>
<p>RGB span within its own clock: ''' + cell(span) + ''' seconds.
This is not a duration shared by RGB, depth, pose and IMU.</p>
<p>For machine-readable evidence, see <a href="evaluation_metrics.json">evaluation_metrics.json</a>
and <a href="geometry_quality.json">geometry_quality.json</a>.
The <a href="evaluation.upstream.html">separate upstream SDK report</a> is unvalidated for
cross-stream timing and hand accuracy.</p></body></html>
'''
    (output / "evaluation.html").write_text(document)
    return metrics
