"""Original Stera container -> JPEG evidence -> decoded RGB.

Fixtures model the recorder's ROS2 CDR channel, including separate log/publish stamps and
repeated MCAP sequences. They are synthetic; they provide no physical camera qualification.
"""

import dataclasses
import hashlib
import io
import struct
import unittest
from fractions import Fraction

from indexed_fixture import build, s
from test_mcap_stream import ForwardOnly, metadata_body

from stateaction_processing.capture_stream import CaptureStreamError, StreamLimits
from stateaction_processing.jpeg_stream import JPEG_PROFILE, JpegCaptureStream

SCHEMA = b"std_msgs/msg/Header header\nstring format\nuint8[] data"


def compressed_image(stamp, jpeg, *, fmt="jpeg"):
    data = bytearray(b"\x00\x01\x00\x00" + struct.pack("<iI", *divmod(stamp, 10**9)))
    for value in ("camera_rgb_optical_frame", fmt):
        data += b"\x00" * (-len(data) % 4)
        encoded = value.encode() + b"\x00"
        data += struct.pack("<I", len(encoded)) + encoded
    data += b"\x00" * (-len(data) % 4)
    return bytes(data) + struct.pack("<I", len(jpeg)) + jpeg


def synthetic_jpeg(width=64, height=48):
    # SOF-only payload for reader tests; decode tests below use real encoded JPEGs.
    return (
        b"\xff\xd8\xff\xc0"
        + struct.pack(">HBHHB", 8, 8, height, width, 3)
        + b"\xff\xd9"
    )


def capture(
    jpegs=None,
    stamps=None,
    *,
    profile="ros2",
    publish_offset=0,
    extra_topics=(),
    **container_options,
):
    jpegs = jpegs or [synthetic_jpeg()] * 3
    stamps = stamps or [2_000_000_123, 2_033_333_987, 2_075_000_001][: len(jpegs)]
    schema = struct.pack("<H", 1) + s("sensor_msgs/msg/CompressedImage") + s("ros2msg")
    schema += struct.pack("<I", len(SCHEMA)) + SCHEMA
    channel = (
        struct.pack("<HH", 9, 1)
        + s("/camera/rgb/compressed")
        + s("cdr")
        + struct.pack("<I", 0)
    )
    records = [(3, schema), (4, channel)]
    for channel_id, topic in enumerate(extra_topics, start=10):
        channel = (
            struct.pack("<HH", channel_id, 0)
            + s(topic)
            + s("cdr")
            + struct.pack("<I", 0)
        )
        records.append((4, channel))
    for stamp, jpeg in zip(stamps, jpegs, strict=True):
        # A global modulo-2**32 sequence is evidence, not a unique camera frame identity.
        records.append(
            (
                5,
                struct.pack(
                    "<HIQQ", 9, 7, stamp + 8_000_000_000, stamp + publish_offset
                )
                + compressed_image(stamp, jpeg),
            )
        )
    for channel_id, _ in enumerate(extra_topics, start=10):
        records.append((5, struct.pack("<HIQQ", channel_id, 1, 123, 456) + b"opaque"))
    return build(
        s(profile) + s("stera-jpeg-synthetic-test"), records, **container_options
    )


class JpegCaptureTests(unittest.TestCase):
    def test_preserves_source_evidence_and_accepts_only_complete_container(self):
        data = capture(metadata_records=(metadata_body(),))
        stream = JpegCaptureStream(ForwardOnly(data))
        iterator = iter(stream)
        first = next(iterator)
        self.assertFalse(stream.accepted)
        frames = [first, *iterator]
        self.assertTrue(stream.accepted)
        self.assertEqual([f.source_frame_id for f in frames], ["0", "1", "2"])
        self.assertEqual([f.sequence for f in frames], [7, 7, 7])
        self.assertEqual(first.ros_stamp_ns, "2000000123")
        self.assertEqual(first.publish_time_ns, "2000000123")
        self.assertEqual(first.log_time_ns, "10000000123")
        self.assertEqual(first.derived_pts_us, 2000000)
        self.assertEqual(first.native_clock_id, "stera_ros_header_unqualified")
        self.assertEqual(first.sha256, hashlib.sha256(first.data).hexdigest())
        self.assertEqual(first.source_message["jpeg_sha256"], first.sha256)
        self.assertEqual(stream.report.source.sha256, hashlib.sha256(data).hexdigest())
        self.assertEqual(stream.report.source.bytes_read, len(data))
        self.assertEqual(stream.report.source.metadata_records, 1)
        self.assertIsNone(stream.report.close)

    def test_rgb_scope_reports_non_rgb_messages_without_decoding_them(self):
        data = capture(
            extra_topics=(
                "/camera/depth",
                "/camera/pose",
                "/device/imu",
                "/camera/camera_info",
                "/capture/frame_geometry",
                "/tf",
                "/map/mesh",
                "/unsupported",
            )
        )
        stream = JpegCaptureStream(ForwardOnly(data))
        self.assertEqual(len(list(stream)), 3)
        self.assertTrue(stream.accepted)
        self.assertTrue(stream.report.rgb_only)
        self.assertEqual(
            stream.report.excluded_messages_by_domain,
            {
                "depth": 1,
                "pose": 1,
                "imu": 1,
                "calibration": 1,
                "frame_geometry": 1,
                "transforms": 1,
                "scene_geometry": 1,
                "other": 1,
            },
        )
        self.assertEqual(stream.report.source.bytes_read, len(data))
        self.assertEqual(stream.report.source.sha256, hashlib.sha256(data).hexdigest())

    def test_publish_stamp_is_preserved_without_assuming_a_clock_mapping(self):
        first = next(iter(JpegCaptureStream(io.BytesIO(capture(publish_offset=1234)))))
        self.assertEqual(first.ros_stamp_ns, "2000000123")
        self.assertEqual(first.publish_time_ns, "2000001357")
        self.assertEqual(first.log_time_ns, "10000000123")

    def test_damaged_footer_cannot_accept_provisional_frames(self):
        stream = JpegCaptureStream(ForwardOnly(capture()[:-3]))
        iterator = iter(stream)
        next(iterator)
        with self.assertRaises(CaptureStreamError):
            list(iterator)
        self.assertFalse(stream.accepted)

    def test_microsecond_collision_fails_without_retiming(self):
        stream = JpegCaptureStream(
            io.BytesIO(capture([synthetic_jpeg()] * 2, [2_000_000_123, 2_000_000_999]))
        )
        with self.assertRaises(CaptureStreamError) as error:
            list(stream)
        self.assertEqual(error.exception.code, "E_JPEG_PTS_COLLISION")
        self.assertFalse(stream.accepted)

    def test_raster_is_bounded_before_decode(self):
        stream = JpegCaptureStream(io.BytesIO(capture([synthetic_jpeg(4096, 4096)])))
        with self.assertRaises(CaptureStreamError) as error:
            list(stream)
        self.assertEqual(error.exception.code, "E_RASTER_BOUND")

    def test_profile_is_explicit_not_autodetected(self):
        from stateaction_processing.frames import FrameStream

        with self.assertRaises(CaptureStreamError):
            list(FrameStream(io.BytesIO(capture())))
        with self.assertRaises(CaptureStreamError) as error:
            list(JpegCaptureStream(io.BytesIO(capture(profile=""))))
        self.assertEqual(error.exception.code, "E_JPEG_PROFILE")

    def test_message_and_frame_limits_fail(self):
        for limits in (
            dataclasses.replace(StreamLimits(), max_frames=1),
            dataclasses.replace(StreamLimits(), max_access_unit_bytes=4),
        ):
            stream = JpegCaptureStream(io.BytesIO(capture()), limits)
            with self.assertRaises(CaptureStreamError):
                list(stream)
            self.assertFalse(stream.accepted)


try:
    import av
    import numpy as np

    HAVE_DECODE = True
except ImportError:
    HAVE_DECODE = False


def real_jpeg():
    rgb = np.zeros((48, 64, 3), dtype=np.uint8)
    rgb[:, :, 0] = np.arange(64, dtype=np.uint8) * 4
    rgb[:, :, 1] = np.arange(48, dtype=np.uint8)[:, None] * 5
    rgb[:, :, 2] = 180
    encoder = av.CodecContext.create("mjpeg", "w")
    encoder.width, encoder.height, encoder.pix_fmt = 64, 48, "yuvj420p"
    encoder.time_base = Fraction(1, 25)
    encoder.thread_count = 1
    encoder.open()
    frame = av.VideoFrame.from_ndarray(rgb, format="rgb24").reformat(format="yuvj420p")
    frame.pts = 0
    return bytes((list(encoder.encode(frame)) + list(encoder.encode(None)))[0])


@unittest.skipUnless(HAVE_DECODE, "decode dependencies unavailable")
class JpegFrameTests(unittest.TestCase):
    def test_real_jpeg_path_decodes_once_and_keeps_identity(self):
        from stateaction_processing.frames import FrameStream

        stream = FrameStream(
            ForwardOnly(capture([real_jpeg()] * 3)), source_profile=JPEG_PROFILE
        )
        frames = list(stream)
        stream.require_accepted()
        self.assertEqual(stream.decode_stats.frames_out, 3)
        self.assertEqual(stream.decode_stats.packets_sent, 3)
        self.assertEqual(stream.decode_stats.decoder_instances, 1)
        self.assertEqual(stream.decode_stats.peak_pending, 1)
        for frame in frames:
            self.assertEqual(frame.rgb.shape, (48, 64, 3))
            self.assertGreater(float(frame.rgb.std()), 30)
            self.assertEqual(frame.access_unit.source_encoding, "jpeg")
            self.assertEqual(frame.transform.raster, (64, 48))
            self.assertIsNone(frame.transform.crop)
            self.assertIsNone(frame.transform.rotation_deg)
            self.assertIsNone(frame.transform.mirror)
            self.assertEqual(
                frame.transform.basis,
                "stera_jpeg_saved_raster; crop_rotation_mirror_unverified",
            )

    def test_reader_valid_but_undecodable_jpeg_cannot_accept(self):
        from stateaction_processing.frames import FrameStream

        stream = FrameStream(io.BytesIO(capture()), source_profile=JPEG_PROFILE)
        with self.assertRaises(Exception):
            list(stream)
        self.assertFalse(stream.accepted)
