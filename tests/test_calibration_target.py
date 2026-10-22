"""Known geometry and deliberate unit/axis/mapping errors for the target audit."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from validate_calibration_target import (audit_capture, board, depth_comparison,
                                         estimate_board, motion_comparison, transform)


class CalibrationTargetTests(unittest.TestCase):
    def setUp(self):
        self.board = board()
        self.K = np.array([[1000., 0, 500], [0, 1000., 600], [0, 0, 1]])
        self.rvec = np.array([.22, -.18, .06])
        self.tvec = np.array([-.065, -.10, .65])
        quad = np.array([[0, 0, 0], [.14, 0, 0], [.14, .2, 0], [0, .2, 0]], float)
        pixels = cv2.projectPoints(quad, self.rvec, self.tvec, self.K, None)[0].reshape(-1, 2)
        warp = cv2.getPerspectiveTransform(np.float32([[0, 0], [700, 0], [700, 1000], [0, 1000]]), pixels.astype(np.float32))
        self.image = cv2.warpPerspective(self.board.generateImage((700, 1000)), warp,
                                         (1000, 1200), borderValue=255)

    def test_rendered_tilted_board_is_detected_with_known_scale_and_pose(self):
        row, pose, pixels = estimate_board(self.image, self.K, self.board)
        self.assertTrue(row["pose_usable"], row)
        self.assertEqual(len(pixels), 54)
        np.testing.assert_allclose(pose[:3, 3], self.tvec, atol=.002)
        np.testing.assert_allclose(pose[:3, :3], cv2.Rodrigues(self.rvec)[0], atol=.01)
        self.assertLess(row["candidate_reprojection_rms_px"][0], .6)

    def test_measured_print_scale_changes_metric_reference(self):
        row, pose, _ = estimate_board(self.image, self.K, board(22.))
        self.assertTrue(row["pose_usable"])
        # Same image, 10% larger measured board -> 10% farther reference.
        np.testing.assert_allclose(pose[:3, 3], self.tvec * 1.1, atol=.002)

    def test_blank_image_is_insufficient_evidence(self):
        row, pose, _ = estimate_board(np.full_like(self.image, 255), self.K, self.board)
        self.assertFalse(row["pose_usable"])
        self.assertIsNone(pose)
        self.assertEqual(row["reason"], "insufficient_detected_corners")

    def test_ambiguous_planar_solutions_are_not_promoted_to_a_reference(self):
        corners = cv2.projectPoints(self.board.getChessboardCorners(), self.rvec,
                                    self.tvec, self.K, None)[0]
        different_rvec = np.array([-.22, .18, .06])
        # Force equally good image residuals with different planar solutions.
        with patch("validate_calibration_target.cv2.solvePnPGeneric", return_value=(
                2, [self.rvec, different_rvec], [self.tvec, self.tvec], None)), \
             patch("validate_calibration_target.cv2.projectPoints", return_value=(corners, None)):
            row, pose, _ = estimate_board(self.image, self.K, self.board,
                                           ambiguity_margin_px=100.)
        self.assertEqual(row["reason"], "ambiguous_planar_pose")
        self.assertFalse(row["pose_usable"])
        self.assertIsNone(pose)

    def slanted_depth_scene(self):
        # Independently specified analytic plane: Z = .8 + .2*X - .3*Y.
        normal = np.array([-.2, .3, 1.]); normal /= np.linalg.norm(normal)
        xaxis = np.cross([0., 1., 0.], normal); xaxis /= np.linalg.norm(xaxis)
        yaxis = np.cross(normal, xaxis)
        rotation = np.column_stack((xaxis, yaxis, normal))
        origin = np.array([-.20, -.12, .796])
        pose = transform(rotation, origin)
        K = np.array([[500., 0, 320], [0, 500., 240], [0, 0, 1.]])
        H = np.diag([.5, .5, 1.]); Kd = H @ K
        yy, xx = np.mgrid[:240, :320]
        rx, ry = (xx - 160) / 250, (yy - 120) / 250
        depth = np.rint(800 / (1 - .2 * rx + .3 * ry)).astype(np.uint16)
        def project(points):
            optical = points @ rotation.T + origin
            projected = optical @ K.T
            return projected[:, :2] / projected[:, 2, None]
        outer = project(np.array([[0, 0, 0], [.14, 0, 0], [.14, .2, 0], [0, .2, 0]]))
        region = np.zeros(depth.shape, np.uint8)
        cv2.fillConvexPoly(region, cv2.convexHull(np.rint(outer * .5).astype(np.int32)), 1)
        depth[region == 0] = 1800
        return depth, Kd, H, project(self.board.getChessboardCorners()), pose

    def test_plane_depth_agrees_but_wrong_units_rotation_and_mapping_are_exposed(self):
        depth, Kd, H, pixels, pose = self.slanted_depth_scene()
        good = depth_comparison(depth, Kd, H, pixels, pose)
        self.assertGreater(good["positive_depth_pixels"], 100)
        self.assertLess(good["absolute_error_mm"]["p90"], .51)
        bad_units = depth_comparison(depth.astype(float) / 1000, Kd, H, pixels, pose)
        self.assertGreater(bad_units["absolute_error_mm"]["median"], 500)
        bad_rotation = depth_comparison(depth[::-1, ::-1], Kd, H, pixels, pose)
        self.assertGreater(bad_rotation["absolute_error_mm"]["median"], 500)
        wrong_H = H.copy(); wrong_H[0, 2] += 70
        bad_mapping = depth_comparison(depth, Kd, wrong_H, pixels, pose)
        self.assertGreater(bad_mapping["absolute_error_mm"]["median"], 500)
        missing = depth_comparison(np.zeros_like(depth), Kd, H, pixels, pose)
        self.assertEqual(missing["status"], "no_valid_depth")
        self.assertEqual(missing["missing_or_invalid_fraction"], 1.)

    def test_static_board_motion_cancels_world_gauge_but_rejects_wrong_pose_direction(self):
        board_world = transform(cv2.Rodrigues(self.rvec)[0], [.1, .2, .8])
        first_camera = transform(cv2.Rodrigues(np.array([.1, .05, .03]))[0], [.02, -.03, .1])
        camera = transform(cv2.Rodrigues(np.array([.2, -.1, .08]))[0], [.18, .05, .04])
        first_board = np.linalg.inv(first_camera) @ board_world
        current_board = np.linalg.inv(camera) @ board_world
        good = motion_comparison(first_camera, camera, first_board, current_board)
        self.assertLess(good["relative_camera_translation_error_m"], 1e-12)
        self.assertLess(good["relative_camera_rotation_error_deg"], 1e-5)
        wrong = motion_comparison(first_camera, np.linalg.inv(camera), first_board, current_board)
        self.assertGreater(wrong["relative_camera_translation_error_m"], .2)
        self.assertGreater(wrong["relative_camera_rotation_error_deg"], 10.)
        gauge = transform(cv2.Rodrigues(np.array([.3, .2, -.2]))[0], [4., -2., 3.])
        gauged = motion_comparison(gauge @ first_camera, gauge @ camera, first_board, current_board)
        self.assertLess(gauged["relative_camera_translation_error_m"], 1e-12)

    def test_native_fixture_without_target_never_claims_accuracy(self):
        source = Path(__file__).parent / "fixtures/android_geometry_v3/session_data_20261022_010805.mcap"
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "audit"
            result = audit_capture(source, output, stride=1)
            self.assertEqual(result["status"], "insufficient_reference_evidence")
            self.assertEqual(result["summary"]["sampled_frames"], 3)
            self.assertEqual(result["summary"]["usable_board_frames"], 0)
            self.assertFalse(result["metric_accuracy_validated"])
            self.assertFalse(result["frontier_lab_training_qualified"])
            self.assertFalse(result["print_scale_user_measured"])
            self.assertTrue(result["source_unchanged"])
            self.assertEqual(json.loads((output / "audit.json").read_text()), result)

    def write_rendered_capture(self, directory, *, wrong_pose_axes=False):
        from mcap_ros2.writer import Writer
        from scipy.spatial.transform import Rotation
        import test_capture_geometry_mcap as fixtures
        from capture_geometry import VERSION, V3_PROVENANCE, OPTICAL_TO_ARCORE

        directory.mkdir()
        path = directory / "reference.mcap"
        (directory / "metadata.json").write_text(json.dumps({"capture_geometry_version": VERSION,
            "capture_result_valid": True, "finalization_complete": True}))
        H = np.diag([.5, .5, 1.]); Kd = H @ self.K
        board_world = transform(cv2.Rodrigues(self.rvec)[0], self.tvec)
        quad = np.array([[0, 0, 0], [.14, 0, 0], [.14, .2, 0], [0, .2, 0]], float)
        with path.open("wb") as stream, Writer(stream) as writer:
            schemas = {key: writer.register_msgdef(*schema) for key, schema in fixtures.SCHEMAS.items()}
            def emit(topic, kind, payload, event, native=None):
                writer.write_message(topic, schemas[kind], payload, log_time=event,
                                     publish_time=event if native is None else native)
            for index in range(2):
                event = 1467836032984466 + index * 33333333
                rgb_time = 1467836033014624 + index * 33333333
                depth_time = 1467836010000000 + index * 33333333
                camera_world = transform(cv2.Rodrigues(np.array([-.025, .015, 0.]) * index)[0],
                                         np.array([.025, .018, .012]) * index)
                camera_board = np.linalg.inv(camera_world) @ board_world
                rvec = cv2.Rodrigues(camera_board[:3, :3])[0]
                tvec = camera_board[:3, 3]
                corners = cv2.projectPoints(quad, rvec, tvec, self.K, None)[0].reshape(-1, 2)
                warp = cv2.getPerspectiveTransform(np.float32([[0, 0], [700, 0], [700, 1000], [0, 1000]]), corners.astype(np.float32))
                image = cv2.warpPerspective(self.board.generateImage((700, 1000)), warp, (1000, 1200), borderValue=255)
                ok, jpeg = cv2.imencode('.jpg', image, [cv2.IMWRITE_JPEG_QUALITY, 95])
                assert ok
                yy, xx = np.mgrid[:600, :500]
                rays = np.column_stack((xx.ravel(), yy.ravel(), np.ones(xx.size))) @ np.linalg.inv(Kd).T
                normal = camera_board[:3, 2]
                depth = np.rint(1000 * (normal @ tvec) / (rays @ normal)).astype(np.uint16).reshape(600, 500)
                if index == 0:
                    emit('/tf', 'tf', {'transforms': [{'header': fixtures.header(event, 'camera_link'),
                        'child_frame_id': 'camera_optical_frame', 'transform': {
                            'translation': dict(x=0., y=0., z=0.), 'rotation': dict(x=1., y=0., z=0., w=0.)}}]}, event)
                    emit('/camera/camera_info', 'info', fixtures.camera_info(event, self.K, 1000, 1200), event)
                    emit('/camera/depth/camera_info', 'info', fixtures.camera_info(event, Kd, 500, 600), event)
                emit('/camera/rgb/compressed', 'rgb', {'header': fixtures.header(rgb_time),
                    'format': 'jpeg', 'data': jpeg.tobytes()}, event, rgb_time)
                emit('/camera/depth', 'depth', {'header': fixtures.header(depth_time), 'height': 600,
                    'width': 500, 'encoding': '16UC1', 'is_bigendian': 0, 'step': 1000,
                    'data': depth.tobytes()}, event, depth_time)
                physical_rotation = camera_world[:3, :3] if wrong_pose_axes else camera_world[:3, :3] @ OPTICAL_TO_ARCORE
                quaternion = Rotation.from_matrix(physical_rotation).as_quat()
                emit('/camera/pose', 'pose', {'header': fixtures.header(event, 'world'), 'pose': {
                    'position': dict(zip('xyz', camera_world[:3, 3])),
                    'orientation': dict(zip('xyzw', quaternion))}}, event)
                row = {'capture_geometry_version': VERSION, **V3_PROVENANCE,
                    'frame_timestamp_ns': event, 'rgb_timestamp_ns': rgb_time,
                    'android_camera_timestamp_ns': 1467836019878654 + index * 33333333,
                    'depth_timestamp_ns': depth_time, 'cross_stream_clock_verified': False,
                    'tracking_state': 'TRACKING', 'rgb_encoded': True, 'depth_available': True,
                    'rgb_width': 1000, 'rgb_height': 1200, 'depth_width': 500, 'depth_height': 600,
                    'rgb_intrinsics': fixtures.intrinsics(self.K, 1000, 1200),
                    'depth_intrinsics': fixtures.intrinsics(Kd, 500, 600),
                    'rgb_pixel_to_depth_pixel': H.ravel().tolist()}
                emit('/capture/frame_geometry', 'string', {'data': json.dumps(row)}, event)
        return path

    def test_mcap_to_detected_board_depth_and_camera_motion_with_axis_negative_control(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = self.write_rendered_capture(root / 'correct')
            good = audit_capture(source, root / 'good_audit', measured_square_mm=20., static_board=True, stride=1)
            self.assertEqual(good['summary']['usable_board_frames'], 2)
            self.assertLess(good['summary']['per_frame_median_absolute_depth_error_mm']['max'], 3.)
            self.assertLess(good['summary']['relative_camera_translation_error_m']['max'], .005)
            self.assertLess(good['summary']['relative_camera_rotation_error_deg']['max'], 1.)
            bad_source = self.write_rendered_capture(root / 'wrong_axes', wrong_pose_axes=True)
            bad = audit_capture(bad_source, root / 'bad_audit', measured_square_mm=20., static_board=True, stride=1)
            self.assertGreater(bad['summary']['relative_camera_translation_error_m']['max'], .03)
            self.assertFalse(good['metric_accuracy_validated'])
            self.assertFalse(good['frontier_lab_training_qualified'])


if __name__ == "__main__":
    unittest.main()
