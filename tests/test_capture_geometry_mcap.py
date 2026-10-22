"""Real ROS2 CDR/MCAP integration fixtures for Android capture contracts."""
from pathlib import Path
import json
import sys
import tempfile
import unittest
from unittest.mock import patch

import cv2
import numpy as np
from mcap_ros2.writer import Writer

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from capture_geometry import GeometrySession, VERSION, VERSION_V1, OPTICAL_TO_ARCORE
from stera.data.mcap import MCAPReader


SEP = '\n' + '=' * 80 + '\n'
HEADER = ('std_msgs/msg/Header', 'builtin_interfaces/msg/Time stamp\nstring frame_id')
TIME = ('builtin_interfaces/msg/Time', 'int32 sec\nuint32 nanosec')
POINT = ('geometry_msgs/msg/Point', 'float64 x\nfloat64 y\nfloat64 z')
VECTOR = ('geometry_msgs/msg/Vector3', 'float64 x\nfloat64 y\nfloat64 z')
QUAT = ('geometry_msgs/msg/Quaternion', 'float64 x\nfloat64 y\nfloat64 z\nfloat64 w')


def definition(body, *dependencies):
    return body + ''.join(SEP + 'MSG: ' + name + '\n' + text for name, text in dependencies) + '\n'


SCHEMAS = {
    'string': ('std_msgs/msg/String', 'string data\n'),
    'rgb': ('sensor_msgs/msg/CompressedImage', definition(
        'std_msgs/msg/Header header\nstring format\nuint8[] data', HEADER, TIME)),
    'depth': ('sensor_msgs/msg/Image', definition(
        'std_msgs/msg/Header header\nuint32 height\nuint32 width\nstring encoding\n'
        'uint8 is_bigendian\nuint32 step\nuint8[] data', HEADER, TIME)),
    'pose': ('geometry_msgs/msg/PoseStamped', definition(
        'std_msgs/msg/Header header\ngeometry_msgs/msg/Pose pose', HEADER, TIME,
        ('geometry_msgs/msg/Pose', 'geometry_msgs/msg/Point position\ngeometry_msgs/msg/Quaternion orientation'), POINT, QUAT)),
    'info': ('sensor_msgs/msg/CameraInfo', definition(
        'std_msgs/msg/Header header\nuint32 height\nuint32 width\nstring distortion_model\n'
        'float64[] d\nfloat64[9] k\nfloat64[9] r\nfloat64[12] p\n'
        'uint32 binning_x\nuint32 binning_y\nsensor_msgs/msg/RegionOfInterest roi', HEADER, TIME,
        ('sensor_msgs/msg/RegionOfInterest', 'uint32 x_offset\nuint32 y_offset\nuint32 height\nuint32 width\nbool do_rectify'))),
    'tf': ('tf2_msgs/msg/TFMessage', definition(
        'geometry_msgs/msg/TransformStamped[] transforms',
        ('geometry_msgs/msg/TransformStamped', 'std_msgs/msg/Header header\nstring child_frame_id\ngeometry_msgs/msg/Transform transform'),
        HEADER, TIME,
        ('geometry_msgs/msg/Transform', 'geometry_msgs/msg/Vector3 translation\ngeometry_msgs/msg/Quaternion rotation'), VECTOR, QUAT)),
}


def header(timestamp, frame_id='camera_optical_frame'):
    return {'stamp': {'sec': int(timestamp // 1_000_000_000), 'nanosec': int(timestamp % 1_000_000_000)},
            'frame_id': frame_id}


def intrinsics(K, width, height):
    return {'focalLengthX': float(K[0, 0]), 'focalLengthY': float(K[1, 1]),
            'principalPointX': float(K[0, 2]), 'principalPointY': float(K[1, 2]),
            'imageWidth': width, 'imageHeight': height}


def camera_info(timestamp, K, width, height):
    return {'header': header(timestamp), 'width': width, 'height': height,
            'distortion_model': 'plumb_bob', 'd': [0.] * 5, 'k': K.ravel().tolist(),
            'r': np.eye(3).ravel().tolist(), 'p': np.column_stack([K, np.zeros(3)]).ravel().tolist(),
            'binning_x': 0, 'binning_y': 0,
            'roi': {'x_offset': 0, 'y_offset': 0, 'height': 0, 'width': 0, 'do_rectify': False}}


class CaptureGeometryMcapTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.events = [10_000_000_000, 10_020_000_000]
        self.rgb_times = self.events.copy()
        # Same native depth time for two differently acquired/stored payloads.
        self.depth_time = 9_990_000_000
        self.depths = [np.arange(12, dtype=np.uint16).reshape(3, 4) + 500,
                       np.arange(12, dtype=np.uint16).reshape(3, 4) + 900]
        self.K = [np.array([[6., 0, 3.3], [0, 7., 2.3], [0, 0, 1.]]),
                  np.array([[6.4, 0, 3.4], [0, 7.2, 2.4], [0, 0, 1.]])]
        self.H = [np.diag([.5, .5, 1.]),
                  np.array([[.4, 0, .2], [0, .4, .1], [0, 0, 1.]])]
        self.rows = [self.row(i) for i in range(2)]

    def row(self, i):
        return {'capture_geometry_version': VERSION,
                'frame_timestamp_ns': self.events[i], 'rgb_timestamp_ns': self.rgb_times[i],
                'android_camera_timestamp_ns': self.rgb_times[i],
                'cross_stream_clock_verified': False,
                'depth_timestamp_ns': self.depth_time, 'tracking_state': 'TRACKING',
                'rgb_encoded': True, 'depth_available': True,
                'rgb_width': 8, 'rgb_height': 6, 'depth_width': 4, 'depth_height': 3,
                'rgb_intrinsics': intrinsics(self.K[i], 8, 6),
                'depth_intrinsics': intrinsics(self.H[i] @ self.K[i], 4, 3),
                'rgb_pixel_to_depth_pixel': self.H[i].ravel().tolist()}

    def write_capture(self, *, metadata_version=VERSION, omitted_geometry=(),
                      wrong_tf=False, omitted_depth=(), omitted_pose=(),
                      depth_headers=None, depth_log_times=None,
                      omitted_rgb=(), rgb_headers=None, rgb_log_times=None,
                      rgb_publish_times=None):
        path = self.root / 'fixture.mcap'
        metadata = {} if metadata_version is None else {'capture_geometry_version': metadata_version}
        (self.root / 'metadata.json').write_text(json.dumps(metadata))
        with path.open('wb') as stream, Writer(stream) as writer:
            schemas = {key: writer.register_msgdef(*schema) for key, schema in SCHEMAS.items()}
            def emit(topic, kind, payload, timestamp, publish_time=None):
                writer.write_message(topic, schemas[kind], payload, log_time=timestamp,
                                     publish_time=timestamp if publish_time is None else publish_time)
            q = {'x': 0. if wrong_tf else 1., 'y': 0., 'z': 0., 'w': 1. if wrong_tf else 0.}
            emit('/tf', 'tf', {'transforms': [{'header': header(self.events[0], 'camera_link'),
                 'child_frame_id': 'camera_optical_frame', 'transform': {
                 'translation': {'x': 0., 'y': 0., 'z': 0.}, 'rotation': q}}]}, self.events[0])
            emit('/camera/camera_info', 'info', camera_info(self.events[0], self.K[0], 8, 6), self.events[0])
            emit('/camera/depth/camera_info', 'info', camera_info(self.events[0], self.H[0] @ self.K[0], 4, 3), self.events[0])
            # Deliberately write the later frame first. Read ordering must be
            # based on recorded events, not physical file emission order.
            for i in (1, 0):
                event = self.events[i]
                pixels = np.full((6, 8, 3), 50 + 80*i, np.uint8)
                ok, jpeg = cv2.imencode('.jpg', pixels)
                assert ok
                if i not in omitted_rgb:
                    native_rgb = self.rgb_times[i] if rgb_headers is None else rgb_headers[i]
                    rgb_log = event if rgb_log_times is None else rgb_log_times[i]
                    rgb_publish = native_rgb if rgb_publish_times is None else rgb_publish_times[i]
                    emit('/camera/rgb/compressed', 'rgb', {'header': header(native_rgb), 'format': 'jpeg', 'data': jpeg.tobytes()}, rgb_log, publish_time=rgb_publish)
                if i not in omitted_depth:
                    native = self.depth_time if depth_headers is None else depth_headers[i]
                    logged = event if depth_log_times is None else depth_log_times[i]
                    emit('/camera/depth', 'depth', {'header': header(native), 'height': 3, 'width': 4,
                         'encoding': '16UC1', 'is_bigendian': 0, 'step': 8, 'data': self.depths[i].tobytes()}, logged, publish_time=native)
                if i not in omitted_pose:
                    emit('/camera/pose', 'pose', {'header': header(event, 'world'), 'pose': {
                         'position': {'x': float(i), 'y': .2, 'z': .3},
                         'orientation': {'x': 0., 'y': 0., 'z': 0., 'w': 1.}}}, event)
                if i not in omitted_geometry:
                    emit('/capture/frame_geometry', 'string', {'data': json.dumps(self.rows[i])}, event)
        return path

    def test_repeated_depth_timestamp_uses_exact_frame_event_payload(self):
        path = self.write_capture()
        # Prove this fixture catches the SDK's nearest-header ambiguity.
        upstream = list(MCAPReader(path).frames())
        self.assertTrue(any(not np.array_equal(frame.depth, expected)
                            for frame, expected in zip(upstream, self.depths)))
        session = GeometrySession(path)
        frames = list(session.frames())
        self.assertEqual(len(frames), 2)
        for i, frame in enumerate(frames):
            np.testing.assert_array_equal(frame.depth, self.depths[i])
            np.testing.assert_allclose(frame.camera_pose.translation, [i, .2, .3])
            self.assertAlmostEqual(frame.timestamp, self.events[i]/1e9)
            self.assertIsNone(frame.geometry['depth_dt_s'])
            self.assertFalse(frame.geometry['depth_time_verified'])
            self.assertFalse(frame.geometry['metric_accuracy_validated'])
        np.testing.assert_array_equal(session.R_optical_to_link, OPTICAL_TO_ARCORE)

    def test_per_frame_intrinsics_and_crop_mapping_survive_real_decode(self):
        frames = list(GeometrySession(self.write_capture()).frames())
        for i, frame in enumerate(frames):
            np.testing.assert_allclose(frame.rgb_K, self.K[i])
            np.testing.assert_allclose(frame.depth_K, self.H[i] @ self.K[i])
            np.testing.assert_allclose(frame.geometry['rgb_to_depth'], self.H[i])
            self.assertTrue(frame.geometry['calibration_contract_verified'])
        self.assertFalse(np.array_equal(frames[0].depth_K, frames[1].depth_K))

    def test_missing_frame_geometry_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'one-to-one'):
            GeometrySession(self.write_capture(omitted_geometry=(1,)))

    def test_wrong_optical_transform_is_rejected(self):
        with self.assertRaisesRegex(ValueError, 'optical transform'):
            GeometrySession(self.write_capture(wrong_tf=True))

    def test_unsupported_metadata_version_is_rejected(self):
        with self.assertRaises(ValueError):
            GeometrySession(self.write_capture(metadata_version='android_arcore_cpu_v999'))

    def test_frame_version_must_match_contract(self):
        self.rows[1]['capture_geometry_version'] = 'unsupported_version'
        with self.assertRaisesRegex(ValueError, 'unsupported'):
            list(GeometrySession(self.write_capture()).frames())

    def test_missing_depth_payload_cannot_borrow_nearby_frame(self):
        with self.assertRaisesRegex(ValueError, 'absent depth payload'):
            list(GeometrySession(self.write_capture(omitted_depth=(1,))).frames())

    def test_depth_header_must_match_same_event_geometry(self):
        with self.assertRaisesRegex(ValueError, 'Depth header'):
            list(GeometrySession(self.write_capture(depth_headers=[self.depth_time, self.depth_time + 1])).frames())

    def test_depth_payload_must_share_acquisition_event_log_time(self):
        with self.assertRaisesRegex(ValueError, 'absent depth payload'):
            list(GeometrySession(self.write_capture(depth_log_times=[self.events[0], self.events[1] + 1])).frames())

    def test_tracked_pose_cannot_borrow_previous_pose(self):
        with self.assertRaisesRegex(ValueError, 'matching physical camera pose'):
            list(GeometrySession(self.write_capture(omitted_pose=(1,))).frames())

    def test_stale_depth_is_retained_with_timing_failure(self):
        self.depth_time -= 1_000_000_000
        self.rows = [self.row(i) for i in range(2)]
        frames = list(GeometrySession(self.write_capture()).frames())
        for i, frame in enumerate(frames):
            np.testing.assert_array_equal(frame.depth, self.depths[i])
            self.assertFalse(frame.geometry['depth_time_verified'])

    def test_unavailable_depth_and_paused_tracking_do_not_borrow_evidence(self):
        self.rows[1]['tracking_state'] = 'PAUSED'
        self.rows[1]['depth_available'] = False
        self.rows[1]['depth_timestamp_ns'] = None
        frames = list(GeometrySession(self.write_capture(omitted_depth=(1,), omitted_pose=(1,))).frames())
        self.assertIsNotNone(frames[0].camera_pose)
        self.assertIsNotNone(frames[0].depth)
        self.assertIsNone(frames[1].camera_pose)
        self.assertIsNone(frames[1].depth)
        self.assertFalse(frames[1].geometry['tracking'])
        self.assertFalse(frames[1].geometry['depth_time_verified'])

    def test_iteration_timing_override_controls_verified_status(self):
        session = GeometrySession(self.write_capture(), max_depth_dt=.033)
        frames = list(session.frames(max_depth_dt=.001))
        self.assertTrue(all(not frame.geometry['depth_time_verified'] for frame in frames))

    def test_distinct_rgb_and_arcore_clocks_join_by_frame_event(self):
        self.rgb_times = [17_000_000_123, 17_020_000_456]
        self.rows = [self.row(i) for i in range(2)]
        session = GeometrySession(self.write_capture())
        frames = list(session.frames())
        self.assertEqual(session._rgb_events, self.events)
        self.assertEqual(session._native_rgb_times, self.rgb_times)
        for i, frame in enumerate(frames):
            self.assertAlmostEqual(frame.timestamp, self.rgb_times[i] / 1e9)
            self.assertEqual(frame.geometry['frame_event_timestamp_ns'], self.events[i])
            self.assertEqual(frame.geometry['source']['android_camera_timestamp_ns'], self.rgb_times[i])
            np.testing.assert_array_equal(frame.depth, self.depths[i])
            np.testing.assert_allclose(frame.camera_pose.translation, [i, .2, .3])
            self.assertFalse(frame.geometry['depth_time_verified'])
            self.assertIsNone(frame.geometry['depth_dt_s'])

    def test_repeated_native_rgb_timestamp_keeps_distinct_event_associations(self):
        self.rgb_times = [17_000_000_000, 17_000_000_000]
        self.rows = [self.row(i) for i in range(2)]
        frames = list(GeometrySession(self.write_capture()).frames())
        self.assertEqual(len(frames), 2)
        for i, frame in enumerate(frames):
            np.testing.assert_array_equal(frame.depth, self.depths[i])
            np.testing.assert_allclose(frame.camera_pose.translation, [i, .2, .3])

    def test_rgb_header_publish_and_event_contracts_are_checked(self):
        for kwargs, pattern in [
                ({'rgb_publish_times': [self.rgb_times[0], self.rgb_times[1]+1]}, 'RGB publish'),
                ({'rgb_headers': [self.rgb_times[0], self.rgb_times[1]+1]}, 'RGB header'),
                ({'rgb_log_times': [self.events[0], self.events[1]+1]}, 'one-to-one')]:
            with self.subTest(kwargs=kwargs), self.assertRaisesRegex(ValueError, pattern):
                GeometrySession(self.write_capture(**kwargs))

    def test_android_camera_timestamp_must_match_native_image(self):
        self.rows[1]['android_camera_timestamp_ns'] += 1
        with self.assertRaisesRegex(ValueError, 'Android camera timestamp'):
            list(GeometrySession(self.write_capture()).frames())

    def test_zero_encoded_rgb_capture_is_rejected_clearly(self):
        with self.assertRaisesRegex(ValueError, 'zero encoded RGB frames'):
            GeometrySession(self.write_capture(omitted_rgb=(0, 1)))

    def test_v1_geometry_still_reads_but_depth_age_is_unverified(self):
        for row in self.rows:
            row['capture_geometry_version'] = VERSION_V1
            del row['android_camera_timestamp_ns']
            del row['cross_stream_clock_verified']
        session = GeometrySession(self.write_capture(metadata_version=VERSION_V1))
        for i, frame in enumerate(session.frames()):
            np.testing.assert_array_equal(frame.depth, self.depths[i])
            self.assertIsNone(frame.geometry['depth_dt_s'])
            self.assertFalse(frame.geometry['depth_time_verified'])

    def test_unverified_nearest_native_imu_association_is_removed(self):
        path = self.write_capture()
        fake_imu = [(self.rgb_times[0]/1e9, {'unverified_sample': True})]
        with patch.object(MCAPReader, 'all_imu_samples', return_value=fake_imu):
            self.assertIsNotNone(next(MCAPReader(path).frames()).imu)
            self.assertIsNone(next(GeometrySession(path).frames()).imu)


if __name__ == '__main__':
    unittest.main()
