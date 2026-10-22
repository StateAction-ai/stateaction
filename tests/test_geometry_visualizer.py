import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np
import rerun as rr

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from geometry_visualizer import GeometryVisualizer, registered_depth_cloud


class GeometryVisualizerTests(unittest.TestCase):
    def frame(self, index=0):
        k = np.array([[6., 0., 4.], [0., 6., 3.], [0., 0., 1.]])
        return SimpleNamespace(index=index, timestamp=100. + index,
            rgb=np.zeros((6, 8, 3), dtype=np.uint8), depth=np.ones((3, 4), dtype=np.uint16) * 1000,
            rgb_K=k, depth_K=np.diag([.5, .5, 1.]) @ k,
            camera_pose=SimpleNamespace(rotation=np.eye(3), translation=np.array([1., 2., 3.])),
            geometry={"depth_registered": True, "depth_time_verified": True,
                      "rgb_to_depth": np.diag([.5, .5, 1.])})

    def test_camera_calibration_is_temporal_and_missing_data_clears(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(rr, "init"), patch.object(rr, "save"), patch.object(rr, "send_blueprint"), \
             patch.object(rr, "set_time_seconds"), patch.object(rr, "set_time_sequence"), \
             patch.object(rr, "log") as log:
            session = SimpleNamespace(R_optical_to_link=np.diag([1., -1., -1.]))
            viz = GeometryVisualizer(session, Path(directory) / "test.rrd")
            first = self.frame()
            second = self.frame(1)
            second.rgb_K[0, 0] = 7.
            second.depth_K[1, 1] = 4.
            viz.log_frame(first)
            viz.log_frame(second)
            camera_calls = [c for c in log.call_args_list if c.args[0] == "world/camera"]
            self.assertEqual(len(camera_calls), 2)
            for call, frame in zip(camera_calls, (first, second)):
                self.assertFalse(call.kwargs.get("static", False))
                transform, pinhole = call.args[1:]
                np.testing.assert_allclose(np.array(transform.mat3x3.as_arrow_array().to_pylist()[0]).reshape(3, 3),
                                           np.diag([1., -1., -1.]))
                np.testing.assert_allclose(np.array(pinhole.image_from_camera.as_arrow_array().to_pylist()[0]).reshape(3, 3).T,
                                           frame.rgb_K)
            depth_pinholes = [c for c in log.call_args_list if c.args[0] == "camera/depth" and isinstance(c.args[1], rr.Pinhole)]
            self.assertEqual(len(depth_pinholes), 2)
            for call, frame in zip(depth_pinholes, (first, second)):
                np.testing.assert_allclose(np.array(call.args[1].image_from_camera.as_arrow_array().to_pylist()[0]).reshape(3, 3).T,
                                           frame.depth_K)
            static_calls = [c for c in log.call_args_list if c.kwargs.get("static")]
            self.assertEqual([c.args[0] for c in static_calls], ["world"])
            log.reset_mock()
            missing = self.frame(2); missing.camera_pose = None; missing.depth = None
            viz.log_frame(missing)
            clears = {c.args[0] for c in log.call_args_list if isinstance(c.args[1], rr.Clear)}
            self.assertTrue({"world/camera", "world/live_pointcloud", "camera/depth"}.issubset(clears))
            self.assertFalse(any(isinstance(a, rr.Pinhole) for c in log.call_args_list for a in c.args[1:]))

    def test_depth_colors_follow_inverse_crop_mapping_and_point_cap(self):
        rgb = np.zeros((4, 4, 3), dtype=np.uint8)
        rgb[:, :, 0] = np.arange(4)[None, :] * 10
        rgb[:, :, 1] = np.arange(4)[:, None] * 20
        depth = np.full((2, 2), 1000, dtype=np.uint16)
        # Depth is the central 2x2 region, not a whole-image resize.
        h = np.array([[1., 0., -1.], [0., 1., -1.], [0., 0., 1.]])
        points, colors = registered_depth_cloud(depth, rgb, np.eye(3), h)
        np.testing.assert_array_equal(colors, [[10, 20, 0], [20, 20, 0], [10, 40, 0], [20, 40, 0]])
        np.testing.assert_allclose(points, [[0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]])
        self.assertEqual(len(registered_depth_cloud(depth, rgb, np.eye(3), h, max_points=2)[0]), 2)

    def test_unverified_depth_never_becomes_a_world_cloud(self):
        viz = GeometryVisualizer.__new__(GeometryVisualizer)
        viz._session = SimpleNamespace(R_optical_to_link=np.diag([1., -1., -1.]))
        frame = self.frame(); frame.geometry["depth_time_verified"] = False
        with patch.object(rr, "log") as log, patch.object(rr, "set_time_seconds"), patch.object(rr, "set_time_sequence"):
            viz.log_frame(frame, enable_pointcloud=True)
        cloud_calls = [c for c in log.call_args_list if c.args[0] == "world/live_pointcloud"]
        self.assertEqual(len(cloud_calls), 1)
        self.assertIsInstance(cloud_calls[0].args[1], rr.Clear)


if __name__ == "__main__":
    unittest.main()
