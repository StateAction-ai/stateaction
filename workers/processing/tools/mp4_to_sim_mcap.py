#!/usr/bin/env python3
"""Convert an MP4 into a labelled `h264_mcap_simulation_v1` MCAP (SA-86).

    uv run --project workers/processing python workers/processing/tools/mp4_to_sim_mcap.py \\
        SOURCE.mp4 OUT.mcap [--reencode auto|never|always] [--camera-label WGO-Bench]

Writes `OUT.mcap`, `OUT.simulation.json` (the `artifacts.simulation-provenance.v1` marker) and
`OUT.conversion.json` (how the access units were produced). One Annex B access unit per MCAP video
message, in presentation order, one source frame id per frame.

Truthfulness rules (nothing is fabricated):
* qualification is `simulation_only`, mapped timeline `simulation_transport_only`; never hardware.
* camera provenance is the public dataset label, encoder and clock provenance are `unknown`.
* the native clock domain is `mp4.container_pts` and the mapped time is the container PTS plus a fixed
  1 s anchor. The contract's `recorder_transport` object only admits `android.elapsed_realtime`; it is
  written with status `unverified` and no uncertainty, and means nothing for an MP4. The contract has
  no slot for a container timestamp except `native_timestamps.metadata_sensor_timestamp_ns`, so that
  key carries the container PTS; it is not a sensor timestamp. Calibration is `unknown`; no IMU, pose,
  depth or sensor events are written (inventory lists only the rgb stream).
* the capture contract refuses B-frames. An MP4 whose access units already satisfy the contract is
  remuxed bit-exactly (`h264_mp4toannexb`). Otherwise (`auto`) it is decoded and re-encoded with
  libx264 (no B-frames, SPS/PPS on every IDR, one packet per frame): the frame count and order are
  preserved, the pixels are not byte-identical, and `conversion.json` records `transcoded: true`.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
import sys
import uuid
from dataclasses import dataclass, field
from fractions import Fraction
from pathlib import Path

TOOLS = Path(__file__).resolve().parent
sys.path.insert(
    0, str(TOOLS.parent / "tests")
)  # indexed_fixture: the test-only MCAP chunk writer

from indexed_fixture import build, s  # noqa: E402

from stateaction_processing import contract  # noqa: E402

CONVERTER_VERSION = "sa86-mp4-to-sim-mcap-1"
SIM_PROFILE = "h264_mcap_simulation_v1"
NATIVE_CLOCK = "mp4.container_pts"
CLOCK_REVISION = "mp4_pts_to_fixed_anchor_v1"
EPOCH_ANCHOR_NS = (
    1_000_000_000  # fixed anchor: native 0 maps to 1 s; not a wall-clock time
)
PRE_LEAD_NS = 1_000_000
VIDEO_CHANNEL = "/camera/rgb/video"
UUID_NAMESPACE = uuid.UUID("5a1d86c3-0b2e-5d4a-9b7c-3f1e8a2d6c40")
X264_PARAMS = "bframes=0:keyint=30:min-keyint=30:scenecut=0:repeat-headers=1:aud=0:threads=1:annexb=1"
X264_OPTIONS = {"preset": "veryfast", "crf": "23", "x264-params": X264_PARAMS}
TB_US = {"numerator": 1, "denominator": 1_000_000}

# (topic, schema name, schema encoding, schema file, message encoding): the reviewed SA-50 channel
# table in golden order, so the definitions are byte-identical to the committed golden MCAPs.
CHANNELS = (
    (
        "/stateaction/capture_profile",
        "stateaction.capture.Profile.v1",
        "jsonschema",
        "Profile.schema.json",
        "json",
    ),
    (
        "/stateaction/clocks",
        "stateaction.capture.Clocks.v1",
        "jsonschema",
        "Clocks.schema.json",
        "json",
    ),
    (
        "/stateaction/inventory",
        "stateaction.capture.Inventory.v1",
        "jsonschema",
        "Inventory.schema.json",
        "json",
    ),
    (
        "/stateaction/frame_events",
        "stateaction.capture.FrameEvent.v1",
        "jsonschema",
        "FrameEvent.schema.json",
        "json",
    ),
    (
        "/stateaction/imu/accel",
        "stateaction.capture.MotionEvent.v1",
        "jsonschema",
        "MotionEvent.schema.json",
        "json",
    ),
    (
        "/stateaction/imu/gyro",
        "stateaction.capture.MotionEvent.v1",
        "jsonschema",
        "MotionEvent.schema.json",
        "json",
    ),
    (
        "/stateaction/sensor_events",
        "stateaction.capture.SensorEvent.v1",
        "jsonschema",
        "SensorEvent.schema.json",
        "json",
    ),
    (
        "/stateaction/close",
        "stateaction.capture.Close.v1",
        "jsonschema",
        "Close.schema.json",
        "json",
    ),
    (
        VIDEO_CHANNEL,
        "foxglove.CompressedVideo",
        "protobuf",
        "foxglove-compressed-video.desc",
        "protobuf",
    ),
    (
        "/tracking/pose",
        "geometry_msgs/msg/PoseStamped",
        "ros2msg",
        "geometry_msgs-PoseStamped.ros2msg",
        "cdr",
    ),
)


class ConvertError(ValueError):
    pass


@dataclass
class AccessUnit:
    data: bytes
    pts_ns: int  # relative to the first frame (first == 0)
    is_idr: bool = False

    @property
    def pts_us(self) -> int:
        return round(self.pts_ns / 1000)


@dataclass
class Source:
    units: list[AccessUnit]
    width: int
    height: int
    fps: int | None
    h264_profile: str
    info: dict[str, object] = field(default_factory=dict)


# --------------------------------------------------------------------------- access units
def _profile_name(first_idr: bytes) -> str:
    ref = contract.reference()
    nals = ref.nals(first_idr) or []
    sps = next((n for n in nals if n[0] & 31 == 7), None)
    if sps is None:
        raise ConvertError("E_NO_SPS: the first access unit carries no SPS")
    idc = sps[1]
    if idc == 66:
        return "baseline"
    if idc == 77:
        return "main"
    if idc == 100:
        return "high"
    raise ConvertError(f"E_PROFILE: unsupported H.264 profile_idc {idc}")


def _int_fps(rate: object) -> int | None:
    """Integral frame rate, else None (never rounded)."""
    if rate is None:
        return None
    f = Fraction(rate.numerator, rate.denominator)  # type: ignore[attr-defined]
    return int(f) if f.denominator == 1 else None


def _check_units(units: list[AccessUnit]) -> list[str]:
    """Contract problems of the access units (empty list: the contract reader will accept them)."""
    ref = contract.reference()
    problems: list[str] = []
    last_us = -1
    for i, u in enumerate(units):
        errors, idr = ref.classify_au(u.data)
        u.is_idr = idr
        if errors:
            problems.append(f"frame {i}: {','.join(errors)}")
        if u.pts_us <= last_us:
            problems.append(f"frame {i}: non-increasing PTS")
        last_us = u.pts_us
    if units and not units[0].is_idr:
        problems.append("first access unit is not an IDR")
    return problems[:8]


def _remux(path: Path) -> Source | list[str]:
    import av
    from av.bitstream import BitStreamFilterContext

    units: list[AccessUnit] = []
    with av.open(str(path), options={"err_detect": "explode"}) as c:
        st = c.streams.video[0]
        bsf = BitStreamFilterContext("h264_mp4toannexb", st)
        tb = Fraction(st.time_base)
        last_dts = None
        first_pts = None

        def take(pk: av.Packet) -> None:
            nonlocal last_dts, first_pts
            if pk.pts is None or pk.dts is None:
                raise ConvertError("E_PTS: every packet needs pts and dts")
            if last_dts is not None and pk.dts <= last_dts:
                raise ConvertError("E_DTS: non-increasing dts")
            last_dts = pk.dts
            first_pts = pk.pts if first_pts is None else first_pts
            units.append(
                AccessUnit(bytes(pk), round((pk.pts - first_pts) * tb * 1_000_000_000))
            )

        for pk in c.demux(st):
            if pk.size == 0:
                continue
            for out in bsf.filter(pk):
                take(out)
        for out in bsf.filter(None):
            take(out)
        width, height, rate = (
            st.codec_context.width,
            st.codec_context.height,
            st.average_rate,
        )
    problems = _check_units(units)
    if not units or problems:
        return problems or ["no video packets"]
    fps = _int_fps(rate)
    return Source(
        units, width, height, fps, _profile_name(units[0].data), {"transcoded": False}
    )


def _transcode(path: Path, reason: list[str]) -> Source:
    import av

    units: list[AccessUnit] = []
    with av.open(str(path), options={"err_detect": "explode"}) as c:
        st = c.streams.video[0]
        st.codec_context.thread_count = 1
        width, height, rate = (
            st.codec_context.width,
            st.codec_context.height,
            st.average_rate,
        )
        enc = av.CodecContext.create("libx264", "w")
        enc.width, enc.height, enc.pix_fmt = width, height, "yuv420p"
        enc.time_base = Fraction(1, 1_000_000)
        enc.framerate = rate
        enc.options = dict(X264_OPTIONS)
        enc.open()
        tb = Fraction(st.time_base)
        first_pts = None
        for frame in c.decode(st):
            if frame.pts is None:
                raise ConvertError("E_PTS: every decoded frame needs a pts")
            first_pts = frame.pts if first_pts is None else first_pts
            pts_ns = round((frame.pts - first_pts) * tb * 1_000_000_000)
            nf = av.VideoFrame.from_ndarray(
                frame.to_ndarray(format="yuv420p"), format="yuv420p"
            )
            nf.pts = round(pts_ns / 1000)
            nf.time_base = enc.time_base
            for pk in enc.encode(nf):
                units.append(AccessUnit(bytes(pk), pk.pts * 1000))
        for pk in enc.encode(None):
            units.append(AccessUnit(bytes(pk), pk.pts * 1000))
    problems = _check_units(units)
    if problems:
        raise ConvertError("E_TRANSCODE: " + "; ".join(problems))
    fps = _int_fps(rate)
    info = {
        "transcoded": True,
        "reason": reason,
        "encoder": "libx264 via PyAV",
        "x264_options": dict(X264_OPTIONS),
    }
    return Source(units, width, height, fps, _profile_name(units[0].data), info)


def read_source(path: Path, reencode: str = "auto") -> Source:
    if reencode not in ("auto", "never", "always"):
        raise ConvertError("E_REENCODE")
    reason: list[str] = ["--reencode always"]
    if reencode != "always":
        got = _remux(path)
        if isinstance(got, Source):
            return got
        reason = got
        if reencode == "never":
            raise ConvertError("E_NOT_REMUXABLE: " + "; ".join(reason))
    return _transcode(path, reason)


# ------------------------------------------------------------------------------- MCAP
def _jb(obj: object) -> bytes:
    return json.dumps(obj, separators=(",", ":"), sort_keys=True).encode()


def _varint(v: int) -> bytes:
    out = bytearray()
    while v > 0x7F:
        out.append((v & 0x7F) | 0x80)
        v >>= 7
    out.append(v)
    return bytes(out)


def _field(n: int, payload: bytes) -> bytes:
    return _varint(n << 3 | 2) + _varint(len(payload)) + payload


def compressed_video(capture_ns: int, data: bytes) -> bytes:
    """foxglove.CompressedVideo protobuf: timestamp, frame_id, data, format."""
    ref = contract.reference()
    stamp = (
        b"\x08" + _varint(capture_ns // 10**9) + b"\x10" + _varint(capture_ns % 10**9)
    )
    return (
        _field(1, stamp)
        + _field(2, ref.FRAME_ID.encode())
        + _field(3, data)
        + _field(4, b"h264")
    )


def recording_id_for(source_sha256: str) -> str:
    return str(uuid.uuid5(UUID_NAMESPACE, source_sha256))


def marker(camera_label: str) -> dict[str, object]:
    return {
        "schema": "stateaction.simulation_provenance.v1",
        "qualification": "simulation_only",
        "mapped_timeline_semantics": "simulation_transport_only",
        "production_qualified": False,
        "provenance": {
            "camera": {"status": "known", "label": camera_label},
            "encoder": {"status": "unknown"},
            "clock": {"status": "unknown"},
        },
    }


def build_mcap(src: Source, recording_id: str) -> bytes:
    cap_dir = contract.contract_dir()
    records: list[tuple[int, bytes]] = []
    schema_ids: dict[str, int] = {}
    channel_ids: dict[str, int] = {}
    for topic, name, enc, filename, msg_enc in CHANNELS:
        if name not in schema_ids:
            sid = schema_ids[name] = len(schema_ids) + 1
            data = (cap_dir / filename).read_bytes()
            records.append(
                (
                    0x03,
                    struct.pack("<H", sid)
                    + s(name)
                    + s(enc)
                    + struct.pack("<I", len(data))
                    + data,
                )
            )
        cid = channel_ids[topic] = len(channel_ids) + 1
        records.append(
            (
                0x04,
                struct.pack("<HH", cid, schema_ids[name])
                + s(topic)
                + s(msg_enc)
                + struct.pack("<I", 0),
            )
        )

    n = len(src.units)
    first_cap = EPOCH_ANCHOR_NS
    rgb = {"rgb": NATIVE_CLOCK}
    profile = {
        "capture_schema": "stateaction.capture.v1",
        "rgb_profile": SIM_PROFILE,
        "recording_id": recording_id,
        "wire_contract_revision": "stateaction.capture.v1.1",
        "production_qualified": False,
        "qualification": "simulation_only",
        "mapped_timeline_semantics": "simulation_transport_only",
        "encoder_time_base": TB_US,
        "limits": {"pending_frames": 4},
        "encoder": {
            "codec": "h264",
            "profile": src.h264_profile,
            "width": src.width,
            "height": src.height,
            "b_frames": 0,
            **({"fps": src.fps} if src.fps else {}),
        },
    }
    clocks = {
        "recording_id": recording_id,
        "stream_clocks": rgb,
        "recorder_transport": {
            "clock_id": "android.elapsed_realtime",
            "target_clock_id": "unix",
            "native_anchor_ns": "0",
            "epoch_anchor_ns": str(EPOCH_ANCHOR_NS),
            "method": "fixed_host_anchor",
            "revision": CLOCK_REVISION,
            "status": "unverified",
            "uncertainty_ns": None,
            "synchronization_accuracy": "unverified",
        },
    }
    inventory = {
        "recording_id": recording_id,
        "sensors": [
            {
                "sensor_id": "rgb",
                "kind": "camera",
                "requested": "unknown",
                "supported": "unknown",
                "enabled": "unknown",
                "observed": "yes",
                "observed_count": str(n),
                "native_clock_id": NATIVE_CLOCK,
                "unavailable_reason": None,
            }
        ],
        "calibrations": [
            {
                "calibration_id": "rgb_0",
                "stream_id": "rgb",
                "state": "unknown",
                "model": None,
            }
        ],
    }
    t0 = first_cap - PRE_LEAD_NS
    timed: list[tuple[int, str, bytes, int | None]] = [
        (t0, "/stateaction/capture_profile", _jb(profile), None),
        (t0, "/stateaction/clocks", _jb(clocks), None),
        (t0, "/stateaction/inventory", _jb(inventory), None),
    ]
    events: list[tuple[int, int, str, bytes, int | None]] = []
    for i, u in enumerate(src.units):
        cap = first_cap + u.pts_ns
        common = {
            "recording_id": recording_id,
            "stream_id": "rgb",
            "source_frame_id": str(i),
            "native_timestamp_ns": str(u.pts_ns),
            "native_clock_id": NATIVE_CLOCK,
            "mapped_capture_time_ns": str(cap),
            "clock_mapping_revision": CLOCK_REVISION,
            "calibration_id": "rgb_0",
            "encoder_pts_us": str(u.pts_us),
            "encoder_time_base": TB_US,
            "native_timestamps": {"metadata_sensor_timestamp_ns": str(u.pts_ns)},
        }
        written = {
            **common,
            "state": "written",
            "output_channel": VIDEO_CHANNEL,
            "output_sequence": i,
            "is_idr": u.is_idr,
        }
        for log, order, topic, data, seq in (
            (cap, 0, VIDEO_CHANNEL, compressed_video(cap, u.data), i),
            (
                cap + 1,
                1,
                "/stateaction/frame_events",
                _jb({**common, "state": "acquired"}),
                None,
            ),
            (
                cap + 2,
                2,
                "/stateaction/frame_events",
                _jb({**common, "state": "submitted"}),
                None,
            ),
            (cap + 3, 3, "/stateaction/frame_events", _jb(written), None),
        ):
            events.append((log, i * 4 + order, topic, data, seq))
    events.sort(key=lambda e: (e[0], e[1]))
    close = {
        "recording_id": recording_id,
        "outcome": "completed",
        "frames": {
            "acquired": str(n),
            "submitted": str(n),
            "written": str(n),
            "dropped": "0",
            "unresolved": "0",
        },
        "video_messages": str(n),
        "motion_events": {"accel": "0", "gyro": "0"},
        "sensor_events": "0",
        "drops": [],
    }
    last = events[-1][0] + 1_000_000
    seqs: dict[str, int] = {}
    messages = (
        timed
        + [(log, topic, data, seq) for log, _, topic, data, seq in events]
        + [(last, "/stateaction/close", _jb(close), None)]
    )
    for log, topic, data, seq in messages:
        k = seqs.get(topic, 0) if seq is None else seq
        seqs[topic] = k + 1
        records.append(
            (0x05, struct.pack("<HIQQ", channel_ids[topic], k, log, log) + data)
        )
    header = s("") + s(CONVERTER_VERSION)
    return build(header, records, messages_per_chunk=256)


def convert(
    mp4: Path, out: Path, *, reencode: str = "auto", camera_label: str = "WGO-Bench"
) -> dict[str, object]:
    h = hashlib.sha256()
    with mp4.open("rb") as f:
        while chunk := f.read(16 << 20):
            h.update(chunk)
    src = read_source(mp4, reencode)
    rid = recording_id_for(h.hexdigest())
    data = build_mcap(src, rid)
    out.write_bytes(data)
    mk = marker(camera_label)
    out.with_suffix(".simulation.json").write_text(
        json.dumps(mk, indent=2, sort_keys=True) + "\n"
    )
    conv = {
        "converter": CONVERTER_VERSION,
        "source_sha256": h.hexdigest(),
        "mcap_sha256": hashlib.sha256(data).hexdigest(),
        "recording_id": rid,
        "access_units": len(src.units),
        "raster": [src.width, src.height],
        "h264_profile": src.h264_profile,
        "clock": {"native_clock_id": NATIVE_CLOCK, "epoch_anchor_ns": EPOCH_ANCHOR_NS},
        **src.info,
    }
    out.with_suffix(".conversion.json").write_text(
        json.dumps(conv, indent=2, sort_keys=True) + "\n"
    )
    return conv


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("mp4", type=Path)
    p.add_argument("out", type=Path)
    p.add_argument("--reencode", choices=("auto", "never", "always"), default="auto")
    p.add_argument("--camera-label", default="WGO-Bench")
    a = p.parse_args(argv)
    try:
        conv = convert(a.mp4, a.out, reencode=a.reencode, camera_label=a.camera_label)
    except ConvertError as e:
        print(f"convert failed: {e}", file=sys.stderr)
        return 2
    print(json.dumps(conv, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
