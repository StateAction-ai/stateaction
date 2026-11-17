"""Single source for the seven strict stateaction.capture JSON Schemas.

  python3 packages/contracts/capture/conformance/python/build_schemas.py          # rewrite
  python3 packages/contracts/capture/conformance/python/build_schemas.py --check  # fail on drift

Every schema embeds the same `$defs` block, so each MCAP schema record stays self-contained (a reader
needs no network or cross-file resolution). Every object is closed (`additionalProperties: false`) or an
explicitly bounded map (`propertyNames` + `maxProperties`); every string has a bounded ASCII pattern;
every array has `maxItems`; every count/timestamp is an exact int64 decimal string. Domain entity IDs
(`recording_id`) are UUIDs; optical frame names, calibration IDs, sensor/stream IDs and reason codes are
intentionally textual labels, never UUIDs. `uuid`, `int64Decimal`, `clockDomain` and `revision` are the
published common.v1 definitions; `label`, `text`, `uint32` and the capture `timeBase` (wire field names
numerator/denominator, fixed at 1/1000000) are capture-owned. The keyword set is the portable subset in
README.md.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

CAP = Path(__file__).resolve().parents[2]
INT64_MAX = 2**63 - 1
UINT32_MAX = 2**32 - 1


def bounded_decimal_pattern(limit: int) -> str:
    """Anchored regex for canonical decimals 0..limit (no sign, no leading zeros)."""
    s = str(limit)
    n = len(s)
    alts = ["0"] + ([f"[1-9][0-9]{{0,{n - 2}}}"] if n > 1 else [])
    for i, ch in enumerate(s):
        d = int(ch)
        low = 1 if i == 0 else 0
        if d - 1 >= low:
            rng = f"[{low}-{d - 1}]" if d - 1 > low else str(low)
            rest = n - i - 1
            alts.append(s[:i] + rng + (f"[0-9]{{{rest}}}" if rest else ""))
    if limit:
        alts.append(s)
    return "^(" + "|".join(alts) + ")$"


def ref(name: str) -> dict:
    return {"$ref": f"#/$defs/{name}"}


def nullable(name: str) -> dict:
    return {"anyOf": [ref(name), {"type": "null"}]}


def obj(required: list[str], properties: dict, **extra) -> dict:
    return {
        "type": "object",
        "additionalProperties": False,
        "required": required,
        "properties": properties,
        **extra,
    }


def integer(minimum: int, maximum: int) -> dict:
    return {"type": "integer", "minimum": minimum, "maximum": maximum}


# Published SA-12 common definitions, bundled verbatim (resolved offline from the repository file) so each
# embedded MCAP schema stays self-contained. verify.py and --check fail if they drift from common.v1.
COMMON_FILE = CAP.parent / "api/common.v1.schema.json"
COMMON_IDS = ("uuid", "int64Decimal", "clockDomain", "revision")
COMMON = json.loads(COMMON_FILE.read_text())["$defs"]
assert COMMON["int64Decimal"]["pattern"] == bounded_decimal_pattern(INT64_MAX), (
    "common.v1 int64Decimal is not exactly 0..int64 max"
)

DEFS = {
    **{k: COMMON[k] for k in COMMON_IDS},
    "uint32": {
        "description": "MCAP message sequence (uint32).",
        **integer(0, UINT32_MAX),
    },
    "label": {
        "description": "Textual label (calibration ID, sensor/stream ID, kind, model, reason code). Intentionally not a UUID.",
        "type": "string",
        "maxLength": 64,
        "pattern": "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
    },
    "text": {
        "description": "Bounded human-readable diagnostic: 1..256 printable ASCII characters.",
        "type": "string",
        "maxLength": 256,
        "pattern": "^[ -~]{1,256}$",
    },
    "timeBase": {
        "description": "Encoder PTS time base: exactly 1/1000000 seconds.",
        "const": {"numerator": 1, "denominator": 1000000},
    },
}

TRI = {"enum": ["yes", "no", "unknown", "unavailable"]}


def schema(name: str, body: dict) -> dict:
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": f"https://stateaction.ai/schemas/capture/v1/{name}",
        "title": f"stateaction.capture.{name}.v1",
        **body,
        "$defs": DEFS,
    }


SCHEMAS = {
    "Profile": schema(
        "Profile",
        {
            **obj(
                [
                    "capture_schema",
                    "rgb_profile",
                    "recording_id",
                    "wire_contract_revision",
                    "encoder_time_base",
                    "production_qualified",
                    "qualification",
                    "limits",
                ],
                {
                    "capture_schema": {"const": "stateaction.capture.v1"},
                    "rgb_profile": {
                        "enum": ["h264_mcap_v1", "h264_mcap_simulation_v1"]
                    },
                    "recording_id": ref("uuid"),
                    "wire_contract_revision": {"const": "stateaction.capture.v1.1"},
                    "encoder_time_base": ref("timeBase"),
                    "production_qualified": {"const": False},
                    "qualification": {"enum": ["unqualified", "simulation_only"]},
                    "mapped_timeline_semantics": {"const": "simulation_transport_only"},
                    "limits": obj(
                        ["pending_frames"],
                        {
                            "pending_frames": integer(1, 64),
                            "access_unit_bytes": integer(1, 16_777_216),
                            "max_queued_encoded_bytes": integer(1, 1_073_741_824),
                            "mcap_chunk_target_bytes": integer(1, 1_073_741_824),
                            "mcap_chunk_input_bytes": integer(1, 1_073_741_824),
                            "chunk_index_count": integer(1, 1_048_576),
                            "writer_mode": {"enum": ["synchronous_bounded_input"]},
                        },
                    ),
                    "encoder": obj(
                        ["codec"],
                        {
                            "codec": {"const": "h264"},
                            "profile": {"enum": ["baseline", "main", "high"]},
                            "name": ref("label"),
                            "hardware": {"type": ["boolean", "null"]},
                            "width": integer(1, 16384),
                            "height": integer(1, 16384),
                            "fps": integer(1, 240),
                            "bitrate": integer(1, 1_000_000_000),
                            "b_frames": {"const": 0},
                            "idr_interval_seconds": integer(1, 60),
                        },
                    ),
                },
            ),
            "allOf": [
                {
                    "if": {
                        "properties": {
                            "rgb_profile": {"const": "h264_mcap_simulation_v1"}
                        }
                    },
                    "then": {
                        "required": ["mapped_timeline_semantics"],
                        "properties": {"qualification": {"const": "simulation_only"}},
                    },
                }
            ],
        },
    ),
    "Clocks": schema(
        "Clocks",
        obj(
            ["recording_id", "recorder_transport", "stream_clocks"],
            {
                "recording_id": ref("uuid"),
                "recorder_transport": obj(
                    [
                        "clock_id",
                        "target_clock_id",
                        "native_anchor_ns",
                        "epoch_anchor_ns",
                        "method",
                        "revision",
                        "status",
                        "uncertainty_ns",
                        "synchronization_accuracy",
                    ],
                    {
                        "clock_id": {"const": "android.elapsed_realtime"},
                        "target_clock_id": {"const": "unix"},
                        "native_anchor_ns": ref("int64Decimal"),
                        "epoch_anchor_ns": ref("int64Decimal"),
                        "uncertainty_ns": nullable("int64Decimal"),
                        "method": {"const": "fixed_host_anchor"},
                        "revision": ref("revision"),
                        "status": {"enum": ["same_domain", "measured", "unverified"]},
                        "synchronization_accuracy": {"const": "unverified"},
                    },
                ),
                "stream_clocks": {
                    "description": "Bounded map: stream label -> native clock domain.",
                    "type": "object",
                    "minProperties": 1,
                    "maxProperties": 32,
                    "propertyNames": ref("label"),
                    "additionalProperties": ref("clockDomain"),
                },
            },
        ),
    ),
    "Inventory": schema(
        "Inventory",
        obj(
            ["recording_id", "sensors", "calibrations"],
            {
                "recording_id": ref("uuid"),
                "sensors": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": 64,
                    "items": obj(
                        [
                            "sensor_id",
                            "kind",
                            "requested",
                            "supported",
                            "enabled",
                            "observed",
                            "observed_count",
                        ],
                        {
                            "sensor_id": ref("label"),
                            "kind": ref("label"),
                            "requested": TRI,
                            "supported": TRI,
                            "enabled": TRI,
                            "observed": TRI,
                            "observed_count": nullable("int64Decimal"),
                            "native_clock_id": nullable("clockDomain"),
                            "unavailable_reason": nullable("label"),
                        },
                    ),
                },
                "calibrations": {
                    "type": "array",
                    "maxItems": 64,
                    "items": obj(
                        ["calibration_id", "stream_id", "state"],
                        {
                            "calibration_id": ref("label"),
                            "stream_id": ref("label"),
                            "state": TRI,
                            "model": nullable("label"),
                        },
                    ),
                },
            },
        ),
    ),
    "FrameEvent": schema(
        "FrameEvent",
        {
            **obj(
                ["recording_id", "stream_id", "source_frame_id", "state"],
                {
                    "recording_id": ref("uuid"),
                    "stream_id": {"const": "rgb"},
                    "source_frame_id": ref("int64Decimal"),
                    "state": {"enum": ["acquired", "submitted", "written", "dropped"]},
                    "native_clock_id": ref("clockDomain"),
                    "clock_mapping_revision": ref("revision"),
                    "calibration_id": ref("label"),
                    "native_timestamp_ns": ref("int64Decimal"),
                    "mapped_capture_time_ns": ref("int64Decimal"),
                    "encoder_pts_us": ref("int64Decimal"),
                    "encoder_time_base": ref("timeBase"),
                    "native_timestamps": obj(
                        [],
                        {
                            "arcore_frame_timestamp_ns": ref("int64Decimal"),
                            "arcore_image_timestamp_ns": ref("int64Decimal"),
                            "metadata_sensor_timestamp_ns": ref("int64Decimal"),
                        },
                        minProperties=1,
                    ),
                    "is_idr": {"type": "boolean"},
                    "output_sequence": ref("uint32"),
                    "output_channel": {"const": "/camera/rgb/video"},
                    "reason": ref("label"),
                },
            ),
            "allOf": [
                {
                    "if": {"properties": {"state": {"enum": ["acquired", "written"]}}},
                    "then": {
                        "required": [
                            "native_timestamp_ns",
                            "native_clock_id",
                            "mapped_capture_time_ns",
                            "clock_mapping_revision",
                            "calibration_id",
                            "encoder_pts_us",
                            "encoder_time_base",
                            "native_timestamps",
                        ]
                    },
                },
                {
                    "if": {"properties": {"state": {"const": "written"}}},
                    "then": {
                        "required": ["output_channel", "output_sequence", "is_idr"]
                    },
                },
                {
                    "if": {"properties": {"state": {"const": "dropped"}}},
                    "then": {"required": ["reason"]},
                },
            ],
        },
    ),
    "MotionEvent": schema(
        "MotionEvent",
        obj(
            [
                "recording_id",
                "event_id",
                "native_timestamp_ns",
                "native_clock_id",
                "unit",
                "values",
            ],
            {
                "recording_id": ref("uuid"),
                "event_id": ref("int64Decimal"),
                "native_timestamp_ns": ref("int64Decimal"),
                "native_clock_id": {"const": "android.elapsed_realtime"},
                "unit": {"enum": ["m/s^2", "rad/s"]},
                "mapped_capture_time_ns": nullable("int64Decimal"),
                "callback_elapsed_ns": ref("int64Decimal"),
                "accuracy": {"anyOf": [integer(-1, 3), {"type": "null"}]},
                "values": {
                    "type": "array",
                    "minItems": 3,
                    "maxItems": 3,
                    "items": {
                        "type": "number",
                        "minimum": -1_000_000,
                        "maximum": 1_000_000,
                    },
                },
                "axes": {"enum": ["android_device"]},
                "includes_gravity": {"type": ["boolean", "null"]},
            },
        ),
    ),
    "SensorEvent": schema(
        "SensorEvent",
        {
            **obj(
                [
                    "recording_id",
                    "stream_id",
                    "event_id",
                    "native_timestamp_ns",
                    "native_clock_id",
                    "mapped_capture_time_ns",
                    "output_channel",
                    "output_sequence",
                    "source_kind",
                    "calibration_id",
                    "association_source_frame_id",
                ],
                {
                    "recording_id": ref("uuid"),
                    "stream_id": ref("label"),
                    "event_id": ref("int64Decimal"),
                    "native_timestamp_ns": ref("int64Decimal"),
                    "native_clock_id": ref("clockDomain"),
                    "mapped_capture_time_ns": nullable("int64Decimal"),
                    "output_channel": {
                        "enum": ["/tracking/pose", "/stateaction/sensor_events"]
                    },
                    "output_sequence": ref("uint32"),
                    "source_kind": ref("label"),
                    "calibration_id": nullable("label"),
                    "association_source_frame_id": nullable("int64Decimal"),
                    "tracking_state": {
                        "enum": ["tracking", "paused", "lost", "unknown"]
                    },
                    "pose_valid": {"type": ["boolean", "null"]},
                    "supersedes_calibration_id": nullable("label"),
                },
            ),
            "allOf": [
                {
                    "if": {
                        "required": ["source_kind"],
                        "properties": {"source_kind": {"const": "arcore_pose"}},
                    },
                    "then": {"required": ["tracking_state", "pose_valid"]},
                },
                {
                    "if": {
                        "required": ["source_kind"],
                        "properties": {"source_kind": {"const": "calibration_reset"}},
                    },
                    "then": {
                        "required": ["supersedes_calibration_id"],
                        "properties": {
                            "calibration_id": ref("label"),
                            "supersedes_calibration_id": ref("label"),
                        },
                    },
                },
            ],
        },
    ),
    "Close": schema(
        "Close",
        obj(
            [
                "recording_id",
                "outcome",
                "frames",
                "video_messages",
                "drops",
                "motion_events",
                "sensor_events",
            ],
            {
                "recording_id": ref("uuid"),
                "outcome": {"enum": ["completed", "failed", "aborted", "unknown"]},
                "failure_reason": nullable("text"),
                "frames": obj(
                    ["acquired", "submitted", "written", "dropped", "unresolved"],
                    {
                        k: ref("int64Decimal")
                        for k in (
                            "acquired",
                            "submitted",
                            "written",
                            "dropped",
                            "unresolved",
                        )
                    },
                ),
                "video_messages": ref("int64Decimal"),
                "motion_events": obj(
                    ["accel", "gyro"],
                    {"accel": ref("int64Decimal"), "gyro": ref("int64Decimal")},
                ),
                "sensor_events": ref("int64Decimal"),
                "drops": {
                    "type": "array",
                    "maxItems": 32,
                    "items": obj(
                        ["reason", "count"],
                        {"reason": ref("label"), "count": ref("int64Decimal")},
                    ),
                },
            },
        ),
    ),
}


# ------------------------------------------------------------------------------------------------
# stateaction.capture.v1.2 additions (SA-68). Existing v1.1 schemas above are frozen byte for byte;
# every v1.2 schema is a NEW file. Profile.v2 and Close.v2 are derived from the frozen v1 definitions.
# ------------------------------------------------------------------------------------------------
import copy  # noqa: E402

REV12 = "stateaction.capture.v1.2"
RAW_IMAGE_BYTES = 16_777_216
ENC_LABELS = {
    "depth_raw": ("arcore_acquire_raw_depth_image_16bits", "/camera/depth_raw/image"),
    "depth_dense": ("arcore_acquire_depth_image_16bits", "/camera/depth_dense/image"),
}


def schema_v(name: str, body: dict, version: str, title: str) -> dict:
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": f"https://stateaction.ai/schemas/capture/{version}/{name}",
        "title": title,
        **body,
        "$defs": DEFS,
    }


def number(bound: int = 1_000_000_000) -> dict:
    return {"type": "number", "minimum": -bound, "maximum": bound}


def numbers(n: int) -> dict:
    return {"type": "array", "minItems": n, "maxItems": n, "items": number()}


def reported_or_unavailable(value_schema: dict, **extra) -> dict:
    return {
        "anyOf": [
            obj(
                ["state", "value"],
                {"state": {"const": "reported"}, "value": value_schema, **extra},
            ),
            obj(
                ["state", "reason"],
                {"state": {"const": "unavailable"}, "reason": ref("label")},
            ),
        ]
    }


def _profile_v2() -> dict:
    body = copy.deepcopy(SCHEMAS["Profile"])
    body["properties"]["wire_contract_revision"] = {"const": REV12}
    for k in ("$schema", "$id", "title", "$defs"):
        body.pop(k)
    return schema_v("Profile", body, "v2", "stateaction.capture.Profile.v2")


def _close_v2() -> dict:
    body = copy.deepcopy(SCHEMAS["Close"])
    for k in ("$schema", "$id", "title", "$defs"):
        body.pop(k)
    count = ref("int64Decimal")
    stream = {
        "events": count,
        "distinct_native_timestamps": count,
        "retention_policy": {"enum": ["all_returned_images", "native_updates_only"]},
        "skipped_repeats": count,
    }
    raw_keys = ["events", "confidence_images", "distinct_native_timestamps"]
    body["required"] += [
        "calibrations",
        "camera_metadata",
        "depth",
        "stop_reason",
        "encoder_drain",
    ]
    body["properties"].update(
        {
            "calibrations": count,
            "camera_metadata": count,
            "depth": obj(
                ["depth_raw", "depth_dense"],
                {
                    "depth_raw": obj(
                        raw_keys + ["retention_policy", "skipped_repeats"],
                        {**stream, "confidence_images": count},
                    ),
                    "depth_dense": obj(list(stream), stream),
                },
            ),
            "stop_reason": {
                "enum": [
                    "user_requested",
                    "duration_limit",
                    "low_storage_reserve",
                    "thermal_critical",
                    "session_interrupted",
                    "camera_lost",
                    "writer_error",
                    "encoder_error",
                    "app_terminating",
                    "unknown",
                ]
            },
            "encoder_drain": {
                "enum": [
                    "eos_reached",
                    "deadline_exceeded",
                    "encoder_failed",
                    "not_started",
                ]
            },
        }
    )
    return schema_v("Close", body, "v2", "stateaction.capture.Close.v2")


def _calibration() -> dict:
    crop = obj(
        ["left", "top", "width", "height"],
        {
            "left": integer(0, 16383),
            "top": integer(0, 16383),
            "width": integer(1, 16384),
            "height": integer(1, 16384),
        },
    )
    return schema_v(
        "Calibration",
        obj(
            [
                "recording_id",
                "calibration_id",
                "stream_id",
                "model",
                "saved_width",
                "saved_height",
                "K",
                "P",
                "source",
                "source_to_saved",
                "distortion",
                "first_source_frame_id",
                "first_native_timestamp_ns",
                "native_clock_id",
            ],
            {
                "recording_id": ref("uuid"),
                "calibration_id": ref("label"),
                "stream_id": {"const": "rgb"},
                "model": {"const": "pinhole"},
                "saved_width": integer(1, 16384),
                "saved_height": integer(1, 16384),
                "K": numbers(9),
                "P": numbers(12),
                "source": obj(
                    ["width", "height", "intrinsics_source", "value_type", "K"],
                    {
                        "width": integer(1, 16384),
                        "height": integer(1, 16384),
                        "intrinsics_source": ref("label"),
                        "value_type": {"enum": ["float32", "float64"]},
                        "K": numbers(9),
                    },
                ),
                "source_to_saved": obj(
                    [
                        "crop",
                        "scaled_width",
                        "scaled_height",
                        "rotation_cw_degrees",
                        "mirror_horizontal",
                        "operation_order",
                        "pixel_center_convention",
                        "matrix",
                    ],
                    {
                        "crop": crop,
                        "scaled_width": integer(1, 16384),
                        "scaled_height": integer(1, 16384),
                        "rotation_cw_degrees": {"const": 0},
                        "mirror_horizontal": {"const": False},
                        "operation_order": {"const": "crop,resize"},
                        "pixel_center_convention": {
                            "const": "integer_centers_assumed_not_verified_against_arcore"
                        },
                        "matrix": numbers(9),
                    },
                ),
                "distortion": obj(
                    ["state", "assumed_model", "measured"],
                    {
                        "state": {"const": "not_exposed_by_source"},
                        "assumed_model": {"const": "none"},
                        "measured": {"const": False},
                    },
                ),
                "first_source_frame_id": ref("int64Decimal"),
                "first_native_timestamp_ns": ref("int64Decimal"),
                "native_clock_id": ref("clockDomain"),
            },
        ),
        "v1",
        "stateaction.capture.Calibration.v1",
    )


def _depth_event() -> dict:
    # Original native plane layout beside the stored (tight) layout: stride padding is dropped, a crop is
    # recorded, and neither ever silently erases the native shape (mirrors SA-55 DepthEvidence).
    plane_keys = [
        "native_width",
        "native_height",
        "native_row_stride_bytes",
        "native_pixel_stride_bytes",
        "stored_width",
        "stored_height",
        "crop",
    ]
    plane = {
        "native_width": integer(1, 16384),
        "native_height": integer(1, 16384),
        "native_row_stride_bytes": integer(1, RAW_IMAGE_BYTES),
        "native_pixel_stride_bytes": integer(1, 16),
        "stored_width": integer(1, 4096),
        "stored_height": integer(1, 4096),
        "crop": {
            "anyOf": [
                obj(
                    ["x", "y", "width", "height"],
                    {
                        "x": integer(0, 16383),
                        "y": integer(0, 16383),
                        "width": integer(1, 4096),
                        "height": integer(1, 4096),
                    },
                ),
                {"type": "null"},
            ]
        },
    }
    separate = obj(
        [
            "state",
            "output_channel",
            "output_sequence",
            "encoding",
            "units",
            "native_format",
            "native_timestamp",
            *plane_keys,
        ],
        {
            "state": {"const": "separate_image"},
            "output_channel": {"const": "/camera/depth_raw/confidence"},
            "output_sequence": ref("uint32"),
            "encoding": {"const": "mono8"},
            "units": {"const": "source_confidence_u8"},
            "native_format": ref("label"),
            "native_timestamp": {
                "anyOf": [
                    obj(
                        ["state", "native_timestamp_ns", "native_clock_id"],
                        {
                            "state": {"const": "reported"},
                            "native_timestamp_ns": ref("int64Decimal"),
                            "native_clock_id": ref("clockDomain"),
                        },
                    ),
                    obj(
                        ["state", "reason"],
                        {
                            "state": {"const": "unavailable"},
                            "reason": ref("label"),
                        },
                    ),
                ]
            },
            **plane,
        },
    )
    absent = obj(
        ["state"],
        {"state": {"enum": ["not_provided_by_source", "unavailable_for_frame"]}},
    )
    body = obj(
        [
            "recording_id",
            "stream_id",
            "event_id",
            "source_kind",
            "native_timestamp_ns",
            "native_clock_id",
            "clock_epoch",
            "timestamp_relation",
            "estimate_provenance",
            "capture_time_basis",
            "capture_time_ns",
            "clock_mapping_revision",
            "receipt_native_timestamp_ns",
            "acquisition_source_frame_id",
            "measurement_source_frame_id",
            "calibration_id",
            "depth",
            "confidence",
        ],
        {
            "recording_id": ref("uuid"),
            "stream_id": {"enum": ["depth_raw", "depth_dense"]},
            "event_id": ref("int64Decimal"),
            "source_kind": {"enum": [v[0] for v in ENC_LABELS.values()]},
            "native_timestamp_ns": ref("int64Decimal"),
            "native_clock_id": ref("clockDomain"),
            "clock_epoch": ref("uint32"),
            "timestamp_relation": {
                "enum": ["first", "advanced", "repeated", "clock_reset"]
            },
            "estimate_provenance": {
                "enum": ["new_estimate", "reprojected", "api_repeat", "unknown"]
            },
            "capture_time_basis": {
                "enum": ["transport_mapping", "acquisition_receipt"]
            },
            "capture_time_ns": ref("int64Decimal"),
            "clock_mapping_revision": ref("revision"),
            "receipt_native_timestamp_ns": nullable("int64Decimal"),
            "acquisition_source_frame_id": nullable("int64Decimal"),
            "measurement_source_frame_id": nullable("int64Decimal"),
            "calibration_id": nullable("label"),
            "depth": obj(
                [
                    "output_channel",
                    "output_sequence",
                    "encoding",
                    "byte_order",
                    "units",
                    "native_format",
                    *plane_keys,
                ],
                {
                    "output_channel": {"enum": [v[1] for v in ENC_LABELS.values()]},
                    "output_sequence": ref("uint32"),
                    "encoding": {"const": "16UC1"},
                    "byte_order": {"const": "little"},
                    "units": {"const": "millimetre"},
                    "native_format": {"const": "android.hardware.HardwareBuffer.D_16"},
                    **plane,
                },
            ),
            "confidence": {"anyOf": [separate, absent]},
        },
    )
    ties = []
    for stream, (kind, channel) in ENC_LABELS.items():
        then = {
            "properties": {
                "source_kind": {"const": kind},
                "depth": {"properties": {"output_channel": {"const": channel}}},
            }
        }
        if stream == "depth_dense":
            then["properties"]["confidence"] = {
                "properties": {
                    "state": {
                        "enum": ["not_provided_by_source", "unavailable_for_frame"]
                    }
                }
            }
        ties.append(
            {
                "if": {
                    "required": ["stream_id"],
                    "properties": {"stream_id": {"const": stream}},
                },
                "then": then,
            }
        )
    ties += [
        {
            "if": {
                "required": ["capture_time_basis"],
                "properties": {"capture_time_basis": {"const": "acquisition_receipt"}},
            },
            "then": {
                "properties": {"receipt_native_timestamp_ns": ref("int64Decimal")}
            },
        },
        {
            "if": {
                "required": ["capture_time_basis"],
                "properties": {"capture_time_basis": {"const": "transport_mapping"}},
            },
            "then": {"properties": {"receipt_native_timestamp_ns": {"type": "null"}}},
        },
    ]
    body["allOf"] = ties
    return schema_v("DepthEvent", body, "v1", "stateaction.capture.DepthEvent.v1")


def _camera_metadata() -> dict:
    return schema_v(
        "CameraMetadata",
        obj(
            [
                "recording_id",
                "stream_id",
                "source_frame_id",
                "native_timestamp_ns",
                "source",
                "exposure_time_ns",
                "frame_duration_ns",
                "rolling_shutter_skew_ns",
                "sensitivity_iso",
                "focus_distance_diopters",
            ],
            {
                "recording_id": ref("uuid"),
                "stream_id": {"const": "rgb"},
                "source_frame_id": ref("int64Decimal"),
                "native_timestamp_ns": nullable("int64Decimal"),
                "source": ref("label"),
                "exposure_time_ns": reported_or_unavailable(ref("int64Decimal")),
                "frame_duration_ns": reported_or_unavailable(ref("int64Decimal")),
                "rolling_shutter_skew_ns": reported_or_unavailable(ref("int64Decimal")),
                "sensitivity_iso": reported_or_unavailable(integer(0, 1_000_000)),
                "focus_distance_diopters": reported_or_unavailable(
                    {"type": "number", "minimum": 0, "maximum": 1_000_000},
                    value_type={"enum": ["float32", "float64"]},
                ),
            },
        ),
        "v1",
        "stateaction.capture.CameraMetadata.v1",
    )


# schema key -> output file stem. The v1.1 keys keep their historical `<key>.schema.json` names.
SCHEMAS12 = {
    "Profile.v2": _profile_v2(),
    "Close.v2": _close_v2(),
    "Calibration": _calibration(),
    "DepthEvent": _depth_event(),
    "CameraMetadata": _camera_metadata(),
}


def _pretty(value, indent: int, prefix_len: int) -> str:
    """Prettier-compatible JSON (printWidth 80): objects always expanded, primitive arrays inline when
    they fit on the line, so the generated files pass the repository's Prettier check byte for byte."""
    pad = " " * indent
    if isinstance(value, dict):
        if not value:
            return "{}"
        items = [
            f"{pad}  {json.dumps(k)}: "
            + _pretty(v, indent + 2, indent + 2 + len(json.dumps(k)) + 2)
            for k, v in value.items()
        ]
        return "{\n" + ",\n".join(items) + "\n" + pad + "}"
    if isinstance(value, list):
        if not value:
            return "[]"
        if all(not isinstance(v, (dict, list)) for v in value):
            inline = "[" + ", ".join(json.dumps(v) for v in value) + "]"
            if prefix_len + len(inline) + 1 <= 80:
                return inline
        items = [f"{pad}  " + _pretty(v, indent + 2, indent + 2) for v in value]
        return "[\n" + ",\n".join(items) + "\n" + pad + "]"
    return json.dumps(value, ensure_ascii=True)


def render(body: dict) -> bytes:
    return (_pretty(body, 0, 0) + "\n").encode()


def main() -> int:
    check = "--check" in sys.argv[1:]
    drift = []
    for name, body in {**SCHEMAS, **SCHEMAS12}.items():
        path = CAP / f"{name}.schema.json"
        data = render(body)
        if check:
            if not path.exists() or path.read_bytes() != data:
                drift.append(path.name)
        else:
            path.write_bytes(data)
    if drift:
        print(f"schema drift (run build_schemas.py): {drift}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
