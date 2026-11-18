"""SA-32 inline QC regressions on the REAL changed export path with a fake hand engine.

The real stream, decoder, clip writer, contract validator and exporter run on the published
golden MCAP. Only the MediaPipe engine is replaced (so no model asset is needed); the replacement
maps results through the real `hands.observation_from_result`, so mask/mapping rules stay real.
"""

import hashlib
import tempfile
import unittest
from pathlib import Path

from indexed_fixture import chunked
from test_hands import hand, result
from test_mcap_stream import ForwardOnly

try:
    import av  # noqa: F401
    import numpy as np  # noqa: F401
    import rerun  # noqa: F401
    import stateaction_contracts  # noqa: F401

    # isort: split
    from stateaction_processing import (
        artifact_export,
        artifact_types,
        frames,
        hands,
    )

    HAVE_EXPORT = True
except ImportError:
    HAVE_EXPORT = False

GOLDEN = Path(__file__).resolve().parents[3] / "packages/contracts/capture/golden"
SHA = "a" * 64
JOB = "11111111-1111-4111-8111-111111111111"
FRAMES = 5  # frames in the published golden valid.mcap


class FakeEngine:
    """Stands in for HandInferencer. `plan(index, frame)` returns a model-result or raises."""

    plan = staticmethod(lambda i, frame: result())  # no hands
    undercount_last = False
    instances: list = []

    def __init__(self, _model):
        self.frames_inferred = 0
        self.seen = 0
        FakeEngine.instances.append(self)

    def infer(self, frame):
        res = FakeEngine.plan(self.seen, frame)
        self.seen += 1
        obs = hands.observation_from_result(res, frame, 1.0)
        if not (FakeEngine.undercount_last and self.seen == FRAMES):
            self.frames_inferred += 1
        return obs

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return None


class RecordingSink:
    """Wraps a LocalDirectorySink and logs ordering plus the inference counter at each event."""

    def __init__(self, inner, fail_put_at=None):
        self.inner, self.events, self.fail_put_at, self.puts = inner, [], fail_put_at, 0

    def _count(self):
        return FakeEngine.instances[-1].frames_inferred if FakeEngine.instances else 0

    def put(self, out):
        self.puts += 1
        if self.fail_put_at is not None and self.puts == self.fail_put_at:
            self.events.append(("put-interrupted", self._count()))
            raise OSError("simulated interrupted write")
        self.events.append(("put", self._count()))
        return self.inner.put(out)

    def seal(self, out):
        self.events.append(("seal", self._count()))
        return self.inner.seal(out)

    def abort(self, reason):
        self.events.append(("abort", self._count(), reason))
        return self.inner.abort(reason)

    def kinds(self):
        return [e[0] for e in self.events]


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
class InlineQcTests(unittest.TestCase):
    def setUp(self):
        FakeEngine.plan = staticmethod(lambda i, frame: result())
        FakeEngine.undercount_last = False
        FakeEngine.instances = []
        self._orig = (
            artifact_export.HandInferencer,
            artifact_export.hand_model.resolve_model,
        )
        artifact_export.HandInferencer = FakeEngine
        artifact_export.hand_model.resolve_model = lambda _m=None: object()

        def restore():
            artifact_export.HandInferencer, artifact_export.hand_model.resolve_model = (
                self._orig
            )

        self.addCleanup(restore)
        self.data = chunked((GOLDEN / "valid.mcap").read_bytes())
        self.raw = self.data  # the exact bytes streamed (and hashed)

    def export(self, data=None, fail_put_at=None, **ctx):
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        root = Path(d.name) / "out"
        sink = RecordingSink(artifact_types.LocalDirectorySink(root), fail_put_at)
        try:
            res = artifact_export.export_artifacts(
                ForwardOnly(self.data if data is None else data), sink, context(**ctx)
            )
            return res, sink, root, None
        except BaseException as e:  # noqa: BLE001 - the tests assert on the exact failure
            return None, sink, root, e

    def assert_withheld(self, sink, root):
        self.assertIn("abort", sink.kinds())
        self.assertNotIn("seal", sink.kinds())
        self.assertFalse((root / artifact_types.MANIFEST_NAME).exists())
        self.assertEqual([p for p in root.rglob("*") if p.is_file()], [])

    def test_wrong_declared_hash_rejects_the_whole_candidate_only_at_final_eof(self):
        res, sink, root, err = self.export(expected_source_sha256="0" * 64)
        self.assertIsNone(res)
        self.assertEqual(getattr(err, "code", None), "E_SOURCE_SHA_MISMATCH")
        # Inference had fully run and the clip files were already handed to the sink (provisional,
        # nothing accepted) before the whole-source hash was compared at EOF.
        kinds = sink.kinds()
        self.assertGreater(len(sink.events), 1)
        self.assertEqual(kinds[0], "put")
        self.assertEqual(kinds[-1], "abort")
        self.assertEqual(FakeEngine.instances[-1].frames_inferred, FRAMES)
        self.assertEqual(sink.events[-1][1], FRAMES)
        diag = err.diagnostics
        self.assertEqual(diag["stage"], "source_verification")
        self.assertEqual(diag["counts"]["frames_inferred"], FRAMES)
        self.assertEqual(diag["counts"]["frames_decoded"], FRAMES)
        self.assertEqual(diag["counts"]["clips_written"], 1)
        self.assertGreater(diag["counts"]["files_put"], 0)
        self.assertEqual(diag["counts"]["source_bytes_read"], len(self.raw))
        self.assertIs(diag["source_verified"], False)  # hash mismatch: never proven
        self.assertTrue(all(isinstance(v, int) for v in diag["counts"].values()))
        self.assert_withheld(sink, root)

    def test_manifest_build_failure_after_valid_eof_reports_source_verified(self):
        def boom(*_a, **_k):
            raise RuntimeError("secret /private/path")

        orig, artifact_export.build_manifest = artifact_export.build_manifest, boom
        try:
            res, sink, root, err = self.export(
                expected_source_sha256=hashlib.sha256(self.raw).hexdigest()
            )
        finally:
            artifact_export.build_manifest = orig
        self.assertIsNone(res)
        diag = err.diagnostics
        self.assertEqual(diag["stage"], "manifest")
        self.assertIs(diag["source_verified"], True)
        self.assertEqual(diag["counts"]["source_bytes_read"], len(self.raw))
        self.assertNotIn(
            "seal", sink.kinds()
        )  # still a failed candidate, nothing accepted
        self.assertIn("abort", sink.kinds())

    def test_matching_declared_hash_is_accepted_and_manifest_is_last(self):
        res, sink, root, err = self.export(
            expected_source_sha256=hashlib.sha256(self.raw).hexdigest()
        )
        self.assertIsNone(err)
        self.assertEqual(res.source_sha256, hashlib.sha256(self.raw).hexdigest())
        self.assertEqual(sink.kinds()[-1], "seal")
        self.assertEqual(sink.kinds().count("seal"), 1)
        self.assertNotIn("abort", sink.kinds())

    def test_honest_zero_hands_is_success_with_coverage_only_checks(self):
        res, sink, _root, err = self.export()
        self.assertIsNone(err)
        checks = {c["code"]: c for c in res.manifest["checks"]}
        self.assertFalse(res.manifest["metric_accuracy_validated"])
        self.assertNotIn("fail", {c["status"] for c in checks.values()})
        self.assertNotIn("warn", {c["status"] for c in checks.values()})
        summary = checks["hand_detection_summary"]
        self.assertEqual(summary["status"], "measured")
        self.assertIn("not an accuracy claim", summary["message"])
        counts = checks["capture_counts"]
        self.assertEqual(counts["status"], "measured")
        self.assertLessEqual(len(counts["measurements"]), 16)
        self.assertEqual(counts["measurements"]["video_messages"], str(FRAMES))
        self.assertEqual(counts["measurements"]["unresolved"], "0")
        for v in counts["measurements"].values():
            self.assertRegex(v, r"^-?[0-9]{1,19}$")
        # No quality/accuracy word anywhere in measured messages.
        for c in checks.values():
            if c["status"] == "measured":
                self.assertNotRegex(
                    c["message"].lower(), r"accurate|accuracy is|quality score"
                )

    def test_nonfinite_joint_is_masked_through_the_exporter_not_repaired(self):
        FakeEngine.plan = staticmethod(lambda i, f: result(hand(bad=3)))
        res, sink, _root, err = self.export()
        self.assertIsNone(err)
        self.assertEqual(res.frames, FRAMES)
        self.assertEqual(sink.kinds()[-1], "seal")
        self.assertEqual(res.missingness.frames, FRAMES)

    def test_mapping_fault_fails_with_diagnostics_and_withholds_candidate(self):
        def plan(i, frame):
            if i == 3:
                short = hand()
                return result((short[0][:20], short[1]))
            return result()

        FakeEngine.plan = staticmethod(plan)
        res, sink, root, err = self.export()
        self.assertIsNone(res)
        self.assertEqual(getattr(err, "code", None), "E_MODEL_LANDMARK_SHAPE")
        self.assertEqual(FakeEngine.instances[-1].frames_inferred, 3)
        self.assertEqual(err.diagnostics["stage"], "inference")
        self.assertEqual(err.diagnostics["counts"]["frames_inferred"], 3)
        self.assertEqual(err.diagnostics["counts"]["clips_written"], 0)
        self.assert_withheld(sink, root)

    def test_engine_fault_midstream_is_not_an_rgb_only_success(self):
        def plan(i, frame):
            if i == 2:
                raise hands.HandInferenceError("E_MODEL_FAILED", "RuntimeError")
            return result()

        FakeEngine.plan = staticmethod(plan)
        res, sink, root, err = self.export()
        self.assertIsNone(res)
        self.assertEqual(getattr(err, "code", None), "E_MODEL_FAILED")
        self.assert_withheld(sink, root)

    def test_reduced_final_inference_count_fails_even_with_valid_source(self):
        FakeEngine.undercount_last = True
        res, sink, root, err = self.export()
        self.assertIsNone(res)
        self.assertEqual(getattr(err, "code", None), "E_INFERENCE_COUNT")
        self.assert_withheld(sink, root)

    def test_decoder_dropping_the_last_frame_is_never_accepted(self):
        class Short(frames.H264Decoder):
            def decode(self, units):
                out = list(super().decode(units))
                yield from out[:-1]

        orig, frames.H264Decoder = frames.H264Decoder, Short
        try:
            res, sink, root, err = self.export()
        finally:
            frames.H264Decoder = orig
        self.assertIsNone(res)
        self.assertIsNotNone(err)
        self.assert_withheld(sink, root)

    def test_interrupted_output_write_aborts_without_a_manifest(self):
        res, sink, root, err = self.export(fail_put_at=3)
        self.assertIsNone(res)
        self.assertIsInstance(err, OSError)
        self.assertIn("put-interrupted", sink.kinds())
        self.assert_withheld(sink, root)

    def test_corrupt_source_bytes_never_reach_a_manifest(self):
        bad = bytearray(self.raw)
        bad[len(bad) // 2] ^= 0xFF
        res, sink, root, err = self.export(data=bytes(bad))
        self.assertIsNone(res)
        self.assertIsNotNone(err)
        self.assert_withheld(sink, root)


if __name__ == "__main__":
    unittest.main()
