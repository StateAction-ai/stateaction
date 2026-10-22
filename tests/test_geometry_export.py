"""Persisted geometry semantics after a real SDK MCAP-to-HDF5 export."""
from pathlib import Path
import sys
import unittest

import h5py
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import test_capture_geometry_mcap as fixtures
from capture_geometry import GeometrySession
from process_geometry_capture import write_geometry_annotations


class GeometryExportTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.CaptureGeometryMcapTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.temp.cleanup)

    def export(self, observations=(), **fixture_options):
        f = self.fixture
        session = GeometrySession(f.write_capture(**fixture_options))
        frames = list(session.frames())
        geometries = [frame.geometry for frame in frames]
        timestamps = [frame.timestamp for frame in frames]
        output = f.root / 'export'
        session.export(str(output), skip_rgb_mp4=True, skip_thumbnail=True)
        path = output / 'annotation.hdf5'
        write_geometry_annotations(path, list(observations), geometries, timestamps)
        return path

    def test_missing_depth_retains_rgb_association_but_unknown_native_time(self):
        f = self.fixture
        f.rows[1]['depth_available'] = False
        f.rows[1]['depth_timestamp_ns'] = None
        path = self.export(omitted_depth=(1,))
        with h5py.File(path) as h5:
            np.testing.assert_allclose(h5['depth/rgb_association_timestamps'][:], [10., 10.02])
            np.testing.assert_array_equal(h5['depth/valid'][:], [True, False])
            np.testing.assert_array_equal(h5['depth/native_timestamp_ns'][:], [f.depth_time, -1])
            self.assertAlmostEqual(h5['depth/timestamps'][0], f.depth_time / 1e9)
            self.assertTrue(np.isnan(h5['depth/timestamps'][1]))
            np.testing.assert_array_equal(h5['capture-geometry/rgb_timestamp_ns'][:], f.events)

    def test_raw_untracked_pose_is_preserved_but_explicitly_invalid(self):
        self.fixture.rows[1]['tracking_state'] = 'PAUSED'
        path = self.export()
        with h5py.File(path) as h5:
            np.testing.assert_array_equal(h5['capture-geometry/tracking'][:], [True, False])
            np.testing.assert_array_equal(h5['cam-pose/valid'][:], [True, False])
            # Raw observations remain available, never silently overwritten by
            # nearest tracked pose, while the valid mask controls their use.
            np.testing.assert_allclose(h5['cam-pose/translations'][:, 0], [0., 1.])
            np.testing.assert_allclose(h5['cam-pose/timestamps'][:], [10., 10.02])

    def test_consistent_candidate_and_handedness_do_not_accept_unknown_visibility(self):
        shape = np.arange(63, dtype=float).reshape(21, 3) / 1000
        candidate = shape + [0., 0., .5]
        pixels = np.arange(42, dtype=float).reshape(21, 2) / 10
        observation = {'frame_index': 0, 'side': 'right',
            'observation': {'relative_joints_m': shape, 'landmarks_rgb_px': pixels, 'handedness_score': .999},
            'result': {'candidate_joints_m': candidate, 'supported_joints_m': np.full((21, 3), np.nan),
                       'joint_visibility_supported': np.zeros(21, bool),
                       'quality': {'geometry_consistent': True}}}
        path = self.export([observation])
        with h5py.File(path) as h5:
            raw = h5['hand-observations/right']
            self.assertTrue(raw['detected'][0])
            self.assertTrue(raw['geometry_consistent'][0])
            self.assertAlmostEqual(raw['handedness_score'][0], .999)
            np.testing.assert_array_equal(raw['candidate_joints_m'][0], candidate)
            np.testing.assert_array_equal(raw['predicted_relative_joints_m'][0], shape)
            np.testing.assert_array_equal(raw['image_landmarks_px'][0], pixels)
            self.assertFalse(h5['hand-pose/right_valid'][:].any())
            self.assertTrue(np.isnan(h5['hand-pose/right_joints'][:]).all())
            self.assertFalse(h5['hand-pose/left_valid'][:].any())
            self.assertTrue(np.isnan(raw['candidate_joints_m'][1]).all())

    def test_partial_joint_support_cannot_become_full_hand_validity(self):
        candidate = np.arange(63, dtype=float).reshape(21, 3) / 1000 + [0., 0., .5]
        support = np.zeros(21, bool); support[:6] = True
        masked = candidate.copy(); masked[~support] = np.nan
        observation = {'frame_index': 1, 'side': 'left',
            'observation': {'relative_joints_m': candidate-candidate[:1],
                            'landmarks_rgb_px': np.zeros((21, 2)), 'handedness_score': .8},
            'result': {'candidate_joints_m': candidate, 'supported_joints_m': masked,
                       'joint_visibility_supported': support, 'quality': {'geometry_consistent': True}}}
        path = self.export([observation])
        with h5py.File(path) as h5:
            self.assertFalse(h5['hand-pose/left_valid'][1])
            np.testing.assert_array_equal(h5['hand-observations/left/joint_visibility_supported'][1], support)
            np.testing.assert_array_equal(h5['hand-pose/left_joints'][1, :6], candidate[:6])
            self.assertTrue(np.isnan(h5['hand-pose/left_joints'][1, 6:]).all())


if __name__ == '__main__':
    unittest.main()
