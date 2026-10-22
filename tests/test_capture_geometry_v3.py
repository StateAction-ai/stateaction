"""Regression for the real Pixel v2 failure, with distinct native clocks.

The timestamp tuple is observed evidence; generated pixels/depth/poses are
synthetic and do not establish hardware accuracy.
"""
import sys
import unittest
import json
import hashlib
from pathlib import Path

import h5py
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import test_capture_geometry_mcap as fixtures
from capture_geometry import GeometrySession, VERSION, V3_PROVENANCE
from process_geometry_capture import write_geometry_annotations


class NativeV3FixtureTests(unittest.TestCase):
    def test_actual_android_writer_preserves_pixel_clock_tuple_and_all_three_streams(self):
        root = Path(__file__).parent / "fixtures/android_geometry_v3"
        provenance = json.loads((root / "provenance.json").read_text())
        for filename, expected in provenance["artifact_files"].items():
            content = (root / filename).read_bytes()
            self.assertEqual(hashlib.sha256(content).hexdigest(), expected["sha256"])
        frames = list(GeometrySession(next(root.glob("*.mcap"))).frames())
        self.assertEqual(len(frames), 3)
        for i, frame in enumerate(frames):
            source = frame.geometry["source"]
            self.assertEqual(source["frame_timestamp_ns"], 1467836032984466 + i * 33333333)
            self.assertEqual(source["rgb_timestamp_ns"], 1467836033014624 + i * 33333333)
            self.assertEqual(source["android_camera_timestamp_ns"], 1467836019878654 + i * 33333333)
            for key, value in V3_PROVENANCE.items():
                self.assertEqual(source[key], value)
            self.assertEqual(frame.rgb.shape, (16, 32, 3))
            actual = [int(frame.rgb[y, x, 0]) for x, y in [(4, 3), (25, 3), (4, 12), (25, 12)]]
            np.testing.assert_allclose(actual, [25, 85, 150, 220], atol=3, rtol=0)
            np.testing.assert_array_equal(frame.depth, np.arange(32, dtype=np.uint16).reshape(4, 8) + 700 + i * 10)
            np.testing.assert_allclose(frame.camera_pose.translation, [i * .01, 0, 0])
            self.assertFalse(frame.geometry["cross_stream_clock_verified"])


class PixelClockRegressionTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.CaptureGeometryMcapTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.temp.cleanup)
        f = self.fixture
        # session_20261022_010013: first recorded v2 encoder failure.
        f.events = [1467836032984466, 1467836052984466]
        f.rgb_times = [1467836033014624, 1467836053014624]
        self.android_times = [1467836019878654, 1467836039878654]
        f.rows = [f.row(i) for i in range(2)]
        for i, row in enumerate(f.rows):
            row.update(V3_PROVENANCE)
            row["capture_geometry_version"] = VERSION
            row["android_camera_timestamp_ns"] = self.android_times[i]

    def read(self):
        return GeometrySession(self.fixture.write_capture(metadata_version=VERSION))

    def test_observed_pixel_clocks_accept_rgb_depth_and_pose_by_event(self):
        frames = list(self.read().frames())
        self.assertEqual(len(frames), 2)
        for i, frame in enumerate(frames):
            source = frame.geometry["source"]
            self.assertEqual(source["frame_timestamp_ns"], self.fixture.events[i])
            self.assertEqual(source["rgb_timestamp_ns"], self.fixture.rgb_times[i])
            self.assertEqual(source["android_camera_timestamp_ns"], self.android_times[i])
            np.testing.assert_array_equal(frame.depth, self.fixture.depths[i])
            np.testing.assert_allclose(frame.camera_pose.translation, [i, .2, .3])
            self.assertFalse(frame.geometry["cross_stream_clock_verified"])
            self.assertIsNone(frame.geometry["depth_dt_s"])

    def test_missing_association_or_clock_provenance_is_rejected(self):
        for key in V3_PROVENANCE:
            with self.subTest(field=key):
                value = self.fixture.rows[0].pop(key)
                with self.assertRaisesRegex(ValueError, "v3 capture provenance"):
                    list(self.read().frames())
                self.fixture.rows[0][key] = value

    def test_missing_native_timestamp_cannot_be_reconstructed_from_other_clock(self):
        self.fixture.rows[0]["android_camera_timestamp_ns"] = None
        with self.assertRaisesRegex(ValueError, "Invalid native timestamp"):
            list(self.read().frames())

    def test_hdf5_preserves_pixel_clocks_and_acquisition_provenance(self):
        session = self.read()
        frames = list(session.frames())
        output = self.fixture.root / "export"
        session.export(str(output), skip_rgb_mp4=True, skip_thumbnail=True)
        path = output / "annotation.hdf5"
        write_geometry_annotations(path, [], [f.geometry for f in frames], [f.timestamp for f in frames])
        with h5py.File(path) as h5:
            cg = h5["capture-geometry"]
            np.testing.assert_array_equal(cg["frame_timestamp_ns"][:], self.fixture.events)
            np.testing.assert_array_equal(cg["rgb_timestamp_ns"][:], self.fixture.rgb_times)
            np.testing.assert_array_equal(cg["android_camera_timestamp_ns"][:], self.android_times)
            for key, value in V3_PROVENANCE.items():
                self.assertEqual(cg[key].asstr()[:].tolist(), [value, value])
            self.assertEqual(cg["capture_geometry_version"].asstr()[:].tolist(), [VERSION, VERSION])
            self.assertFalse(cg["cross_stream_clock_verified"][:].any())


if __name__ == "__main__":
    unittest.main()
