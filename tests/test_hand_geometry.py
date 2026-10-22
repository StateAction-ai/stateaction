"""Synthetic camera evidence: reconstruction must expose contradictions."""
from pathlib import Path
import sys
import unittest
from types import SimpleNamespace

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from hand_geometry import (reconstruct_hand, project_points, detect_observations,
                           fit_perspective_camera, reconstruct_perspective_hand)


class HandGeometryTests(unittest.TestCase):
    def setUp(self):
        self.K = np.array([[500., 0, 320], [0, 500, 240], [0, 0, 1.]])
        self.relative = np.zeros((21, 3))
        # Five separated synthetic fingers; known metric joints and camera.
        for finger, base in enumerate((1, 5, 9, 13, 17)):
            for j in range(4):
                self.relative[base+j] = [(finger-2)*.026, -.04-j*.025, .004*j]
        self.wrist = np.array([.02, .02, .6])
        self.truth = self.relative + self.wrist
        self.uv = project_points(self.truth, self.K)
        self.depth = np.zeros((480, 640))
        for point, xyz in zip(self.uv, self.truth):
            x, y = np.rint(point).astype(int)
            self.depth[y-1:y+2, x-1:x+2] = xyz[2]

    def reconstruct(self, **kwargs):
        defaults = dict(rgb_size_wh=(640, 480), rgb_to_depth=np.eye(3),
                        calibration_verified=True, depth_registered=True,
                        depth_time_verified=True, visible_joints=np.ones(21, bool))
        defaults.update(kwargs)
        return reconstruct_hand(self.relative, self.uv, self.depth, self.K, **defaults)

    def test_known_projection_recovers_translation_without_changing_shape(self):
        result = self.reconstruct()
        self.assertTrue(result['quality']['geometry_consistent'])
        self.assertTrue(result['quality']['fully_observed_consistent'])
        self.assertFalse(result['quality']['metric_accuracy_validated'])
        np.testing.assert_allclose(result['supported_joints_m'], self.truth, atol=1e-12)

    def test_wrong_depth_is_rejected_even_with_high_handedness_score(self):
        self.depth[self.depth > 0] += .4
        result = self.reconstruct(handedness_score=.999)
        self.assertFalse(result['quality']['geometry_consistent'])
        self.assertIn('model_image_projection_inconsistent', result['quality']['rejection_reasons'])
        self.assertTrue(np.isnan(result['supported_joints_m']).all())
        self.assertFalse(result['quality']['handedness_score_is_pose_confidence'])

    def test_unknown_visibility_never_becomes_verified_hidden_joints(self):
        result = self.reconstruct(visible_joints=None)
        self.assertTrue(result['quality']['geometry_consistent'])
        self.assertFalse(result['quality']['fully_observed_consistent'])
        self.assertEqual(result['quality']['visibility_status'], 'unknown')
        self.assertTrue(np.isnan(result['supported_joints_m']).all())
        self.assertTrue(np.isfinite(result['candidate_joints_m']).all())

    def test_occluded_fingers_remain_masked(self):
        visible = np.ones(21, bool)
        visible[[7, 8, 11, 12]] = False
        result = self.reconstruct(visible_joints=visible)
        self.assertTrue(result['quality']['geometry_consistent'])
        self.assertTrue(np.isnan(result['supported_joints_m'][~visible]).all())
        np.testing.assert_allclose(result['supported_joints_m'][visible], self.truth[visible])

    def test_metric_export_requires_calibration_mapping_and_native_timing(self):
        for kwargs, reason in [({'calibration_verified': False}, 'camera_calibration_unverified'),
                               ({'depth_registered': False}, 'rgb_depth_registration_unverified'),
                               ({'rgb_to_depth': None}, 'rgb_depth_registration_unverified'),
                               ({'depth_time_verified': False}, 'rgb_depth_timing_unverified')]:
            with self.subTest(kwargs=kwargs):
                result = self.reconstruct(**kwargs)
                self.assertIn(reason, result['quality']['rejection_reasons'])
                self.assertFalse(result['quality']['geometry_consistent'])
                self.assertTrue(np.isnan(result['supported_joints_m']).all())

    def test_explicit_crop_mapping_is_used_not_dimension_scaling(self):
        # Depth has the SAME dimensions as RGB but its pixels are translated.
        shifted = np.zeros_like(self.depth)
        shifted[:, 45:] = self.depth[:, :-45]
        self.depth = shifted
        mapping = np.array([[1, 0, 45.], [0, 1, 0], [0, 0, 1]])
        correct = self.reconstruct(rgb_to_depth=mapping)
        wrong = self.reconstruct()
        np.testing.assert_allclose(correct['supported_joints_m'], self.truth)
        self.assertFalse(wrong['quality']['geometry_consistent'])

    def test_missing_depth_is_not_replaced_by_stale_geometry(self):
        self.depth.fill(0)
        result = self.reconstruct()
        self.assertIn('insufficient_wrist_and_palm_depth', result['quality']['rejection_reasons'])
        self.assertTrue(np.isnan(result['candidate_joints_m']).all())

    def test_palm_anchor_depth_is_compensated_for_relative_z(self):
        self.relative[[5, 9, 13, 17], 2] = .03
        self.truth = self.relative + self.wrist
        self.uv = project_points(self.truth, self.K)
        self.depth.fill(0)
        for point, xyz in zip(self.uv, self.truth):
            x, y = np.rint(point).astype(int)
            self.depth[y-1:y+2, x-1:x+2] = xyz[2]
        result = self.reconstruct()
        self.assertAlmostEqual(result['quality']['wrist_depth_m'], .6)
        np.testing.assert_allclose(result['candidate_joints_m'], self.truth)

    def test_background_contaminated_palm_is_rejected(self):
        x, y = np.rint(self.uv[9]).astype(int)
        self.depth[y-1:y+2, x-1:x+2] = 1.0
        result = self.reconstruct()
        self.assertIn('inconsistent_palm_depth', result['quality']['rejection_reasons'])
        self.assertFalse(result['quality']['geometry_consistent'])

    def test_preserves_inputs_and_provenance(self):
        snapshots = [x.copy() for x in [self.relative, self.uv, self.depth, self.K]]
        source = {'capture': 'synthetic_known_camera', 'source_sha256': 'fixture'}
        result = self.reconstruct(provenance=source)
        for actual, before in zip([self.relative, self.uv, self.depth, self.K], snapshots):
            np.testing.assert_array_equal(actual, before)
        self.assertEqual(result['quality']['provenance'], source)
        self.assertEqual(len(result['quality']['input_hashes']['depth_m']), 64)

    def test_observations_preserve_world_shape_without_depth_and_dedup(self):
        calls = []
        def landmarks(array):
            return [SimpleNamespace(x=x, y=y, z=z) for x, y, z in array]
        image_lm = np.column_stack([self.uv / [640, 480], np.zeros(21)])
        result = SimpleNamespace(
            hand_landmarks=[landmarks(image_lm)] * 3,
            hand_world_landmarks=[landmarks(self.truth)] * 3,
            handedness=[[SimpleNamespace(category_name=side, score=score)]
                        for side, score in [('Right', .6), ('Right', .95), ('Left', .8)]])
        backend = SimpleNamespace(load=lambda: calls.append('load'),
            _mp=SimpleNamespace(Image=lambda **kwargs: kwargs, ImageFormat=SimpleNamespace(SRGB='RGB')),
            _landmarker=SimpleNamespace(detect=lambda image: result))
        observed = detect_observations(backend, np.zeros((480, 640, 3), np.uint8))
        self.assertEqual(calls, ['load'])
        self.assertEqual([x['hand_side'] for x in observed], ['right', 'left'])
        self.assertEqual(observed[0]['handedness_score'], .95)
        np.testing.assert_allclose(observed[0]['relative_joints_m'], self.relative, atol=1e-16)
        np.testing.assert_allclose(observed[0]['landmarks_rgb_px'], self.uv)
        np.testing.assert_array_equal(observed[0]['raw_world_landmarks_m'], self.truth)
        raw = detect_observations(backend, np.zeros((480, 640, 3), np.uint8),
                                  deduplicate_by_side=False)
        self.assertEqual([x['hand_side'] for x in raw], ['right', 'right', 'left'])
        self.assertEqual([x['handedness_score'] for x in raw], [.6, .95, .8])
        self.assertEqual(len(raw), 3)
        self.assertEqual(len(observed), 2)


class VideoInferenceContractTests(unittest.TestCase):
    def backend(self, calls):
        empty = SimpleNamespace(hand_landmarks=[], handedness=[])
        return SimpleNamespace(
            load=lambda: None,
            _mp=SimpleNamespace(Image=lambda **kw: kw["data"],
                                ImageFormat=SimpleNamespace(SRGB="rgb")),
            _landmarker=SimpleNamespace(
                detect=lambda image: calls.append(("image", None)) or empty,
                detect_for_video=lambda image, timestamp: calls.append(("video", timestamp)) or empty))

    def test_recorded_event_timestamp_reaches_video_api_without_timeless_fallback(self):
        calls = []
        backend = self.backend(calls)
        image = np.zeros((24, 32, 3), np.uint8)
        self.assertEqual(detect_observations(backend, image, timestamp_ms=1519429847), [])
        self.assertEqual(detect_observations(backend, image), [])
        self.assertEqual(calls, [("video", 1519429847), ("image", None)])

    def test_ambiguous_or_invalid_video_timestamps_fail_before_inference(self):
        calls = []
        for timestamp in (-1, True, 1.5, "42"):
            with self.subTest(timestamp=timestamp), self.assertRaises(ValueError):
                detect_observations(self.backend(calls), np.zeros((24, 32, 3), np.uint8),
                                    timestamp_ms=timestamp)
        self.assertEqual(calls, [])


class PerspectiveCameraTests(unittest.TestCase):
    """Independent synthetic camera truth tests the missing reconstruction step."""

    def setUp(self):
        HandGeometryTests.setUp(self)
        import cv2
        self.rotation = cv2.Rodrigues(np.array([.4, -.3, .35]))[0]
        self.truth = self.relative @ self.rotation.T + self.wrist
        self.uv = project_points(self.truth, self.K)
        self.depth.fill(0)
        for point, xyz in zip(self.uv, self.truth):
            x, y = np.rint(point).astype(int)
            self.depth[y-1:y+2, x-1:x+2] = xyz[2]

    def perspective(self, **kwargs):
        defaults = dict(rgb_size_wh=(640, 480), rgb_to_depth=np.eye(3),
                        calibration_verified=True, depth_registered=True,
                        depth_time_verified=True, visible_joints=np.ones(21, bool))
        defaults.update(kwargs)
        return reconstruct_perspective_hand(self.relative, self.uv, self.depth,
                                             self.K, **defaults)

    def test_calibrated_camera_recovers_known_rotated_shape(self):
        fit = fit_perspective_camera(self.relative, self.uv, self.K)
        self.assertIsNotNone(fit)
        np.testing.assert_allclose(fit['candidate_joints_m'], self.truth, atol=1e-7)
        np.testing.assert_allclose(fit['rotation'], self.rotation, atol=1e-7)
        np.testing.assert_allclose(fit['translation_m'], self.wrist, atol=1e-7)
        self.assertAlmostEqual(np.linalg.det(fit['rotation']), 1., places=9)
        np.testing.assert_allclose(fit['rotation'] @ fit['rotation'].T, np.eye(3), atol=1e-9)

    def test_corrected_candidate_preserves_bones_and_passes_known_depth(self):
        result = self.perspective()
        np.testing.assert_allclose(result['candidate_joints_m'], self.truth, atol=1e-7)
        self.assertTrue(result['quality']['geometry_consistent'])
        self.assertFalse(result['quality']['metric_accuracy_validated'])
        self.assertGreater(result['quality']['baseline_translation_only']['nonwrist_reprojection_median_px'], 10)
        np.testing.assert_allclose(np.linalg.norm(np.diff(result['candidate_joints_m'], axis=0), axis=1),
                                   np.linalg.norm(np.diff(self.relative, axis=0), axis=1), atol=1e-12)

    def test_learned_scale_ambiguity_is_detected_by_independent_depth(self):
        original = self.relative.copy()
        self.relative *= 2
        result = self.perspective()
        np.testing.assert_allclose(result['candidate_joints_m'], self.truth*2, atol=1e-7)
        self.assertLess(result['quality']['nonwrist_reprojection_median_px'], 1e-5)
        self.assertIn('model_scale_surface_depth_disagreement', result['quality']['rejection_reasons'])
        self.assertFalse(result['quality']['geometry_consistent'])
        self.assertTrue(np.isnan(result['supported_joints_m']).all())
        np.testing.assert_array_equal(self.relative, original*2)

    def test_wrong_focal_length_cannot_pass_depth_audit_by_fitting_pixels(self):
        self.K[0, 0] *= 2
        self.K[1, 1] *= 2
        result = self.perspective()
        self.assertGreater(result['quality']['model_scale_surface_depth_disagreement_m'], .3)
        self.assertIn('model_scale_surface_depth_disagreement', result['quality']['rejection_reasons'])
        self.assertFalse(result['quality']['geometry_consistent'])

    def test_bad_joint_correspondence_is_not_accepted_after_pnp(self):
        self.uv = self.uv[np.random.default_rng(17).permutation(21)]
        result = self.perspective()
        self.assertFalse(result['quality']['geometry_consistent'])
        self.assertIn('model_image_projection_inconsistent', result['quality']['rejection_reasons'])
        self.assertTrue(np.isnan(result['supported_joints_m']).all())

    def test_degenerate_shape_cannot_create_a_camera_estimate(self):
        self.relative.fill(0)
        self.assertIsNone(fit_perspective_camera(self.relative, self.uv, self.K))
        result = self.perspective()
        self.assertFalse(result['quality']['camera_fit_valid'])
        self.assertIn('perspective_camera_solve_failed', result['quality']['rejection_reasons'])
        self.assertTrue(np.isnan(result['candidate_joints_m']).all())

    def test_unknown_visibility_preserves_estimate_but_never_training_labels(self):
        result = self.perspective(visible_joints=None)
        self.assertTrue(np.isfinite(result['candidate_joints_m']).all())
        self.assertTrue(np.isnan(result['supported_joints_m']).all())
        self.assertEqual(result['quality']['visibility_status'], 'unknown')
        self.assertFalse(result['quality']['fully_observed_consistent'])

    def test_no_depth_keeps_image_based_estimate_with_explicit_rejection(self):
        self.depth.fill(0)
        result = self.perspective()
        np.testing.assert_allclose(result['candidate_joints_m'], self.truth, atol=1e-7)
        self.assertIn('insufficient_wrist_and_palm_depth', result['quality']['rejection_reasons'])
        self.assertFalse(result['quality']['geometry_consistent'])

    def test_camera_fit_never_mutates_inputs_and_has_positive_camera_depth(self):
        before = [a.copy() for a in (self.relative, self.uv, self.depth, self.K)]
        result = self.perspective()
        for actual, original in zip((self.relative, self.uv, self.depth, self.K), before):
            np.testing.assert_array_equal(actual, original)
        self.assertTrue((result['candidate_joints_m'][:, 2] > 0).all())


if __name__ == '__main__':
    unittest.main()
