"""Deterministic stateaction.capture.v1.2 golden corpus (SA-68): golden/v1.2/*.mcap, cases.json, expected/.

Called from gen_golden.main(). The frozen v1.1 corpus is generated first and is untouched. Every depth,
confidence and camera byte here is a controlled synthetic byte pattern: it carries NO physical-device,
sensor-accuracy or depth-quality claim. Declared outcomes/codes/violations are written by hand from the
rule each case violates; main() asserts that the reference checker agrees and never copies its output.
"""

from __future__ import annotations

import copy
import json
import re
import struct

G = None  # the gen_golden module (set by generate())
cc = None

TRANSPORT_CLOCK = "android.elapsed_realtime"
RGB_CLOCK = "android.camera.sensor_timestamp"
DEPTH_CLOCK = "arcore.depth_timestamp"
SRC_W, SRC_H = 640, 480  # source camera raster
SAVED_W, SAVED_H = (
    64,
    48,
)  # the golden video raster (ffprobe of golden/source/baseline-5.h264)
CHANNEL_OF = {
    "depth_raw": "/camera/depth_raw/image",
    "depth_dense": "/camera/depth_dense/image",
}
KIND_OF = {
    "depth_raw": "arcore_acquire_raw_depth_image_16bits",
    "depth_dense": "arcore_acquire_depth_image_16bits",
}
RAW_NEW = [
    (
        "/stateaction/calibrations",
        "stateaction.capture.Calibration.v1",
        "Calibration.schema.json",
        ("jsonschema", "json"),
    ),
    (
        "/stateaction/depth_events",
        "stateaction.capture.DepthEvent.v1",
        "DepthEvent.schema.json",
        ("jsonschema", "json"),
    ),
    (
        "/stateaction/camera_metadata",
        "stateaction.capture.CameraMetadata.v1",
        "CameraMetadata.schema.json",
        ("jsonschema", "json"),
    ),
]


def offset() -> int:
    return G.BASE_CAPTURE_NS - G.BASE_NATIVE_NS


def cap_of(sid: int) -> int:
    return G.BASE_CAPTURE_NS + sid * G.STEP_NS


# ---------------------------------------------------------------- bytes
def raw_image(capture_ns, width, height, encoding, data, step=None, frame_id=None):
    step = (width * (2 if encoding == "16UC1" else 1)) if step is None else step
    frame_id = "depth_optical_frame" if frame_id is None else frame_id
    stamp = (
        b"\x08" + G.varint(capture_ns // 10**9) + b"\x10" + G.varint(capture_ns % 10**9)
    )
    return (
        G.field(1, stamp)
        + b"\x15"
        + struct.pack("<I", width)
        + b"\x1d"
        + struct.pack("<I", height)
        + G.field(4, encoding.encode())
        + b"\x2d"
        + struct.pack("<I", step)
        + G.field(6, data)
        + G.field(7, frame_id.encode())
    )


def depth_plane(width, height, seed):
    """Full-range uint16 little-endian millimetres, including values above 13 bits."""
    values = [
        (1000 + 37 * x + 101 * y + 7919 * seed) % 65536
        for y in range(height)
        for x in range(width)
    ]
    values[0], values[1], values[2] = 0, 40000, 65535
    return struct.pack(f"<{len(values)}H", *values)


def confidence_plane(width, height, seed):
    values = [
        (31 * x + 17 * y + 5 * seed) % 256 for y in range(height) for x in range(width)
    ]
    values[0], values[1] = 0, 255
    return bytes(values)


# ---------------------------------------------------------------- calibration
def calibration(cid, first_sid, crop=(0, 0, SRC_W, SRC_H), scaled=(SAVED_W, SAVED_H)):
    left, top, cw, ch = crop
    sw, sh = scaled
    fx, fy, cx, cy = (
        480.0,
        480.0,
        320.0,
        240.0,
    )  # float32-representable (ARCore CameraIntrinsics)
    sx, sy = sw / cw, sh / ch
    m02, m12 = (0.5 - left) * sx - 0.5, (0.5 - top) * sy - 0.5
    k = [fx * sx, 0.0, cx * sx + m02, 0.0, fy * sy, cy * sy + m12, 0.0, 0.0, 1.0]
    return {
        "recording_id": G.REC,
        "calibration_id": cid,
        "stream_id": "rgb",
        "model": "pinhole",
        "saved_width": sw,
        "saved_height": sh,
        "K": k,
        "P": [k[0], 0.0, k[2], 0.0, 0.0, k[4], k[5], 0.0, 0.0, 0.0, 1.0, 0.0],
        "source": {
            "width": SRC_W,
            "height": SRC_H,
            "intrinsics_source": "arcore.camera.image_intrinsics",
            "value_type": "float32",
            "K": [fx, 0.0, cx, 0.0, fy, cy, 0.0, 0.0, 1.0],
        },
        "source_to_saved": {
            "crop": {"left": left, "top": top, "width": cw, "height": ch},
            "scaled_width": sw,
            "scaled_height": sh,
            "rotation_cw_degrees": 0,
            "mirror_horizontal": False,
            "operation_order": "crop,resize",
            "pixel_center_convention": "integer_centers_assumed_not_verified_against_arcore",
            "matrix": [sx, 0.0, m02, 0.0, sy, m12, 0.0, 0.0, 1.0],
        },
        "distortion": {
            "state": "not_exposed_by_source",
            "assumed_model": "none",
            "measured": False,
        },
        "first_source_frame_id": str(first_sid),
        "first_native_timestamp_ns": str(G.native(first_sid)),
        "native_clock_id": RGB_CLOCK,
    }


def fix_p(c):
    k = c["K"]
    c["P"] = [k[0], k[1], k[2], 0.0, k[3], k[4], k[5], 0.0, k[6], k[7], k[8], 0.0]
    return c


# ---------------------------------------------------------------- model builder
def sensor_entry(
    sensor_id, kind, count=None, clock=None, reason="device_reports_unsupported"
):
    if count:
        return {
            "sensor_id": sensor_id,
            "kind": kind,
            "requested": "yes",
            "supported": "yes",
            "enabled": "yes",
            "observed": "yes",
            "observed_count": str(count),
            "native_clock_id": clock,
            "unavailable_reason": None,
        }
    return {
        "sensor_id": sensor_id,
        "kind": kind,
        "requested": "yes",
        "supported": "no",
        "enabled": "no",
        "observed": "unavailable",
        "observed_count": None,
        "native_clock_id": None,
        "unavailable_reason": reason,
    }


def plane_fields(sp, sample, stored_w, stored_h, pstride):
    nw, nh = sp.get("nw", stored_w), sp.get("nh", stored_h)
    crop = sp.get("crop")
    return {
        "native_width": nw,
        "native_height": nh,
        "native_row_stride_bytes": nw * pstride + sp.get("pad", 0),
        "native_pixel_stride_bytes": pstride,
        "stored_width": stored_w,
        "stored_height": stored_h,
        "crop": {"x": crop[0], "y": crop[1], "width": stored_w, "height": stored_h}
        if crop
        else None,
    }


def make(
    cals=(("rgb_0", 0),),
    depth=None,
    meta=(),
    reset=None,
    stop=("user_requested", "eos_reached", "completed"),
    unresolved_last=False,
    policies=None,
    model_fn=None,
):
    """Build a render model. cals: ((calibration_id, first_sid[, crop]), ...); depth: {stream: [spec]}."""
    m = (model_fn or G.model)()
    frames = m["frames"]
    if unresolved_last:
        frames[-1]["unresolved"] = True
    cal_msgs, inv_cals = [], []
    for item in cals:
        cid, first = item[0], item[1]
        crop = item[2] if len(item) > 2 else (0, 0, SRC_W, SRC_H)
        cal_msgs.append((cap_of(first) - 5, calibration(cid, first, crop)))
        inv_cals.append(
            {
                "calibration_id": cid,
                "stream_id": "rgb",
                "state": "yes",
                "model": "pinhole",
            }
        )
    if reset:  # reset: (sid where the new calibration starts, new id, superseded id)
        sid, new, old = reset
        for f in frames:
            if f["sid"] >= sid:
                f["calibration"] = new
        m["extra"]["sensors"] = [
            (0, "arcore_pose", "tracking", True, cals[0][0], None, 0),
            (1, "arcore_pose", "lost", False, cals[0][0], None, 1),
            (3, "calibration_reset", None, None, new, old, sid),
        ]
    if "rgb_1" not in {c[0] for c in cals}:
        inv_cals.append(
            {
                "calibration_id": "rgb_1",
                "stream_id": "rgb",
                "state": "unknown",
                "model": None,
            }
        )
    events = [(t, "/stateaction/calibrations", c) for t, c in cal_msgs]
    depth = depth or {}
    seqs = {t: 0 for t in CHANNEL_OF.values()} | {"/camera/depth_raw/confidence": 0}
    stats = {}
    for stream, specs in depth.items():
        stats[stream] = {"events": 0, "conf": 0, "pairs": set(), "repeated": 0}
        for i, sp in enumerate(specs):
            clock = sp.get("clock", DEPTH_CLOCK)
            basis = sp.get("basis", "acquisition_receipt")
            ts = sp["ts"]
            receipt = sp.get("receipt")
            if basis == "acquisition_receipt" and receipt is None:
                receipt = G.BASE_NATIVE_NS + sp.get("receipt_k", i + 1) * 1_000_003
            base = ts if basis == "transport_mapping" else receipt
            capture = base + offset()
            w, h = sp.get("w", 8), sp.get("h", 6)
            ch = CHANNEL_OF[stream]
            conf = sp.get("conf", "absent" if stream == "depth_dense" else "separate")
            body = {
                "recording_id": G.REC,
                "stream_id": stream,
                "event_id": str(sp.get("id", i)),
                "source_kind": KIND_OF[stream],
                "native_timestamp_ns": str(ts),
                "native_clock_id": clock,
                "clock_epoch": sp.get("epoch", 0),
                "timestamp_relation": sp["rel"],
                "estimate_provenance": sp["prov"],
                "capture_time_basis": basis,
                "capture_time_ns": str(capture),
                "clock_mapping_revision": "android_elapsed_to_unix_v1",
                "receipt_native_timestamp_ns": str(receipt)
                if basis == "acquisition_receipt"
                else None,
                "acquisition_source_frame_id": sp.get("acq"),
                "measurement_source_frame_id": sp.get("mea"),
                "calibration_id": sp.get("cal"),
                "depth": {
                    "output_channel": ch,
                    "output_sequence": seqs[ch],
                    "encoding": "16UC1",
                    "byte_order": "little",
                    "units": "millimetre",
                    "native_format": "android.hardware.HardwareBuffer.D_16",
                    **plane_fields(sp, 2, w, h, sp.get("pstride", 2)),
                },
                "confidence": {"state": "not_provided_by_source"},
            }
            # file order follows acquisition order, never the (possibly regressing) capture time
            log = G.BASE_CAPTURE_NS + 100_000_000 + len(stats) * 1_000_000 + i * 10
            events.append((log, "/stateaction/depth_events", body))
            events.append(
                (
                    log + 1,
                    ch,
                    (
                        seqs[ch],
                        raw_image(
                            capture, w, h, "16UC1", depth_plane(w, h, sp.get("seed", i))
                        ),
                    ),
                )
            )
            seqs[ch] += 1
            if conf == "separate":
                cch = "/camera/depth_raw/confidence"
                cts = sp.get("conf_ts")
                body["confidence"] = {
                    "state": "separate_image",
                    "output_channel": cch,
                    "output_sequence": seqs[cch],
                    "encoding": "mono8",
                    "units": "source_confidence_u8",
                    "native_format": "arcore.raw_depth_confidence",
                    "native_timestamp": {
                        "state": "reported",
                        "native_timestamp_ns": str(cts[0]),
                        "native_clock_id": cts[1],
                    }
                    if cts
                    else {"state": "unavailable", "reason": "not_exposed_by_source"},
                    **plane_fields(sp, 1, w, h, sp.get("cpstride", 1)),
                }
                events.append(
                    (
                        log + 2,
                        cch,
                        (
                            seqs[cch],
                            raw_image(
                                capture,
                                w,
                                h,
                                "mono8",
                                confidence_plane(w, h, sp.get("seed", i)),
                            ),
                        ),
                    )
                )
                seqs[cch] += 1
                stats[stream]["conf"] += 1
            elif conf == "unavailable":
                body["confidence"] = {"state": "unavailable_for_frame"}
            stats[stream]["events"] += 1
            stats[stream]["pairs"].add((sp.get("epoch", 0), ts))
            stats[stream]["repeated"] += sp["rel"] == "repeated"
    for i, mt in enumerate(meta):
        sid = mt["sid"]
        events.append((cap_of(sid) + 4, "/stateaction/camera_metadata", mt["body"]))
    channels = []
    if cal_msgs:
        channels.append(RAW_NEW[0])
    if depth:
        channels.append(RAW_NEW[1])
    if meta:
        channels.append(RAW_NEW[2])
    desc = "foxglove-raw-image.desc"
    raw = ("protobuf", "protobuf")
    used_raw = {e[1] for e in events if isinstance(e[2], tuple)}
    for topic in (
        "/camera/depth_raw/image",
        "/camera/depth_raw/confidence",
        "/camera/depth_dense/image",
    ):
        if topic in used_raw:
            channels.append((topic, "foxglove.RawImage", desc, raw))
    sensors = [
        sensor_entry(
            "depth_raw",
            "depth",
            len(depth.get("depth_raw", [])),
            (depth.get("depth_raw") or [{}])[0].get("clock", DEPTH_CLOCK),
        ),
        sensor_entry(
            "depth_dense",
            "depth",
            len(depth.get("depth_dense", [])),
            (depth.get("depth_dense") or [{}])[0].get("clock", DEPTH_CLOCK),
        ),
        sensor_entry(
            "camera_metadata",
            "camera",
            len(meta),
            "android.camera.sensor_timestamp",
            "not_collected",
        ),
        sensor_entry("mesh", "geometry", 0, None, "no_source"),
        sensor_entry("point_cloud", "geometry", 0, None, "no_source"),
    ]
    zero = "0"

    def depth_close(stream):
        st = stats.get(stream)
        pol = (policies or {}).get(stream, ("all_returned_images", "0"))
        out = {
            "events": str(st["events"] if st else 0),
            "distinct_native_timestamps": str(len(st["pairs"]) if st else 0),
            "retention_policy": pol[0],
            "skipped_repeats": pol[1],
        }
        if stream == "depth_raw":
            out["confidence_images"] = str(st["conf"] if st else 0)
        return out

    reason, drain, outcome = stop
    close = {
        "outcome": outcome,
        "calibrations": str(len(cal_msgs)),
        "camera_metadata": str(len(meta)),
        "depth": {s: depth_close(s) for s in ("depth_raw", "depth_dense")},
        "stop_reason": reason,
        "encoder_drain": drain,
    }
    if outcome == "failed":
        close["failure_reason"] = "encoder_error"
    sc = {}
    for stream, specs in depth.items():
        sc[stream] = specs[0].get("clock", DEPTH_CLOCK)
        for sp in specs:
            if sp.get("conf_ts"):
                sc["depth_raw_confidence"] = sp["conf_ts"][1]
    if sc:
        m["stream_clocks"] = sc
    m["v12"] = {
        "encoder": {"width": SAVED_W, "height": SAVED_H},
        "channels": channels,
        "inventory_sensors": sensors,
        "inventory_calibrations": inv_cals,
        "close": close,
        "events": events,
    }
    del zero
    return m


def camera_meta(sid, reported=True, ts=True):
    s = G.native(sid)
    if reported:
        body = {
            "recording_id": G.REC,
            "stream_id": "rgb",
            "source_frame_id": str(sid),
            "native_timestamp_ns": str(s) if ts else None,
            "source": "arcore.image_metadata",
            "exposure_time_ns": {"state": "reported", "value": "8333333"},
            "frame_duration_ns": {"state": "reported", "value": "33333333"},
            "rolling_shutter_skew_ns": {
                "state": "unavailable",
                "reason": "not_exposed_by_source",
            },
            "sensitivity_iso": {"state": "reported", "value": 100},
            "focus_distance_diopters": {
                "state": "reported",
                "value": 2.5,
                "value_type": "float32",
            },
        }
    else:
        un = {"state": "unavailable", "reason": "nonfinite_value_from_platform"}
        body = {
            "recording_id": G.REC,
            "stream_id": "rgb",
            "source_frame_id": str(sid),
            "native_timestamp_ns": None,
            "source": "arcore.image_metadata",
            "exposure_time_ns": un,
            "frame_duration_ns": {
                "state": "unavailable",
                "reason": "not_exposed_by_source",
            },
            "rolling_shutter_skew_ns": un,
            "sensitivity_iso": un,
            "focus_distance_diopters": un,
        }
    return {"sid": sid, "body": body}


# ---------------------------------------------------------------- mutation helpers
def evs(m, topic):
    return [e[2] for e in m["v12"]["events"] if e[1] == topic]


def set_in(obj, path, value):
    for k in path[:-1]:
        obj = obj[k]
    if value is None and False:
        obj.pop(path[-1])
    obj[path[-1]] = value


def mutate(topic, index, path, value):
    """Change evs(m, topic)[index] at the nested path (value=DELETE removes the key)."""

    def fn(m):
        target = evs(m, topic)[index]
        for k in path[:-1]:
            target = target[k]
        if value is DELETE:
            target.pop(path[-1])
        else:
            target[path[-1]] = value

    return fn


DELETE = object()


def close_set(path, value):
    def fn(m):
        node = m["v12"]["close"]
        for k in path[:-1]:
            node = node[k]
        node[path[-1]] = value

    return fn


def replace_image(topic, index, build):
    """Replace the index-th image on topic with build(capture_ns) -> (sequence, bytes)."""

    def fn(m):
        ev = m["v12"]["events"]
        idx = [i for i, e in enumerate(ev) if e[1] == topic]
        i = idx[index]
        seq = ev[i][2][0]
        decoded = cc.decode_raw_image(ev[i][2][1])
        ev[i] = (ev[i][0], topic, (seq, build(decoded)))

    return fn


def chain(*fns):
    def fn(m):
        for f in fns:
            f(m)

    return fn


D_RAW_BASE = 5_000_000_000
SPEC_RAW = [  # reprojection: equal native timestamps with distinct acquisition IDs and bytes
    dict(ts=D_RAW_BASE, rel="first", prov="new_estimate", acq="1", seed=0),
    dict(ts=D_RAW_BASE, rel="repeated", prov="reprojected", acq="2", seed=1),
    dict(
        ts=D_RAW_BASE + 33_000_000,
        rel="advanced",
        prov="new_estimate",
        acq="4",
        conf="unavailable",
        seed=2,
    ),
    dict(
        ts=D_RAW_BASE + 33_000_000, rel="repeated", prov="api_repeat", acq="5", seed=2
    ),
]


def with_raw(specs=None, **kw):
    return make(depth={"depth_raw": copy.deepcopy(specs or SPEC_RAW)}, **kw)


def transport_specs():
    t = G.BASE_NATIVE_NS
    return [
        dict(
            ts=t + 2 * G.STEP_NS + 3,
            clock=TRANSPORT_CLOCK,
            basis="transport_mapping",
            rel="first",
            prov="new_estimate",
            acq="2",
            seed=0,
        ),
        dict(
            ts=t + 3 * G.STEP_NS + 3,
            clock=TRANSPORT_CLOCK,
            basis="transport_mapping",
            rel="advanced",
            prov="new_estimate",
            acq="4",
            seed=1,
        ),
        dict(
            ts=t + 1000,
            clock=TRANSPORT_CLOCK,
            basis="transport_mapping",
            rel="clock_reset",
            prov="new_estimate",
            epoch=1,
            acq="5",
            seed=2,
        ),
        dict(
            ts=t + 1000 + G.STEP_NS,
            clock=TRANSPORT_CLOCK,
            basis="transport_mapping",
            rel="advanced",
            prov="new_estimate",
            epoch=1,
            acq=None,
            seed=3,
        ),
    ]


def with_transport(**kw):
    return make(
        depth={"depth_raw": transport_specs()},
        policies={"depth_raw": ("native_updates_only", "3")},
        **kw,
    )


def dense_specs():
    return [
        dict(
            ts=G.native(2),
            clock=RGB_CLOCK,
            rel="first",
            prov="new_estimate",
            acq="2",
            mea="2",
            w=6,
            h=4,
            seed=0,
        ),
        dict(
            ts=G.native(4),
            clock=RGB_CLOCK,
            rel="advanced",
            prov="new_estimate",
            acq="4",
            mea="4",
            w=6,
            h=4,
            seed=1,
        ),
    ]


def with_dense(**kw):
    return make(depth={"depth_dense": dense_specs()}, **kw)


def stream_clock(**clocks):
    def fn(m):
        m["stream_clocks"] = clocks

    return fn


def model_with(m, **kw):
    m.update(kw)
    return m


def cases():
    out = {}

    def add(name, desc, m, outcome, codes, viol=None):
        out[name] = (desc, m, outcome, codes) + ((viol,) if viol else ())

    def reject(name, desc, m, codes, mut=None, viol=None, **extra):
        if mut:
            mut(m)
        m.update(extra)
        add(name, desc, m, "reject", codes, viol)

    def clocks_for(m, **sc):
        m["stream_clocks"] = sc

    D = "/stateaction/depth_events"
    CAL = "/stateaction/calibrations"
    MET = "/stateaction/camera_metadata"
    CL = "/stateaction/close"
    RAWT = "/camera/depth_raw/image"
    CONF = "/camera/depth_raw/confidence"

    # ------------------------------------------------------------ accept
    add(
        "v12_valid_calibration_only",
        "v1.2: one RGB calibration (640x480 source resized to the 64x48 saved raster), depth/camera metadata/mesh/point cloud declared unsupported, Close.v2 completed.",
        make(),
        "accept",
        [],
    )
    add(
        "v12_two_calibration_revisions_with_reset",
        "Two calibration revisions: rgb_0 for frames 0-2, a cropped+resized rgb_1 from frame 4 announced by a calibration_reset sensor event.",
        make(
            cals=(("rgb_0", 0), ("rgb_1", 4, (80, 0, 480, 480))),
            reset=(4, "rgb_1", "rgb_0"),
        ),
        "accept",
        [],
    )
    m = with_raw()
    add(
        "v12_depth_raw_unknown_mapping_reprojected",
        "Raw depth in its own clock domain with UNKNOWN native-to-capture mapping (acquisition-receipt time basis); equal native timestamps with distinct acquisition IDs and bytes are retained SDK reprojections/repeats; confidence separate, one frame unavailable; measurement association unknown.",
        m,
        "accept",
        [],
    )
    m = with_dense()
    add(
        "v12_depth_dense_measurement_linked",
        "Dense depth sharing the RGB native domain with exact timestamp equality: measurement_source_frame_id links the frames; no confidence plane (not provided by the source); different dimensions from raw depth.",
        m,
        "accept",
        [],
    )
    m = with_transport()
    add(
        "v12_depth_transport_mapping_clock_reset",
        "Raw depth in the recorder transport domain mapped by the declared fixed anchor, an explicit clock reset (epoch 1, timestamp regression kept verbatim) and a declared native-updates-only policy with 3 counted skips.",
        m,
        "accept",
        [],
    )
    add(
        "v12_camera_metadata_partial_unavailable",
        "Camera metadata for two frames: one reported with partly unavailable fields, one entirely unavailable (non-finite platform value, unknown timestamp).",
        make(meta=(camera_meta(0), camera_meta(1, reported=False))),
        "accept",
        [],
    )
    add(
        "v12_aborted_low_storage_clean",
        "Clean closed shorter take: aborted with stop_reason low_storage_reserve, every frame resolved, encoder drained. Valid evidence, never auto-admissible.",
        make(stop=("low_storage_reserve", "eos_reached", "aborted")),
        "accept",
        [],
    )
    add(
        "v12_aborted_encoder_deadline_unresolved",
        "User stop but the encoder missed the drain deadline: aborted, last frame unresolved, drain deadline_exceeded.",
        make(
            stop=("user_requested", "deadline_exceeded", "aborted"),
            unresolved_last=True,
        ),
        "accept",
        [],
    )
    add(
        "v12_failed_encoder_error",
        "Encoder failure: failed with failure_reason, stop_reason encoder_error, drain encoder_failed, last frame unresolved.",
        make(stop=("encoder_error", "encoder_failed", "failed"), unresolved_last=True),
        "accept",
        [],
    )
    m = make()
    m["v12"]["inventory_sensors"][3]["observed_count"] = None
    add(
        "v12_json_at_size_cap",
        "A JSON evidence message of exactly 65536 bytes (valid JSON padded with trailing whitespace) is accepted.",
        m,
        "accept",
        [],
    )
    m["raw_patch"] = lambda topic, n, data: (
        data + b" " * (65536 - len(data)) if topic == CL else data
    )

    # ------------------------------------------------------------ calibration rejects
    def drop_cal(m):
        m["v12"]["events"] = [e for e in m["v12"]["events"] if e[1] != CAL]
        m["v12"]["close"]["calibrations"] = "0"

    reject(
        "v12_calibration_values_missing",
        "Inventory declares rgb_0 state=yes but no Calibration message carries the values (no fabricated K/P).",
        make(),
        ["E_CALIBRATION_VALUES"],
        drop_cal,
    )
    base_cal = lambda m: evs(m, CAL)[0]  # noqa: E731

    def cal_edit(fn):
        def go(m):
            fn(base_cal(m))

        return go

    def p_not_k0(c):
        c["P"][3] = 1.0

    reject(
        "v12_calibration_p_not_k_zero",
        "P is not exactly [K | 0].",
        make(),
        ["E_CALIBRATION_VALUES"],
        cal_edit(p_not_k0),
    )

    def skew(c):
        c["K"][1] = 0.5
        fix_p(c)

    reject(
        "v12_calibration_k_skew",
        "K carries a nonzero skew term (not the canonical pinhole form).",
        make(),
        ["E_CALIBRATION_VALUES"],
        cal_edit(skew),
    )

    def mat(c):
        c["source_to_saved"]["matrix"][0] = 0.2

    reject(
        "v12_calibration_matrix_inconsistent",
        "source_to_saved.matrix disagrees with the declared crop/resize.",
        make(),
        ["E_CALIBRATION_VALUES"],
        cal_edit(mat),
    )

    def kmis(c):
        c["K"][0] += 0.001
        fix_p(c)

    reject(
        "v12_calibration_k_not_matrix_times_source",
        "K differs from matrix x source.K beyond 1e-9 relative tolerance.",
        make(),
        ["E_CALIBRATION_VALUES"],
        cal_edit(kmis),
    )

    def dims(c):
        c["saved_width"] = 65

    reject(
        "v12_calibration_saved_dims_mismatch",
        "saved_width disagrees with the resized raster (and the encoder).",
        make(),
        ["E_CALIBRATION_VALUES"],
        cal_edit(dims),
    )

    def crop_out(c):
        c["source_to_saved"]["crop"]["width"] = 641

    reject(
        "v12_calibration_crop_outside_source",
        "The crop extends beyond the source raster.",
        make(),
        ["E_CALIBRATION_VALUES"],
        cal_edit(crop_out),
    )

    def f32(c):
        c["source"]["K"][0] = 480.1
        k = c["K"]
        k[0] = 480.1 * c["source_to_saved"]["matrix"][0]
        fix_p(c)

    reject(
        "v12_calibration_float32_not_representable",
        "source.value_type is float32 but fx=480.1 is not a float32 value.",
        make(),
        ["E_CALIBRATION_VALUES"],
        cal_edit(f32),
    )

    def rot(c):
        c["source_to_saved"]["rotation_cw_degrees"] = 90

    reject(
        "v12_calibration_rotation_unsupported",
        "Rotated saved pixels are not supported in v1.2 (display rotation is not a pixel transform).",
        make(),
        ["E_SCHEMA_MALFORMED"],
        cal_edit(rot),
        viol=[f"{CAL}/source_to_saved/rotation_cw_degrees:const"],
    )

    def mir(c):
        c["source_to_saved"]["mirror_horizontal"] = True

    reject(
        "v12_calibration_mirror_unsupported",
        "Mirrored saved pixels are not supported in v1.2.",
        make(),
        ["E_SCHEMA_MALFORMED"],
        cal_edit(mir),
        viol=[f"{CAL}/source_to_saved/mirror_horizontal:const"],
    )

    def dist(c):
        c["distortion"]["assumed_model"] = "brown_conrady"

    reject(
        "v12_calibration_fake_distortion",
        "A distortion model is asserted although the source exposes none.",
        make(),
        ["E_SCHEMA_MALFORMED"],
        cal_edit(dist),
        viol=[f"{CAL}/distortion/assumed_model:const"],
    )

    def depth_stream(c):
        c["stream_id"] = "depth_raw"

    reject(
        "v12_calibration_depth_stream_values",
        "Calibration values for a depth stream: depth intrinsics are not supported in v1.2.",
        make(),
        ["E_SCHEMA_MALFORMED"],
        cal_edit(depth_stream),
        viol=[f"{CAL}/stream_id:const"],
    )

    def late(m):
        ev = m["v12"]["events"]
        i = next(i for i, e in enumerate(ev) if e[1] == CAL)
        ev[i] = (G.BASE_CAPTURE_NS + 1000, CAL, ev[i][2])

    reject(
        "v12_calibration_after_first_frame",
        "The Calibration message is written after the first FrameEvent that references it.",
        make(),
        ["E_CALIBRATION_ASSOCIATION"],
        late,
    )

    def first_ts(c):
        c["first_native_timestamp_ns"] = str(G.native(0) + 1)

    reject(
        "v12_calibration_first_frame_timestamp_mismatch",
        "first_native_timestamp_ns differs from the first acquired frame's original sensor timestamp.",
        make(),
        ["E_CALIBRATION_ASSOCIATION"],
        cal_edit(first_ts),
    )

    def first_clock(c):
        c["native_clock_id"] = "android.elapsed_realtime"

    reject(
        "v12_calibration_first_frame_clock_mismatch",
        "Calibration native_clock_id differs from the first acquired frame's clock.",
        make(),
        ["E_CALIBRATION_ASSOCIATION"],
        cal_edit(first_clock),
    )

    def unknown(c):
        c["calibration_id"] = "rgb_9"

    reject(
        "v12_calibration_unknown_id",
        "A Calibration message names an id the Inventory never declared.",
        make(),
        ["E_CALIBRATION_UNKNOWN", "E_CALIBRATION_VALUES"],
        cal_edit(unknown),
    )

    def dup(m):
        ev = m["v12"]["events"]
        c = next(e for e in ev if e[1] == CAL)
        ev.append((c[0] + 1, CAL, copy.deepcopy(c[2])))
        m["v12"]["close"]["calibrations"] = "2"

    reject(
        "v12_calibration_duplicate_message",
        "Two Calibration messages for one calibration_id.",
        make(),
        ["E_CALIBRATION_VALUES"],
        dup,
    )

    def unused_value(m):
        # a Calibration for rgb_1 although the Inventory says rgb_1 is unknown (values for unknown state)
        ev = m["v12"]["events"]
        ev.append((G.BASE_CAPTURE_NS + 4, CAL, calibration("rgb_1", 4)))
        m["v12"]["close"]["calibrations"] = "2"

    reject(
        "v12_calibration_values_for_unknown_state",
        "Calibration values supplied for rgb_1 although the Inventory declares it state=unknown (and no frame uses it).",
        make(),
        ["E_CALIBRATION_ASSOCIATION", "E_CALIBRATION_VALUES"],
        unused_value,
    )

    # ------------------------------------------------------------ numeric boundaries (all ports share these)
    def tol_edit(factor):
        def go(c):
            k = c["K"]
            k[0] = k[0] + factor * 1e-9 * max(1.0, abs(k[0]))
            fix_p(c)

        return go

    m = make()
    tol_edit(0.5)(evs(m, CAL)[0])
    add(
        "v12_calibration_k_within_tolerance",
        "K differs from matrix x source.K by half the 1e-9 relative tolerance: accepted.",
        m,
        "accept",
        [],
    )
    reject(
        "v12_calibration_k_beyond_tolerance",
        "K differs from matrix x source.K by 1.5x the 1e-9 relative tolerance: rejected.",
        make(),
        ["E_CALIBRATION_VALUES"],
        lambda m: tol_edit(1.5)(evs(m, CAL)[0]),
    )
    int64_max = 2**63 - 1
    edge = [
        dict(
            ts=int64_max - offset(),
            clock=TRANSPORT_CLOCK,
            basis="transport_mapping",
            rel="first",
            prov="new_estimate",
            acq=None,
            seed=0,
        )
    ]
    add(
        "v12_depth_capture_time_at_int64_max",
        "transport_mapping whose mapped capture time is exactly 9223372036854775807 (the int64 maximum): accepted.",
        make(depth={"depth_raw": edge}),
        "accept",
        [],
    )
    reject(
        "v12_depth_capture_time_overflow",
        "native timestamp + anchor offset exceeds int64; the event claims the clamped maximum. Readers must reject (never wrap or saturate).",
        make(depth={"depth_raw": copy.deepcopy(edge)}),
        ["E_CLOCK_MISMATCH"],
        mutate(D, 0, ["native_timestamp_ns"], str(int64_max - offset() + 1)),
    )

    def at_epoch_zero(timestamp):
        m = make(depth={"depth_raw": [{**edge[0], "ts": 0, "conf": "unavailable"}]})
        evs(m, D)[0]["capture_time_ns"] = "0"

        def patch_clocks(topic, _index, data):
            if topic != "/stateaction/clocks":
                return data
            clocks = json.loads(data)
            transport = clocks["recorder_transport"]
            transport["epoch_anchor_ns"] = transport["native_anchor_ns"]
            return G.jb(clocks)

        m["raw_patch"] = patch_clocks
        # Replace the explicit zero scalars with an empty Timestamp or omit the field.
        explicit_zero = G.field(1, b"\x08\x00\x10\x00")
        replace_image(
            RAWT,
            0,
            lambda d: (
                timestamp
                + raw_image(0, d["width"], d["height"], d["encoding"], d["data"])[
                    len(explicit_zero) :
                ]
            ),
        )(m)
        return m

    add(
        "v12_rawimage_epoch_zero",
        "Depth capture time zero with a present but empty RawImage Timestamp.",
        at_epoch_zero(G.field(1, b"")),
        "accept",
        [],
    )
    reject(
        "v12_rawimage_missing_timestamp",
        "Depth capture time zero with RawImage field 1 omitted.",
        at_epoch_zero(b""),
        ["E_MALFORMED_MESSAGE"],
    )

    strided = [
        dict(
            ts=D_RAW_BASE,
            rel="first",
            prov="new_estimate",
            acq="2",
            seed=4,
            w=6,
            h=4,
            nw=10,
            nh=8,
            crop=(2, 3),
            pstride=4,
            cpstride=2,
            pad=8,
            conf_ts=(D_RAW_BASE + 5_000, "arcore.confidence_timestamp"),
        ),
        dict(
            ts=D_RAW_BASE + 1,
            rel="advanced",
            prov="new_estimate",
            acq="2",
            seed=5,
            w=6,
            h=4,
            nw=6,
            nh=4,
            pad=4,
        ),
    ]
    add(
        "v12_depth_strided_cropped_planes",
        "Native 10x8 planes with pixel stride 4 (depth) / 2 (confidence) and row padding, cropped to the stored 6x4 region; the confidence carries its OWN native timestamp and clock (5 us after the depth timestamp), never assumed equal; a second event with row padding only.",
        make(depth={"depth_raw": strided}),
        "accept",
        [],
    )
    reject(
        "v12_depth_confidence_clock_undeclared",
        "A reported confidence clock that Clocks.stream_clocks does not declare as depth_raw_confidence.",
        make(depth={"depth_raw": copy.deepcopy(strided)}),
        ["E_CLOCK_MISMATCH"],
        lambda m: m["stream_clocks"].pop("depth_raw_confidence"),
    )
    reject(
        "v12_depth_crop_outside_native",
        "The recorded crop extends past the native plane.",
        make(depth={"depth_raw": copy.deepcopy(strided)}),
        ["E_DEPTH_EVIDENCE"],
        mutate(D, 0, ["depth", "crop"], {"x": 8, "y": 3, "width": 6, "height": 4}),
    )
    reject(
        "v12_depth_stored_dims_vs_crop",
        "stored dimensions disagree with the recorded crop.",
        make(depth={"depth_raw": copy.deepcopy(strided)}),
        ["E_DEPTH_EVIDENCE"],
        mutate(D, 0, ["depth", "stored_width"], 5),
    )
    reject(
        "v12_depth_row_stride_too_small",
        "native_row_stride_bytes is smaller than one native row.",
        make(depth={"depth_raw": copy.deepcopy(strided)}),
        ["E_DEPTH_EVIDENCE"],
        mutate(D, 0, ["depth", "native_row_stride_bytes"], 20),
    )
    reject(
        "v12_depth_pixel_stride_below_sample",
        "native_pixel_stride_bytes (1) is smaller than a 16-bit sample.",
        make(depth={"depth_raw": copy.deepcopy(strided)}),
        ["E_DEPTH_EVIDENCE"],
        mutate(D, 0, ["depth", "native_pixel_stride_bytes"], 1),
    )
    reject(
        "v12_depth_confidence_plane_differs",
        "The confidence plane's native dimensions differ from the depth plane's (the API guarantees the same size).",
        make(depth={"depth_raw": copy.deepcopy(strided)}),
        ["E_DEPTH_EVIDENCE"],
        mutate(D, 0, ["confidence", "native_width"], 12),
    )

    # ------------------------------------------------------------ depth rejects
    reject(
        "v12_depth_data_length_mismatch",
        "RawImage data is one row short of step*height.",
        with_raw(),
        ["E_DEPTH_EVIDENCE"],
        replace_image(
            RAWT,
            0,
            lambda d: raw_image(
                d["capture_ns"], d["width"], d["height"], d["encoding"], d["data"][:-16]
            ),
        ),
    )
    reject(
        "v12_depth_step_mismatch",
        "RawImage step is not width*2 for 16UC1 (and the data is sized to that step).",
        with_raw(),
        ["E_DEPTH_EVIDENCE"],
        replace_image(
            RAWT,
            0,
            lambda d: raw_image(
                d["capture_ns"],
                d["width"],
                d["height"],
                d["encoding"],
                d["data"] + b"\x00" * 12,
                step=18,
            ),
        ),
    )
    reject(
        "v12_depth_dimensions_vs_event",
        "RawImage width disagrees with the DepthEvent dimensions.",
        with_raw(),
        ["E_DEPTH_EVIDENCE"],
        replace_image(
            RAWT,
            0,
            lambda d: raw_image(d["capture_ns"], 4, 12, d["encoding"], d["data"]),
        ),
    )
    reject(
        "v12_depth_wrong_encoding",
        "Depth RawImage uses 32FC1 although v1.2 stores uint16 millimetres.",
        with_raw(),
        ["E_DEPTH_EVIDENCE"],
        replace_image(
            RAWT,
            0,
            lambda d: raw_image(
                d["capture_ns"], d["width"], d["height"], "32FC1", d["data"]
            ),
        ),
    )
    reject(
        "v12_depth_wrong_frame_id",
        "Depth RawImage frame_id is camera_optical_frame: no alignment with the RGB frame is claimed.",
        with_raw(),
        ["E_DEPTH_EVIDENCE"],
        replace_image(
            RAWT,
            0,
            lambda d: raw_image(
                d["capture_ns"],
                d["width"],
                d["height"],
                d["encoding"],
                d["data"],
                frame_id="camera_optical_frame",
            ),
        ),
    )
    reject(
        "v12_depth_timestamp_not_capture_time",
        "RawImage timestamp differs from the DepthEvent capture_time_ns.",
        with_raw(),
        ["E_DEPTH_EVIDENCE"],
        replace_image(
            RAWT,
            0,
            lambda d: raw_image(
                d["capture_ns"] + 1, d["width"], d["height"], d["encoding"], d["data"]
            ),
        ),
    )

    def orphan(m):
        m["v12"]["events"].append(
            (
                G.BASE_CAPTURE_NS + 9_999_999,
                RAWT,
                (99, raw_image(G.BASE_CAPTURE_NS, 8, 6, "16UC1", depth_plane(8, 6, 9))),
            )
        )

    reject(
        "v12_depth_orphan_image",
        "A RawImage on the depth channel that no DepthEvent references.",
        with_raw(),
        ["E_DEPTH_EVIDENCE"],
        orphan,
    )
    reject(
        "v12_depth_sequence_reused",
        "Two DepthEvents reference the same RawImage channel sequence.",
        with_raw(),
        ["E_DEPTH_EVIDENCE"],
        mutate(D, 1, ["depth", "output_sequence"], 0),
    )
    reject(
        "v12_depth_duplicate_event_id",
        "Two retained depth events share one acquisition ID.",
        with_raw(),
        ["E_DEPTH_EVIDENCE"],
        mutate(D, 1, ["event_id"], "0"),
    )

    def no_conf(m):
        m["v12"]["events"] = [e for e in m["v12"]["events"] if not (e[1] == CONF)][:]

    reject(
        "v12_depth_confidence_image_missing",
        "A DepthEvent declares a separate confidence image that is not in the file.",
        with_raw(),
        ["E_DEPTH_EVIDENCE"],
        no_conf,
    )
    reject(
        "v12_depth_confidence_dims_mismatch",
        "The confidence plane has different dimensions from the depth image.",
        with_raw(),
        ["E_DEPTH_EVIDENCE"],
        replace_image(
            CONF, 0, lambda d: raw_image(d["capture_ns"], 4, 12, "mono8", d["data"])
        ),
    )
    reject(
        "v12_depth_regression_without_reset",
        "A native timestamp regresses within one clock epoch (timestamps are never rewritten; a reset must be explicit).",
        with_raw(),
        ["E_DEPTH_CADENCE"],
        mutate(D, 3, ["native_timestamp_ns"], str(D_RAW_BASE)),
    )
    reject(
        "v12_depth_repeat_advertised_as_new",
        "A repeated native timestamp is advertised as a new depth estimate.",
        with_raw(),
        ["E_DEPTH_CADENCE"],
        mutate(D, 1, ["estimate_provenance"], "new_estimate"),
    )
    reject(
        "v12_depth_relation_mismatch",
        "timestamp_relation says advanced but the native timestamp equals the previous one.",
        with_raw(),
        ["E_DEPTH_CADENCE"],
        mutate(D, 1, ["timestamp_relation"], "advanced"),
    )
    reject(
        "v12_depth_api_repeat_on_advanced",
        "An api_repeat provenance on an event whose native timestamp advanced.",
        with_raw(),
        ["E_DEPTH_CADENCE"],
        mutate(D, 2, ["estimate_provenance"], "api_repeat"),
    )
    reject(
        "v12_depth_clock_reset_without_epoch",
        "A clock_reset relation without a clock_epoch increase.",
        with_transport(),
        ["E_DEPTH_CADENCE"],
        mutate(D, 2, ["clock_epoch"], 0),
    )
    reject(
        "v12_depth_native_updates_only_with_repeat",
        "The declared native-updates-only retention policy contradicts a retained repeated timestamp.",
        with_raw(),
        ["E_DEPTH_CADENCE"],
        close_set(["depth", "depth_raw", "retention_policy"], "native_updates_only"),
    )
    reject(
        "v12_depth_skips_without_policy",
        "skipped_repeats is nonzero although every returned image is retained.",
        with_raw(),
        ["E_DEPTH_CADENCE"],
        close_set(["depth", "depth_raw", "skipped_repeats"], "2"),
    )
    reject(
        "v12_depth_false_mapping_claim",
        "transport_mapping is claimed for a native clock that is not the recorder transport domain.",
        with_raw(),
        ["E_CLOCK_MISMATCH"],
        chain(
            *[
                mutate(D, i, ["capture_time_basis"], "transport_mapping")
                for i in range(4)
            ]
            + [mutate(D, i, ["receipt_native_timestamp_ns"], None) for i in range(4)]
        ),
    )
    reject(
        "v12_depth_capture_time_arithmetic",
        "capture_time_ns is not the declared anchor mapping of the receipt timestamp.",
        with_raw(),
        [
            "E_CLOCK_MISMATCH",
            "E_DEPTH_EVIDENCE",
        ],  # the RawImage timestamp no longer equals it either
        mutate(D, 0, ["capture_time_ns"], str(G.BASE_CAPTURE_NS + 1)),
    )
    reject(
        "v12_depth_receipt_missing",
        "acquisition_receipt basis without a receipt timestamp.",
        with_raw(),
        ["E_SCHEMA_MALFORMED"],
        mutate(D, 0, ["receipt_native_timestamp_ns"], None),
        viol=[f"{D}/receipt_native_timestamp_ns:type"],
    )
    reject(
        "v12_depth_mapping_revision_mismatch",
        "clock_mapping_revision differs from the declared recorder transport revision.",
        with_raw(),
        ["E_CLOCK_MISMATCH"],
        mutate(D, 0, ["clock_mapping_revision"], "other_revision_v1"),
    )
    m = with_raw()
    m["stream_clocks"] = {"depth_raw": RGB_CLOCK}
    reject(
        "v12_depth_stream_clock_mismatch",
        "Clocks.stream_clocks declares a different domain from the events' native_clock_id.",
        m,
        ["E_CLOCK_MISMATCH"],
    )
    reject(
        "v12_depth_measurement_timestamp_mismatch",
        "measurement_source_frame_id claims simultaneity with a frame whose native timestamp is different.",
        with_dense(),
        ["E_DEPTH_ASSOCIATION"],
        mutate(D, 0, ["measurement_source_frame_id"], "4"),
    )
    reject(
        "v12_depth_measurement_clock_mismatch",
        "measurement_source_frame_id claimed across different native clock domains.",
        with_raw(),
        ["E_DEPTH_ASSOCIATION"],
        mutate(D, 0, ["measurement_source_frame_id"], "0"),
    )
    reject(
        "v12_depth_acquisition_unknown_frame",
        "acquisition_source_frame_id names a frame that was never acquired.",
        with_raw(),
        ["E_DEPTH_ASSOCIATION"],
        mutate(D, 0, ["acquisition_source_frame_id"], "99"),
    )
    reject(
        "v12_depth_calibration_unknown",
        "A DepthEvent references a calibration the Inventory does not declare for that stream.",
        with_raw(),
        ["E_CALIBRATION_UNKNOWN"],
        mutate(D, 0, ["calibration_id"], "depth_0"),
    )
    reject(
        "v12_dense_with_separate_confidence",
        "A dense-depth event claims a separate confidence image (ARCore has none for dense depth).",
        with_dense(),
        ["E_SCHEMA_MALFORMED"],
        mutate(
            D,
            0,
            ["confidence"],
            {
                "state": "separate_image",
                "output_channel": "/camera/depth_raw/confidence",
                "output_sequence": 0,
                "encoding": "mono8",
                "units": "source_confidence_u8",
                "native_format": "arcore.raw_depth_confidence",
                "native_row_stride_bytes": 6,
            },
        ),
        viol=[f"{D}/confidence/state:enum", f"{D}/confidence:anyOf"],
    )
    reject(
        "v12_raw_kind_on_dense_stream",
        "The raw-depth source_kind on a dense stream (raw and dense are never conflated).",
        with_dense(),
        ["E_SCHEMA_MALFORMED"],
        mutate(D, 0, ["source_kind"], KIND_OF["depth_raw"]),
        viol=[f"{D}/source_kind:const"],
    )
    reject(
        "v12_inventory_depth_count_mismatch",
        "Inventory depth_raw observed_count disagrees with the retained events.",
        with_raw(),
        ["E_COUNT_MISMATCH"],
        lambda m: m["v12"]["inventory_sensors"][0].__setitem__("observed_count", "3"),
    )
    reject(
        "v12_inventory_depth_missing",
        "Depth events exist but the Inventory declares depth_raw unsupported.",
        with_raw(),
        ["E_COUNT_MISMATCH"],
        lambda m: m["v12"]["inventory_sensors"].__setitem__(
            0, sensor_entry("depth_raw", "depth")
        ),
    )
    reject(
        "v12_close_depth_count_mismatch",
        "Close.v2 depth_raw events disagree with the retained events.",
        with_raw(),
        ["E_COUNT_MISMATCH"],
        close_set(["depth", "depth_raw", "events"], "3"),
    )
    reject(
        "v12_close_distinct_timestamps_mismatch",
        "Close.v2 distinct_native_timestamps counts the retained images instead of the distinct measurements.",
        with_raw(),
        ["E_COUNT_MISMATCH"],
        close_set(["depth", "depth_raw", "distinct_native_timestamps"], "4"),
    )
    reject(
        "v12_close_confidence_count_mismatch",
        "Close.v2 confidence_images disagrees with the separate confidence images.",
        with_raw(),
        ["E_COUNT_MISMATCH"],
        close_set(["depth", "depth_raw", "confidence_images"], "4"),
    )

    # ------------------------------------------------------------ RawImage wire
    def wire(name, desc, codes, patch, base=with_raw):
        m = base()

        def rp(topic, seq, data):
            return patch(data) if topic == RAWT and seq == 0 else data

        m["raw_patch"] = rp
        add(name, desc, m, "reject", codes)

    wire(
        "v12_rawimage_truncated_fixed32",
        "The width fixed32 field is cut short (3 of 4 bytes remain).",
        ["E_MALFORMED_MESSAGE"],
        lambda d: d[: d.index(b"\x15") + 4],
    )
    wire(
        "v12_rawimage_length_overflow",
        "The data field declares a length far beyond the message.",
        ["E_MALFORMED_MESSAGE"],
        lambda d: d[: d.index(b"\x32")] + b"\x32" + G.varint(2**62) + b"\x00\x01",
    )
    wire(
        "v12_rawimage_unknown_field",
        "The message carries an undeclared field 8.",
        ["E_MALFORMED_MESSAGE"],
        lambda d: d + b"\x40\x01",
    )
    wire(
        "v12_rawimage_duplicate_field",
        "The width field appears twice.",
        ["E_MALFORMED_MESSAGE"],
        lambda d: d + b"\x15\x08\x00\x00\x00",
    )
    wire(
        "v12_rawimage_varint_width",
        "width is encoded as a varint instead of fixed32 (wrong wire type).",
        ["E_MALFORMED_MESSAGE"],
        lambda d: d.replace(b"\x15\x08\x00\x00\x00", b"\x10\x08", 1),
    )
    wire(
        "v12_rawimage_zero_dimension",
        "height is 0 (dimensions must be 1..4096).",
        ["E_MALFORMED_MESSAGE"],
        lambda d: d.replace(b"\x1d\x06\x00\x00\x00", b"\x1d\x00\x00\x00\x00", 1),
    )
    wire(
        "v12_rawimage_dimension_over_limit",
        "width is 4097 (dimensions must be 1..4096).",
        ["E_MALFORMED_MESSAGE"],
        lambda d: d.replace(b"\x15\x08\x00\x00\x00", b"\x15\x01\x10\x00\x00", 1),
    )
    wire(
        "v12_rawimage_nanos_out_of_range",
        "timestamp nanos is 1e9 (must be below 1e9).",
        ["E_MALFORMED_MESSAGE"],
        lambda d: bad_nanos(d),
    )

    def bad_nanos(d):
        # rewrite the leading timestamp sub-message with nanos = 1_000_000_000
        n = d[1]
        rest = d[2 + n :]
        stamp = (
            b"\x08"
            + G.varint(G.BASE_CAPTURE_NS // 10**9)
            + b"\x10"
            + G.varint(1_000_000_000)
        )
        return G.field(1, stamp) + rest

    # descriptor / dispatch / caps
    m = with_raw()
    m["channel_overrides"] = {RAWT: {"schema_data": b"tampered"}}
    add(
        "v12_rawimage_descriptor_hash",
        "The embedded foxglove.RawImage descriptor differs from the pinned bytes.",
        m,
        "reject",
        ["E_DESCRIPTOR_HASH"],
    )
    m = make()
    m["channel_overrides"] = {"/stateaction/capture_profile": {"schema_data": b"{}"}}
    add(
        "v12_profile_v2_schema_hash",
        "The embedded Profile.v2 schema differs from the reviewed bytes.",
        m,
        "reject",
        ["E_SCHEMA_MISMATCH"],
    )
    m = make()
    m["v12"]["close_schema"] = ("stateaction.capture.Close.v1", "Close.schema.json")
    add(
        "v12_profile_v2_with_close_v1",
        "Profile.v2 selects v1.2 but the Close channel is the v1 schema: v1.2 files never mix revisions.",
        m,
        "reject",
        ["E_CHANNEL_ENCODING"],
    )
    m = make()
    m["patch"] = G.topic_patch(
        "/stateaction/capture_profile",
        G.setp(["wire_contract_revision"], "stateaction.capture.v1.1"),
    )
    add(
        "v12_profile_v2_wrong_revision_const",
        "Profile.v2 carrying wire_contract_revision v1.1.",
        m,
        "reject",
        ["E_SCHEMA_MALFORMED"],
        ["/stateaction/capture_profile/wire_contract_revision:const"],
    )

    def json_over(m):
        m["raw_patch"] = lambda topic, n, data: (
            data + b" " * (65537 - len(data)) if topic == CL else data
        )

    m = make()
    json_over(m)
    add(
        "v12_json_over_size_cap",
        "A JSON evidence message of 65537 bytes exceeds the 64 KiB v1.2 cap before parsing.",
        m,
        "reject",
        ["E_MALFORMED_MESSAGE"],
    )

    # ------------------------------------------------------------ camera metadata, mesh, close
    reject(
        "v12_camera_metadata_unknown_frame",
        "Camera metadata names a source frame that was never acquired.",
        make(meta=(camera_meta(0),)),
        ["E_CAMERA_METADATA"],
        mutate(MET, 0, ["source_frame_id"], "99"),
    )
    reject(
        "v12_camera_metadata_duplicate",
        "Two camera metadata messages for one frame.",
        make(meta=(camera_meta(0), camera_meta(0))),
        ["E_CAMERA_METADATA"],
    )
    reject(
        "v12_camera_metadata_timestamp_mismatch",
        "Camera metadata native_timestamp_ns differs from the frame's.",
        make(meta=(camera_meta(0),)),
        ["E_CAMERA_METADATA"],
        mutate(MET, 0, ["native_timestamp_ns"], str(G.native(0) + 1)),
    )
    reject(
        "v12_camera_metadata_inventory_mismatch",
        "Inventory camera_metadata observed_count disagrees with the messages.",
        make(meta=(camera_meta(0),)),
        ["E_COUNT_MISMATCH"],
        lambda m: m["v12"]["inventory_sensors"][2].__setitem__("observed_count", "2"),
    )
    reject(
        "v12_camera_metadata_nan",
        "A JSON NaN where the platform value was non-finite (must be unavailable).",
        make(meta=(camera_meta(0),)),
        ["E_MALFORMED_MESSAGE"],
        None,
        raw_patch=lambda topic, n, data: (
            data.replace(b'"value":2.5', b'"value":NaN') if topic == MET else data
        ),
    )
    reject(
        "v12_mesh_observed_unsupported",
        "The Inventory claims observed mesh data although v1.2 has no mesh payload channel.",
        make(),
        ["E_UNSUPPORTED_STREAM"],
        lambda m: m["v12"]["inventory_sensors"].__setitem__(
            3, {**sensor_entry("mesh", "geometry", 5), "observed_count": "5"}
        ),
    )
    reject(
        "v12_point_cloud_enabled_unsupported",
        "point_cloud enabled=yes although nothing can be recorded for it.",
        make(),
        ["E_UNSUPPORTED_STREAM"],
        lambda m: m["v12"]["inventory_sensors"][4].update(enabled="yes"),
    )
    reject(
        "v12_close_completed_with_deadline_exceeded",
        "completed take with encoder_drain deadline_exceeded.",
        make(stop=("user_requested", "deadline_exceeded", "completed")),
        ["E_OUTCOME_MISMATCH"],
    )
    reject(
        "v12_close_completed_with_low_storage",
        "completed take stopped by low_storage_reserve (must be aborted or failed).",
        make(stop=("low_storage_reserve", "eos_reached", "completed")),
        ["E_OUTCOME_MISMATCH"],
    )
    reject(
        "v12_close_writer_error_not_failed",
        "stop_reason writer_error with outcome aborted.",
        make(stop=("writer_error", "eos_reached", "aborted")),
        ["E_OUTCOME_MISMATCH"],
    )
    reject(
        "v12_close_encoder_failed_not_failed",
        "encoder_drain encoder_failed with outcome aborted.",
        make(stop=("user_requested", "encoder_failed", "aborted")),
        ["E_OUTCOME_MISMATCH"],
    )
    reject(
        "v12_close_not_started_with_video",
        "encoder_drain not_started although frames were written.",
        make(stop=("user_requested", "not_started", "aborted")),
        ["E_OUTCOME_MISMATCH"],
    )
    reject(
        "v12_close_unknown_outcome_with_known_reason",
        "outcome unknown must carry stop_reason unknown.",
        make(stop=("user_requested", "eos_reached", "unknown")),
        ["E_OUTCOME_MISMATCH"],
    )
    reject(
        "v12_close_calibrations_count_mismatch",
        "Close.v2 calibrations disagrees with the Calibration messages.",
        make(),
        ["E_COUNT_MISMATCH"],
        close_set(["calibrations"], "2"),
    )
    reject(
        "v12_close_camera_metadata_count_mismatch",
        "Close.v2 camera_metadata disagrees with the messages.",
        make(meta=(camera_meta(0),)),
        ["E_COUNT_MISMATCH"],
        close_set(["camera_metadata"], "0"),
    )
    reject(
        "v12_close_stop_reason_unknown_value",
        "stop_reason outside the declared enum.",
        make(),
        ["E_SCHEMA_MALFORMED"],
        close_set(["stop_reason"], "operator_cancelled"),
        viol=[f"{CL}/stop_reason:enum"],
    )
    return out


def v11_new_topic_case():
    """A v1.1 file (Profile.v1) with an extra v1.2 topic: frozen readers never extend their table."""
    m = G.model()
    m["v12_downgrade"] = True
    return m


def generate(g):
    global G, cc
    G, cc = g, g.cc
    gold = g.GOLD / "v1.2"
    (gold / "expected").mkdir(parents=True, exist_ok=True)
    import capture_conformance  # noqa: F401

    index = {}
    models = {}
    declared = cases()
    for name, (desc, m, expect, codes, *viol) in declared.items():
        data = render(m)
        (gold / f"{name}.mcap").write_bytes(data)
        models[name] = m
        index[name] = {
            "description": desc,
            "expect": expect,
            "expected_errors": sorted(codes),
            "sha256": cc.sha256(data),
        }
        if viol:
            index[name]["expected_violations"] = sorted(viol[0])
    # revision-dispatch cases built from raw v1.1 bytes
    for name, desc, data, codes, viol in extra_cases():
        (gold / f"{name}.mcap").write_bytes(data)
        index[name] = {
            "description": desc,
            "expect": "reject",
            "expected_errors": sorted(codes),
            "sha256": cc.sha256(data),
        }
        if viol:
            index[name]["expected_violations"] = sorted(viol)
    for name, entry in sorted(index.items()):
        data = (gold / f"{name}.mcap").read_bytes()
        result = cc.check(data)
        assert result["outcome"] == entry["expect"], (
            name,
            result["outcome"],
            result["errors"],
            result["facts"].get("schema_violations"),
        )
        assert result["errors"] == entry["expected_errors"], (
            name,
            result["errors"],
            entry["expected_errors"],
        )
        got_v = sorted(
            re.sub(r"\[[0-9]+\]", "", v, count=1)
            for v in result["facts"].get("schema_violations", [])
        )
        assert got_v == entry.get("expected_violations", []), (name, got_v)
        (gold / "expected" / f"{name}.json").write_text(cc.canonical(result))
        old = cc.check(data, max_revision="v1.1")
        assert old["outcome"] == "reject", (name, old)
        entry["v1_1_reader"] = {"outcome": old["outcome"], "errors": old["errors"]}
    (gold / "cases.json").write_text(json.dumps(index, indent=2, sort_keys=True) + "\n")
    for n, e in sorted(index.items()):
        print(n, e["expect"], e["expected_errors"])
    write_fixtures()


def render(m):
    return G.render(m)


def extra_cases():
    """Revision-dispatch rejects derived from valid v1.1 / v1.2 bytes."""
    out = []
    # unknown future profile revision: Profile.v3 falls through to the v1.1 table and rejects
    base = (G.GOLD / "v1.2" / "v12_valid_calibration_only.mcap").read_bytes()
    v3 = base.replace(
        b"stateaction.capture.Profile.v2", b"stateaction.capture.Profile.v3"
    )
    assert v3 != base and len(v3) == len(base)
    v3 = G.mcap_rebuild(G.mcap_records(v3))
    out.append(
        (
            "v12_profile_unknown_future_revision",
            "A Profile.v3 schema record: unknown revisions reject (the v1.1 table applies, so the v1.2 Close.v2 channel and payload are foreign to it).",
            v3,
            ["E_CHANNEL_ENCODING", "E_SCHEMA_MALFORMED"],
            [
                "/stateaction/capture_profile/wire_contract_revision:const",
                "/stateaction/close:additionalProperties",
            ],
        )
    )
    # a v1.1 file that adds a v1.2 topic: frozen readers never extend their channel table
    records = G.mcap_records((G.GOLD / "valid.mcap").read_bytes())
    first = next(i for i, (op, _) in enumerate(records) if op == cc.OP_MESSAGE)
    schema_body = (
        struct.pack("<H", 99)
        + G.s("stateaction.capture.Calibration.v1")
        + G.s("jsonschema")
        + struct.pack("<I", len((G.CAP / "Calibration.schema.json").read_bytes()))
        + (G.CAP / "Calibration.schema.json").read_bytes()
    )
    channel_body = (
        struct.pack("<HH", 99, 99)
        + G.s("/stateaction/calibrations")
        + G.s("json")
        + struct.pack("<I", 0)
    )
    records[first:first] = [(cc.OP_SCHEMA, schema_body), (cc.OP_CHANNEL, channel_body)]
    out.append(
        (
            "v12_new_topic_under_v1_1",
            "A Profile.v1 (v1.1) file that declares the v1.2 /stateaction/calibrations channel: the v1.1 channel table is exact.",
            G.mcap_rebuild(records),
            ["E_CHANNEL_ENCODING"],
            None,
        )
    )
    return out


# ---------------------------------------------------------------- direct fixtures
def schema_cases():
    """Direct interpreter cases for the new schemas; violations are declared by hand (verify.py also
    requires identical results from jsonschema)."""
    P, CLS, CAL, DEP, META = (
        "stateaction.capture.Profile.v2",
        "stateaction.capture.Close.v2",
        "stateaction.capture.Calibration.v1",
        "stateaction.capture.DepthEvent.v1",
        "stateaction.capture.CameraMetadata.v1",
    )
    sample = make(
        depth={"depth_raw": copy.deepcopy(SPEC_RAW), "depth_dense": dense_specs()},
        meta=(camera_meta(0), camera_meta(1, reported=False)),
    )
    cal = copy.deepcopy(evs(sample, "/stateaction/calibrations")[0])
    dep = evs(sample, "/stateaction/depth_events")
    raw0 = copy.deepcopy(next(d for d in dep if d["stream_id"] == "depth_raw"))
    dense0 = copy.deepcopy(next(d for d in dep if d["stream_id"] == "depth_dense"))
    meta0 = copy.deepcopy(evs(sample, "/stateaction/camera_metadata")[0])
    meta1 = copy.deepcopy(evs(sample, "/stateaction/camera_metadata")[1])
    close = {
        "recording_id": G.REC,
        "outcome": "completed",
        "frames": {
            k: "1"
            for k in ("acquired", "submitted", "written", "dropped", "unresolved")
        },
        "video_messages": "1",
        "motion_events": {"accel": "2", "gyro": "2"},
        "sensor_events": "2",
        "drops": [],
        **sample["v12"]["close"],
    }
    profile = {
        "capture_schema": "stateaction.capture.v1",
        "rgb_profile": "h264_mcap_v1",
        "recording_id": G.REC,
        "wire_contract_revision": "stateaction.capture.v1.2",
        "production_qualified": False,
        "qualification": "unqualified",
        "encoder_time_base": {"numerator": 1, "denominator": 1000000},
        "limits": {"pending_frames": 4},
    }

    def edit(base, *path_value):
        out = copy.deepcopy(base)
        for path, value in zip(path_value[::2], path_value[1::2]):
            node = out
            for k in path[:-1]:
                node = node[k]
            if value is DELETE:
                node.pop(path[-1])
            else:
                node[path[-1]] = value
        return out

    cases = []

    def add(name, schema, value, expect):
        cases.append(
            {
                "name": name,
                "schema": schema,
                "json": json.dumps(value, separators=(",", ":"), sort_keys=True),
                "expect": sorted(expect),
            }
        )

    add("profile_v2_valid", P, profile, [])
    add(
        "profile_v2_old_revision",
        P,
        edit(profile, ["wire_contract_revision"], "stateaction.capture.v1.1"),
        ["/wire_contract_revision:const"],
    )
    add("close_v2_valid", CLS, close, [])
    add("close_v2_missing_depth", CLS, edit(close, ["depth"], DELETE), [":required"])
    add(
        "close_v2_bad_stop_reason",
        CLS,
        edit(close, ["stop_reason"], "cancelled"),
        ["/stop_reason:enum"],
    )
    add(
        "close_v2_bad_drain",
        CLS,
        edit(close, ["encoder_drain"], "stalled"),
        ["/encoder_drain:enum"],
    )
    add(
        "close_v2_bad_policy",
        CLS,
        edit(close, ["depth", "depth_raw", "retention_policy"], "sometimes"),
        ["/depth/depth_raw/retention_policy:enum"],
    )
    add(
        "close_v2_dense_confidence_count",
        CLS,
        edit(close, ["depth", "depth_dense", "confidence_images"], "0"),
        ["/depth/depth_dense:additionalProperties"],
    )
    add(
        "close_v2_count_not_decimal",
        CLS,
        edit(close, ["calibrations"], "01"),
        ["/calibrations:pattern"],
    )
    add("calibration_valid", CAL, cal, [])
    add("calibration_k_short", CAL, edit(cal, ["K"], cal["K"][:8]), ["/K:minItems"])
    add("calibration_k_long", CAL, edit(cal, ["K"], cal["K"] + [0.0]), ["/K:maxItems"])
    add("calibration_p_short", CAL, edit(cal, ["P"], cal["P"][:11]), ["/P:minItems"])
    add(
        "calibration_k_over_bound",
        CAL,
        edit(cal, ["K", 0], 1_000_000_001),
        ["/K/0:maximum"],
    )
    add("calibration_k_string", CAL, edit(cal, ["K", 0], "48"), ["/K/0:type"])
    add(
        "calibration_saved_width_zero",
        CAL,
        edit(cal, ["saved_width"], 0),
        ["/saved_width:minimum"],
    )
    add(
        "calibration_saved_width_over",
        CAL,
        edit(cal, ["saved_width"], 16385),
        ["/saved_width:maximum"],
    )
    add(
        "calibration_rotation",
        CAL,
        edit(cal, ["source_to_saved", "rotation_cw_degrees"], 90),
        ["/source_to_saved/rotation_cw_degrees:const"],
    )
    add(
        "calibration_mirror",
        CAL,
        edit(cal, ["source_to_saved", "mirror_horizontal"], True),
        ["/source_to_saved/mirror_horizontal:const"],
    )
    add(
        "calibration_depth_stream",
        CAL,
        edit(cal, ["stream_id"], "depth_raw"),
        ["/stream_id:const"],
    )
    add(
        "calibration_unknown_key",
        CAL,
        edit(cal, ["extrinsics"], [0]),
        [":additionalProperties"],
    )
    add(
        "calibration_missing_distortion",
        CAL,
        edit(cal, ["distortion"], DELETE),
        [":required"],
    )
    add(
        "calibration_crop_negative",
        CAL,
        edit(cal, ["source_to_saved", "crop", "left"], -1),
        ["/source_to_saved/crop/left:minimum"],
    )
    add(
        "calibration_value_type",
        CAL,
        edit(cal, ["source", "value_type"], "float16"),
        ["/source/value_type:enum"],
    )
    add(
        "calibration_non_uuid",
        CAL,
        edit(cal, ["recording_id"], "x"),
        ["/recording_id:pattern"],
    )
    add("depth_raw_valid", DEP, raw0, [])
    add("depth_dense_valid", DEP, dense0, [])
    add(
        "depth_epoch_negative",
        DEP,
        edit(raw0, ["clock_epoch"], -1),
        ["/clock_epoch:minimum"],
    )
    add(
        "depth_epoch_over_uint32",
        DEP,
        edit(raw0, ["clock_epoch"], 4294967296),
        ["/clock_epoch:maximum"],
    )
    add(
        "depth_relation_unknown",
        DEP,
        edit(raw0, ["timestamp_relation"], "unchanged"),
        ["/timestamp_relation:enum"],
    )
    add(
        "depth_provenance_unknown",
        DEP,
        edit(raw0, ["estimate_provenance"], "duplicated"),
        ["/estimate_provenance:enum"],
    )
    add(
        "depth_dense_raw_kind",
        DEP,
        edit(dense0, ["source_kind"], KIND_OF["depth_raw"]),
        ["/source_kind:const"],
    )
    add(
        "depth_raw_dense_kind",
        DEP,
        edit(raw0, ["source_kind"], KIND_OF["depth_dense"]),
        ["/source_kind:const"],
    )
    add(
        "depth_raw_dense_channel",
        DEP,
        edit(raw0, ["depth", "output_channel"], "/camera/depth_dense/image"),
        ["/depth/output_channel:const"],
    )
    add(
        "depth_receipt_missing",
        DEP,
        edit(raw0, ["receipt_native_timestamp_ns"], None),
        ["/receipt_native_timestamp_ns:type"],
    )
    add(
        "depth_transport_with_receipt",
        DEP,
        edit(raw0, ["capture_time_basis"], "transport_mapping"),
        ["/receipt_native_timestamp_ns:type"],
    )
    add(
        "depth_encoding_32fc1",
        DEP,
        edit(raw0, ["depth", "encoding"], "32FC1"),
        ["/depth/encoding:const"],
    )
    add(
        "depth_legacy_format",
        DEP,
        edit(raw0, ["depth", "native_format"], "android.graphics.ImageFormat.DEPTH16"),
        ["/depth/native_format:const"],
    )
    add(
        "depth_units_metre",
        DEP,
        edit(raw0, ["depth", "units"], "metre"),
        ["/depth/units:const"],
    )
    add(
        "depth_big_endian",
        DEP,
        edit(raw0, ["depth", "byte_order"], "big"),
        ["/depth/byte_order:const"],
    )
    add(
        "depth_stored_width_over",
        DEP,
        edit(raw0, ["depth", "stored_width"], 4097),
        ["/depth/stored_width:maximum"],
    )
    add(
        "depth_stored_height_zero",
        DEP,
        edit(raw0, ["depth", "stored_height"], 0),
        ["/depth/stored_height:minimum"],
    )
    add(
        "depth_native_width_over",
        DEP,
        edit(raw0, ["depth", "native_width"], 16385),
        ["/depth/native_width:maximum"],
    )
    add(
        "depth_pixel_stride_over",
        DEP,
        edit(raw0, ["depth", "native_pixel_stride_bytes"], 17),
        ["/depth/native_pixel_stride_bytes:maximum"],
    )
    add(
        "depth_row_stride_over",
        DEP,
        edit(raw0, ["depth", "native_row_stride_bytes"], 16777217),
        ["/depth/native_row_stride_bytes:maximum"],
    )
    add(
        "depth_crop_negative",
        DEP,
        edit(raw0, ["depth", "crop"], {"x": -1, "y": 0, "width": 4, "height": 4}),
        ["/depth/crop:anyOf"],
    )
    add(
        "depth_crop_extra_key",
        DEP,
        edit(
            raw0, ["depth", "crop"], {"x": 0, "y": 0, "width": 4, "height": 4, "z": 0}
        ),
        ["/depth/crop:anyOf"],
    )
    add(
        "depth_dense_separate_confidence",
        DEP,
        edit(dense0, ["confidence"], raw0["confidence"]),
        ["/confidence/state:enum"],
    )
    add(
        "depth_confidence_no_native_timestamp",
        DEP,
        edit(raw0, ["confidence", "native_timestamp"], DELETE),
        ["/confidence:anyOf"],
    )
    add(
        "depth_confidence_bad_timestamp_state",
        DEP,
        edit(raw0, ["confidence", "native_timestamp", "state"], "assumed_equal"),
        ["/confidence:anyOf"],
    )
    add(
        "depth_unknown_key",
        DEP,
        edit(raw0, ["verified_alignment"], True),
        [":additionalProperties"],
    )
    add(
        "depth_event_id_leading_zero",
        DEP,
        edit(raw0, ["event_id"], "01"),
        ["/event_id:pattern"],
    )
    add("camera_metadata_valid", META, meta0, [])
    add("camera_metadata_unavailable_valid", META, meta1, [])
    add(
        "camera_metadata_iso_over",
        META,
        edit(meta0, ["sensitivity_iso", "value"], 1_000_001),
        ["/sensitivity_iso:anyOf"],
    )
    add(
        "camera_metadata_unavailable_without_reason",
        META,
        edit(meta0, ["exposure_time_ns"], {"state": "unavailable"}),
        ["/exposure_time_ns:anyOf"],
    )
    add(
        "camera_metadata_focus_negative",
        META,
        edit(meta0, ["focus_distance_diopters", "value"], -1),
        ["/focus_distance_diopters:anyOf"],
    )
    add(
        "camera_metadata_stream",
        META,
        edit(meta0, ["stream_id"], "depth_raw"),
        ["/stream_id:const"],
    )
    add(
        "camera_metadata_missing_timestamp_key",
        META,
        edit(meta0, ["native_timestamp_ns"], DELETE),
        [":required"],
    )
    return {
        "description": "Direct strict-schema cases for the stateaction.capture.v1.2 schemas (SA-68). Violations are declared by hand: <instance pointer>:<keyword>.",
        "cases": cases,
    }


def raw_image_cases():
    """Direct foxglove.RawImage decode cases: hex for small messages, `build` recipes for the cap
    boundaries (so no 16 MiB file is committed). Every port must reach the same verdict and facts."""
    cap = G.cc.RAW_DATA_MAX
    ts = G.varint

    def msg(
        width=8,
        height=6,
        encoding="16UC1",
        data=None,
        step=None,
        frame_id="depth_optical_frame",
        sec=1_800_000_000,
        nanos=7,
        extra=b"",
        fixed=None,
    ):
        data = bytes(range(8 * 6 * 2)) if data is None else data
        step = 16 if step is None else step
        stamp = b"\x08" + ts(sec) + b"\x10" + ts(nanos)
        w = struct.pack("<I", width)
        return (
            G.field(1, stamp)
            + b"\x15"
            + w
            + b"\x1d"
            + struct.pack("<I", height)
            + G.field(4, encoding.encode())
            + b"\x2d"
            + struct.pack("<I", step)
            + G.field(6, data)
            + G.field(7, frame_id.encode())
            + extra
        )

    good = msg()
    out = []

    def hexcase(name, data, expect):
        out.append({"name": name, "hex": data.hex(), "expect": expect})

    hexcase("ok_depth_8x6", good, "ok")
    hexcase("ok_one_by_one", msg(1, 1, "mono8", b"\x07", 1), "ok")
    hexcase("ok_dimension_4096", msg(4096, 4096, "mono8", b"", 4096), "ok")
    hexcase("bad_width_zero", msg(0), "malformed")
    hexcase("bad_height_zero", msg(8, 0), "malformed")
    hexcase("bad_width_4097", msg(4097), "malformed")
    hexcase("bad_height_4097", msg(8, 4097), "malformed")
    hexcase("bad_empty_message", b"", "malformed")
    hexcase("bad_truncated_fixed32", good[: good.index(b"\x15") + 4], "malformed")
    hexcase("bad_fixed32_missing", good[: good.index(b"\x15") + 1], "malformed")
    hexcase(
        "bad_length_overflow",
        good[: good.index(b"\x32")] + b"\x32" + G.varint(2**62) + b"\x00",
        "malformed",
    )
    hexcase(
        "bad_length_just_past_end",
        good[: good.index(b"\x32")] + b"\x32" + G.varint(len(good)) + b"\x00",
        "malformed",
    )
    hexcase("bad_unknown_field", msg(extra=b"\x40\x01"), "malformed")
    hexcase("bad_field_zero", msg(extra=b"\x00\x01"), "malformed")
    hexcase("bad_duplicate_width", msg(extra=b"\x15\x08\x00\x00\x00"), "malformed")
    hexcase(
        "bad_width_varint_wire",
        good.replace(b"\x15\x08\x00\x00\x00", b"\x10\x08", 1),
        "malformed",
    )
    hexcase("bad_group_wire_type", msg(extra=b"\x0b"), "malformed")
    hexcase("bad_nanos_1e9", msg(nanos=1_000_000_000), "malformed")
    hexcase("bad_seconds_2_63", msg(sec=2**63), "malformed")
    hexcase("ok_seconds_int64_max", msg(sec=2**63 - 1, nanos=999_999_999), "ok")
    hexcase(
        "bad_varint_11_bytes", msg(extra=b"\x38" + b"\xff" * 10 + b"\x01"), "malformed"
    )
    hexcase(
        "bad_encoding_invalid_utf8", good.replace(b"16UC1", b"16\xffC1", 1), "malformed"
    )
    hexcase("bad_truncated_varint_tail", good + b"\x80", "malformed")
    out.append(
        {
            "name": "ok_data_at_cap",
            "build": {
                "width": 4096,
                "height": 2048,
                "encoding": "16UC1",
                "step": 8192,
                "data_len": cap,
                "fill": 0,
            },
            "expect": "ok",
        }
    )
    out.append(
        {
            "name": "bad_data_over_cap",
            "build": {
                "width": 4096,
                "height": 2048,
                "encoding": "16UC1",
                "step": 8192,
                "data_len": cap + 1,
                "fill": 0,
            },
            "expect": "malformed",
        }
    )

    def total(extra_id):
        return len(msg(4096, 2048, "16UC1", bytes(cap), 8192, "x" * extra_id))

    base = total(0)
    n = G.cc.RAW_MESSAGE_MAX - base
    while total(n) > G.cc.RAW_MESSAGE_MAX:
        n -= 1
    while total(n + 1) <= G.cc.RAW_MESSAGE_MAX:
        n += 1
    assert total(n) == G.cc.RAW_MESSAGE_MAX
    out.append(
        {
            "name": "ok_message_at_cap",
            "build": {
                "width": 4096,
                "height": 2048,
                "encoding": "16UC1",
                "step": 8192,
                "data_len": cap,
                "fill": 0,
                "frame_id_len": n,
            },
            "expect": "ok",
        }
    )
    out.append(
        {
            "name": "bad_message_over_cap",
            "build": {
                "width": 4096,
                "height": 2048,
                "encoding": "16UC1",
                "step": 8192,
                "data_len": cap,
                "fill": 0,
                "frame_id_len": n + 1,
            },
            "expect": "malformed",
        }
    )
    return {
        "description": "Direct foxglove.RawImage decode cases for the v1.2 readers (SA-68). Fields: timestamp=1 (seconds varint, nanos varint), width=2/height=3/step=5 (fixed32), encoding=4, data=6, frame_id=7. `build` recipes: fields in canonical order, data = data_len bytes of `fill`, frame_id = 'depth_optical_frame' or frame_id_len copies of 'x', timestamp 1800000000 s + 7 ns. Verdict `malformed` = E_MALFORMED_MESSAGE.",
        "data_cap_bytes": cap,
        "message_cap_bytes": G.cc.RAW_MESSAGE_MAX,
        "cases": out,
    }


def build_raw(recipe: dict) -> bytes:
    frame_id = (
        "x" * recipe["frame_id_len"]
        if "frame_id_len" in recipe
        else "depth_optical_frame"
    )
    stamp = b"\x08" + G.varint(1_800_000_000) + b"\x10" + G.varint(7)
    return (
        G.field(1, stamp)
        + b"\x15"
        + struct.pack("<I", recipe["width"])
        + b"\x1d"
        + struct.pack("<I", recipe["height"])
        + G.field(4, recipe["encoding"].encode())
        + b"\x2d"
        + struct.pack("<I", recipe["step"])
        + G.field(6, bytes([recipe["fill"]]) * recipe["data_len"])
        + G.field(7, frame_id.encode())
    )


def write_fixtures():
    fx = G.CAP / "fixtures"
    for name, doc in (
        ("schema_cases.v1.2.json", schema_cases()),
        ("raw_image_cases.v1.2.json", raw_image_cases()),
    ):
        (fx / name).write_text(json.dumps(doc, indent=2) + "\n")
