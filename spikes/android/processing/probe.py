#!/usr/bin/env python3
"""SA-61 isolated CPU hands + Rerun 0.41.0 probe. NOT the production worker.

    process  strict h264_mcap_v1 MCAP -> one sequential H.264 decode -> real CPU MediaPipe hand
             landmarks on every decoded frame -> per-clip IDR-safe native MP4 remux (original AU
             bytes), masked landmark arrays, exact frame map and a bounded customer-safe RRD whose
             VideoStream samples are the original access units.
    replay   build a clearly labelled, contract-valid replay MCAP from the retained historical
             Android JPEG capture (software H.264 transcode, synthetic contract timing). It never
             qualifies phone hardware capture, codec, clocks, calibration or thermal behaviour.

Outputs can contain private imagery. Keep them under the ignored artifacts/ directory.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import platform
import resource
import struct
import sys
import time
from fractions import Fraction
from pathlib import Path

import av
import mediapipe as mp
import numpy as np
import psutil
import rerun as rr
import rerun.blueprint as rrb
import strict_capture as sc

HERE = Path(__file__).resolve().parent
MODEL = json.loads((HERE / "model.json").read_text())
MODEL_DEFAULT = Path.home() / ".cache/mediapipe/hand_landmarker.task"
TIME_BASE = Fraction(*sc.TIME_BASE)
MAX_PENDING = 4
MAX_DIMENSION = 3840
MAX_RRD_BYTES = 256 * 1024 * 1024
MAX_HANDS = 2
HAND_EDGES = [(0, 1), (1, 2), (2, 3), (3, 4), (0, 5), (5, 6), (6, 7), (7, 8), (5, 9), (9, 10),
              (10, 11), (11, 12), (9, 13), (13, 14), (14, 15), (15, 16), (13, 17), (0, 17), (17, 18),
              (18, 19), (19, 20)]  # fmt: skip
SIDE_COLORS = {"left": [80, 200, 255], "right": [255, 160, 40]}
MODEL_3D_NOTE = (
    "Model-relative 3D estimate from MediaPipe hand_world_landmarks: metres in a hand-centred model "
    "frame, NOT camera or world coordinates. Metric accuracy, depth and occlusion are not validated."
)


class ProbeFailure(RuntimeError):
    pass


def require(ok: bool, code: str, detail: object = None) -> None:
    if not ok:
        raise ProbeFailure(code if detail is None else f"{code}: {detail}")


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while block := f.read(1 << 20):
            h.update(block)
    return h.hexdigest()


def dump(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def rss_mib() -> float:
    return round(psutil.Process().memory_info().rss / 2**20, 1)


def environment() -> dict:
    pkgs = ["av", "mediapipe", "rerun-sdk", "numpy", "psutil", "mcap"]
    return {
        "python": platform.python_version(),
        "implementation": platform.python_implementation(),
        "platform": platform.platform(),
        "machine": platform.machine(),
        "cpu_count": psutil.cpu_count(logical=True),
        "packages": {p: importlib.metadata.version(p) for p in pkgs},
        "ffmpeg": {k: str(v) for k, v in av.library_versions.items()},
        "delegate": "CPU",
    }


# ------------------------------------------------------------------------------------------ inference
def landmarker(model_path: Path):
    require(model_path.is_file(), "E_MODEL_MISSING", str(model_path))
    require(digest(model_path) == MODEL["sha256"], "E_MODEL_HASH_MISMATCH")
    options = mp.tasks.vision.HandLandmarkerOptions(
        base_options=mp.tasks.BaseOptions(
            model_asset_path=str(model_path), delegate=mp.tasks.BaseOptions.Delegate.CPU
        ),
        # IMAGE mode: every frame is an independent detection. No cross-frame tracking state can
        # leak a hand into a frame where the detector did not observe one.
        running_mode=mp.tasks.vision.RunningMode.IMAGE,
        num_hands=MAX_HANDS,
        min_hand_detection_confidence=MODEL["config"]["min_hand_detection_confidence"],
        min_hand_presence_confidence=MODEL["config"]["min_hand_presence_confidence"],
    )
    return mp.tasks.vision.HandLandmarker.create_from_options(options)


def hand_arrays(result, width: int, height: int):
    """Masked fixed-shape arrays. Absent hands/joints are NaN with a False mask, never fabricated."""
    image = np.full((MAX_HANDS, 21, 2), np.nan, dtype=np.float32)
    local = np.full((MAX_HANDS, 21, 3), np.nan, dtype=np.float32)
    mask = np.zeros((MAX_HANDS, 21), dtype=bool)
    score = np.full(MAX_HANDS, np.nan, dtype=np.float32)
    label = np.full(MAX_HANDS, "", dtype="U8")
    for j, (lm, world, handed) in enumerate(
        zip(
            result.hand_landmarks,
            result.hand_world_landmarks,
            result.handedness,
            strict=True,
        )
    ):
        require(j < MAX_HANDS, "E_MODEL_TOO_MANY_HANDS")
        require(
            len(lm) == 21 and len(world) == 21,
            "E_MODEL_LANDMARK_SHAPE",
            (len(lm), len(world)),
        )
        image[j] = [
            [p.x * width, p.y * height] for p in lm
        ]  # normalized -> source raster pixels
        local[j] = [[p.x, p.y, p.z] for p in world]
        mask[j] = np.isfinite(image[j]).all(axis=1) & np.isfinite(local[j]).all(axis=1)
        side = handed[0].category_name.lower()
        require(side in ("left", "right"), "E_MODEL_HANDEDNESS", side)
        label[j], score[j] = side, handed[0].score
    return image, local, mask, score, label


# ------------------------------------------------------------------------------------------ clip output
class Clip:
    def __init__(self, root: Path, index: int, units: list[sc.AccessUnit]):
        self.dir = root / f"clip-{index:03d}"
        self.dir.mkdir()
        self.units = units
        self.origin = units[0].encoder_pts_us
        self.rows: list[dict] = []
        self.arrays: dict[str, list] = {
            k: [] for k in ("image", "local", "mask", "score", "label")
        }
        self.mp4 = av.open(str(self.dir / "rgb.mp4"), "w")
        self.stream = None
        self.rec = rr.RecordingStream(
            "stateaction-sa61-clip", recording_id=f"sa61-clip-{index:03d}"
        )
        self.rec.save(str(self.dir / "viewer.rrd"))
        # Allowlisted, customer-safe entities only: video, overlays, labelled model-relative 3D, notes.
        self.rec.log("rgb", rr.VideoStream(codec=rr.VideoCodec.H264), static=True)
        self.rec.log(
            "notes/model_relative_3d", rr.TextDocument(MODEL_3D_NOTE), static=True
        )
        self.rec.send_blueprint(
            rrb.Horizontal(
                rrb.Spatial2DView(origin="rgb", name="RGB + detected hands (image px)"),
                rrb.Vertical(
                    rrb.Spatial3DView(
                        origin="model_relative_3d/left",
                        name="Left: model-relative 3D estimate",
                    ),
                    rrb.Spatial3DView(
                        origin="model_relative_3d/right",
                        name="Right: model-relative 3D estimate",
                    ),
                    rrb.TextDocumentView(origin="notes", name="Notes"),
                ),
                column_shares=[3, 2],
            )
        )

    def add(
        self, unit: sc.AccessUnit, frame: av.VideoFrame, rgb: np.ndarray, result
    ) -> int:
        clip_pts = sc.clip_pts(unit, self.units)
        h, w = rgb.shape[:2]
        if self.stream is None:
            self.stream = self.mp4.add_stream("h264", rate=30)
            self.stream.width, self.stream.height = w, h
            self.stream.time_base = TIME_BASE
            self.raster = [w, h]
        require([w, h] == self.raster, "E_RASTER_CHANGED_IN_CLIP")
        # Native remux: the original Annex B AU enters the MP4 muxer unchanged (no transcode).
        packet = av.Packet(unit.data)
        packet.pts = packet.dts = clip_pts
        packet.time_base = TIME_BASE
        packet.stream = self.stream
        packet.is_keyframe = unit.idr
        self.mp4.mux(packet)

        image, local, mask, score, label = hand_arrays(result, w, h)
        rec = self.rec
        rec.set_time("clip_time", duration=np.timedelta64(clip_pts * 1000, "ns"))
        rec.set_time("source_frame", sequence=int(unit.source_frame_id))
        rec.log(
            "rgb", rr.VideoStream.from_fields(sample=unit.data, is_keyframe=unit.idr)
        )
        for side in (
            "left",
            "right",
        ):  # missing hands clear prior drawings at this exact time
            rec.log(f"rgb/hands/{side}", rr.Clear(recursive=True))
            rec.log(f"model_relative_3d/{side}", rr.Clear(recursive=True))
        for j in range(MAX_HANDS):
            if not mask[j].any():
                continue
            side, color = str(label[j]), SIDE_COLORS[str(label[j])]
            ok = mask[j]
            edges = [(a, b) for a, b in HAND_EDGES if ok[a] and ok[b]]
            rec.log(
                f"rgb/hands/{side}/joints",
                rr.Points2D(image[j][ok], radii=max(2.0, w / 320), colors=color),
            )
            rec.log(
                f"model_relative_3d/{side}/joints",
                rr.Points3D(local[j][ok], radii=0.004, colors=color),
            )
            if edges:
                rec.log(
                    f"rgb/hands/{side}/bones",
                    rr.LineStrips2D([image[j][[a, b]] for a, b in edges], colors=color),
                )
                rec.log(
                    f"model_relative_3d/{side}/bones",
                    rr.LineStrips3D([local[j][[a, b]] for a, b in edges], colors=color),
                )
        for key, value in zip(self.arrays, (image, local, mask, score, label)):
            self.arrays[key].append(value)
        self.rows.append(
            {
                "source_index": unit.index,
                "mcap_sequence": unit.sequence,
                "source_frame_id": unit.source_frame_id,
                "source_pts": str(unit.encoder_pts_us),
                "source_time_base": list(sc.TIME_BASE),
                "source_pts_origin": str(self.origin),
                "clip_pts": str(clip_pts),
                "clip_time_ns": str(clip_pts * 1000),
                "capture_time_ns": unit.capture_time_ns,
                "mcap_log_time_ns": unit.log_time_ns,
                "frame_id": unit.frame_id,
                "idr": unit.idr,
                "access_unit_sha256": unit.sha256,
                "source_vcl_sha256": unit.vcl_sha256,
                "decoded_rgb_sha256": hashlib.sha256(rgb.tobytes()).hexdigest(),
                "raster": [w, h],
                "hands_detected": int(mask.any(axis=1).sum()),
                "handedness": [str(x) or None for x in label],
            }
        )
        return int(mask.any(axis=1).sum())

    def close(self) -> dict:
        self.mp4.close()
        self.rec.flush()
        self.rec.disconnect()
        rrd = self.dir / "viewer.rrd"
        require(rrd.stat().st_size <= MAX_RRD_BYTES, "E_RRD_LIMIT", rrd.stat().st_size)
        a = self.arrays
        np.savez_compressed(
            self.dir / "hands.npz",
            image_landmarks_px=np.array(a["image"]),
            model_relative_landmarks_m=np.array(a["local"]),
            landmark_mask=np.array(a["mask"]),
            handedness_score=np.array(a["score"]),
            handedness_label=np.array(a["label"]),
            source_frame_id=np.array([r["source_frame_id"] for r in self.rows]),
            clip_pts_us=np.array(
                [int(r["clip_pts"]) for r in self.rows], dtype=np.int64
            ),
        )
        (self.dir / "frame-map.jsonl").write_text(
            "".join(json.dumps(r, sort_keys=True) + "\n" for r in self.rows)
        )
        self._verify_mp4()
        return {
            "directory": self.dir.name,
            "frames": len(self.rows),
            "first_source_frame_id": self.rows[0]["source_frame_id"],
            "last_source_frame_id": self.rows[-1]["source_frame_id"],
            "source_pts_origin": str(self.origin),
            "raster": self.raster,
            "frames_with_hands": sum(1 for r in self.rows if r["hands_detected"]),
            "hand_observations": sum(r["hands_detected"] for r in self.rows),
            "mp4_independent_decode": {
                "pts_exact": True,
                "pixels_exact": True,
                "vcl_nal_bytes_exact": True,
            },
            "files": {
                p.name: {"bytes": p.stat().st_size, "sha256": digest(p)}
                for p in sorted(self.dir.iterdir())
            },
        }

    def _verify_mp4(self) -> None:
        """Independent output decode: exact clip PTS, decoded pixels and encoded VCL NAL bytes."""
        path = str(self.dir / "rgb.mp4")
        with av.open(path) as src:
            got = [(Fraction(f.pts) * f.time_base, hashlib.sha256(f.to_ndarray(format="rgb24").tobytes()).hexdigest())
                   for f in src.decode(video=0)]  # fmt: skip
        want = [
            (Fraction(int(r["clip_pts"])) * TIME_BASE, r["decoded_rgb_sha256"])
            for r in self.rows
        ]
        require([g[0] for g in got] == [w[0] for w in want], "E_MP4_PTS_OR_COUNT")
        require([g[1] for g in got] == [w[1] for w in want], "E_MP4_PIXELS_CHANGED")
        with av.open(path) as src:
            nal_len = (src.streams.video[0].codec_context.extradata[4] & 3) + 1
            packets = [bytes(p) for p in src.demux(video=0) if p.size]
        require(len(packets) == len(self.rows), "E_MP4_PACKET_COUNT")
        for row, data in zip(self.rows, packets, strict=True):
            pos, vcl = 0, []
            while pos < len(data):
                n = int.from_bytes(data[pos : pos + nal_len], "big")
                pos += nal_len
                nal = data[pos : pos + n]
                pos += n
                require(bool(nal) and pos <= len(data), "E_MP4_NAL_LENGTH")
                if nal[0] & 31 in (1, 5):
                    vcl.append(hashlib.sha256(nal).hexdigest())
            require(
                vcl == row["source_vcl_sha256"],
                "E_MP4_VCL_CHANGED",
                row["source_frame_id"],
            )


# ------------------------------------------------------------------------------------------ process
def process(source: Path, out: Path, *, model: Path, max_clip_seconds: float, expected_sha256: str | None,
            max_source_bytes: int, input_class: str) -> dict:  # fmt: skip
    out.mkdir(parents=True, exist_ok=False)
    t0 = time.perf_counter()
    rss = {"start_mib": rss_mib()}
    capture = sc.load(
        source, max_bytes=max_source_bytes, expected_sha256=expected_sha256
    )
    t_gate = time.perf_counter()
    rss["after_strict_gate_mib"] = rss_mib()
    clips = sc.plan_clips(capture.access_units, round(max_clip_seconds * 1_000_000))
    detector = landmarker(model)
    rss["after_model_load_mib"] = rss_mib()
    decoder = av.CodecContext.create("h264", "r")
    decoder.thread_count = 1  # deterministic, sequential decode
    decoder.options = {"err_detect": "explode"}
    infer_ns: list[int] = []
    decode_ns = 0
    decoded_order: list[str] = []
    results: list[dict] = []
    total_hands = 0
    with detector:
        for index, units in enumerate(clips):
            clip = Clip(out, index, units)
            pending: dict[int, sc.AccessUnit] = {}

            def consume(frames):
                nonlocal total_hands
                for frame in frames:
                    require(frame.pts in pending, "E_DECODER_UNKNOWN_PTS", frame.pts)
                    unit = pending.pop(frame.pts)
                    require(
                        not pending or min(pending) > frame.pts, "E_DECODER_REORDERED"
                    )
                    require(
                        frame.width <= MAX_DIMENSION and frame.height <= MAX_DIMENSION,
                        "E_DIMENSION_LIMIT",
                    )
                    rgb = frame.to_ndarray(format="rgb24")
                    t = time.perf_counter_ns()
                    result = detector.detect(
                        mp.Image(
                            image_format=mp.ImageFormat.SRGB,
                            data=np.ascontiguousarray(rgb),
                        )
                    )
                    infer_ns.append(time.perf_counter_ns() - t)
                    total_hands += clip.add(unit, frame, rgb, result)
                    decoded_order.append(unit.source_frame_id)

            for unit in units:
                require(len(pending) < MAX_PENDING, "E_DECODER_PENDING_LIMIT")
                pending[unit.encoder_pts_us] = unit
                packet = av.Packet(unit.data)
                packet.pts = packet.dts = unit.encoder_pts_us
                packet.time_base = TIME_BASE
                t = time.perf_counter_ns()
                frames = decoder.decode(packet)
                decode_ns += time.perf_counter_ns() - t
                consume(frames)
            # Clip boundaries are IDRs; drain delayed output so no frame crosses a clip.
            consume(decoder.decode(None))
            require(not pending, "E_DECODER_UNRESOLVED_FRAMES", sorted(pending))
            decoder = av.CodecContext.create("h264", "r")
            decoder.thread_count = 1
            decoder.options = {"err_detect": "explode"}
            results.append(clip.close())
    require(
        decoded_order == [u.source_frame_id for u in capture.access_units],
        "E_DECODED_ORDER",
    )
    t_end = time.perf_counter()
    rss["peak_process_rss_mib"] = round(
        resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1
    )
    rss["end_mib"] = rss_mib()
    arr = np.array(infer_ns) / 1e6
    receipt = {
        "status": "passed",
        "probe": "SA-61 isolated CPU hands + Rerun probe (not the production worker)",
        "input_class": input_class,
        "source": {
            "sha256": capture.source_sha256,
            "bytes": capture.source_bytes,
            **sc.summary(capture),
        },
        "decode": {
            "decoder": "ffmpeg h264 (PyAV), one sequential pass, thread_count=1, err_detect=explode",
            "decoded_frames": len(decoded_order),
            "decoded_order_equals_source_order": True,
            "decoded_source_frame_ids": decoded_order,
            "decode_seconds": round(decode_ns / 1e9, 4),
        },
        "model": {
            **MODEL,
            "running_mode": "IMAGE",
            "num_hands": MAX_HANDS,
            "delegate": "CPU",
        },
        "inference": {
            "frames": len(infer_ns),
            "frames_with_hands": sum(c["frames_with_hands"] for c in results),
            "hand_observations": total_hands,
            "ms_per_frame": {
                "mean": round(float(arr.mean()), 2),
                "p50": round(float(np.median(arr)), 2),
                "p95": round(float(np.percentile(arr, 95)), 2),
                "max": round(float(arr.max()), 2),
            },  # fmt: skip
            "metric_accuracy_validated": False,
            "note": "Detection counts are observations only, not anatomical or metric accuracy.",
        },
        "clips": results,
        "clip_policy": {
            "split": "IDR only",
            "max_clip_seconds": max_clip_seconds,
            "clip_pts": "source_pts - first_included_source_pts",
            "time_base": list(sc.TIME_BASE),
        },  # fmt: skip
        "rrd_total_bytes": sum(c["files"]["viewer.rrd"]["bytes"] for c in results),
        "resources": {
            **rss,
            "wall_seconds": round(t_end - t0, 3),
            "strict_gate_seconds": round(t_gate - t0, 3),
        },
        "environment": environment(),
        "semantics": {
            "image_landmarks_px": "[frames, 2, 21, 2] in the encoded source raster; NaN + mask=False when absent",
            "model_relative_landmarks_m": "[frames, 2, 21, 3] model-relative estimate, NOT camera/world/metric",
            "hand_axis": "detection order within a frame, NOT tracked identity",
            "handedness": "model label/score per detection; not per-joint confidence or visibility",
            "rerun_timelines": {
                "clip_time": "duration ns = clip_pts_us * 1000",
                "source_frame": "original source_frame_id",
            },
            "unknown": [
                "camera/IMU synchronization",
                "per-joint visibility",
                "occlusion",
                "depth",
                "metric accuracy",
            ],
        },
    }
    dump(out / "receipt.json", receipt)
    return receipt


# ------------------------------------------------------------------------------------------ replay
def _legacy_jpeg(data: bytes) -> tuple[int, bytes]:
    """Known historical Stera sensor_msgs/CompressedImage CDR layout (bounded, explicit, no repair)."""
    require(data[:4] == b"\0\1\0\0", "E_LEGACY_CDR")
    sec, ns = struct.unpack_from("<iI", data, 4)
    pos = 12

    def string() -> str:
        nonlocal pos
        pos += (-(pos - 4)) % 4
        (n,) = struct.unpack_from("<I", data, pos)
        pos += 4
        require(0 < n < 1 << 20 and pos + n <= len(data), "E_LEGACY_STRING")
        value = data[pos : pos + n]
        pos += n
        return value[:-1].decode()

    string()
    require(string().lower() in ("jpeg", "jpg"), "E_LEGACY_NOT_JPEG")
    pos += (-(pos - 4)) % 4
    (n,) = struct.unpack_from("<I", data, pos)
    pos += 4
    require(pos + n == len(data), "E_LEGACY_JPEG_LENGTH")
    return sec * 1_000_000_000 + ns, data[pos:]


def replay(
    legacy: Path, out: Path, *, frames: int, start: int, width: int, height: int
) -> dict:
    from mcap.reader import NonSeekingReader

    sys.path.insert(0, str(sc.CONFORMANCE))
    import gen_golden  # published SA-50 golden writer (contract-valid Profile/Clocks/Inventory/Close)

    require(not out.exists(), "E_OUTPUT_EXISTS")
    legacy_sha = digest(legacy)
    jpegs: list[tuple[int, bytes]] = []
    with legacy.open("rb") as f:
        for schema, channel, message in NonSeekingReader(f).iter_messages(
            topics=["/camera/rgb/compressed"]
        ):
            require(
                schema.name == "sensor_msgs/msg/CompressedImage"
                and channel.message_encoding == "cdr",
                "E_LEGACY_SCHEMA",
            )
            jpegs.append(_legacy_jpeg(message.data))
            if len(jpegs) >= start + frames:
                break
    jpegs = jpegs[start:]
    require(len(jpegs) == frames, "E_LEGACY_TOO_SHORT", len(jpegs))
    mj = av.CodecContext.create("mjpeg", "r")
    (first,) = mj.decode(av.Packet(jpegs[0][1]))
    width, height = (
        width or first.width,
        height or first.height,
    )  # default: keep the source raster
    require(width % 2 == 0 and height % 2 == 0, "E_REPLAY_RASTER", (width, height))
    mj = av.CodecContext.create("mjpeg", "r")
    enc = av.CodecContext.create("libx264", "w")
    enc.width, enc.height, enc.pix_fmt, enc.time_base = (
        width,
        height,
        "yuv420p",
        TIME_BASE,
    )
    enc.framerate = Fraction(30, 1)
    enc.options = {"preset": "veryfast", "profile": "baseline", "tune": "zerolatency",
                   "x264-params": "keyint=30:min-keyint=30:scenecut=0:bframes=0:repeat-headers=1"}  # fmt: skip
    enc.open()
    aus: list[
        bytes
    ] = []  # one encoder packet == one complete access unit (SPS/PPS stay with their IDR)
    for i, (_, jpeg) in enumerate(jpegs):
        (img,) = mj.decode(av.Packet(jpeg))
        frame = img.reformat(width=width, height=height, format="yuv420p")
        frame.pts, frame.time_base = i * 33_333, TIME_BASE
        aus += [bytes(p) for p in enc.encode(frame)]
    aus += [bytes(p) for p in enc.encode(None)]
    require(len(aus) == frames, "E_REPLAY_ENCODER_COUNT", len(aus))
    # Same frame model shape as gen_golden.model(), without its single-IDR stream splitter.
    model = {"frames": [{"sid": i, "au": au, "seq": i, "pts": i * 33_333, "delay_ns": 0} for i, au in enumerate(aus)],
             "drop_ids": [], "extra": {}}  # fmt: skip
    data = gen_golden.render(model)
    capture = sc.gate(
        data
    )  # must pass the strict reader exactly like a recorder output
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(data)
    provenance = {
        "input_class": "historical_android_jpeg_replay_software_h264",
        "qualifies_phone_hardware": False,
        "legacy_source_sha256": legacy_sha,
        "legacy_frames_used": [start, start + frames],
        "legacy_native_header_ns_first_last": [str(jpegs[0][0]), str(jpegs[-1][0])],
        "transcode": f"mjpeg -> libx264 baseline {width}x{height} keyint=30 bframes=0 repeat-headers (software)",
        "contract_timing": "synthetic gen_golden model timing (33,333 us); original JPEG timing is not carried",
        "replay_mcap_sha256": capture.source_sha256,
        "replay_mcap_bytes": capture.source_bytes,
        "strict_reader_outcome": capture.result["outcome"],
        "video_messages": len(capture.access_units),
    }
    dump(out.with_suffix(".provenance.json"), provenance)
    return provenance


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("process")
    p.add_argument("source", type=Path)
    p.add_argument("output", type=Path, help="new directory (must not exist)")
    p.add_argument("--model", type=Path, default=MODEL_DEFAULT)
    p.add_argument("--max-clip-seconds", type=float, default=2.0)
    p.add_argument("--expected-sha256")
    p.add_argument("--max-source-bytes", type=int, default=sc.DEFAULT_MAX_SOURCE_BYTES)
    p.add_argument("--input-class", required=True,
                   choices=["published_golden_fixture", "historical_android_jpeg_replay_software_h264",
                            "android_emulator_spike", "physical_android_capture"])  # fmt: skip
    r = sub.add_parser("replay")
    r.add_argument("legacy", type=Path)
    r.add_argument("output", type=Path)
    r.add_argument("--frames", type=int, default=90)
    r.add_argument("--start", type=int, default=0)
    r.add_argument("--width", type=int, default=0, help="0 keeps the source raster")
    r.add_argument("--height", type=int, default=0, help="0 keeps the source raster")
    a = ap.parse_args(argv)
    try:
        if a.cmd == "process":
            res = process(a.source, a.output, model=a.model, max_clip_seconds=a.max_clip_seconds,
                          expected_sha256=a.expected_sha256, max_source_bytes=a.max_source_bytes,
                          input_class=a.input_class)  # fmt: skip
            print(
                json.dumps(
                    {
                        k: res[k]
                        for k in (
                            "status",
                            "input_class",
                            "inference",
                            "rrd_total_bytes",
                            "resources",
                        )
                    },
                    indent=2,
                )
            )
        else:
            print(
                json.dumps(
                    replay(
                        a.legacy,
                        a.output,
                        frames=a.frames,
                        start=a.start,
                        width=a.width,
                        height=a.height,
                    ),
                    indent=2,
                )
            )
    except (sc.CaptureRejected, ProbeFailure) as e:
        print(json.dumps({"status": "rejected", "error": str(e)}), file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
