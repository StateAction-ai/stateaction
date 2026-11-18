import dataclasses
import hashlib
import io
import json
import os
import tempfile
import types
import unittest
import uuid
from pathlib import Path
from unittest.mock import Mock

from indexed_fixture import chunked
from test_mcap_stream import ForwardOnly

try:
    import av  # noqa: F401
    import mediapipe  # noqa: F401
    import numpy as np
    import rerun  # noqa: F401
    import stateaction_contracts  # noqa: F401

    from stateaction_processing import (
        artifact_clip,
        artifact_export,
        artifact_reader,
        artifact_rrd,
        artifact_types,
        frames,
        hand_model,
    )

    HAVE_EXPORT = True
except ImportError:
    HAVE_EXPORT = False

GOLDEN = Path(__file__).resolve().parents[3] / "packages/contracts/capture/golden"
SHA = "a" * 64
JOB = "11111111-1111-4111-8111-111111111111"


def _have_model() -> bool:
    if not HAVE_EXPORT:
        return False
    try:
        hand_model.resolve_model()
        return True
    except hand_model.HandModelError:
        return False


HAVE_MODEL = _have_model()


def context(**kw):
    base = dict(
        fixture_identities=True,
        job_id=JOB,
        source_manifest_sha256=SHA,
        code_revision="test",
        image_spec_sha256=SHA,
        profile_revision="h264_mcap_v1",
    )
    base.update(kw)
    return artifact_types.ExportContext(**base)


@unittest.skipUnless(HAVE_EXPORT, "decode, cpu and export groups not installed")
class PureTests(unittest.TestCase):
    def test_cut_only_at_idr_and_never_beyond_ceiling(self):
        lim = artifact_types.ExportLimits(
            clip_target_seconds=2.0, clip_target_frames=100
        )
        cut = artifact_export.should_cut
        self.assertFalse(cut(1_000_000, 10, True, lim))  # young IDR: no cut
        self.assertTrue(cut(2_000_000, 10, True, lim))  # due + IDR
        self.assertFalse(cut(3_000_000, 10, False, lim))  # due but P frame: never cut
        self.assertTrue(cut(500_000, 100, True, lim))  # frame target
        with self.assertRaises(artifact_types.ExportError) as e:
            cut(60_000_001, 10, False, lim)  # no IDR within 60 s: explicit error
        self.assertEqual(e.exception.code, "E_NO_IDR_WITHIN_CLIP_CEILING")
        with self.assertRaises(artifact_types.ExportError):
            cut(1, lim.clip_max_frames, False, lim)

    def test_proxy_shape_bounds_and_orientation(self):
        lim = artifact_types.ExportLimits()
        self.assertEqual(artifact_rrd.proxy_shape(640, 480, lim), (640, 480, True))
        self.assertEqual(artifact_rrd.proxy_shape(1280, 720, lim), (1280, 720, True))
        self.assertEqual(artifact_rrd.proxy_shape(720, 1280, lim), (720, 1280, True))
        self.assertEqual(artifact_rrd.proxy_shape(641, 481, lim), (640, 480, True))
        w, h, re_enc = artifact_rrd.proxy_shape(1920, 1080, lim)
        self.assertEqual((w, h, re_enc), (1280, 720, True))
        w, h, re_enc = artifact_rrd.proxy_shape(3840, 2160, lim)
        self.assertTrue(re_enc and w <= 1280 and h <= 720 and w % 2 == 0 and h % 2 == 0)
        w, h, re_enc = artifact_rrd.proxy_shape(1080, 1920, lim)
        self.assertTrue(re_enc and (w, h) == (720, 1280))

    def test_fitting_raster_proxy_excludes_native_user_data_sei(self):
        width, height = 64, 48
        rgb = np.full((height, width, 3), (32, 120, 220), dtype=np.uint8)
        limits = artifact_types.ExportLimits()
        source_encoder = artifact_rrd.ProxyEncoder(width, height, limits)
        [(source, keyframe, _)] = source_encoder.encode(rgb, 0) + source_encoder.flush()
        self.assertTrue(keyframe)
        marker = b"synthetic-private-user-data"
        payload = b"a" * 16 + marker
        sei = b"\x00\x00\x00\x01\x06\x05" + bytes([len(payload)]) + payload + b"\x80"
        au = types.SimpleNamespace(
            data=source + sei,
            is_idr=True,
            sequence=1,
            encoder_pts_us=100,
            native_clock_id="fixture-clock",
            native_timestamp_ns="100000",
            source_frame_id="7",
        )
        frame = types.SimpleNamespace(
            access_unit=au,
            rgb=rgb,
            transform=types.SimpleNamespace(raster=(width, height)),
        )
        obs = types.SimpleNamespace(
            landmark_mask=np.zeros((2, 21), dtype=bool),
            image_landmarks_px=np.zeros((2, 21, 2), dtype=np.float32),
            model_relative_landmarks_m=np.zeros((2, 21, 3), dtype=np.float32),
            hand_present=np.zeros(2, dtype=bool),
            handedness_score=np.zeros(2, dtype=np.float32),
            handedness_label=("", ""),
        )

        with tempfile.TemporaryDirectory() as scratch:
            writer = artifact_clip.ClipWriter(
                Path(scratch), 0, str(uuid.uuid4()), JOB, frame, limits
            )
            native_packets = []

            def mux(packet):
                native_packets.append(bytes(packet))
                native_mux.mux(packet)

            native_mux = writer.mp4
            writer.mp4 = types.SimpleNamespace(mux=mux)
            writer.rrd._sample = Mock(wraps=writer.rrd._sample)
            try:
                writer.add(frame, obs)
                detail = writer.rrd.close()
            finally:
                native_mux.close()

            self.assertEqual(native_packets, [au.data])
            self.assertEqual(detail["proxy_raster"], [width, height])
            self.assertEqual(detail["samples"], 1)
            self.assertTrue(detail["reencoded"])
            proxy, is_idr = writer.rrd._sample.call_args.args
            self.assertTrue(is_idr)
            self.assertNotIn(marker, proxy)

    def test_proxy_encode_preserves_color_and_irregular_microsecond_pts(self):
        # A decoder-success check alone missed near-flat grey proxies when
        # libx264 inferred 1,000,000 fps from the microsecond time base.
        from fractions import Fraction

        width, height = 320, 180
        y, x = np.indices((height, width))
        expected = []
        stamps = [i * 33333 + (7123 if i >= 12 else 0) for i in range(30)]
        encoder = artifact_rrd.ProxyEncoder(
            width, height, artifact_types.ExportLimits()
        )
        packets = []
        for i, pts in enumerate(stamps):
            rgb = np.stack(
                (
                    (x + i * 3) % 256,
                    (y * 2 + i) % 256,
                    ((x // 16 + y // 16 + i // 5) % 2) * 255,
                ),
                axis=-1,
            ).astype(np.uint8)
            expected.append(rgb)
            packets.extend(encoder.encode(rgb, pts))
        packets.extend(encoder.flush())
        decoder = av.CodecContext.create("h264", "r")
        decoded = []
        for data, _, pts in packets:
            packet = av.Packet(data)
            packet.pts = packet.dts = pts
            packet.time_base = Fraction(1, 1000000)
            decoded.extend(decoder.decode(packet))
        decoded.extend(decoder.decode(None))
        self.assertEqual([frame.pts for frame in decoded], stamps)
        for frame, want in zip(decoded, expected, strict=True):
            actual = frame.to_ndarray(format="rgb24")
            self.assertGreater(float(actual.std()), 40)
            error = np.abs(actual.astype(np.int16) - want.astype(np.int16)).mean()
            self.assertLess(float(error), 8, "proxy lost the actual RGB content")

    def test_local_sink_never_overwrites_and_aborts_cleanly(self):
        with tempfile.TemporaryDirectory() as d:
            scratch, root = Path(d) / "s", Path(d) / "out"
            scratch.mkdir()
            f = scratch / "a.bin"
            f.write_bytes(b"x")
            out = artifact_types.make_output("clip_mp4", "clips/000/a.bin", f, 0)
            sink = artifact_types.LocalDirectorySink(root)
            sink.put(out)
            self.assertFalse(f.exists())
            self.assertEqual((root / "clips/000/a.bin").read_bytes(), b"x")
            g = scratch / "b.bin"
            g.write_bytes(b"y")
            with self.assertRaises(artifact_types.ExportError) as e:
                sink.put(
                    artifact_types.make_output("clip_mp4", "clips/000/a.bin", g, 0)
                )
            self.assertEqual(e.exception.code, "E_OUTPUT_EXISTS")
            self.assertEqual((root / "clips/000/a.bin").read_bytes(), b"x")
            sink.abort("test")
            self.assertEqual(list(root.rglob("*")), [])
            # A retry on a non-empty prefix is refused.
            (root / "stale").write_bytes(b"1")
            with self.assertRaises(artifact_types.ExportError) as e:
                artifact_types.LocalDirectorySink(root)
            self.assertEqual(e.exception.code, "E_OUTPUT_PREFIX_NOT_EMPTY")

    def test_production_identity_is_required_and_receipts_must_match(self):
        sink = artifact_types.CallbackSink(print, print)
        full = dict(
            fixture_identities=False,
            recording_id=str(uuid.uuid4()),
            source_file_id=str(uuid.uuid4()),
            expected_source_sha256=SHA,
        )
        for drop in (None, "recording_id", "source_file_id", "expected_source_sha256"):
            kw = {k: v for k, v in full.items() if k != drop}
            if drop is None:
                kw["recording_id"] = None
            with self.assertRaises(artifact_types.ExportError) as e:
                artifact_export.export_artifacts(io.BytesIO(b""), sink, context(**kw))
            self.assertEqual(e.exception.code, "E_IDENTITY_REQUIRED", drop)

    def test_limits_are_validated(self):
        for bad in (
            dict(clip_target_seconds=61.0),
            dict(clip_ceiling_seconds=61.0),
            dict(clip_target_frames=0),
            dict(clip_max_frames=7201),
        ):
            lim = dataclasses.replace(artifact_types.ExportLimits(), **bad)
            with self.assertRaises(artifact_types.ExportError):
                artifact_export.export_artifacts(
                    io.BytesIO(b""),
                    artifact_types.CallbackSink(print, print),
                    context(),
                    limits=lim,
                )

    def test_forbidden_strings_are_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "x.rrd"
            p.write_bytes(b"....private-user-dir/secret....")
            artifact_export._scan_forbidden(p, ("not-present-here",))
            with self.assertRaises(artifact_types.ExportError):
                artifact_export._scan_forbidden(p, ("private-user-dir/secret",))


@unittest.skipUnless(HAVE_MODEL, "pinned MediaPipe model not in local cache")
class RealPipelineTests(unittest.TestCase):
    def golden(self):
        return chunked((GOLDEN / "valid.mcap").read_bytes())

    def run_export(self, data, root, **kw):
        sink = artifact_types.LocalDirectorySink(root)
        return artifact_export.export_artifacts(
            ForwardOnly(data), sink, context(), **kw
        )

    def test_golden_export_round_trips_through_reader(self):
        data = self.golden()
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "out"
            res = self.run_export(data, root)
            self.assertEqual(res.frames, 5)
            self.assertEqual(res.source_sha256, hashlib.sha256(data).hexdigest())
            self.assertEqual(len(res.clips), 1)
            got = artifact_reader.open_result(root, require_contracts=True)
            self.assertTrue(got.contract_validated)
            self.assertEqual(got.manifest_sha256, res.manifest_sha256)
            self.assertEqual(
                got.provenance["verified_sources"][0]["sha256"], res.source_sha256
            )
            clip = got.clips[0]
            arrays = clip.arrays()
            self.assertEqual(arrays["image_landmarks_px"].shape, (5, 2, 21, 2))
            self.assertFalse(
                arrays["hand_detected"].any()
            )  # golden has no hands: masked, not fabricated
            self.assertTrue(np.isnan(arrays["model_relative_joints"]).all())
            t = clip.timestamps()
            self.assertEqual(int(t["clip_pts"][0]), 0)
            self.assertTrue(
                np.array_equal(t["clip_pts"], t["source_pts"] - t["source_pts"][0])
            )
            self.assertEqual(clip.verify_roundtrip()["frames"], 5)
            self.assertEqual(clip.verify_mp4()["packets"], 5)
            # No workstation path leaked into any output.
            for p in root.rglob("*"):
                if p.is_file():
                    self.assertNotIn(str(Path.home()).encode(), p.read_bytes())

    def test_attested_v2_export_round_trips_through_reader(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch) / "out"
            result = artifact_export.export_artifacts(
                ForwardOnly(self.golden()),
                artifact_types.LocalDirectorySink(root),
                context(
                    source_file_id=JOB,
                    attestation=artifact_types.Attestation(
                        invocation_nonce="a" * 43,
                        rgb_profile="h264_mcap_v1",
                    ),
                ),
            )

            read = artifact_reader.open_result(root, require_contracts=True)
            self.assertTrue(read.contract_validated)
            self.assertEqual(
                read.manifest["schema"], "stateaction.processing_result.v2"
            )
            self.assertEqual(read.manifest_sha256, result.manifest_sha256)
            self.assertEqual(read.clips[0].verify_roundtrip()["frames"], 5)

    def test_manifest_cites_store_receipt_ids_and_rejects_wrong_receipts(self):
        ids = {}

        def put(o):
            ids[o.relative_path] = str(uuid.uuid4())  # server-selected random id
            return artifact_types.OutputReceipt(
                ids[o.relative_path], o.role, o.size_bytes, o.sha256
            )

        def seal(o):
            return artifact_types.OutputReceipt(
                str(uuid.uuid4()), o.role, o.size_bytes, o.sha256
            )

        res = artifact_export.export_artifacts(
            ForwardOnly(self.golden()),
            artifact_types.CallbackSink(put, seal),
            context(
                fixture_identities=False,
                recording_id=str(uuid.uuid4()),
                source_file_id=str(uuid.uuid4()),
                expected_source_sha256=hashlib.sha256(self.golden()).hexdigest(),
            ),
        )
        cited = {o["relative_path"]: o["file_id"] for o in res.manifest["outputs"]}
        self.assertEqual(cited, ids)
        self.assertNotIn("fixtures", " ".join(res.manifest["limitations"]))

        def bad_put(o):
            return artifact_types.OutputReceipt(
                str(uuid.uuid4()), o.role, o.size_bytes, "0" * 64
            )

        with self.assertRaises(artifact_types.ExportError) as e:
            artifact_export.export_artifacts(
                ForwardOnly(self.golden()),
                artifact_types.CallbackSink(bad_put, seal),
                context(),
            )
        self.assertEqual(e.exception.code, "E_RECEIPT_MISMATCH")

    def test_same_label_hands_and_no_hand_use_distinct_slot_entities(self):
        from stateaction_processing import artifact_rrd as rrdmod

        calls = []
        times = {}
        sample_times = []

        class Rec:
            def set_time(self, timeline, **time):
                times[timeline] = next(iter(time.values()))

            def log(self, path, *a, **k):
                calls.append(path)
                if path == "rgb":
                    sample_times.append(times.copy())

        w = object.__new__(rrdmod.RrdWriter)
        w._rr = __import__("rerun")
        w.rec, w.sx, w.sy, w.pw, w.samples = Rec(), 1.0, 1.0, 640, 0
        w._source_frames = {}
        w.encoder = types.SimpleNamespace(
            encode=lambda rgb, pts: [(b"x", True, 0)] if pts else [],
        )
        pts = np.full((2, 21, 2), 10.0, dtype=np.float32)
        loc = np.zeros((2, 21, 3), dtype=np.float32)
        ok = np.ones((2, 21), dtype=bool)

        def obs(present):
            return types.SimpleNamespace(
                hand_present=np.array(present),
                landmark_mask=ok & np.array(present)[:, None],
                handedness_label=("right", "right"),
                handedness_score=np.array([0.9, 0.8], dtype=np.float32),
                image_landmarks_px=pts,
                model_relative_landmarks_m=loc,
            )

        w.add(None, 0, 1, obs([True, True]))
        both = [c for c in calls if c.endswith("/joints")]
        self.assertIn("rgb/hands/hand0/joints", both)
        self.assertIn("rgb/hands/hand1/joints", both)  # same label, distinct entities
        self.assertFalse(any("/left" in c or "/right" in c for c in calls))
        calls.clear()
        w.add(None, 33333, 2, obs([False, False]))
        self.assertEqual(
            sample_times, [{"clip_time": np.timedelta64(0, "ns"), "source_frame": 1}]
        )
        self.assertEqual(
            times, {"clip_time": np.timedelta64(33_333_000, "ns"), "source_frame": 2}
        )
        self.assertFalse(any(c.endswith("/joints") for c in calls))
        self.assertEqual(
            [c for c in calls if "hands/hand" in c and not c.endswith("/joints")],
            ["rgb/hands/hand0", "rgb/hands/hand1"],
        )  # both slots cleared on the no-hand frame

    def test_manifest_is_last_and_files_precede_acceptance(self):
        events = []

        def receipt(o):
            return artifact_types.OutputReceipt(
                str(uuid.uuid4()), o.role, o.size_bytes, o.sha256
            )

        def put(o):
            events.append(("put", o.role))
            return receipt(o)

        def seal(o):
            events.append(("seal", o.role))
            return receipt(o)

        sink = artifact_types.CallbackSink(
            put, seal, lambda r: events.append(("abort", r))
        )
        artifact_export.export_artifacts(
            ForwardOnly(self.golden()), sink, context(fixture_identities=True)
        )
        self.assertEqual(events[-1], ("seal", "result_manifest"))
        self.assertEqual(sum(1 for e in events if e[0] == "seal"), 1)
        self.assertEqual([e[1] for e in events[:-1]].count("viewer_rrd"), 1)
        self.assertNotIn("abort", [e[0] for e in events])

    def test_truncated_source_publishes_nothing(self):
        data = self.golden()
        for cut in (len(data) - 5, len(data) // 2):
            with tempfile.TemporaryDirectory() as d:
                root = Path(d) / "out"
                with self.assertRaises(Exception):
                    self.run_export(data[:cut], root)
                self.assertEqual([p for p in root.rglob("*") if p.is_file()], [])
                with self.assertRaises(artifact_reader.ArtifactError):
                    artifact_reader.open_result(root)

    def test_decoder_failure_after_valid_footer_publishes_no_manifest(self):
        from stateaction_processing.h264_decode import DecodeError

        class Boom(frames.H264Decoder):
            def decode(self, units):
                yield from super().decode(units)
                raise DecodeError("E_DECODE_FAILED", "final flush")

        orig, frames.H264Decoder = frames.H264Decoder, Boom
        try:
            with tempfile.TemporaryDirectory() as d:
                root = Path(d) / "out"
                with self.assertRaises(DecodeError):
                    self.run_export(self.golden(), root)
                self.assertFalse((root / artifact_types.MANIFEST_NAME).exists())
                self.assertEqual([p for p in root.rglob("*") if p.is_file()], [])
        finally:
            frames.H264Decoder = orig

    def test_wrong_expected_source_hash_fails_before_manifest(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "out"
            sink = artifact_types.LocalDirectorySink(root)
            with self.assertRaises(artifact_types.ExportError) as e:
                artifact_export.export_artifacts(
                    ForwardOnly(self.golden()),
                    sink,
                    context(expected_source_sha256="0" * 64),
                )
            self.assertEqual(e.exception.code, "E_SOURCE_SHA_MISMATCH")
            self.assertEqual([p for p in root.rglob("*") if p.is_file()], [])

    def test_each_frame_is_decoded_and_inferred_once(self):
        from stateaction_processing import hands

        calls = []
        orig = hands.HandInferencer.infer

        def counting(self, frame):
            calls.append(frame.access_unit.sequence)
            return orig(self, frame)

        hands.HandInferencer.infer = counting  # type: ignore[method-assign]
        try:
            with tempfile.TemporaryDirectory() as d:
                res = self.run_export(self.golden(), Path(d) / "out")
        finally:
            hands.HandInferencer.infer = orig  # type: ignore[method-assign]
        self.assertEqual(calls, [0, 1, 2, 3, 4])
        measured = {c["code"]: c for c in res.manifest["checks"]}[
            "decode_and_inference_once"
        ]
        self.assertEqual(measured["measurements"]["decoder_instances"], "1")

    def test_idr_cuts_make_multiple_immutable_clips(self):
        """Flag frames 0, 2 and 4 as IDR (flag only; bytes are unchanged) and cut every 2 frames."""

        class Flagged(frames.FrameStream):
            def __iter__(self):
                for f in super().__iter__():
                    if f.access_unit.sequence in (0, 2, 4):
                        au = dataclasses.replace(f.access_unit, is_idr=True)
                        f = dataclasses.replace(f, access_unit=au)
                    yield f

        orig, artifact_export.FrameStream = artifact_export.FrameStream, Flagged
        try:
            with tempfile.TemporaryDirectory() as d:
                res = self.run_export(
                    self.golden(),
                    Path(d) / "out",
                    limits=dataclasses.replace(
                        artifact_types.ExportLimits(), clip_target_frames=2
                    ),
                )
                got = artifact_reader.open_result(
                    Path(d) / "out", require_contracts=True
                )
                self.assertEqual([c["frame_count"] for c in res.clips], [2, 2, 1])
                self.assertEqual([c.meta["clip_ordinal"] for c in got.clips], [0, 1, 2])
                for clip in got.clips:  # clip_pts rebased per clip, source_pts retained
                    t = clip.timestamps()
                    self.assertEqual(int(t["clip_pts"][0]), 0)
                    self.assertGreater(int(t["source_pts"][0]), -1)
                starts = [int(c.timestamps()["source_pts"][0]) for c in got.clips]
        finally:
            artifact_export.FrameStream = orig
        self.assertEqual(starts, sorted(starts))
        self.assertEqual(len(set(starts)), 3)

    def test_reader_refuses_unsafe_manifest_paths_without_validators(self):
        import sys
        from unittest import mock

        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "out"
            self.run_export(self.golden(), root)
            good = json.loads((root / artifact_types.MANIFEST_NAME).read_text())
            outside = Path(d) / "outside.bin"
            outside.write_bytes(b"secret")
            cases = {
                "absolute": str(outside),
                "dotdot": "../outside.bin",
                "dot": "clips/./000/rgb.mp4",
                "backslash": "clips\\000\\rgb.mp4",
            }
            with mock.patch.dict(sys.modules, {"stateaction_contracts": None}):
                for name, rel in cases.items():
                    bad = json.loads(json.dumps(good))
                    bad["outputs"][0]["relative_path"] = rel
                    (root / artifact_types.MANIFEST_NAME).write_text(json.dumps(bad))
                    with self.assertRaises(
                        artifact_reader.ArtifactError, msg=name
                    ) as e:
                        artifact_reader.open_result(root)
                    self.assertEqual(e.exception.code, "E_UNSAFE_PATH", name)
            # A symlinked parent directory escaping the prefix is refused as well.
            (root / artifact_types.MANIFEST_NAME).write_text(json.dumps(good))
            real = root / "clips"
            moved = Path(d) / "elsewhere"
            real.rename(moved)
            real.symlink_to(moved, target_is_directory=True)
            with mock.patch.dict(sys.modules, {"stateaction_contracts": None}):
                with self.assertRaises(artifact_reader.ArtifactError) as e:
                    artifact_reader.open_result(root)
            self.assertEqual(e.exception.code, "E_UNSAFE_PATH_SYMLINK")

    def test_tampered_artifact_is_rejected_by_reader(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "out"
            self.run_export(self.golden(), root)
            target = next(root.rglob("frame-map.json"))
            raw = bytearray(target.read_bytes())
            raw[raw.index(b"timing_verified") + 17] ^= (
                0x01  # same length, different byte
            )
            target.write_bytes(bytes(raw))
            with self.assertRaises(artifact_reader.ArtifactError) as e:
                artifact_reader.open_result(root)
            self.assertEqual(e.exception.code, "E_OUTPUT_SHA256")
            # An unlisted extra file is rejected too.
            (root / "extra.bin").write_bytes(b"1")
            with self.assertRaises(artifact_reader.ArtifactError):
                artifact_reader.open_result(root)

    @unittest.skipUnless(
        os.environ.get("STATEACTION_HAND_FIXTURE"),
        "set STATEACTION_HAND_FIXTURE to an indexed capture containing hands",
    )
    def test_real_positive_example_exports_and_round_trips_hands(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d) / "out"
            sink = artifact_types.LocalDirectorySink(root)
            with open(os.environ["STATEACTION_HAND_FIXTURE"], "rb") as raw:
                res = artifact_export.export_artifacts(raw, sink, context())
            self.assertGreaterEqual(
                res.missingness.frames_one_hand + res.missingness.frames_two_hands, 1
            )
            got = artifact_reader.open_result(root, require_contracts=True)
            for clip in got.clips:
                clip.verify_roundtrip()
                clip.verify_mp4()
                a = clip.arrays()
                self.assertEqual(
                    bool(a["hand_detected"].any()),
                    json.loads(clip.paths["hand_observations_json"].read_bytes())[
                        "frames"
                    ]
                    != []
                    and any(f["hands"] for f in clip.hand_observations()["frames"]),
                )


if __name__ == "__main__":
    unittest.main()
