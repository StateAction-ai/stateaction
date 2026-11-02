#!/usr/bin/env python3
"""SA-71 additive conformance fixtures for the catalog.v6 contracts.

Only NEW fixture files are produced here (one per added contract id); the
published SA-12..SA-20 fixtures are authored, unchanged, by generate_fixtures.py,
which includes these files in its reproducibility check. Every adapter (TS,
Python, Dart) runs the same files.
"""

from __future__ import annotations

import copy
from pathlib import Path

from generate_fixtures import (
    DELETE,
    OUT,
    OWNER,
    U,
    bad,
    dump,
    mut,
    ok,
    recording,
    recording_source,
    task_export,
    task_process,
)

SIM = "h264_mcap_simulation_v1"
HW = "h264_mcap_v1"
PROV = {
    "camera": {"status": "known", "label": "android-emulator-virtualscene"},
    "encoder": {"status": "unknown"},
    "clock": {"status": "known", "label": "host-receipt-transport-only"},
}
MARKER_ART = {
    "schema": "stateaction.simulation_provenance.v1",
    "qualification": "simulation_only",
    "mapped_timeline_semantics": "simulation_transport_only",
    "production_qualified": False,
    "provenance": PROV,
}
MARKER_HTTP = {
    "schema": "stateaction.simulation_provenance.v1",
    "qualification": "simulation_only",
    "mappedTimelineSemantics": "simulation_transport_only",
    "productionQualified": False,
    "provenance": PROV,
}


def sim_source():
    doc = copy.deepcopy(recording_source)
    doc["schema"] = "stateaction.recording_source.v2"
    doc["rgb_profile"] = SIM
    doc["simulation"] = copy.deepcopy(MARKER_ART)
    return doc


def hw_source():
    doc = copy.deepcopy(recording_source)
    doc["schema"] = "stateaction.recording_source.v2"
    return doc


def marker_cases(base, camel):
    prod = "productionQualified" if camel else "production_qualified"
    mapped = "mappedTimelineSemantics" if camel else "mapped_timeline_semantics"
    return [
        ok("explicit unknown and known provenance", base),
        mut(
            "every component unknown",
            base,
            [
                ("/provenance/camera", {"status": "unknown"}),
                ("/provenance/clock", {"status": "unknown"}),
            ],
            None,
        ),
        mut(
            "cannot claim production qualification",
            base,
            [(f"/{prod}", True)],
            "schema_violation",
            f"/{prod}",
        ),
        mut(
            "cannot be unqualified",
            base,
            [("/qualification", "unqualified")],
            "schema_violation",
            "/qualification",
        ),
        mut(
            "cannot be device-clock semantics",
            base,
            [(f"/{mapped}", "device_clock")],
            "schema_violation",
            f"/{mapped}",
        ),
        mut(
            "known provenance needs a label",
            base,
            [("/provenance/camera", {"status": "known"})],
            "schema_violation",
            "/provenance/camera",
        ),
        mut(
            "unknown provenance carries no label",
            base,
            [("/provenance/encoder", {"status": "unknown", "label": "x"})],
            "schema_violation",
            "/provenance/encoder",
        ),
        mut(
            "hardware is not a provenance status",
            base,
            [("/provenance/encoder", {"status": "hardware", "label": "x"})],
            "schema_violation",
            "/provenance/encoder",
        ),
        mut(
            "clock provenance may not be omitted",
            base,
            [("/provenance/clock", DELETE)],
            "schema_violation",
            "/provenance",
        ),
        mut(
            "label charset is bounded",
            base,
            [("/provenance/camera/label", "bad label!")],
            "schema_violation",
            "/provenance/camera",
        ),
        mut(
            "label length is bounded",
            base,
            [("/provenance/camera/label", "a" * 65)],
            "schema_violation",
            "/provenance/camera",
        ),
        mut("extra field", base, [("/note", "emulator")], "schema_violation", ""),
        mut(
            "future schema version",
            base,
            [("/schema", "stateaction.simulation_provenance.v2")],
            "unsupported_version",
            "/schema",
        ),
    ]


def slash_cases():
    def name(value):
        doc = hw_source()
        doc["channels"][1]["schema_name"] = value
        return doc

    good = [
        (
            "ROS slash schema name geometry_msgs/msg/PoseStamped",
            "geometry_msgs/msg/PoseStamped",
        ),
        ("two segment ROS-style name", "geometry_msgs/PoseStamped"),
        ("dotted names stay valid", "foxglove.CompressedVideo"),
    ]
    refused = [
        ("traversal segment", "geometry_msgs/../PoseStamped"),
        ("parent directory only", "../PoseStamped"),
        ("empty segment", "geometry_msgs//PoseStamped"),
        ("leading slash", "/geometry_msgs/PoseStamped"),
        ("trailing slash", "geometry_msgs/msg/"),
        ("four segments", "a/b/c/d"),
        ("segment starts with a digit", "geometry_msgs/9msg/PoseStamped"),
        ("control character", "geometry_msgs/msg/Pose\nStamped"),
        ("trailing newline", "geometry_msgs/msg/PoseStamped\n"),
        ("backslash separator", "geometry_msgs\\msg\\PoseStamped"),
        ("space", "geometry_msgs/msg/Pose Stamped"),
        ("overlong segment", "geometry_msgs/msg/" + "A" * 65),
        ("overlong total", "a" * 60 + "/" + "b" * 60 + "/" + "c" * 60),
        ("non-ascii", "geometry_msgs/msg/Posé"),
    ]
    return [ok(n, name(v)) for n, v in good] + [
        bad(n, name(v), "schema_violation", "/channels/1/schema_name")
        for n, v in refused
    ]


def source_cases():
    sim = sim_source()
    hw = hw_source()
    return [
        ok("hardware document needs no marker", hw),
        ok("simulation profile with explicit marker", sim),
        mut(
            "simulation profile requires the marker",
            sim,
            [("/simulation", DELETE)],
            "schema_violation",
            "",
        ),
        mut(
            "hardware profile forbids the marker",
            hw,
            [("/simulation", MARKER_ART)],
            "schema_violation",
            "",
        ),
        mut(
            "v1 schema value is not v2",
            hw,
            [("/schema", "stateaction.recording_source.v1")],
            "unsupported_version",
            "/schema",
        ),
        mut(
            "future schema version",
            hw,
            [("/schema", "stateaction.recording_source.v3")],
            "unsupported_version",
            "/schema",
        ),
        mut(
            "unknown rgb profile",
            hw,
            [("/rgb_profile", "h264_mcap_v2")],
            "schema_violation",
            "/rgb_profile",
        ),
        mut(
            "marker cannot claim production qualification",
            sim,
            [("/simulation/production_qualified", True)],
            "schema_violation",
            "/simulation/production_qualified",
        ),
        mut(
            "marker camelCase is refused in the durable manifest",
            sim,
            [("/simulation", MARKER_HTTP)],
            "schema_violation",
            "/simulation",
        ),
        mut(
            "source verification cannot be pre-claimed",
            sim,
            [("/source_verification", "verified")],
            "schema_violation",
            "/source_verification",
        ),
        mut(
            "missing required recorder metadata",
            sim,
            [("/files/1/role", "calibration")],
            "inventory_incomplete",
            "/files",
        ),
        mut(
            "channel clock must be declared",
            sim,
            [("/channels/0/clock_domain", "android.other")],
            "reference_mismatch",
            "/channels/0/clock_domain",
        ),
        *slash_cases(),
    ]


DEVICE = {
    "model": "sdk_gphone64_x86_64",
    "osVersion": "Android 15",
    "appVersion": "0.1.0+7",
}


def create_doc(sim: bool):
    doc = {
        "schema": "stateaction.recording_create.v2",
        "clientRecordingId": U["client_recording"],
        "captureFormat": "stateaction.capture.v1",
        "rgbProfile": SIM if sim else HW,
        "startedAt": "2026-11-02T08:00:00.123456789Z",
        "device": copy.deepcopy(DEVICE),
    }
    if sim:
        doc["simulation"] = copy.deepcopy(MARKER_HTTP)
    return doc


def create_cases():
    hw, sim = create_doc(False), create_doc(True)
    return [
        ok("hardware create v2", hw),
        ok("simulated create with explicit marker", sim),
        mut(
            "simulation profile requires the marker",
            sim,
            [("/simulation", DELETE)],
            "schema_violation",
            "",
        ),
        mut(
            "hardware profile forbids the marker",
            hw,
            [("/simulation", MARKER_HTTP)],
            "schema_violation",
            "",
        ),
        mut(
            "v2 requires its schema discriminator",
            hw,
            [("/schema", DELETE)],
            "schema_violation",
            "",
        ),
        mut(
            "v1 body is not v2",
            hw,
            [("/schema", "stateaction.recording_create.v1")],
            "unsupported_version",
            "/schema",
        ),
        mut(
            "owner cannot be supplied",
            sim,
            [("/ownerUserId", OWNER)],
            "schema_violation",
            "",
        ),
        mut(
            "marker cannot claim production qualification",
            sim,
            [("/simulation/productionQualified", True)],
            "schema_violation",
            "/simulation/productionQualified",
        ),
        mut(
            "snake_case marker is refused over HTTP",
            sim,
            [("/simulation", MARKER_ART)],
            "schema_violation",
            "/simulation",
        ),
        mut(
            "unknown rgb profile",
            sim,
            [("/rgbProfile", "h264_mcap_v2")],
            "schema_violation",
            "/rgbProfile",
        ),
        mut(
            "uppercase uuid rejected",
            hw,
            [("/clientRecordingId", U["client_recording"].upper())],
            "schema_violation",
            "/clientRecordingId",
        ),
    ]


def recording_view(sim: bool):
    doc = copy.deepcopy(recording)
    doc["rgbProfile"] = SIM if sim else HW
    if sim:
        doc["simulation"] = copy.deepcopy(MARKER_HTTP)
    return doc


def recording_cases():
    hw, sim = recording_view(False), recording_view(True)
    return [
        ok("hardware recording view v2", hw),
        ok("simulated recording view with explicit marker", sim),
        mut(
            "simulation profile requires the marker",
            sim,
            [("/simulation", DELETE)],
            "schema_violation",
            "",
        ),
        mut(
            "hardware profile forbids the marker",
            hw,
            [("/simulation", MARKER_HTTP)],
            "schema_violation",
            "",
        ),
        mut(
            "rgbProfile is required in v2",
            hw,
            [("/rgbProfile", DELETE)],
            "schema_violation",
            "",
        ),
        mut(
            "unknown rgb profile",
            hw,
            [("/rgbProfile", "mp4")],
            "schema_violation",
            "/rgbProfile",
        ),
        mut(
            "unknown status",
            hw,
            [("/status", "archived")],
            "schema_violation",
            "/status",
        ),
        mut("extra field", sim, [("/hardwareQualified", True)], "schema_violation", ""),
    ]


def registration_cases():
    def wrap(view):
        return {"recording": view, "collectionPermissionRef": "pilot-consent-2026-10"}

    hw, sim = wrap(recording_view(False)), wrap(recording_view(True))
    return [
        ok("hardware registration v2", hw),
        ok("simulated registration with explicit marker", sim),
        mut(
            "recording must be the v2 shape",
            sim,
            [("/recording/rgbProfile", DELETE)],
            "schema_violation",
            "/recording",
        ),
        mut(
            "simulated recording without marker",
            sim,
            [("/recording/simulation", DELETE)],
            "schema_violation",
            "/recording",
        ),
        mut(
            "permission ref is required",
            sim,
            [("/collectionPermissionRef", DELETE)],
            "schema_violation",
            "",
        ),
    ]


def task_doc(sim: bool):
    doc = copy.deepcopy(task_process)
    doc["schemaVersion"] = 2
    doc["rgbProfile"] = SIM if sim else HW
    if sim:
        doc["simulation"] = copy.deepcopy(MARKER_HTTP)
    return doc


def task_cases():
    hw, sim = task_doc(False), task_doc(True)
    export = copy.deepcopy(task_export)
    export["schemaVersion"] = 2
    return [
        ok("hardware process_recording input", hw),
        ok("simulated process_recording input with explicit marker", sim),
        ok("export_release input", export),
        mut(
            "simulation profile requires the marker",
            sim,
            [("/simulation", DELETE)],
            "schema_violation",
            "",
        ),
        mut(
            "hardware profile forbids the marker",
            hw,
            [("/simulation", MARKER_HTTP)],
            "schema_violation",
            "",
        ),
        mut(
            "process_recording needs rgbProfile",
            hw,
            [("/rgbProfile", DELETE)],
            "schema_violation",
            "",
        ),
        mut(
            "v1 input is not v2",
            hw,
            [("/schemaVersion", 1)],
            "unsupported_version",
            "/schemaVersion",
        ),
        mut(
            "future schema version",
            hw,
            [("/schemaVersion", 3)],
            "unsupported_version",
            "/schemaVersion",
        ),
        mut(
            "export_release carries no profile",
            export,
            [("/rgbProfile", HW)],
            "schema_violation",
            "",
        ),
        mut(
            "marker cannot claim production qualification",
            sim,
            [("/simulation/productionQualified", True)],
            "schema_violation",
            "",
        ),
        mut(
            "unknown provenance stays explicit and valid",
            sim,
            [("/simulation/provenance/camera", {"status": "unknown"})],
            None,
        ),
    ]


def render_sa71() -> dict[Path, bytes]:
    cases = {
        "artifacts.simulation-provenance.v1": marker_cases(MARKER_ART, False),
        "http.simulation-provenance.v1": marker_cases(MARKER_HTTP, True),
        "artifacts.recording-source.v2": source_cases(),
        "http.recording-create.v2": create_cases(),
        "http.recording.v2": recording_cases(),
        "http.recording-registration.v2": registration_cases(),
        "jobs.task-input.v2": task_cases(),
    }
    return {
        OUT / "contracts" / f"{cid}.json": dump({"contract": cid, "cases": c})
        for cid, c in cases.items()
    }


if __name__ == "__main__":
    files = render_sa71()
    for p, b in files.items():
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b)
    print(f"wrote {len(files)} SA-71 fixture files")
