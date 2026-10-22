"""Predicted handedness must never be an identity key in persisted evidence."""
from pathlib import Path
import sys
import tempfile
import unittest

import h5py
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from test_public_egocentric_video import write_observation_archive


class PublicVideoExportTests(unittest.TestCase):
    def test_two_same_side_observations_survive_without_becoming_valid_metric_hands(self):
        observations = []
        for value in (0.1, 0.7):
            observations.append({"hand_side": "left", "handedness_score": value,
                                 "raw_image_landmarks_normalized": np.full((21, 3), value),
                                 "landmarks_rgb_px": np.full((21, 2), value * 100),
                                 "raw_world_landmarks_m": np.full((21, 3), value),
                                 "relative_joints_m": np.full((21, 3), value / 10)})
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "observations.hdf5"
            write_observation_archive(path, [observations, []],
                                      {"rgb_native_timestamp_ns": np.array([17, 29], dtype=np.int64)}, "test-source")
            with h5py.File(path) as archive:
                self.assertEqual(archive["model_estimates/predicted_side"].asstr()[0].tolist(), ["left", "left"])
                np.testing.assert_array_equal(archive["model_estimates/detected"][:], [[True, True], [False, False]])
                np.testing.assert_allclose(archive["model_estimates/image_landmarks_pixels"][0, 0], 10)
                np.testing.assert_allclose(archive["model_estimates/image_landmarks_pixels"][0, 1], 70)
                np.testing.assert_allclose(archive["model_estimates/handedness_score"][0], [.1, .7])
                self.assertTrue(np.isnan(archive["model_estimates/world_landmarks_m"][1]).all())
                np.testing.assert_array_equal(archive["source_clocks/rgb_native_timestamp_ns"][:], [17, 29])
                self.assertFalse(archive["accepted_metric_hand_valid"][:].any())
                self.assertFalse(archive["accepted_metric_joint_valid"][:].any())
                self.assertNotIn("hand_order", archive.attrs)


if __name__ == "__main__":
    unittest.main()
