#!/usr/bin/env python3
"""Bounded local interoperability spike, NOT the production worker.

Artifacts can contain private video. All generated files belong under artifacts/.
The synthetic overlay is an explicit decoder/timeline probe, never a model result.
"""
from __future__ import annotations

import argparse
import contextlib
import dataclasses
import hashlib
import importlib.metadata
import io
import json
import resource
import struct
import time
from collections import Counter
from fractions import Fraction
from pathlib import Path

import av
import mediapipe as mp
import numpy as np
import rerun as rr
import rerun.blueprint as rrb
from foxglove_schemas_protobuf.CompressedVideo_pb2 import CompressedVideo
from mcap.records import Channel, Chunk, Footer, Header, Message, Schema
from mcap.stream_reader import StreamReader, breakup_chunk
from mcap.writer import CompressionType, Writer
from mcap_protobuf.decoder import DecoderFactory as ProtobufDecoder
from mcap_ros2.decoder import DecoderFactory as RosDecoder

HERE = Path(__file__).resolve().parent
MODEL_HASH = "fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1"
MODEL_DEFAULT = Path.home() / ".cache/mediapipe/hand_landmarker.task"
NS = 1_000_000_000
TIMEBASE = Fraction(1, 1_000_000)
LIMIT = 16 * 1024 * 1024
MAX_PENDING = 8
MAX_DIMENSION = 1920
HAND_EDGES = [(0, 1), (1, 2), (2, 3), (3, 4), (0, 5), (5, 6), (6, 7), (7, 8),
              (5, 9), (9, 10), (10, 11), (11, 12), (9, 13), (13, 14), (14, 15),
              (15, 16), (13, 17), (0, 17), (17, 18), (18, 19), (19, 20)]
BASE_NATIVE_NS = 3_000_000_000_000
BASE_EPOCH_NS = 1_798_473_600 * NS
VIDEO = "/camera/rgb/video"
FRAMES = "/stateaction/frame_events"
PROFILE = "/stateaction/capture_profile"
CLOCKS = "/stateaction/clocks"


class InvalidCapture(ValueError):
    pass


def require(ok, reason):
    if not ok:
        raise InvalidCapture(reason)


def digest(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        while b := f.read(1024 * 1024):
            h.update(b)
    return h.hexdigest()


def dump(path, value):
    Path(path).write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def nal_units(data):
    """Return Annex B NAL byte strings, never treating an AVC length as a prefix."""
    starts = []
    i = 0
    while i < len(data) - 2:
        if data[i:i + 4] == b"\0\0\0\1":
            starts.append((i, i + 4)); i += 4
        elif data[i:i + 3] == b"\0\0\1":
            starts.append((i, i + 3)); i += 3
        else:
            i += 1
    require(starts and starts[0][0] == 0, "not_annex_b")
    return [data[start:starts[k + 1][0] if k + 1 < len(starts) else len(data)]
            for k, (_, start) in enumerate(starts)]


def packet_shape(data):
    units = nal_units(data)
    kinds = [n[0] & 31 for n in units if n]
    require(any(n in (1, 5) for n in kinds), "config_only_or_empty_access_unit")
    if 5 in kinds:
        require(7 in kinds and 8 in kinds, "idr_missing_sps_pps")
    return 5 in kinds


class HashingReader:
    def __init__(self, file):
        self.file = file
        self.hash = hashlib.sha256()
        self.count = 0

    def read(self, size=-1):
        require(0 <= size <= LIMIT, "unbounded_read_requested")
        data = self.file.read(size)
        self.hash.update(data)
        self.count += len(data)
        return data


def bounded_records(source):
    """Bound *actual* expanded bytes before the library parses an MCAP chunk.

    NonSeekingReader expands before exposing a chunk. Use its underlying public
    StreamReader in emit_chunks mode instead, preserving file order and CRCs.
    """
    for record in StreamReader(source, emit_chunks=True, validate_crcs=True,
                               record_size_limit=LIMIT).records:
        if not isinstance(record, Chunk):
            yield record
            continue
        require(record.uncompressed_size <= LIMIT, "decompressed_chunk_limit")
        if record.compression == "zstd":
            import zstandard
            with zstandard.ZstdDecompressor().stream_reader(io.BytesIO(record.data)) as z:
                data = z.read(LIMIT + 1)
        elif record.compression == "lz4":
            import lz4.frame
            with lz4.frame.open(io.BytesIO(record.data), "rb") as z:
                data = z.read(LIMIT + 1)
        elif not record.compression:
            data = record.data
        else:
            raise InvalidCapture("unsupported_compression")
        require(len(data) <= LIMIT, "actual_decompressed_chunk_limit")
        require(len(data) == record.uncompressed_size, "chunk_size_mismatch")
        yield from breakup_chunk(dataclasses.replace(record, compression="", data=data), validate_crc=True)


def encode_frames(images, pts_values, *, width=320, height=192, b_frames=0):
    codec = av.CodecContext.create("libx264", "w")
    codec.width = width; codec.height = height
    codec.pix_fmt = "yuv420p"; codec.time_base = TIMEBASE
    codec.framerate = Fraction(30, 1)
    codec.options = {"preset": "ultrafast", "tune": "zerolatency", "profile": "main",
                     "x264-params": f"keyint=30:min-keyint=30:scenecut=0:bframes={b_frames}:repeat-headers=1"}
    codec.open()
    for image, pts in zip(images, pts_values, strict=True):
        frame = av.VideoFrame.from_ndarray(image, format="rgb24").reformat(width=width, height=height)
        frame.pts = pts; frame.time_base = TIMEBASE
        yield from codec.encode(frame)
    yield from codec.encode()


def synthetic_image(i):
    image = np.zeros((192, 320, 3), dtype=np.uint8)
    image[:, :, :] = (20, 35, 60)
    x = 15 + (i * 3) % 280
    image[70:120, x:x + 20] = (245, 180, 25)
    # Binary source index markers: no optical reading is used for association.
    for bit in range(8):
        image[5:15, 5 + bit * 15:15 + bit * 15] = 240 if (i >> bit) & 1 else 40
    return image


CDR_SCHEMA = """std_msgs/Header header
geometry_msgs/Vector3 vector
================================================================================
MSG: std_msgs/Header
builtin_interfaces/Time stamp
string frame_id
================================================================================
MSG: builtin_interfaces/Time
int32 sec
uint32 nanosec
================================================================================
MSG: geometry_msgs/Vector3
float64 x
float64 y
float64 z
"""


def cdr_vector(ns):
    # CDR encapsulation, little endian; align relative to the post-header origin.
    out = bytearray(struct.pack("<iII", ns // NS, ns % NS, 7) + b"camera\0")
    out.extend(b"\0" * ((-len(out)) % 8))
    out.extend(struct.pack("<ddd", 0.1, 0.2, 9.81))
    return b"\0\1\0\0" + out


def historical_jpeg(data):
    """Explicit historical CDR layout, not a generic schema repair/fallback.

    Old Stera schema fields use std_msgs/msg/Header inside .msg definitions,
    which mcap-ros2-support rejects. Read only known CompressedImage bytes here.
    """
    require(data[:4] == b"\0\1\0\0", "legacy_cdr_endianness")
    sec, ns = struct.unpack_from("<iI", data, 4)
    pos = 12
    def string():
        nonlocal pos
        pos += (-(pos - 4)) % 4
        length, = struct.unpack_from("<I", data, pos); pos += 4
        require(0 < length < LIMIT and pos + length <= len(data), "legacy_string_length")
        value = data[pos:pos + length]; pos += length
        require(value[-1:] == b"\0", "legacy_string_terminator")
        return value[:-1].decode()
    string()  # Optical coordinate frame, not a unique image id.
    require(string().lower() in ("jpeg", "jpg"), "legacy_not_jpeg")
    pos += (-(pos - 4)) % 4
    length, = struct.unpack_from("<I", data, pos); pos += 4
    require(length <= LIMIT and pos + length == len(data), "legacy_jpeg_length")
    return sec * NS + ns, data[pos:]


def make_fixture(destination, *, legacy_source=None, fault=None):
    """Generate finite test MCAP; never call this a hardware capture."""
    source_hash = None
    times = [1_000_000 + sum(33_333 + (1_111 if j % 7 == 0 else 0) for j in range(i)) for i in range(95)]
    images = (synthetic_image(i) for i in range(len(times)))
    native_times = [BASE_NATIVE_NS + (t - times[0]) * 1000 + 123 for t in times]
    native_clock = "arcore.camera"
    provenance = "synthetic_software_h264"
    if legacy_source:
        from mcap.reader import NonSeekingReader
        source_hash = digest(legacy_source)
        legacy = []
        # Bounded fixture creation only: at most 95 JPEGs, not a production reader.
        with Path(legacy_source).open("rb") as f:
            for schema, channel, message in NonSeekingReader(f).iter_messages(
                    topics=["/camera/rgb/compressed"], log_time_order=False):
                require(schema.name == "sensor_msgs/msg/CompressedImage" and channel.message_encoding == "cdr", "legacy_schema")
                legacy.append(historical_jpeg(message.data))
                if len(legacy) == 95:
                    break
        require(len(legacy) >= 60, "legacy_fixture_too_short")
        times = [1_000_000 + (t - legacy[0][0]) // 1000 for t, _ in legacy]
        native_times = [t for t, _ in legacy]
        native_clock = "historical_cdr_header_unqualified"
        def frames():
            codec = av.CodecContext.create("mjpeg", "r")
            for _, jpeg in legacy:
                yield codec.decode(av.Packet(jpeg))[0].to_ndarray(format="rgb24")
        images = frames()
        provenance = "historical_android_jpeg_derived_software_h264"
    packets = iter(encode_frames(images, times, b_frames=2 if fault == "b_frames" else 0))
    schema_data = (HERE / "foxglove-compressed-video-0.4.0.desc").read_bytes()
    with Path(destination).open("wb") as f:
        writer = Writer(f, chunk_size=64 * 1024, compression=CompressionType.ZSTD, enable_data_crcs=True)
        writer.start(profile="", library="stateaction.android.processing.spike")
        schema = writer.register_schema("foxglove.CompressedVideo", "protobuf", schema_data)
        video = writer.register_channel(VIDEO, "protobuf", schema)
        channels = {}
        for topic, name in [(PROFILE, "Profile"), (CLOCKS, "Clocks"), (FRAMES, "FrameEvent"),
                            ("/stateaction/imu/accel", "MotionEvent"), ("/stateaction/imu/gyro", "MotionEvent")]:
            s = writer.register_schema(f"stateaction.capture.{name}.v1", "jsonschema", json.dumps({"type": "object"}).encode())
            channels[topic] = writer.register_channel(topic, "json", s)
        cdr = writer.register_schema("geometry_msgs/msg/Vector3Stamped", "ros2msg", CDR_SCHEMA.encode())
        sensor = writer.register_channel("/fixture/calibrated_vector", "cdr", cdr)
        serial = 0
        def write_json(topic, obj):
            nonlocal serial
            serial += 1
            writer.add_message(channels[topic], BASE_EPOCH_NS + serial * 1000, json.dumps(obj).encode(),
                               publish_time=BASE_EPOCH_NS + serial * 1000)
        write_json(PROFILE, {"capture_schema": "stateaction.capture.v1", "rgb_profile": "h264_mcap_v1",
                            "encoder_time_base": {"numerator": 1, "denominator": 1_000_000},
                            "fixture_provenance": provenance, "legacy_source_sha256": source_hash,
                            "pixel_raster": [320, 192], "calibration_status": "not_qualified_fixture"})
        write_json(CLOCKS, {"mapping_revision": "fixture_1", "status": "unverified",
                           "note": "Unequal clocks are retained; no cross-sensor association is made."})
        pending = []
        for i, packet in enumerate(packets):
            pts = int(packet.pts)
            event = {"recording_id": "fixture", "stream_id": "rgb", "source_frame_id": str(i),
                     "native_timestamp_ns": str(native_times[i]),
                     "native_clock_id": native_clock, "mapping_revision": "fixture_1",
                     "mapped_capture_time_ns": str(BASE_EPOCH_NS + native_times[i] - native_times[0]),
                     "calibration_id": "fixture_rgb", "encoder_pts_us": str(pts)}
            if fault == "duplicate_pts" and i == 3:
                event["encoder_pts_us"] = str(times[2])
            write_json(FRAMES, event | {"state": "acquired"})
            # Independent IMU clocks/times; deliberately cannot be safely RGB-joined.
            write_json("/stateaction/imu/accel", {"event_id": str(i), "native_timestamp_ns": str(9_000_000 + i * 10_000_000),
                        "native_clock_id": "sensor.accel", "mapped_capture_time_ns": None, "unit": "m/s^2",
                        "includes_gravity": True, "values": [0.1, 0.2, 9.81]})
            write_json("/stateaction/imu/gyro", {"event_id": str(i), "native_timestamp_ns": str(9_040_000 + i * 10_010_000),
                        "native_clock_id": "sensor.gyro", "mapped_capture_time_ns": None, "unit": "rad/s",
                        "values": [0.01, 0.02, 0.03]})
            pending.append((i, event, bytes(packet)))
            # Delay output by two acquisitions and interleave sensor messages.
            if len(pending) >= 3:
                emit(writer, video, pending.pop(0), write_json, fault)
        for item in pending:
            emit(writer, video, item, write_json, fault)
        writer.add_message(sensor, BASE_EPOCH_NS + serial * 1000, cdr_vector(BASE_EPOCH_NS),
                           publish_time=BASE_EPOCH_NS + serial * 1000, sequence=0)
        writer.finish()
    if fault == "truncated":
        with Path(destination).open("r+b") as f:
            f.truncate(Path(destination).stat().st_size - 16)
    return {"path": str(destination), "sha256": digest(destination), "frames": len(times),
            "provenance": provenance, "legacy_source_sha256": source_hash}


def emit(writer, channel, item, write_json, fault):
    i, event, data = item
    idr = packet_shape(data)
    if fault == "missing_config" and i == 0:
        data = b"".join(b"\0\0\0\1" + n for n in nal_units(data) if n[0] & 31 not in (7, 8))
    if fault == "config_only" and i == 0:
        data = b"".join(b"\0\0\0\1" + n for n in nal_units(data) if n[0] & 31 in (7, 8))
    if fault == "wrong_codec" and i == 0:
        data = b"not an annex b video frame"
    msg = CompressedVideo(frame_id="camera_optical", data=data, format="h264")
    epoch = int(event["mapped_capture_time_ns"])
    if fault == "wrong_capture_time" and i == 2:
        epoch += 1
    msg.timestamp.seconds, msg.timestamp.nanos = divmod(epoch, NS)
    writer.add_message(channel, BASE_EPOCH_NS + i * 1_000_000 + 50_000_000, msg.SerializeToString(),
                       publish_time=BASE_EPOCH_NS + i * 1_000_000 + 40_000_000, sequence=i)
    if not (fault == "unresolved" and i == 4):
        write_json(FRAMES, event | {"state": "written", "output_sequence": i, "is_idr": idr})


def read_access_units(source, receipt):
    schemas = {}; channels = {}; acquired = {}; videos = {}
    proto = ProtobufDecoder(); ros = RosDecoder()
    profile = None; footer = False; last_pts = None; last_acquired_id = -1; written_count = 0
    counts = Counter(); peaks = Counter()
    with Path(source).open("rb") as f:
        hashed = HashingReader(f)
        for record in bounded_records(hashed):
            if isinstance(record, Header):
                require(record.profile == "", "expected_generic_mcap_profile")
            elif isinstance(record, Schema):
                require(len(schemas) < 64 or record.id in schemas, "schema_limit")
                schemas[record.id] = record
            elif isinstance(record, Channel):
                require(len(channels) < 64 or record.id in channels, "channel_limit")
                channels[record.id] = record
            elif isinstance(record, Footer):
                footer = True
            elif isinstance(record, Message):
                channel = channels[record.channel_id]
                schema = schemas[channel.schema_id]
                counts[channel.topic] += 1
                if channel.message_encoding == "cdr":
                    decoder = ros.decoder_for("cdr", schema)
                    require(decoder is not None, "unsupported_cdr_schema")
                    sample = decoder(record.data)
                    # Only this finite fixture asserts fields; other CDR remains preserved input.
                    if channel.topic == "/fixture/calibrated_vector":
                        require(abs(sample.vector.z - 9.81) < 1e-10, "cdr_value_mismatch")
                    continue
                if channel.topic == VIDEO:
                    require(schema.name == "foxglove.CompressedVideo" and channel.message_encoding == "protobuf", "wrong_video_schema")
                    decoder = proto.decoder_for("protobuf", schema)
                    require(decoder is not None, "missing_protobuf_descriptor")
                    msg = decoder(record.data)
                    require(msg.format == "h264", "wrong_video_codec")
                    require(record.sequence not in videos, "duplicate_video_sequence")
                    require(len(videos) < MAX_PENDING, "pending_video_limit")
                    videos[record.sequence] = (msg, record)
                elif channel.message_encoding == "json":
                    obj = json.loads(record.data)
                    if channel.topic == PROFILE:
                        require(profile is None, "midstream_profile_change")
                        # The second value is an explicit unqualified native spike,
                        # never a production auto-dispatch fallback.
                        require(obj["rgb_profile"] in ("h264_mcap_v1", "android_h264_spike_v1"), "wrong_capture_profile")
                        require(obj["encoder_time_base"] == {"numerator": 1, "denominator": 1_000_000}, "unsupported_time_base")
                        profile = obj
                        receipt["profile"] = profile
                    elif channel.topic == FRAMES:
                        frame_id = obj["source_frame_id"]
                        if obj["state"] == "acquired":
                            require(int(frame_id) > last_acquired_id, "duplicate_or_nonmonotonic_source_frame_id")
                            last_acquired_id = int(frame_id)
                            require(len(acquired) < MAX_PENDING, "pending_acquisition_limit")
                            acquired[frame_id] = obj
                        elif obj["state"] == "dropped":
                            require(frame_id in acquired and bool(obj.get("reason")), "invalid_drop")
                            acquired.pop(frame_id)
                        elif obj["state"] == "written":
                            require(profile is not None, "missing_profile")
                            require(frame_id in acquired, "unknown_or_duplicate_terminal")
                            require(obj["output_sequence"] in videos, "terminal_before_video_or_missing_video")
                            original = acquired.pop(frame_id)
                            for key in ["native_timestamp_ns", "native_clock_id", "encoder_pts_us", "mapped_capture_time_ns"]:
                                require(original[key] == obj[key], f"identity_changed:{key}")
                            msg, video_record = videos.pop(obj["output_sequence"])
                            pts = int(obj["encoder_pts_us"])
                            require(last_pts is None or pts > last_pts, "duplicate_or_nonmonotonic_pts")
                            last_pts = pts
                            capture_ns = msg.timestamp.seconds * NS + msg.timestamp.nanos
                            require(str(capture_ns) == obj["mapped_capture_time_ns"], "capture_timestamp_mismatch")
                            idr = packet_shape(msg.data)
                            require(idr == obj["is_idr"], "idr_evidence_mismatch")
                            if not written_count:
                                require(idr, "stream_does_not_start_at_idr")
                            written_count += 1
                            yield {"event": obj, "pts": pts, "data": bytes(msg.data), "idr": idr,
                                   "log_time_ns": str(video_record.log_time), "publish_time_ns": str(video_record.publish_time)}
                peaks["pending_acquisitions"] = max(peaks["pending_acquisitions"], len(acquired))
                peaks["pending_video"] = max(peaks["pending_video"], len(videos))
        require(footer, "missing_footer")
        require(not hashed.read(1), "trailing_data")
        require(not acquired and not videos, "unresolved_frame_evidence")
        receipt.update(source_sha256=hashed.hash.hexdigest(), source_bytes=hashed.count,
                       channels=dict(counts), association_peaks=dict(peaks), profile=profile,
                       cross_sensor_synchronization_validated=False)


class ClipWriter:
    def __init__(self, destination, index, origin, *, max_seconds):
        self.dir = destination / f"clip-{index:03d}"; self.dir.mkdir()
        self.origin = origin; self.max_seconds = max_seconds
        self.rows = []; self.hands = []; self.world = []; self.valid = []; self.handedness = []; self.labels = []
        self.native = av.open(str(self.dir / "rgb.mp4"), "w")
        self.stream = self.native.add_stream("h264", rate=30)
        self.stream.width = 320; self.stream.height = 192
        self.stream.time_base = TIMEBASE
        self.stream.codec_context.time_base = TIMEBASE
        self.proxy = av.CodecContext.create("libx264", "w")
        self.proxy.width = 320; self.proxy.height = 192; self.proxy.pix_fmt = "yuv420p"
        self.proxy.time_base = TIMEBASE; self.proxy.framerate = Fraction(30, 1)
        self.proxy.options = {"preset": "ultrafast", "tune": "zerolatency", "profile": "main", "x264-params": "bframes=0:keyint=30:repeat-headers=1"}
        self.proxy.open()
        self.recording = rr.RecordingStream("stateaction-android-spike-clip")
        self.recording.save(str(self.dir / "viewer.rrd"))
        self.recording.log("rgb", rr.VideoStream(codec=rr.VideoCodec.H264), static=True)
        self.recording.log("model_estimate_note", rr.TextDocument("Model-relative 3D estimate; metric accuracy not validated."), static=True)
        self.recording.send_blueprint(rrb.Horizontal(
            rrb.Spatial2DView(origin="rgb", name="RGB and detected hands"),
            rrb.Vertical(rrb.Spatial3DView(origin="model_local/left", name="Left: model-relative 3D estimate"),
                         rrb.Spatial3DView(origin="model_local/right", name="Right: model-relative 3D estimate"))))

    def write(self, access, decoded, result, *, synthetic_probe):
        event = access["event"]
        clip_pts = access["pts"] - self.origin
        packet = av.Packet(access["data"]); packet.pts = clip_pts; packet.dts = clip_pts
        packet.time_base = TIMEBASE; packet.stream = self.stream
        if not self.rows:
            self.stream.width = decoded.width; self.stream.height = decoded.height
        # No transcoding: the original AU bytes enter the MP4 muxer unchanged.
        packet.is_keyframe = access["idr"]
        self.native.mux(packet)
        rgb = decoded.to_ndarray(format="rgb24")
        h, w = rgb.shape[:2]
        points = np.full((2, 21, 2), np.nan, dtype=np.float32)
        world = np.full((2, 21, 3), np.nan, dtype=np.float32)
        valid = np.zeros((2, 21), dtype=bool)
        scores = np.full(2, np.nan, dtype=np.float32)
        labels = np.full(2, "unknown", dtype="U8")
        self.recording.set_time("clip_time", duration=np.timedelta64(clip_pts * 1000, "ns"))
        for side in ("left", "right"):
            self.recording.log(f"rgb/hands/{side}", rr.Clear(recursive=True))
            self.recording.log(f"model_local/{side}", rr.Clear(recursive=True))
        for j, (landmarks, local, handed) in enumerate(zip(result.hand_landmarks, result.hand_world_landmarks, result.handedness, strict=True)):
            require(j < 2 and len(landmarks) == 21 and len(local) == 21, "model_shape")
            points[j] = [[p.x * w, p.y * h] for p in landmarks]
            world[j] = [[p.x, p.y, p.z] for p in local]
            valid[j] = np.isfinite(points[j]).all(axis=1) & np.isfinite(world[j]).all(axis=1)
            scores[j] = handed[0].score
            side = handed[0].category_name.lower()
            require(side in ("left", "right"), "unknown_handedness_label")
            labels[j] = side
            # No per-joint confidence/visibility is manufactured.
            proxy_points = points[j][valid[j]] * np.array([320 / w, 192 / h])
            self.recording.log(f"rgb/hands/{side}", rr.Points2D(proxy_points, radii=2))
            self.recording.log(f"model_local/{side}", rr.Points3D(world[j][valid[j]], radii=0.004))
            edges = [(a, b) for a, b in HAND_EDGES if valid[j, a] and valid[j, b]]
            if edges:
                proxy_all = points[j] * np.array([320 / w, 192 / h])
                self.recording.log(f"rgb/hands/{side}/edges", rr.LineStrips2D([proxy_all[[a, b]] for a, b in edges]))
                self.recording.log(f"model_local/{side}/edges", rr.LineStrips3D([world[j][[a, b]] for a, b in edges]))
        if synthetic_probe:
            # QA overlay at moving block center. It is explicitly NOT a hand prediction.
            i = int(event["source_frame_id"])
            self.recording.log("rgb/qa_timeline_probe", rr.Points2D([[25 + (i * 3) % 280, 95]], colors=[[255, 0, 255]], radii=4))
        frame = av.VideoFrame.from_ndarray(rgb, format="rgb24").reformat(width=320, height=192)
        frame.pts = clip_pts; frame.time_base = TIMEBASE
        for sample in self.proxy.encode(frame):
            require(sample.pts == clip_pts, "proxy_pts_changed")
            self.recording.log("rgb", rr.VideoStream.from_fields(sample=bytes(sample), is_keyframe=packet_shape(bytes(sample))))
        self.rows.append(event | {"source_pts": str(access["pts"]), "source_time_base": [1, 1_000_000],
                         "clip_pts": str(clip_pts), "clip_time_ns": str(clip_pts * 1000),
                         "source_pts_origin": str(self.origin), "native_raster": [w, h],
                         "source_decoded_rgb_sha256": hashlib.sha256(rgb.tobytes()).hexdigest(),
                         "source_vcl_sha256": [hashlib.sha256(n).hexdigest() for n in nal_units(access["data"]) if n[0] & 31 in (1, 5)],
                         "proxy_raster": [320, 192], "proxy_transform": {"scale_x": 320 / w, "scale_y": 192 / h},
                         "mcap_log_time_ns": access["log_time_ns"], "mcap_publish_time_ns": access["publish_time_ns"]})
        self.hands.append(points); self.world.append(world); self.valid.append(valid); self.handedness.append(scores); self.labels.append(labels)
        require(len(self.rows) <= 3600, "clip_frame_limit")

    def close(self):
        require(not list(self.proxy.encode()), "unexpected_delayed_proxy_frames")
        self.native.close(); self.recording.flush(); self.recording.disconnect()
        require((self.dir / "viewer.rrd").stat().st_size <= 128 * 1024 * 1024, "rrd_limit")
        np.savez_compressed(self.dir / "hands.npz", image_landmarks_px=np.array(self.hands),
                            model_relative_joints_m=np.array(self.world), finite_mask=np.array(self.valid),
                            handedness_score=np.array(self.handedness), handedness_label=np.array(self.labels))
        (self.dir / "frame-map.jsonl").write_text("".join(json.dumps(r) + "\n" for r in self.rows))
        with av.open(str(self.dir / "rgb.mp4")) as source:
            decoded_pts = []
            for row, frame in zip(self.rows, source.decode(video=0), strict=True):
                decoded_pts.append(Fraction(frame.pts) * frame.time_base)
                require(hashlib.sha256(frame.to_ndarray(format="rgb24").tobytes()).hexdigest() == row["source_decoded_rgb_sha256"], "mp4_pixels_changed")
        expected = [Fraction(int(r["clip_pts"]), 1_000_000) for r in self.rows]
        require(decoded_pts == expected, "mp4_pts_or_count_mismatch")
        with av.open(str(self.dir / "rgb.mp4")) as source:
            stream = source.streams.video[0]
            length_bytes = (stream.codec_context.extradata[4] & 3) + 1
            packets = (p for p in source.demux(video=0) if p.size)
            for i, (row, packet) in enumerate(zip(self.rows, packets, strict=True)):
                if i == 0:
                    require(packet.is_keyframe, "mp4_first_not_keyframe")
                data = bytes(packet); pos = 0; hashes = []
                while pos < len(data):
                    length = int.from_bytes(data[pos:pos + length_bytes], "big"); pos += length_bytes
                    n = data[pos:pos + length]; pos += length
                    require(n and pos <= len(data), "bad_mp4_nal_length")
                    if n[0] & 31 in (1, 5):
                        hashes.append(hashlib.sha256(n).hexdigest())
                require(hashes == row["source_vcl_sha256"], "mp4_encoded_vcl_changed")
        return {"directory": self.dir.name, "frames": len(self.rows), "source_pts_origin": str(self.origin),
                "native_resolution": self.rows[0]["native_raster"],
                "time_base": [1, 1_000_000], "decoded_mp4_pts_exact": True,
                "decoded_mp4_pixels_exact": True, "encoded_mp4_vcl_nals_exact": True,
                "first_source_frame_id": self.rows[0]["source_frame_id"],
                "last_source_frame_id": self.rows[-1]["source_frame_id"],
                "detected_hands": int(np.any(np.array(self.valid), axis=2).sum()),
                "files": {p.name: {"bytes": p.stat().st_size, "sha256": digest(p)} for p in sorted(self.dir.iterdir())}}


def process(source, destination, *, model=MODEL_DEFAULT, max_clip_seconds=1.1, expected_sha256=None):
    destination = Path(destination); destination.mkdir(parents=True, exist_ok=False)
    require(digest(model) == MODEL_HASH, "model_hash_mismatch")
    started = time.monotonic(); receipt = {"status": "running", "clips": []}
    decoder = av.CodecContext.create("h264", "r")
    decoder.options = {"err_detect": "explode"}
    detector_options = mp.tasks.vision.HandLandmarkerOptions(
        base_options=mp.tasks.BaseOptions(model_asset_path=str(model), delegate=mp.tasks.BaseOptions.Delegate.CPU),
        running_mode=mp.tasks.vision.RunningMode.IMAGE, num_hands=2)
    clip = None; pending = {}; last_cut = None; count = 0
    with mp.tasks.vision.HandLandmarker.create_from_options(detector_options) as detector:
        for access in read_access_units(source, receipt):
            pts = access["pts"]
            if clip and access["idr"] and Fraction(pts - last_cut, 1_000_000) >= Fraction(max_clip_seconds) / 2:
                require(not pending, "cut_with_delayed_decode")
                receipt["clips"].append(clip.close()); clip = None
            if clip is None:
                require(access["idr"], "clip_does_not_start_idr")
                last_cut = pts
                clip = ClipWriter(destination, len(receipt["clips"]), pts, max_seconds=max_clip_seconds)
            require(Fraction(pts - last_cut, 1_000_000) <= max_clip_seconds, "idr_interval_exceeds_clip_limit")
            packet = av.Packet(access["data"]); packet.pts = pts; packet.dts = pts; packet.time_base = TIMEBASE
            require(pts not in pending and len(pending) < MAX_PENDING, "decoder_pending_limit")
            pending[pts] = access
            for decoded in decoder.decode(packet):
                require(decoded.pict_type != av.video.frame.PictureType.B, "forbidden_b_frame")
                require(decoded.pts in pending, "unknown_decoded_pts")
                mapped = pending.pop(decoded.pts)
                require(decoded.width <= MAX_DIMENSION and decoded.height <= MAX_DIMENSION, "decoded_dimension_limit")
                rgb = decoded.to_ndarray(format="rgb24")
                result = detector.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb))
                clip.write(mapped, decoded, result, synthetic_probe=receipt["profile"].get("fixture_provenance") == "synthetic_software_h264")
                count += 1
        require(not decoder.decode(None) and not pending, "unresolved_delayed_decoder_frames")
    if clip:
        receipt["clips"].append(clip.close())
    if expected_sha256:
        require(receipt["source_sha256"] == expected_sha256, "source_hash_mismatch")
    receipt.update(status="passed", frames=count, model_sha256=MODEL_HASH, metric_accuracy_validated=False,
                   synthetic="fixture_provenance" in receipt["profile"],
                   fixture_kind=receipt["profile"].get("fixture_provenance", "native_android_spike"),
                   seconds=time.monotonic() - started, peak_rss_kib=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
                   packages={p: importlib.metadata.version(p) for p in ["av", "rerun-sdk", "mediapipe", "mcap", "foxglove-schemas-protobuf"]},
                   limitations=["Finite local spike, not a production worker or API/storage/workflow integration.",
                                "Synthetic or software-derived H264, not Android hardware encoding evidence.",
                                "No cross-sensor synchronization, metric 3D accuracy, two-hour capacity or mobile thermal qualification.",
                                "Original sensor messages are decoded/checked but sensor output/export is not implemented."])
    dump(destination / "receipt.json", receipt)
    return receipt


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    fixture = sub.add_parser("fixture"); fixture.add_argument("output", type=Path)
    fixture.add_argument("--legacy-source", type=Path); fixture.add_argument("--fault")
    run = sub.add_parser("process"); run.add_argument("source", type=Path); run.add_argument("output", type=Path)
    run.add_argument("--model", type=Path, default=MODEL_DEFAULT); run.add_argument("--expected-sha256")
    run.add_argument("--max-clip-seconds", type=float, default=1.1)
    check = sub.add_parser("check"); check.add_argument("source", type=Path)
    args = parser.parse_args()
    if args.command == "fixture":
        args.output.parent.mkdir(parents=True, exist_ok=True)
        result = make_fixture(args.output, legacy_source=args.legacy_source, fault=args.fault)
    elif args.command == "process":
        result = process(args.source, args.output, model=args.model, expected_sha256=args.expected_sha256,
                         max_clip_seconds=args.max_clip_seconds)
    else:
        result = {}; frames = sum(1 for _ in read_access_units(args.source, result)); result["frames"] = frames
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
