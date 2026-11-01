#!/usr/bin/env python3
"""Author the shared SA-12 contract fixtures deterministically.

Run with ``--check`` to prove the committed fixtures are exactly reproducible.
Golden canonical-JSON texts below are written by hand; their digests are plain
SHA-256 of those literal bytes, independent of any adapter implementation.
"""

from __future__ import annotations

import argparse
import base64
import copy
import hashlib
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "fixtures"

U = {
    "recording": "3f1b8c2e-6a4d-4e7b-9c1a-2b5d8e9f0a11",
    "client_recording": "0d9e8f7a-1b2c-4d3e-8f4a-5b6c7d8e9f00",
    "client_upload": "6b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b",
    "file_mcap": "7c2d3e4f-5061-4728-9bac-1d2e3f4a5b6c",
    "file_meta": "8d3e4f50-6172-4839-acbd-2e3f4a5b6c7d",
    "job": "019a4b2c-3d4e-7f50-8a6b-7c8d9e0f1a2b",
    "prev_job": "019a4b2c-0000-7f50-8a6b-7c8d9e0f1a2b",
    "clip": "019a4b2c-3d4e-7f51-9b6c-8d9e0f1a2b3c",
    "request": "519f19f0-1f9c-49f1-bf88-7343fd2dc358",
    "manifest": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
    "out_mp4": "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e",
    "out_npz": "c3d4e5f6-a7b8-4c9d-8e1f-2a3b4c5d6e7f",
    "out_hands": "d4e5f6a7-b8c9-4d0e-9f2a-3b4c5d6e7f80",
    "out_fmap": "e5f6a7b8-c9d0-4e1f-a03b-4c5d6e7f8091",
    "out_thumb": "f6a7b8c9-d0e1-4f2a-b14c-5d6e7f8091a2",
    "out_rrd": "07b8c9d0-e1f2-4a3b-825d-6e7f8091a2b3",
    "evidence": "18c9d0e1-f2a3-4b4c-936e-7f8091a2b3c4",
}
H = {
    k: hashlib.sha256(k.encode()).hexdigest()
    for k in [
        "mcap",
        "meta",
        "config",
        "code",
        "model",
        "img",
        "mp4",
        "npz",
        "hands",
        "fmap",
        "thumb",
        "rrd",
        "source_manifest",
        "evidence",
    ]
}
OWNER = "Xk9pQ2rT7vW1yZ4bN6mC8dF3hJ5kL0sA"  # opaque Better Auth-style ID, not a UUID
NONCE = "q1w2e3r4t5y6u7i8o9p0a1s2d3f4g5h6j7k8l9z0x1c"
I64_MAX = "9223372036854775807"
I64_OVER = "9223372036854775808"
FILE_MAX = "107374182400"
FILE_OVER = "107374182401"
MIB64 = 67108864


def ptr_set(doc: object, pointer: str, value: object) -> object:
    doc = copy.deepcopy(doc)
    parts = [p.replace("~1", "/").replace("~0", "~") for p in pointer.split("/")[1:]]
    target = doc
    for p in parts[:-1]:
        target = target[int(p)] if isinstance(target, list) else target[p]
    last = parts[-1]
    if value is DELETE:
        if isinstance(target, list):
            del target[int(last)]
        else:
            del target[last]
    elif isinstance(target, list):
        target[int(last)] = value
    else:
        target[last] = value
    return doc


DELETE = object()


def ok(name, doc):
    return {"name": name, "input": {"document": doc}, "expect": {"valid": True}}


def bad(name, doc, code, *paths):
    exp = {"valid": False, "code": code}
    if paths:
        exp["paths"] = list(paths)
    return {"name": name, "input": {"document": doc}, "expect": exp}


def mut(name, base, changes, code, *paths):
    doc = base
    for pointer, value in changes:
        doc = ptr_set(doc, pointer, value)
    return bad(name, doc, code, *paths)


# ---------------------------------------------------------------- HTTP
recording_create = {
    "clientRecordingId": U["client_recording"],
    "captureFormat": "stateaction.capture.v1",
    "rgbProfile": "h264_mcap_v1",
    "startedAt": "2026-11-01T18:04:05.123456789Z",
    "device": {
        "model": "Pixel 9 Pro",
        "osVersion": "Android 16",
        "appVersion": "0.1.0+7",
    },
}
seal = {
    "files": [
        {
            "fileId": U["file_mcap"],
            "role": "source_mcap",
            "sizeBytes": FILE_MAX,
            "sha256": H["mcap"],
            "required": True,
        },
        {
            "fileId": U["file_meta"],
            "role": "recorder_metadata",
            "sizeBytes": "4096",
            "sha256": H["meta"],
            "required": True,
        },
    ]
}
upload_create = {
    "recordingId": U["recording"],
    "clientUploadId": U["client_upload"],
    "role": "source_mcap",
    "sizeBytes": "134217729",
    "sha256": H["mcap"],
}
upload_plan = {
    "fileId": U["file_mcap"],
    "recordingId": U["recording"],
    "role": "source_mcap",
    "sizeBytes": "134217729",
    "sha256": H["mcap"],
    "transportEpoch": 1,
    "partSizeBytes": "67108864",
    "partCount": 3,
    "state": "uploading",
    "transportExpiresAt": "2026-11-08T18:04:05Z",
}
upload_plan_max = dict(upload_plan, sizeBytes=FILE_MAX, partCount=1600)
sign = {"expectedTransportEpoch": 1, "partNumbers": [1, 2, 10000]}
signed = {
    "transportEpoch": 1,
    "parts": [
        {
            "partNumber": 1,
            "method": "PUT",
            "url": "https://acct.r2.cloudflarestorage.com/stateaction-dev/k?X-Amz-Signature=abc",
            "headers": {"Content-Length": "67108864"},
            "offsetBytes": "0",
            "lengthBytes": "67108864",
            "expiresAt": "2026-11-01T19:04:05Z",
        }
    ],
}
receipts = {
    "expectedTransportEpoch": 2,
    "receipts": [
        {
            "partNumber": 1,
            "etag": '"9b2cf535f27731c974343645a3985328"',
            "sizeBytes": "67108864",
        },
        {
            "partNumber": 2,
            "etag": "9b2cf535f27731c974343645a3985329",
            "sizeBytes": "67108864",
        },
    ],
}
error_env = {
    "error": {
        "code": "idempotency_conflict",
        "message": "Request differs from the original for this idempotency key.",
        "retryable": False,
    },
    "requestId": U["request"],
}
success_env = {"data": {"anything": [1, "two"]}, "requestId": U["request"]}
recording = {
    "recordingId": U["recording"],
    "clientRecordingId": U["client_recording"],
    "ownerUserId": OWNER,
    "status": "uploading",
    "createdAt": "2026-11-01T18:04:06Z",
    "files": [
        {
            "fileId": U["file_mcap"],
            "role": "source_mcap",
            "sizeBytes": "134217729",
            "sha256": H["mcap"],
            "required": True,
            "state": "uploading",
        }
    ],
    "missingRequiredRoles": ["recorder_metadata"],
}

# ---------------------------------------------------------------- Jobs
task_process = {
    "schemaVersion": 1,
    "jobId": U["job"],
    "kind": "process_recording",
    "targetId": U["recording"],
    "sourceManifestSha256": H["source_manifest"],
    "profileRevision": "cpu-mediapipe-1",
}
task_export = {
    "schemaVersion": 1,
    "jobId": U["job"],
    "kind": "export_release",
    "targetId": U["recording"],
    "selectionSha256": H["source_manifest"],
    "profileRevision": "export-1",
}
claim_local = {
    "schemaVersion": 1,
    "jobId": U["job"],
    "invocationNonce": NONCE,
    "executor": {"kind": "local", "localExecutionRef": "pid:4242:boot-7"},
}
claim_modal = {
    "schemaVersion": 1,
    "jobId": U["job"],
    "invocationNonce": NONCE,
    "executor": {"kind": "modal", "functionCallId": "fc-01JABCDEF0123456789"},
}
grant = {
    "schemaVersion": 1,
    "jobId": U["job"],
    "invocationNonce": NONCE,
    "kind": "process_recording",
    "startDeadline": "2026-11-01T18:14:05Z",
    "executionDeadline": "2026-11-02T00:04:05Z",
    "digests": {
        "sourceManifestSha256": H["source_manifest"],
        "codeRevision": "0f8a21f",
        "imageDigest": H["img"],
        "modelSha256": "fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1",
        "configSha256": H["config"],
    },
    "limits": {
        "maxOutputFiles": 2000,
        "maxOutputBytes": FILE_MAX,
        "maxControlDocumentBytes": 1048576,
    },
    "inputs": [
        {
            "fileId": U["file_mcap"],
            "role": "source_mcap",
            "sizeBytes": "134217729",
            "sha256": H["mcap"],
            "readUrl": "http://127.0.0.1:8333/stateaction-local/k?X-Amz-Signature=abc",
            "expiresAt": "2026-11-01T19:04:05Z",
        }
    ],
    "capability": {"token": "c" * 43, "expiresAt": "2026-11-02T00:04:05Z"},
}
heartbeat = {
    "schemaVersion": 1,
    "jobId": U["job"],
    "invocationNonce": NONCE,
    "phase": "inference",
    "processedFrames": "1800",
    "totalFrames": None,
}
candidate = {
    "schemaVersion": 1,
    "jobId": U["job"],
    "invocationNonce": NONCE,
    "manifestFileId": U["manifest"],
    "manifestSha256": "",  # filled after manifest bytes exist
    "summary": {
        "outcome": "succeeded",
        "clipCount": 1,
        "checks": {"pass": 5, "warn": 0, "fail": 0, "measured": 1, "notEvaluated": 0},
        "errorCode": None,
    },
}
job_status = {
    "jobId": U["job"],
    "kind": "process_recording",
    "targetId": U["recording"],
    "state": "submit_unknown",
    "previousJobId": U["prev_job"],
    "createdAt": "2026-11-01T18:04:07Z",
    "updatedAt": "2026-11-01T18:05:07Z",
}

# ---------------------------------------------------------------- Artifacts
recording_source = {
    "schema": "stateaction.recording_source.v1",
    "recording_id": U["recording"],
    "client_recording_id": U["client_recording"],
    "owner_user_id": OWNER,
    "capture_format": "stateaction.capture.v1",
    "rgb_profile": "h264_mcap_v1",
    "capture_config_sha256": H["config"],
    "close_status": "closed_clean",
    "files": [
        {
            "file_id": U["file_mcap"],
            "role": "source_mcap",
            "required": True,
            "size_bytes": "134217729",
            "sha256": H["mcap"],
        },
        {
            "file_id": U["file_meta"],
            "role": "recorder_metadata",
            "required": True,
            "size_bytes": "4096",
            "sha256": H["meta"],
        },
    ],
    "clock_domains": ["android.elapsed_realtime", "android.sensor_event"],
    "channels": [
        {
            "topic": "/camera/rgb/h264",
            "message_encoding": "protobuf",
            "schema_name": "foxglove.CompressedVideo",
            "clock_domain": "android.elapsed_realtime",
            "message_count": "108000",
        },
        {
            "topic": "/imu/motion",
            "message_encoding": "json",
            "schema_name": "stateaction.capture.MotionEvent",
            "clock_domain": "android.sensor_event",
            "message_count": "1440000",
        },
    ],
    "counts": {
        "video_frames": "108000",
        "dropped_video_frames": "0",
        "motion_events": "1440000",
    },
    "collection_permission_ref": "pilot-consent-2026-10",
    "source_verification": "pending",
}
FRAMES = 3
SRC_PTS0 = 9000000000  # 90 kHz ticks: 100000 s after stream origin (exceeds 2^32)
TS0 = 9223372036000000000  # within 1 s of int64 max: exact integer handling required
frame_rows = []
for i in range(FRAMES):
    frame_rows.append(
        {
            "frame_index": i,
            "source_frame_id": str(4294967296 + i),
            "clock_domain": "android.elapsed_realtime",
            "timestamp_ns": str(TS0 + i * 33333333),
            "source_pts": str(SRC_PTS0 + i * 3000),
            "clip_pts": str(i * 3000),
            "raster": {"width": 1920, "height": 1080},
            "transform": {
                "rotation_degrees": 90,
                "mirrored": False,
                "crop": {"x": 0, "y": 0, "width": 1920, "height": 1080},
            },
            "timing_verified": i != 2,
        }
    )
frame_map = {
    "schema": "stateaction.frame_map.v1",
    "job_id": U["job"],
    "clip_id": U["clip"],
    "frame_count": FRAMES,
    "time_base": {"num": 1, "den": 90000},
    "rows": frame_rows,
}
JOINTS = [
    "wrist",
    "thumb_cmc",
    "thumb_mcp",
    "thumb_ip",
    "thumb_tip",
    "index_finger_mcp",
    "index_finger_pip",
    "index_finger_dip",
    "index_finger_tip",
    "middle_finger_mcp",
    "middle_finger_pip",
    "middle_finger_dip",
    "middle_finger_tip",
    "ring_finger_mcp",
    "ring_finger_pip",
    "ring_finger_dip",
    "ring_finger_tip",
    "pinky_mcp",
    "pinky_pip",
    "pinky_dip",
    "pinky_tip",
]


def lm2(j, missing=()):
    return [
        None
        if k in missing
        else [round(800.5 + 10.25 * k, 3), round(400.0 + 7.5 * k, 3)]
        for k in range(21)
    ]


def lm3(missing=()):
    return [
        None
        if k in missing
        else [round(0.001 * k - 0.01, 6), round(-0.002 * k, 6), round(0.0005 * k, 6)]
        for k in range(21)
    ]


def mask(missing=()):
    return [k not in missing for k in range(21)]


def model_relative(missing=()):
    return {
        "space": "model_relative",
        "units": "model_estimated_meters",
        "origin": "hand_geometric_center",
        "metric_accuracy_validated": False,
        "joints": lm3(missing),
        "mask": mask(missing),
    }


def hand(i, side, missing=(), p3=None):
    return {
        "hand_index": i,
        "handedness": side,
        "handedness_score": 0.93,
        "visibility": "unknown",
        "image_landmarks_px": lm2(i, missing),
        "image_mask": mask(missing),
        "points_3d": p3 if p3 is not None else model_relative(missing),
    }


hands_doc = {
    "schema": "stateaction.hand_observations.v1",
    "job_id": U["job"],
    "clip_id": U["clip"],
    "frame_count": FRAMES,
    "joint_order": JOINTS,
    "image_space": {
        "raster": {"width": 1920, "height": 1080},
        "units": "px",
        "origin": "top_left_pixel_corner",
    },
    "frames": [
        {
            "frame_index": 0,
            "hands": [hand(0, "left"), hand(1, "right", missing=(4, 8))],
        },
        {
            "frame_index": 1,
            "hands": [],
        },  # legitimate no-hand frame: masked observation, not an error
        {"frame_index": 2, "hands": [hand(0, "right")]},
    ],
}
metric_points = {
    "space": "camera_metric",
    "units": "meters",
    "frame": "camera_optical",
    "metric_accuracy_validated": True,
    "validation": {
        "profile_revision": "future-qualified-metric-1",
        "evidence_file_id": U["evidence"],
        "evidence_sha256": H["evidence"],
    },
    "joints": lm3(),
    "mask": mask(),
}
hands_metric = ptr_set(hands_doc, "/frames/2/hands/0/points_3d", metric_points)

ARR = [
    ("image_landmarks_px", "float32", [FRAMES, 2, 21, 2]),
    ("image_landmarks_mask", "bool", [FRAMES, 2, 21]),
    ("model_relative_joints", "float32", [FRAMES, 2, 21, 3]),
    ("model_relative_mask", "bool", [FRAMES, 2, 21]),
    ("hand_detected", "bool", [FRAMES, 2]),
    ("handedness_score", "float32", [FRAMES, 2]),
    ("frame_index", "int64", [FRAMES]),
]
outputs = [
    ("out_mp4", "clip_mp4", "clips/000/rgb.mp4", "1048576", "mp4"),
    ("out_npz", "hand_arrays_npz", "clips/000/hands.npz", "20480", "npz"),
    ("out_hands", "hand_observations_json", "clips/000/hands.json", "30720", "hands"),
    ("out_fmap", "frame_map_json", "clips/000/frame_map.json", "2048", "fmap"),
    ("out_thumb", "thumbnail_jpeg", "clips/000/thumb.jpg", "8192", "thumb"),
    ("out_rrd", "viewer_rrd", "clips/000/viewer.rrd", "524288", "rrd"),
]
result = {
    "schema": "stateaction.processing_result.v1",
    "job_id": U["job"],
    "recording_id": U["recording"],
    "source_manifest_sha256": H["source_manifest"],
    "provenance": {
        "code_revision": "0f8a21f",
        "image_digest": H["img"],
        "config_sha256": H["config"],
        "profile_revision": "cpu-mediapipe-1",
        "model": {
            "name": "mediapipe_hand_landmarker",
            "asset_sha256": "fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1",
            "license": "Apache-2.0",
        },
        "rerun_sdk_version": "0.41.0",
    },
    "verified_sources": [
        {"file_id": U["file_mcap"], "size_bytes": "134217729", "sha256": H["mcap"]},
        {"file_id": U["file_meta"], "size_bytes": "4096", "sha256": H["meta"]},
    ],
    "outputs": [
        {
            "file_id": U[k],
            "role": role,
            "relative_path": path,
            "size_bytes": size,
            "sha256": H[h],
        }
        for k, role, path, size, h in outputs
    ],
    "clips": [
        {
            "clip_id": U["clip"],
            "clip_ordinal": 0,
            "title": "Recording 3f1b clip 1",
            "source_start_ns": str(TS0),
            "source_end_ns": str(TS0 + 100000000),
            "duration_ns": "100000000",
            "clock_domain": "android.elapsed_realtime",
            "raster": {"width": 1920, "height": 1080},
            "frame_count": FRAMES,
            "files": {
                "rgb_mp4": U["out_mp4"],
                "hand_arrays_npz": U["out_npz"],
                "hand_observations_json": U["out_hands"],
                "frame_map_json": U["out_fmap"],
                "thumbnail_jpeg": U["out_thumb"],
                "viewer_rrd": U["out_rrd"],
            },
            "hand_arrays": {
                "format": "npz",
                "joint_order_ref": "stateaction.hand_observations.v1#joint_order",
                "arrays": [{"name": n, "dtype": d, "shape": s} for n, d, s in ARR],
            },
            "frame_map_schema": "stateaction.frame_map.v1",
            "hand_observations_schema": "stateaction.hand_observations.v1",
        }
    ],
    "checks": [
        {
            "code": "source_checksum",
            "status": "pass",
            "message": "Every sealed source matched its declared SHA-256 at EOF.",
            "rule_revision": "1",
        },
        {
            "code": "decode",
            "status": "pass",
            "message": "All access units decoded.",
            "rule_revision": "1",
        },
        {
            "code": "frame_mapping",
            "status": "pass",
            "message": "Every clip frame maps to one native frame.",
            "rule_revision": "1",
        },
        {
            "code": "landmark_shape",
            "status": "pass",
            "message": "21-joint arrays and masks have consistent shapes.",
            "rule_revision": "1",
        },
        {
            "code": "finite_masks",
            "status": "pass",
            "message": "Non-finite coordinates are masked.",
            "rule_revision": "1",
        },
        {
            "code": "detection_coverage",
            "status": "measured",
            "message": "Frames with at least one detected hand.",
            "rule_revision": "1",
            "measurements": {"observed_frames": "2", "total_frames": "3"},
        },
    ],
    "metric_accuracy_validated": False,
    "limitations": [
        "3D joints are model-relative estimates, not calibrated camera or world positions."
    ],
}


def contract_cases():
    c = {}
    c["http.recording-create.v1"] = [
        ok("canonical create", recording_create),
        mut(
            "owner cannot be supplied",
            recording_create,
            [("/ownerUserId", OWNER)],
            "schema_violation",
            "",
        ),
        mut(
            "uppercase uuid rejected",
            recording_create,
            [("/clientRecordingId", U["client_recording"].upper())],
            "schema_violation",
            "/clientRecordingId",
        ),
        mut(
            "uuid with trailing newline rejected",
            recording_create,
            [("/clientRecordingId", U["client_recording"] + "\n")],
            "schema_violation",
            "/clientRecordingId",
        ),
        mut(
            "unknown capture format",
            recording_create,
            [("/captureFormat", "stateaction.capture.v2")],
            "schema_violation",
            "/captureFormat",
        ),
        mut(
            "non-UTC wall time rejected",
            recording_create,
            [("/startedAt", "2026-11-01T18:04:05+01:00")],
            "schema_violation",
            "/startedAt",
        ),
        mut(
            "missing device",
            recording_create,
            [("/device", DELETE)],
            "schema_violation",
            "",
        ),
    ]
    c["http.recording-seal.v1"] = [
        ok("two-file inventory with 100 GiB source", seal),
        mut(
            "byte size over 100 GiB cap",
            seal,
            [("/files/0/sizeBytes", FILE_OVER)],
            "schema_violation",
            "/files/0/sizeBytes",
        ),
        mut(
            "byte size must be a decimal string, not a number",
            seal,
            [("/files/0/sizeBytes", 4096)],
            "schema_violation",
            "/files/0/sizeBytes",
        ),
        mut(
            "zero-byte file rejected",
            seal,
            [("/files/1/sizeBytes", "0")],
            "schema_violation",
            "/files/1/sizeBytes",
        ),
        mut(
            "leading zero rejected",
            seal,
            [("/files/1/sizeBytes", "04096")],
            "schema_violation",
            "/files/1/sizeBytes",
        ),
        mut(
            "uppercase digest rejected",
            seal,
            [("/files/0/sha256", H["mcap"].upper())],
            "schema_violation",
            "/files/0/sha256",
        ),
        mut(
            "duplicate file id",
            seal,
            [("/files/1/fileId", U["file_mcap"])],
            "duplicate_identity",
            "/files/1/fileId",
        ),
        {
            "name": "more than 2000 files",
            "input": {"repeat": {"document": seal, "pointer": "/files", "count": 2001}},
            "expect": {"valid": False, "code": "schema_violation", "paths": ["/files"]},
        },
        bad("empty inventory", {"files": []}, "schema_violation", "/files"),
    ]
    c["http.recording.v1"] = [
        ok("recording with opaque owner", recording),
        mut(
            "opaque owner may not be empty",
            recording,
            [("/ownerUserId", "")],
            "schema_violation",
            "/ownerUserId",
        ),
        mut(
            "opaque owner may not contain whitespace",
            recording,
            [("/ownerUserId", "user 1")],
            "schema_violation",
            "/ownerUserId",
        ),
        mut(
            "unknown status",
            recording,
            [("/status", "done")],
            "schema_violation",
            "/status",
        ),
    ]
    c["http.upload-create.v1"] = [
        ok("allocate", upload_create),
        mut(
            "client chooses part size",
            upload_create,
            [("/partSizeBytes", "5242880")],
            "schema_violation",
            "",
        ),
        mut(
            "client supplies object key",
            upload_create,
            [("/objectKey", "uploads/x")],
            "schema_violation",
            "",
        ),
        mut(
            "bad role",
            upload_create,
            [("/role", "viewer_rrd")],
            "schema_violation",
            "/role",
        ),
    ]
    c["http.upload-plan.v1"] = [
        ok("three 64 MiB parts for 128 MiB + 1 byte", upload_plan),
        ok("100 GiB plan uses 1600 parts", upload_plan_max),
        mut(
            "part count disagrees with size",
            upload_plan,
            [("/partCount", 2)],
            "part_plan_mismatch",
            "/partCount",
        ),
        mut(
            "part size is fixed at 64 MiB",
            upload_plan,
            [("/partSizeBytes", "5242880")],
            "schema_violation",
            "/partSizeBytes",
        ),
        mut(
            "over 10000 parts",
            upload_plan,
            [("/partCount", 10001)],
            "schema_violation",
            "/partCount",
        ),
        mut(
            "epoch must be integer",
            upload_plan,
            [("/transportEpoch", 1.5)],
            "schema_violation",
            "/transportEpoch",
        ),
    ]
    c["http.parts-sign.v1"] = [
        ok("sign three parts", sign),
        mut(
            "duplicate part numbers",
            sign,
            [("/partNumbers", [1, 1])],
            "schema_violation",
            "/partNumbers",
        ),
        mut(
            "part zero",
            sign,
            [("/partNumbers", [0])],
            "schema_violation",
            "/partNumbers/0",
        ),
        bad(
            "more than 32 parts",
            {"expectedTransportEpoch": 1, "partNumbers": list(range(1, 34))},
            "schema_violation",
            "/partNumbers",
        ),
        mut(
            "missing epoch",
            sign,
            [("/expectedTransportEpoch", DELETE)],
            "schema_violation",
            "",
        ),
        mut(
            "unsafe integer part number",
            sign,
            [("/partNumbers", [9007199254740993])],
            "schema_violation",
            "/partNumbers/0",
        ),
    ]
    c["http.parts-signed.v1"] = [
        ok("signed part", signed),
        mut(
            "non-PUT method",
            signed,
            [("/parts/0/method", "POST")],
            "schema_violation",
            "/parts/0/method",
        ),
        mut(
            "non-http url",
            signed,
            [("/parts/0/url", "file:///etc/passwd")],
            "schema_violation",
            "/parts/0/url",
        ),
    ]
    c["http.parts-receipts.v1"] = [
        ok("two receipts, quoted and bare etags", receipts),
        mut(
            "duplicate receipt part",
            receipts,
            [("/receipts/1/partNumber", 1)],
            "duplicate_identity",
            "/receipts/1/partNumber",
        ),
        mut(
            "receipt size as number",
            receipts,
            [("/receipts/0/sizeBytes", 67108864)],
            "schema_violation",
            "/receipts/0/sizeBytes",
        ),
    ]
    c["http.upload-transition.v1"] = [
        ok("complete with expected epoch", {"expectedTransportEpoch": 3}),
        bad(
            "client completion list rejected",
            {"expectedTransportEpoch": 3, "parts": [{"partNumber": 1, "etag": "x"}]},
            "schema_violation",
            "",
        ),
        bad(
            "epoch zero",
            {"expectedTransportEpoch": 0},
            "schema_violation",
            "/expectedTransportEpoch",
        ),
    ]
    c["http.error-envelope.v1"] = [
        ok("idempotency conflict", error_env),
        mut(
            "unknown error code",
            error_env,
            [("/error/code", "teapot")],
            "schema_violation",
            "/error/code",
        ),
        mut(
            "missing retryable",
            error_env,
            [("/error/retryable", DELETE)],
            "schema_violation",
            "/error",
        ),
        mut(
            "provider details leak field",
            error_env,
            [("/error/stack", "at ...")],
            "schema_violation",
            "/error",
        ),
    ]
    c["http.success-envelope.v1"] = [
        ok("arbitrary data", success_env),
        mut(
            "missing request id",
            success_env,
            [("/requestId", DELETE)],
            "schema_violation",
            "",
        ),
    ]
    c["jobs.controller-input.v1"] = [
        ok("job id only", {"jobId": U["job"]}),
        bad(
            "secrets are not task input",
            {"jobId": U["job"], "bootstrapToken": "c" * 43},
            "schema_violation",
            "",
        ),
    ]
    c["jobs.task-input.v1"] = [
        ok("process recording", task_process),
        ok("export release", task_export),
        mut(
            "unsupported schema version",
            task_process,
            [("/schemaVersion", 2)],
            "unsupported_version",
            "/schemaVersion",
        ),
        mut(
            "process task with selection digest",
            task_process,
            [
                ("/sourceManifestSha256", DELETE),
                ("/selectionSha256", H["source_manifest"]),
            ],
            "schema_violation",
            "",
        ),
        mut(
            "unknown kind",
            task_process,
            [("/kind", "train_model")],
            "schema_violation",
            "",
        ),
    ]
    c["jobs.worker-claim.v1"] = [
        ok("local executor", claim_local),
        ok("modal executor", claim_modal),
        mut(
            "modal claim without call id",
            claim_modal,
            [("/executor/functionCallId", DELETE)],
            "schema_violation",
            "/executor",
        ),
        mut(
            "short nonce",
            claim_local,
            [("/invocationNonce", "abc")],
            "schema_violation",
            "/invocationNonce",
        ),
        mut(
            "schema version as string",
            claim_local,
            [("/schemaVersion", "1")],
            "unsupported_version",
            "/schemaVersion",
        ),
    ]
    c["jobs.claim-grant.v1"] = [
        ok("grant", grant),
        mut(
            "database url never granted",
            grant,
            [("/databaseUrl", "postgres://x")],
            "schema_violation",
            "",
        ),
        mut(
            "control document limit above 1 MiB",
            grant,
            [("/limits/maxControlDocumentBytes", 1048577)],
            "schema_violation",
            "/limits/maxControlDocumentBytes",
        ),
    ]
    c["jobs.heartbeat.v1"] = [
        ok("unknown total is null", heartbeat),
        mut(
            "processed exceeds total",
            heartbeat,
            [("/totalFrames", "1799")],
            "progress_mismatch",
            "/processedFrames",
        ),
        mut(
            "float frame count",
            heartbeat,
            [("/processedFrames", 1800.0)],
            "schema_violation",
            "/processedFrames",
        ),
    ]
    c["jobs.job-status.v1"] = [
        ok("submit unknown with predecessor", job_status),
        mut(
            "unknown state",
            job_status,
            [("/state", "done")],
            "schema_violation",
            "/state",
        ),
    ]
    c["jobs.result-candidate.v1"] = [
        {
            "name": "candidate referencing manifest",
            "input": {"file": "artifacts/result-candidate.v1.json"},
            "expect": {"valid": True},
        },
        mut(
            "unsupported version",
            candidate_doc(),
            [("/schemaVersion", 2)],
            "unsupported_version",
            "/schemaVersion",
        ),
        mut(
            "candidate may not carry arrays or urls",
            candidate_doc(),
            [("/manifestUrl", "https://x")],
            "schema_violation",
            "",
        ),
    ]
    c["artifacts.recording-source.v1"] = [
        {
            "name": "stored source declaration bytes",
            "input": {"file": "artifacts/recording-source.v1.json"},
            "expect": {"valid": True},
        },
        mut(
            "future schema version",
            recording_source,
            [("/schema", "stateaction.recording_source.v2")],
            "unsupported_version",
            "/schema",
        ),
        mut(
            "source verification cannot be pre-claimed",
            recording_source,
            [("/source_verification", "verified")],
            "schema_violation",
            "/source_verification",
        ),
        mut(
            "camelCase field in durable manifest",
            recording_source,
            [("/recordingId", U["recording"])],
            "schema_violation",
            "",
        ),
        mut(
            "missing required recorder metadata",
            recording_source,
            [("/files/1/role", "calibration")],
            "inventory_incomplete",
            "/files",
        ),
        mut(
            "channel in undeclared clock domain",
            recording_source,
            [("/channels/1/clock_domain", "android.boot_time")],
            "reference_mismatch",
            "/channels/1/clock_domain",
        ),
        mut(
            "float message count",
            recording_source,
            [("/channels/0/message_count", 108000)],
            "schema_violation",
            "/channels/0/message_count",
        ),
        mut(
            "owner id is opaque, not uuid-only: still bounded",
            recording_source,
            [("/owner_user_id", "x" * 129)],
            "schema_violation",
            "/owner_user_id",
        ),
    ]
    c["artifacts.frame-map.v1"] = [
        {
            "name": "stored frame map with int64 timestamps",
            "input": {"file": "artifacts/frame-map.v1.json"},
            "expect": {"valid": True},
        },
        mut(
            "timestamp beyond int64",
            frame_map,
            [("/rows/2/timestamp_ns", I64_OVER)],
            "schema_violation",
            "/rows/2/timestamp_ns",
        ),
        mut(
            "timestamp as JSON number",
            frame_map,
            [("/rows/0/timestamp_ns", 1000)],
            "schema_violation",
            "/rows/0/timestamp_ns",
        ),
        mut(
            "frame count disagrees with rows",
            frame_map,
            [("/frame_count", 4)],
            "dimension_mismatch",
            "/rows",
        ),
        mut(
            "frame index gap",
            frame_map,
            [("/rows/1/frame_index", 5)],
            "ordering_violation",
            "/rows/1/frame_index",
        ),
        mut(
            "clip pts not rebased from first source pts",
            frame_map,
            [("/rows/2/clip_pts", "6001")],
            "clock_mismatch",
            "/rows/2/clip_pts",
        ),
        mut(
            "mixed clock domains in one clip",
            frame_map,
            [("/rows/1/clock_domain", "android.sensor_event")],
            "clock_mismatch",
            "/rows/1/clock_domain",
        ),
        mut(
            "non-increasing timestamp",
            frame_map,
            [("/rows/2/timestamp_ns", str(TS0))],
            "ordering_violation",
            "/rows/2/timestamp_ns",
        ),
        mut(
            "crop outside raster",
            frame_map,
            [("/rows/0/transform/crop/x", 1)],
            "dimension_mismatch",
            "/rows/0/transform/crop",
        ),
        mut(
            "time base zero denominator",
            frame_map,
            [("/time_base/den", 0)],
            "schema_violation",
            "/time_base/den",
        ),
    ]
    c["artifacts.hand-observations.v1"] = [
        {
            "name": "stored model-relative observations",
            "input": {"file": "artifacts/hand-observations.v1.json"},
            "expect": {"valid": True},
        },
        ok("explicit validated metric profile is a distinct space", hands_metric),
        mut(
            "model-relative 3D relabelled as metric-validated",
            hands_doc,
            [("/frames/0/hands/0/points_3d/metric_accuracy_validated", True)],
            "schema_violation",
            "/frames/0/hands/0/points_3d",
        ),
        mut(
            "metric claim without validation evidence",
            hands_metric,
            [("/frames/2/hands/0/points_3d/validation", DELETE)],
            "schema_violation",
            "/frames/2/hands/0/points_3d",
        ),
        mut(
            "20 image landmarks",
            hands_doc,
            [("/frames/0/hands/0/image_landmarks_px", lm2(0)[:20])],
            "schema_violation",
            "/frames/0/hands/0/image_landmarks_px",
        ),
        mut(
            "landmark with three image coordinates",
            hands_doc,
            [("/frames/0/hands/0/image_landmarks_px/3", [1.0, 2.0, 3.0])],
            "schema_violation",
            "/frames/0/hands/0/image_landmarks_px/3",
        ),
        mut(
            "22-entry mask",
            hands_doc,
            [("/frames/0/hands/0/image_mask", mask() + [True])],
            "schema_violation",
            "/frames/0/hands/0/image_mask",
        ),
        mut(
            "2D model joint",
            hands_doc,
            [("/frames/0/hands/0/points_3d/joints/0", [0.1, 0.2])],
            "schema_violation",
            "/frames/0/hands/0/points_3d",
        ),
        mut(
            "three hands",
            hands_doc,
            [("/frames/0/hands", [hand(0, "left"), hand(1, "right"), hand(1, "left")])],
            "schema_violation",
            "/frames/0/hands",
        ),
        mut(
            "mask true for missing landmark",
            hands_doc,
            [("/frames/0/hands/1/image_mask/4", True)],
            "mask_mismatch",
            "/frames/0/hands/1/image_mask/4",
        ),
        mut(
            "mask false for present 3D joint",
            hands_doc,
            [("/frames/0/hands/0/points_3d/mask/0", False)],
            "mask_mismatch",
            "/frames/0/hands/0/points_3d/mask/0",
        ),
        mut(
            "frame count disagrees",
            hands_doc,
            [("/frame_count", 2)],
            "dimension_mismatch",
            "/frames",
        ),
        mut(
            "duplicate hand index",
            hands_doc,
            [("/frames/0/hands/1/hand_index", 0)],
            "duplicate_identity",
            "/frames/0/hands/1/hand_index",
        ),
        mut(
            "reordered joint order",
            hands_doc,
            [("/joint_order/1", "thumb_mcp"), ("/joint_order/2", "thumb_cmc")],
            "schema_violation",
            "/joint_order",
        ),
        mut(
            "per-joint visibility is not invented",
            hands_doc,
            [("/frames/0/hands/0/visibility", "visible")],
            "schema_violation",
            "/frames/0/hands/0/visibility",
        ),
        mut(
            "handedness score above 1",
            hands_doc,
            [("/frames/0/hands/0/handedness_score", 1.5)],
            "schema_violation",
            "/frames/0/hands/0/handedness_score",
        ),
        mut(
            "unsupported version",
            hands_doc,
            [("/schema", "stateaction.hand_observations.v0")],
            "unsupported_version",
            "/schema",
        ),
    ]
    c["artifacts.processing-result.v1"] = [
        {
            "name": "stored result manifest",
            "input": {"file": "artifacts/processing-result.v1.json"},
            "expect": {"valid": True},
        },
        mut(
            "array shape frame dimension mismatch",
            result,
            [("/clips/0/hand_arrays/arrays/0/shape/0", FRAMES + 1)],
            "dimension_mismatch",
            "/clips/0/hand_arrays/arrays/0/shape",
        ),
        mut(
            "array joint dimension mismatch",
            result,
            [("/clips/0/hand_arrays/arrays/2/shape/2", 20)],
            "dimension_mismatch",
            "/clips/0/hand_arrays/arrays/2/shape",
        ),
        mut(
            "array rank mismatch",
            result,
            [("/clips/0/hand_arrays/arrays/1/shape", [FRAMES, 2])],
            "schema_violation",
            "/clips/0/hand_arrays/arrays/1/shape",
        ),
        mut(
            "wrong array dtype",
            result,
            [("/clips/0/hand_arrays/arrays/0/dtype", "float64")],
            "schema_violation",
            "/clips/0/hand_arrays/arrays/0/dtype",
        ),
        mut(
            "missing mask array",
            result,
            [("/clips/0/hand_arrays/arrays/5", DELETE)],
            "schema_violation",
            "/clips/0/hand_arrays/arrays",
        ),
        mut(
            "clip file references output of another role",
            result,
            [("/clips/0/files/viewer_rrd", U["out_mp4"])],
            "reference_mismatch",
            "/clips/0/files/viewer_rrd",
        ),
        mut(
            "result manifest lists itself",
            result,
            [("/outputs/0/role", "result_manifest")],
            "reference_mismatch",
            "/outputs/0/role",
        ),
        mut(
            "clip ordinal gap",
            result,
            [("/clips/0/clip_ordinal", 1)],
            "ordering_violation",
            "/clips/0/clip_ordinal",
        ),
        mut(
            "duration disagrees with exact bounds",
            result,
            [("/clips/0/duration_ns", "99999999")],
            "clock_mismatch",
            "/clips/0/duration_ns",
        ),
        mut(
            "result claims metric accuracy",
            result,
            [("/metric_accuracy_validated", True)],
            "schema_violation",
            "/metric_accuracy_validated",
        ),
        mut(
            "unsafe output path",
            result,
            [("/outputs/0/relative_path", "clips/../../secret")],
            "schema_violation",
            "/outputs/0/relative_path",
        ),
        mut(
            "duplicate output path",
            result,
            [("/outputs/1/relative_path", "clips/000/rgb.mp4")],
            "duplicate_identity",
            "/outputs/1/relative_path",
        ),
        mut(
            "unpinned rerun sdk",
            result,
            [("/provenance/rerun_sdk_version", "0.42.0")],
            "schema_violation",
            "/provenance/rerun_sdk_version",
        ),
    ]
    c["artifacts.processing-result.v1"].append(
        {
            "name": "control document over 1 MiB",
            "input": {
                "pad": {
                    "file": "artifacts/processing-result.v1.json",
                    "totalBytes": 1048577,
                }
            },
            "expect": {"valid": False, "code": "document_too_large"},
        }
    )
    c["artifacts.processing-result.v1"].append(
        {
            "name": "control document padded to exactly 1 MiB",
            "input": {
                "pad": {
                    "file": "artifacts/processing-result.v1.json",
                    "totalBytes": 1048576,
                }
            },
            "expect": {"valid": True},
        }
    )
    c["jobs.controller-input.v1"] += [
        {
            "name": "NaN literal",
            "input": {"json": '{"jobId": NaN}'},
            "expect": {"valid": False, "code": "malformed_json"},
        },
        {
            "name": "overflowing number",
            "input": {"json": '{"jobId": 1e400}'},
            "expect": {"valid": False, "code": "malformed_json"},
        },
        {
            "name": "invalid UTF-8",
            "input": {"base64": base64.b64encode(b'{"jobId": "\xff"}').decode()},
            "expect": {"valid": False, "code": "malformed_json"},
        },
        {
            "name": "UTF-8 byte order mark",
            "input": {
                "base64": base64.b64encode(
                    b'\xef\xbb\xbf{"jobId": "' + U["job"].encode() + b'"}'
                ).decode()
            },
            "expect": {"valid": False, "code": "malformed_json"},
        },
        {
            "name": "lone surrogate escape",
            "input": {"json": '{"jobId": "\\ud800"}'},
            "expect": {"valid": False, "code": "malformed_json"},
        },
        {
            "name": "trailing garbage",
            "input": {"json": '{"jobId": "' + U["job"] + '"} x'},
            "expect": {"valid": False, "code": "malformed_json"},
        },
        {
            "name": "nesting deeper than 32",
            "input": {"json": "[" * 40 + "]" * 40},
            "expect": {"valid": False, "code": "malformed_json"},
        },
        {
            "name": "raw bytes form of valid input",
            "input": {"json": '{"jobId":"' + U["job"] + '"}'},
            "expect": {"valid": True},
        },
    ]
    return c


def dump(value) -> bytes:
    return (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode()


def candidate_doc():
    doc = copy.deepcopy(candidate)
    doc["manifestSha256"] = hashlib.sha256(dump(result)).hexdigest()
    return doc


# Hand-written canonical texts (sa-cjson-v1). Each "canonical" string is the exact
# expected UTF-8 output; "sha256" is computed over those literal bytes only.
REQUEST_DIGESTS = [
    (
        "keys sorted, whitespace removed",
        '{ "b": 1, "a": [true, false, null], "c": {"z": "", "y": -0} }',
        '{"a":[true,false,null],"b":1,"c":{"y":0,"z":""}}',
    ),
    (
        "UTF-16 key order differs from code point order",
        '{"\\ue000": 1, "\\ud83d\\ude00": 2, "a": 3, "\\u00e9": 4}',
        '{"a":3,"\u00e9":4,"\U0001f600":2,"\ue000":1}',
    ),
    (
        "string escapes",
        '{"s": "quote\\" backslash\\\\ slash\\/ ctl\\u0001\\u001f tab\\t nl\\n cr\\r bs\\b ff\\f del\\u007f ls\\u2028"}',
        '{"s":"quote\\" backslash\\\\ slash/ ctl\\u0001\\u001f tab\\t nl\\n cr\\r bs\\b ff\\f del\u007f ls\u2028"}',
    ),
    (
        "non-ASCII stays literal UTF-8",
        '{"name": "Gr\\u00fc\\u00dfe \u65e5\u672c \U0001f91a"}',
        '{"name":"Gr\u00fc\u00dfe \u65e5\u672c \U0001f91a"}',
    ),
    (
        "safe integer extremes and decimal strings",
        '{"max": 9007199254740991, "min": -9007199254740991, "bytes": "107374182400", "ts": "9223372036854775807"}',
        '{"bytes":"107374182400","max":9007199254740991,"min":-9007199254740991,"ts":"9223372036854775807"}',
    ),
    (
        "integral number spellings normalize to integers",
        '{"a": 1.0, "b": 1e3, "c": -0.0, "d": 25E-1e0}'.replace(', "d": 25E-1e0', ""),
        '{"a":1,"b":1000,"c":0}',
    ),
    (
        "nested arrays keep order",
        '[3, [2, 1], {"k": [{"b": 2, "a": 1}]}]',
        '[3,[2,1],{"k":[{"a":1,"b":2}]}]',
    ),
    ("create recording request", json.dumps(recording_create), None),
]
REQUEST_REJECTS = [
    ("fractional number", '{"a": 1.5}'),
    ("integer above safe range", '{"a": 9007199254740992}'),
    ("integer below safe range", '{"a": -9007199254740992}'),
    ("exponent producing fraction", '{"a": 25e-1}'),
    ("lone surrogate", '{"a": "\\udc00"}'),
    ("overflowing exponent", '{"a": 1e400}'),
]
REQUEST_MALFORMED = [
    ("NaN literal", '{"a": NaN}'),
    ("trailing comma", '{"a": 1,}'),
]


def canonical_reference(text: str) -> str:
    """Only used for the recording request case; matches the hand-written rules."""

    def enc(v):
        if v is None:
            return "null"
        if v is True:
            return "true"
        if v is False:
            return "false"
        if isinstance(v, int):
            return str(v)
        if isinstance(v, str):
            out = ['"']
            for ch in v:
                o = ord(ch)
                out.append(
                    {
                        '"': '\\"',
                        "\\": "\\\\",
                        "\b": "\\b",
                        "\f": "\\f",
                        "\n": "\\n",
                        "\r": "\\r",
                        "\t": "\\t",
                    }.get(ch)
                    or (f"\\u{o:04x}" if o < 0x20 else ch)
                )
            return "".join(out) + '"'
        if isinstance(v, list):
            return "[" + ",".join(enc(x) for x in v) + "]"
        return (
            "{"
            + ",".join(
                enc(k) + ":" + enc(v[k])
                for k in sorted(v, key=lambda k: k.encode("utf-16-be"))
            )
            + "}"
        )

    return enc(json.loads(text))


def digests():
    cases = []
    for name, text, canonical in REQUEST_DIGESTS:
        canonical = canonical if canonical is not None else canonical_reference(text)
        cases.append(
            {
                "name": name,
                "json": text,
                "canonical": canonical,
                "sha256": hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
            }
        )
    for name, text in REQUEST_REJECTS:
        cases.append({"name": name, "json": text, "error": "noncanonical_value"})
    for name, text in REQUEST_MALFORMED:
        cases.append({"name": name, "json": text, "error": "malformed_json"})
    rec_sha = hashlib.sha256(
        canonical_reference(json.dumps(recording_create)).encode()
    ).hexdigest()
    changed = dict(
        recording_create, rgbProfile="h264_mcap_v1", startedAt="2026-11-01T18:04:06Z"
    )
    idem = [
        {
            "name": "exact replay with different key order and whitespace",
            "storedSha256": rec_sha,
            "json": json.dumps(
                dict(reversed(list(recording_create.items()))), indent=4
            ),
            "expect": "replay",
        },
        {
            "name": "changed content under same idempotency key",
            "storedSha256": rec_sha,
            "json": json.dumps(changed),
            "expect": "idempotency_conflict",
        },
        {
            "name": "added field under same key",
            "storedSha256": rec_sha,
            "json": json.dumps(dict(recording_create, note="x")),
            "expect": "idempotency_conflict",
        },
    ]
    manifest = [
        {
            "name": f"stored {n} bytes",
            "file": f"artifacts/{n}.v1.json",
            "sha256": hashlib.sha256(b).hexdigest(),
            "expect": "match",
        }
        for n, b in [
            ("processing-result", dump(result)),
            ("recording-source", dump(recording_source)),
            ("frame-map", dump(frame_map)),
            ("hand-observations", dump(hands_doc)),
        ]
    ]
    rs = hashlib.sha256(dump(result)).hexdigest()
    manifest += [
        {
            "name": "result candidate digest matches stored manifest bytes",
            "file": "artifacts/processing-result.v1.json",
            "sha256From": {
                "file": "artifacts/result-candidate.v1.json",
                "pointer": "/manifestSha256",
            },
            "expect": "match",
        },
        {
            "name": "same JSON value re-serialized compactly has different bytes",
            "file": "artifacts/processing-result.compact.json",
            "sha256": rs,
            "expect": "digest_mismatch",
        },
        {
            "name": "changed declared digest",
            "file": "artifacts/processing-result.v1.json",
            "sha256": rs[:-1] + ("0" if rs[-1] != "0" else "1"),
            "expect": "digest_mismatch",
        },
    ]
    return {
        "encoding": "sa-cjson-v1",
        "requestDigests": cases,
        "idempotency": idem,
        "manifestBytes": manifest,
    }


def render() -> dict[Path, bytes]:
    files: dict[Path, bytes] = {}
    art = OUT / "artifacts"
    files[art / "processing-result.v1.json"] = dump(result)
    files[art / "processing-result.compact.json"] = json.dumps(
        result, separators=(",", ":"), ensure_ascii=False
    ).encode()
    files[art / "recording-source.v1.json"] = dump(recording_source)
    files[art / "frame-map.v1.json"] = dump(frame_map)
    files[art / "hand-observations.v1.json"] = dump(hands_doc)
    files[art / "result-candidate.v1.json"] = dump(candidate_doc())
    for cid, cases in contract_cases().items():
        files[OUT / "contracts" / f"{cid}.json"] = dump(
            {"contract": cid, "cases": cases}
        )
    files[OUT / "digests.v1.json"] = dump(digests())
    return files


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    files = render()
    existing = {p for p in OUT.rglob("*") if p.is_file()} if OUT.exists() else set()
    if args.check:
        stale = [
            str(p.relative_to(HERE))
            for p, b in files.items()
            if not p.exists() or p.read_bytes() != b
        ]
        extra = [str(p.relative_to(HERE)) for p in existing - set(files)]
        if stale or extra:
            print(
                "Fixtures are not reproducible:",
                stale,
                "unexpected:",
                extra,
                file=sys.stderr,
            )
            raise SystemExit(1)
        print(f"{len(files)} fixture files reproducible")
        return
    for p in existing - set(files):
        p.unlink()
    for p, b in files.items():
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b)
    print(f"wrote {len(files)} fixture files")


if __name__ == "__main__":
    main()
