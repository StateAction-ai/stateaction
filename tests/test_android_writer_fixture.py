"""Decode bytes emitted by Android's JPEG encoder and the Kotlin MCAP writer.

Unlike the Python-generated fixtures, this locks down the producer/consumer
boundary, including ROS2 CDR alignment and separate acquisition/native clocks.
All pixel, pose, and depth values are synthetic; passing is not sensor accuracy.
"""
from collections import defaultdict
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

import numpy as np
from mcap.reader import make_reader
from mcap_ros2.decoder import DecoderFactory

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from capture_geometry import GeometrySession, OPTICAL_TO_ARCORE, VERSION, header_ns


FIXTURE = Path(__file__).parent / "fixtures" / "android_geometry_v2"
MCAP = FIXTURE / "session_data_20261022_002554.mcap"
EVENTS = [1_453_692_090_999_999 + i * 33_333_333 for i in range(3)]
RGB_TIMES = [1_453_692_090_123_456 + i * 33_333_333 for i in range(3)]
DEPTH_TIME = 1_453_692_080_123_456
RGB_K = np.array([[30., 0, 15.5], [0, 30., 7.5], [0, 0, 1.]])
RGB_TO_DEPTH = np.diag([.25, .25, 1.])


class AndroidWriterFixtureTests(unittest.TestCase):
    def test_failed_metadata_rejects_otherwise_readable_three_frame_capture(self):
        self.assertEqual(len(list(GeometrySession(MCAP).frames())), 3)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            capture = root / MCAP.name
            capture.write_bytes(MCAP.read_bytes())
            original = json.loads((FIXTURE / "metadata.json").read_text())
            for flag in ("capture_result_valid", "finalization_complete"):
                with self.subTest(flag=flag):
                    metadata = {**original, "capture_result_valid": True,
                                "finalization_complete": True, flag: False}
                    (root / "metadata.json").write_text(json.dumps(metadata))
                    with self.assertRaisesRegex(ValueError, flag + "=false"):
                        GeometrySession(capture)
            # Older valid captures may omit either field; absence is not failure.
            metadata = {key: value for key, value in original.items()
                        if key not in ("capture_result_valid", "finalization_complete")}
            (root / "metadata.json").write_text(json.dumps(metadata))
            self.assertEqual(len(list(GeometrySession(capture).frames())), 3)

    def test_generated_files_are_preserved_with_three_frame_metadata(self):
        provenance = json.loads((FIXTURE / "provenance.json").read_text())
        for filename, expected in provenance["artifact_files"].items():
            with self.subTest(file=filename):
                data = (FIXTURE / filename).read_bytes()
                self.assertEqual(len(data), expected["size_bytes"])
                self.assertEqual(hashlib.sha256(data).hexdigest(), expected["sha256"])
        metadata = json.loads((FIXTURE / "metadata.json").read_text())
        self.assertEqual(metadata["capture_geometry_version"], VERSION)
        self.assertEqual(metadata["capture_geometry"]["version"], VERSION)
        self.assertEqual(metadata["device_model"], "synthetic_android_fixture")
        self.assertEqual(metadata["rgb_written_count"], 3)
        self.assertIs(metadata["capture_result_valid"], True)
        self.assertIs(metadata["capture_geometry"]["cross_stream_clock_verified"], False)

    def test_kotlin_cdr_retains_each_clock_and_acquisition_association(self):
        records = defaultdict(list)
        with MCAP.open("rb") as stream:
            reader = make_reader(stream, decoder_factories=[DecoderFactory()])
            for schema, channel, message, decoded in reader.iter_decoded_messages():
                records[channel.topic].append((schema, channel, message, decoded))

        topics = ("/capture/frame_geometry", "/camera/rgb/compressed",
                  "/camera/depth", "/camera/pose")
        for topic in topics:
            self.assertEqual(len(records[topic]), 3, topic)
            for index, (schema, channel, message, decoded) in enumerate(records[topic]):
                with self.subTest(topic=topic, frame=index):
                    self.assertEqual(channel.message_encoding, "cdr")
                    self.assertEqual(schema.encoding, "ros2msg")
                    self.assertEqual(message.log_time, EVENTS[index])
                    if topic == "/capture/frame_geometry":
                        self.assertEqual(schema.name, "std_msgs/msg/String")
                        row = json.loads(decoded.data)
                        self.assertEqual(row["capture_geometry_version"], VERSION)
                        self.assertEqual(row["frame_timestamp_ns"], EVENTS[index])
                        self.assertEqual(row["android_camera_timestamp_ns"], RGB_TIMES[index])
                        self.assertEqual(row["rgb_timestamp_ns"], RGB_TIMES[index])
                        self.assertEqual(row["depth_timestamp_ns"], DEPTH_TIME)
                        self.assertIs(row["cross_stream_clock_verified"], False)
                        self.assertEqual(message.publish_time, EVENTS[index])
                    else:
                        native = (RGB_TIMES[index] if topic == "/camera/rgb/compressed"
                                  else DEPTH_TIME if topic == "/camera/depth"
                                  else EVENTS[index])
                        self.assertEqual(header_ns(decoded), native)
                        self.assertEqual(message.publish_time, native)
        # The fixture deliberately cannot be read by assuming Frame == Image.
        self.assertTrue(all(event != rgb for event, rgb in zip(EVENTS, RGB_TIMES)))

    def test_repeated_native_depth_time_does_not_reuse_another_event_payload(self):
        session = GeometrySession(MCAP)
        frames = list(session.frames())
        self.assertEqual(len(frames), 3)
        np.testing.assert_allclose(session.R_optical_to_link, OPTICAL_TO_ARCORE)
        for index, frame in enumerate(frames):
            with self.subTest(frame=index):
                expected = np.arange(32, dtype=np.uint16).reshape(4, 8) + 700 + index * 10
                np.testing.assert_array_equal(frame.depth, expected)
                self.assertEqual(frame.depth.dtype, np.uint16)
                np.testing.assert_allclose(frame.rgb_K, RGB_K)
                np.testing.assert_allclose(frame.geometry["rgb_to_depth"], RGB_TO_DEPTH)
                np.testing.assert_allclose(frame.depth_K, RGB_TO_DEPTH @ RGB_K)
                np.testing.assert_allclose(frame.camera_pose.translation, [index * .01, 0, 0])
                np.testing.assert_allclose(frame.camera_pose.rotation, np.eye(3))
                self.assertEqual(frame.timestamp, RGB_TIMES[index] / 1e9)
                self.assertEqual(frame.geometry["frame_event_timestamp_ns"], EVENTS[index])
                self.assertEqual(frame.geometry["source"]["depth_timestamp_ns"], DEPTH_TIME)
                self.assertIs(frame.geometry["calibration_contract_verified"], True)
                self.assertIs(frame.geometry["cross_stream_clock_verified"], False)
                self.assertIs(frame.geometry["depth_time_verified"], False)
                self.assertIs(frame.geometry["metric_accuracy_validated"], False)
                self.assertIsNone(frame.geometry["depth_dt_s"])
                self.assertIsNone(frame.imu)

    def test_android_jpeg_keeps_native_orientation_and_asymmetric_quadrants(self):
        for frame in GeometrySession(MCAP).frames():
            with self.subTest(frame=frame.index):
                self.assertEqual(frame.rgb.shape, (16, 32, 3))
                # Same coordinates/assertion as the instrumented Android test;
                # the source Y plane is padded and has a nonzero buffer offset.
                actual = [int(frame.rgb[y, x, 0])
                          for x, y in [(4, 3), (25, 3), (4, 12), (25, 12)]]
                self.assertTrue(all(a < b for a, b in zip(actual, actual[1:])), actual)
                np.testing.assert_allclose(actual, [25, 85, 150, 220], atol=3, rtol=0)


if __name__ == "__main__":
    unittest.main()
