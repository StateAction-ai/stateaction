import sys
import unittest
from pathlib import Path

import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from capture_geometry import OPTICAL_TO_ARCORE, VERSION, VERSION_V1, validate_record, rotate_intrinsics_180
from stera.data.mcap import CameraIntrinsics


class GeometryTests(unittest.TestCase):
    def record(self):
        # CPU 640x480 image, cropped to 16:9 depth: v_d=.25*v_rgb-15.
        return {"capture_geometry_version": VERSION, "rgb_encoded": True,
                "frame_timestamp_ns": 100_000_000, "rgb_timestamp_ns": 200_000_000,
                "android_camera_timestamp_ns": 200_000_000,
                "cross_stream_clock_verified": False,
                "depth_timestamp_ns": 199_000_000, "tracking_state": "TRACKING",
                "rgb_width": 640, "rgb_height": 480, "depth_width": 160, "depth_height": 90,
                "rgb_intrinsics": {"focalLengthX": 500, "focalLengthY": 500,
                    "principalPointX": 320, "principalPointY": 240, "imageWidth": 640, "imageHeight": 480},
                "depth_intrinsics": {"focalLengthX": 125, "focalLengthY": 125,
                    "principalPointX": 80, "principalPointY": 45, "imageWidth": 160, "imageHeight": 90},
                "depth_available": True, "rgb_pixel_to_depth_pixel": [.25, 0, 0, 0, .25, -15, 0, 0, 1]}

    def test_cropped_depth_projects_same_ray(self):
        result = validate_record(self.record(), (480, 640, 3), (90, 160))
        xyz = np.array([.1, .2, 1.])
        np.testing.assert_allclose(result["rgb_to_depth"] @ result["rgb_K"] @ xyz, result["depth_K"] @ xyz)
        self.assertFalse(result["depth_time_verified"])
        self.assertIsNone(result["depth_dt_s"])

    def test_dimension_only_mapping_fails_for_crop(self):
        row = self.record()
        row["rgb_pixel_to_depth_pixel"] = [.25, 0, 0, 0, 90/480, 0, 0, 0, 1]
        with self.assertRaisesRegex(ValueError, "intrinsics disagree"):
            validate_record(row, (480, 640, 3), (90, 160))

    def test_native_stale_depth_not_timing_verified(self):
        row = self.record(); row["depth_timestamp_ns"] = 0
        result = validate_record(row, (480, 640, 3), (90, 160))
        self.assertFalse(result["depth_time_verified"])
        self.assertIsNone(result["depth_dt_s"])

    def test_distinct_arcore_and_native_rgb_clocks_are_supported(self):
        row = self.record()
        result = validate_record(row, (480, 640, 3), (90, 160))
        self.assertTrue(result["calibration_contract_verified"])
        self.assertEqual(result["frame_event_timestamp_ns"], 100_000_000)
        self.assertEqual(result["rgb_timestamp_ns"], 200_000_000)

    def test_numeric_clock_equality_cannot_prove_depth_age(self):
        row = self.record(); row["depth_timestamp_ns"] = row["rgb_timestamp_ns"]
        result = validate_record(row, (480, 640, 3), (90, 160))
        self.assertFalse(result["cross_stream_clock_verified"])
        self.assertFalse(result["depth_time_verified"])
        self.assertIsNone(result["depth_dt_s"])

    def test_v2_clock_claim_and_missing_android_timestamp_rejected(self):
        for key, value in (("android_camera_timestamp_ns", None), ("cross_stream_clock_verified", True)):
            row = self.record(); row[key] = value
            with self.assertRaises(ValueError):
                validate_record(row, (480, 640, 3), (90, 160))

    def test_v1_read_support_retains_conservative_timing(self):
        row = self.record(); row["capture_geometry_version"] = VERSION_V1
        row["rgb_timestamp_ns"] = row["frame_timestamp_ns"]
        del row["android_camera_timestamp_ns"]
        del row["cross_stream_clock_verified"]
        result = validate_record(row, (480, 640, 3), (90, 160))
        self.assertTrue(result["calibration_contract_verified"])
        self.assertFalse(result["depth_time_verified"])
        self.assertIsNone(result["depth_dt_s"])
        row["rgb_timestamp_ns"] += 1
        with self.assertRaisesRegex(ValueError, "timestamps differ"):
            validate_record(row, (480, 640, 3), (90, 160))

    def test_missing_payload_and_rotated_mapping_rejected(self):
        with self.assertRaisesRegex(ValueError, "absent depth"):
            validate_record(self.record(), (480, 640, 3))
        row = self.record(); row["rgb_pixel_to_depth_pixel"][0] = -.25
        with self.assertRaisesRegex(ValueError, "optical-axis"):
            validate_record(row, (480, 640, 3), (90, 160))

    def test_timestamp_and_image_contract_rejected(self):
        for key, value in (("rgb_timestamp_ns", 4), ("rgb_width", 100)):
            row = self.record(); row[key] = value
            with self.assertRaises(ValueError): validate_record(row, (480, 640, 3), (90, 160))

    def test_optical_forward_and_image_rotation_roundtrip(self):
        np.testing.assert_array_equal(OPTICAL_TO_ARCORE @ [0, 0, 1], [0, 0, -1])
        k = np.array([[500., 0, 321], [0, 500, 238], [0, 0, 1]])
        intrinsic = CameraIntrinsics(640, 480, k, np.zeros(0))
        rotated = rotate_intrinsics_180(intrinsic)
        point = np.array([.1, .2, 1.])
        p = k @ point; q = rotated.K @ np.diag([-1., -1., 1.]) @ point
        np.testing.assert_allclose(q[:2]/q[2], [639-p[0]/p[2], 479-p[1]/p[2]])
        np.testing.assert_array_equal(intrinsic.K, k)


if __name__ == "__main__": unittest.main()
