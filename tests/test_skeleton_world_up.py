"""Camera-roll invariance, retained warmup, and capture provenance gates."""

import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest

import numpy as np
from stera.models import UpperBodyEstimator

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from skeleton_world_up import adapt_skeleton_world_up, VERIFIED_SDK_COMMIT


class SkeletonWorldUpTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name) / "session_20261021_210417"
        root.mkdir()
        self.mcap = root / "session_data_20261021_210417.mcap"
        self.metadata_path = root / "metadata.json"
        self.metadata = {
            "android_version": "17", "arcore_version": "1.57",
            "session_start_timestamp_ns": 1453679687118988,
            "storage": {"path": "/phone/ar_sessions/session_20261021_210417"},
        }
        self.session = SimpleNamespace(
            path=str(self.mcap), R_optical_to_link=np.eye(3),
            all_camera_poses=lambda: [(1453679.687118988, None)],
        )

    def attach(self, estimator, sdk=VERIFIED_SDK_COMMIT):
        self.metadata_path.write_text(json.dumps(self.metadata))
        return adapt_skeleton_world_up(estimator, self.session, self.mcap,
                                        self.metadata_path, sdk)

    def test_roll_never_flips_world_up_and_warmup_stays_nine_frames(self):
        for rotation in (np.eye(3), np.diag([-1., -1., 1.])):
            with self.subTest(rotation=rotation):
                estimator = UpperBodyEstimator(session=self.session)
                self.assertTrue(self.attach(estimator)["applied"])
                frame = SimpleNamespace(camera_pose=SimpleNamespace(
                    rotation=rotation, translation=np.array([0., 0., 0.])))
                outputs = [estimator.estimate(frame, hands=[]) for _ in range(12)]
                self.assertEqual([i for i,x in enumerate(outputs) if x is not None], [9,10,11])
                for skeleton in outputs[9:]:
                    j = skeleton.joints
                    np.testing.assert_array_equal(estimator._up, [0.,1.,0.])
                    self.assertAlmostEqual(j[0,1]-j[1,1], 0.1)
                    self.assertAlmostEqual(j[2,1]-(j[3,1]+j[6,1])/2, -0.45)
                    np.testing.assert_array_equal(j[9], frame.camera_pose.translation)

    def test_non_android_retains_upstream(self):
        del self.metadata["android_version"]
        estimator = UpperBodyEstimator(session=self.session)
        upstream = estimator._ensure_up
        self.assertFalse(self.attach(estimator)["applied"])
        self.assertEqual(estimator._ensure_up, upstream)

    def test_capture_mismatch_and_unknown_sdk_are_not_adapted(self):
        self.metadata["storage"]["path"] = "/phone/session_other"
        self.assertFalse(self.attach(UpperBodyEstimator(session=self.session))["applied"])
        self.assertFalse(self.attach(UpperBodyEstimator(session=self.session), sdk="other")["applied"])

    def test_native_clock_mismatch_is_not_adapted(self):
        self.metadata["session_start_timestamp_ns"] += 1_000_000_000
        self.assertFalse(self.attach(UpperBodyEstimator(session=self.session))["applied"])


if __name__ == "__main__":
    unittest.main()
