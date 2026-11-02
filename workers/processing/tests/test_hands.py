import hashlib
import io
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace as NS

from indexed_fixture import chunked
from test_mcap_stream import ForwardOnly

try:
    import av  # noqa: F401
    import mediapipe  # noqa: F401
    import numpy as np
    from stateaction_processing import hand_model, hand_stream, hands
    from stateaction_processing.h264_decode import DecodedFrame, FrameTransform

    HAVE_CPU = True
except ImportError:
    HAVE_CPU = False

GOLDEN = Path(__file__).resolve().parents[3] / "packages/contracts/capture/golden"


def _have_model() -> bool:
    if not HAVE_CPU:
        return False
    try:
        hand_model.resolve_model()
        return True
    except hand_model.HandModelError:
        return False


HAVE_MODEL = _have_model()


def point(x, y, z=0.0):
    return NS(x=x, y=y, z=z)


def hand(offset=0.0, bad=None):
    pts = [point(0.25 + offset + i * 0.01, 0.5 + i * 0.005) for i in range(21)]
    worlds = [point(0.001 * i, -0.001 * i, 0.002 * i) for i in range(21)]
    if bad is not None:
        pts[bad] = point(float("nan"), 0.5)
    return pts, worlds


def result(*hs, sides=("Left", "Right"), scores=(0.9, 0.8)):
    return NS(
        hand_landmarks=[h[0] for h in hs],
        hand_world_landmarks=[h[1] for h in hs],
        handedness=[
            [NS(category_name=sides[i], score=scores[i])] for i in range(len(hs))
        ],
    )


def fake_frame(width=200, height=100):
    au = NS(
        sequence=7,
        source_frame_id="f-7",
        encoder_pts_us=777,
        capture_time_ns="1",
        log_time_ns="2",
        native_clock_id="clk",
        native_timestamp_ns="3",
        native_timestamps={"a": "3"},
        calibration_id="cal",
        sha256="ab" * 32,
    )
    return DecodedFrame(
        np.zeros((height, width, 3), np.uint8), au, FrameTransform((width, height))
    )


@unittest.skipUnless(HAVE_CPU, "decode and cpu dependency groups not installed")
class MappingTests(unittest.TestCase):
    def test_no_hand_is_masked_output_not_an_error(self):
        o = hands.observation_from_result(result(), fake_frame())
        self.assertEqual(o.hands_detected, 0)
        self.assertFalse(o.landmark_mask.any())
        self.assertTrue(np.isnan(o.image_landmarks_px).all())
        self.assertTrue(np.isnan(o.model_relative_landmarks_m).all())
        self.assertTrue(np.isnan(o.handedness_score).all())
        self.assertEqual(o.handedness_label, ("", ""))

    def test_two_hands_pixels_3d_and_identity(self):
        o = hands.observation_from_result(result(hand(), hand(0.4)), fake_frame())
        self.assertEqual(o.hands_detected, 2)
        self.assertEqual(o.image_landmarks_px.shape, (2, 21, 2))
        self.assertEqual(o.model_relative_landmarks_m.shape, (2, 21, 3))
        self.assertEqual(o.landmark_mask.shape, (2, 21))
        self.assertTrue(o.landmark_mask.all())
        np.testing.assert_allclose(o.image_landmarks_px[0, 0], (50.0, 50.0), rtol=1e-6)
        np.testing.assert_allclose(
            o.model_relative_landmarks_m[0, 20], (0.02, -0.02, 0.04), rtol=1e-6
        )
        self.assertEqual(o.handedness_label, ("left", "right"))
        np.testing.assert_allclose(o.handedness_score, (0.9, 0.8), rtol=1e-6)
        i = o.identity
        self.assertEqual(
            (i.sequence, i.source_frame_id, i.encoder_pts_us, i.native_clock_id),
            (7, "f-7", 777, "clk"),
        )
        self.assertEqual(o.transform.raster, (200, 100))
        self.assertIsNone(o.transform.rotation_deg)
        self.assertIsNone(o.transform.mirror)

    def test_semantics_never_claim_confidence_or_metric_accuracy(self):
        o = hands.observation_from_result(result(hand()), fake_frame())
        self.assertFalse(o.metric_accuracy_validated)
        self.assertIsNone(o.joint_confidence)
        self.assertIsNone(o.joint_visibility)
        self.assertEqual(o.semantics["joint_confidence"], "unsupported")
        self.assertIn("NOT per-joint", o.semantics["handedness_score"])
        self.assertFalse(o.semantics["metric_accuracy_validated"])
        self.assertFalse(hasattr(o, "confidence"))

    def test_nonfinite_joint_is_masked_not_repaired(self):
        o = hands.observation_from_result(result(hand(bad=3)), fake_frame())
        self.assertTrue(o.hand_present[0])
        self.assertFalse(o.landmark_mask[0, 3])
        self.assertEqual(int(o.landmark_mask[0].sum()), 20)
        self.assertTrue(np.isnan(o.image_landmarks_px[0, 3]).all())
        self.assertTrue(np.isnan(o.model_relative_landmarks_m[0, 3]).all())

    def test_out_of_raster_joint_is_kept_unclamped(self):
        h = hand()
        h[0][0] = point(1.2, -0.1)
        o = hands.observation_from_result(result(h), fake_frame())
        np.testing.assert_allclose(
            o.image_landmarks_px[0, 0], (240.0, -10.0), rtol=1e-6
        )
        self.assertTrue(o.landmark_mask[0, 0])

    def test_malformed_model_results_fail(self):
        f = fake_frame()
        with self.assertRaises(hands.HandInferenceError) as e:
            hands.observation_from_result(
                result(
                    hand(),
                    hand(),
                    hand(),
                    sides=("Left", "Right", "Left"),
                    scores=(1, 1, 1),
                ),
                f,
            )
        self.assertEqual(e.exception.code, "E_MODEL_TOO_MANY_HANDS")
        short = hand()
        short = (short[0][:20], short[1])
        with self.assertRaises(hands.HandInferenceError) as e:
            hands.observation_from_result(result(short), f)
        self.assertEqual(e.exception.code, "E_MODEL_LANDMARK_SHAPE")
        with self.assertRaises(hands.HandInferenceError) as e:
            hands.observation_from_result(result(hand(), sides=("Both", "x")), f)
        self.assertEqual(e.exception.code, "E_MODEL_HANDEDNESS")

    def test_digest_is_deterministic_and_excludes_timing(self):
        a = hands.observation_from_result(result(hand()), fake_frame(), 1.0)
        b = hands.observation_from_result(result(hand()), fake_frame(), 99.0)
        ha, hb = hashlib.sha256(), hashlib.sha256()
        a.digest_into(ha)
        b.digest_into(hb)
        self.assertEqual(ha.hexdigest(), hb.hexdigest())


@unittest.skipUnless(HAVE_CPU, "decode and cpu dependency groups not installed")
class ModelPinTests(unittest.TestCase):
    def test_pins_are_the_sa61_pins(self):
        p = hand_model.PINS
        self.assertEqual(
            p["sha256"],
            "fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1",
        )
        self.assertEqual(p["bytes"], 7819105)
        self.assertEqual(p["license"], "Apache-2.0")
        self.assertEqual(p["max_hands"], 2)
        self.assertEqual(p["min_hand_detection_confidence"], 0.5)
        self.assertEqual(p["min_hand_presence_confidence"], 0.5)
        self.assertTrue(p["runtime"].startswith("mediapipe==1.2.0"))

    def test_missing_wrong_size_and_wrong_hash_are_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(hand_model.HandModelError) as e:
                hand_model.resolve_model(Path(d) / "nope.task")
            self.assertEqual(e.exception.code, "E_MODEL_MISSING")
            bad = Path(d) / "bad.task"
            bad.write_bytes(b"x" * 10)
            with self.assertRaises(hand_model.HandModelError) as e:
                hand_model.resolve_model(bad)
            self.assertEqual(e.exception.code, "E_MODEL_SIZE_MISMATCH")
            bad.write_bytes(b"x" * hand_model.PINS["bytes"])
            with self.assertRaises(hand_model.HandModelError) as e:
                hand_model.resolve_model(bad)
            self.assertEqual(e.exception.code, "E_MODEL_HASH_MISMATCH")

    def test_unverified_model_fails_the_job_before_any_decode(self):
        data = chunked((GOLDEN / "valid.mcap").read_bytes())
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(hand_model.HandModelError):
                hand_stream.run_hand_inference(
                    ForwardOnly(data), lambda _o: None, model=Path(d) / "x"
                )


@unittest.skipUnless(HAVE_MODEL, "pinned MediaPipe model not in local cache")
class RealModelStreamTests(unittest.TestCase):
    def golden(self):
        return chunked((GOLDEN / "valid.mcap").read_bytes())

    def test_golden_no_hand_run_is_accepted_masked_output(self):
        data = self.golden()
        seen = []
        s = hand_stream.run_hand_inference(ForwardOnly(data), seen.append)
        self.assertTrue(s.accepted)
        self.assertEqual(s.source_sha256, hashlib.sha256(data).hexdigest())
        self.assertEqual(
            (s.frames_decoded, s.frames_inferred, s.decoder_instances), (5, 5, 1)
        )
        self.assertEqual(s.missingness.frames_no_hand, 5)
        self.assertFalse(s.metric_accuracy_validated)
        self.assertEqual(s.model["verified_sha256"], hand_model.PINS["sha256"])
        self.assertEqual([o.identity.sequence for o in seen], [0, 1, 2, 3, 4])
        self.assertTrue(all(not o.landmark_mask.any() for o in seen))
        again = hand_stream.run_hand_inference(ForwardOnly(data), lambda _o: None)
        self.assertEqual(again.observations_sha256, s.observations_sha256)

    def test_inference_runs_once_per_decoded_frame(self):
        calls = []
        orig = hands.HandInferencer.infer

        def counting(self, frame):
            calls.append(frame.access_unit.sequence)
            return orig(self, frame)

        hands.HandInferencer.infer = counting  # type: ignore[method-assign]
        try:
            hand_stream.run_hand_inference(ForwardOnly(self.golden()), lambda _o: None)
        finally:
            hands.HandInferencer.infer = orig  # type: ignore[method-assign]
        self.assertEqual(calls, [0, 1, 2, 3, 4])

    def test_model_error_fails_the_job_no_rgb_only_success(self):
        orig = hands.HandInferencer.infer

        def boom(self, frame):
            raise hands.HandInferenceError("E_MODEL_FAILED", "RuntimeError")

        hands.HandInferencer.infer = boom  # type: ignore[method-assign]
        try:
            with self.assertRaises(hands.HandInferenceError):
                hand_stream.run_hand_inference(
                    ForwardOnly(self.golden()), lambda _o: None
                )
        finally:
            hands.HandInferencer.infer = orig  # type: ignore[method-assign]

    def test_truncated_source_never_returns_a_summary(self):
        data = self.golden()
        for cut in (len(data) - 5, len(data) - 60, len(data) // 2):
            out = []
            with self.assertRaises(Exception):
                hand_stream.run_hand_inference(io.BytesIO(data[:cut]), out.append)

    def test_decoder_failure_after_valid_footer_fails(self):
        import stateaction_processing.frames as fr
        from stateaction_processing.h264_decode import DecodeError

        class Boom(fr.H264Decoder):
            def decode(self, units):
                yield from super().decode(units)
                raise DecodeError("E_DECODE_FAILED", "final flush")

        orig, fr.H264Decoder = fr.H264Decoder, Boom
        try:
            with self.assertRaises(DecodeError):
                hand_stream.run_hand_inference(
                    ForwardOnly(self.golden()), lambda _o: None
                )
        finally:
            fr.H264Decoder = orig

    @unittest.skipUnless(
        os.environ.get("STATEACTION_HAND_FIXTURE"),
        "set STATEACTION_HAND_FIXTURE to an indexed capture containing hands",
    )
    def test_real_positive_example(self):
        want = int(os.environ.get("STATEACTION_HAND_FIXTURE_MIN_HAND_FRAMES", "1"))
        seen = []
        with open(os.environ["STATEACTION_HAND_FIXTURE"], "rb") as raw:
            s = hand_stream.run_hand_inference(raw, seen.append)
        hand_frames = [o for o in seen if o.hands_detected]
        self.assertGreaterEqual(len(hand_frames), want)
        o = hand_frames[0]
        self.assertGreaterEqual(int(o.landmark_mask[o.hand_present].sum()), 21)
        self.assertTrue(np.isfinite(o.handedness_score[o.hand_present]).all())
        self.assertFalse(s.metric_accuracy_validated)


if __name__ == "__main__":
    unittest.main()
