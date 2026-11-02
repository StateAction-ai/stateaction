import hashlib
import unittest
from pathlib import Path

from indexed_fixture import chunked
from stateaction_processing.frames import FrameStream
from stateaction_processing.h264_decode import DecodeError
from test_mcap_stream import ForwardOnly

try:
    import av  # noqa: F401
    import numpy  # noqa: F401

    HAVE_DECODE = True
except ImportError:
    HAVE_DECODE = False

GOLDEN = Path(__file__).resolve().parents[3] / "packages/contracts/capture/golden"


@unittest.skipUnless(HAVE_DECODE, "decode dependency group not installed")
class FrameTests(unittest.TestCase):
    def test_decodes_each_frame_once_with_original_identity(self):
        data = chunked((GOLDEN / "valid.mcap").read_bytes())
        st = FrameStream(ForwardOnly(data))
        frames = []
        for f in st:
            self.assertEqual(f.rgb.dtype.name, "uint8")
            self.assertEqual(f.rgb.shape, (48, 64, 3))
            self.assertEqual(f.transform.raster, (64, 48))
            self.assertIsNone(f.transform.rotation_deg)
            self.assertIsNone(f.transform.mirror)
            self.assertIsNone(f.transform.crop)
            frames.append(
                (
                    f.access_unit.sequence,
                    f.access_unit.source_frame_id,
                    f.access_unit.encoder_pts_us,
                )
            )
        report = st.require_accepted()
        self.assertEqual([x[0] for x in frames], [0, 1, 2, 3, 4])
        self.assertEqual(st.decode_stats.packets_sent, 5)
        self.assertEqual(st.decode_stats.frames_out, 5)
        self.assertEqual(st.decode_stats.decoder_instances, 1)
        self.assertLessEqual(st.decode_stats.peak_pending, 4)
        self.assertEqual(report.source.sha256, hashlib.sha256(data).hexdigest())

    def test_not_accepted_until_exhausted(self):
        data = chunked((GOLDEN / "valid.mcap").read_bytes())
        st = FrameStream(ForwardOnly(data))
        it = iter(st)
        next(it)
        with self.assertRaises(Exception):
            st.require_accepted()

    def test_corrupt_h264_payload_fails_the_job(self):
        from indexed_fixture import build, flat_records

        header, recs = flat_records((GOLDEN / "valid.mcap").read_bytes())
        out, videos = [], 0
        for op, body in recs:
            if (
                op == 5
                and body[22:26] != b""
                and b"foxglove" not in body
                and len(body) > 100
            ):
                pass
            out.append((op, body))
        # Corrupt the slice data of the second video access unit (message with the video channel).
        import capture_conformance as cc

        chans = {}
        for op, body in recs:
            if op == 4:
                import struct

                cid = struct.unpack_from("<H", body)[0]
                n = struct.unpack_from("<I", body, 4)[0]
                chans[cid] = body[8 : 8 + n].decode()
        out = []
        for op, body in recs:
            if (
                op == 5
                and chans[int.from_bytes(body[:2], "little")] == cc.VIDEO_CHANNEL
            ):
                videos += 1
                if videos == 2:
                    b = bytearray(body)
                    for i in range(len(b) - 16, len(b) - 9):
                        b[i] ^= 0xFF
                    body = bytes(b)
            out.append((op, body))
        st = FrameStream(ForwardOnly(build(header, out)))
        with self.assertRaises(Exception) as e:
            list(st)
        self.assertFalse(st.accepted)
        print("corrupt payload ->", type(e.exception).__name__, e.exception)

    def test_declared_raster_mismatch_fails(self):
        from indexed_fixture import build, flat_records

        header, recs = flat_records((GOLDEN / "valid.mcap").read_bytes())
        out = []
        for op, body in recs:
            if op == 5 and b'"rgb_profile"' in body:
                body = body.replace(
                    b'"encoder":{', b'"encoder":{"width":128,"height":96,'
                )
            out.append((op, body))
        data = build(header, out)
        st = FrameStream(ForwardOnly(data))
        with self.assertRaises(Exception) as e:
            list(st)
        print("declared raster ->", type(e.exception).__name__, e.exception)
        self.assertFalse(st.accepted)

    def test_decoder_failure_after_valid_footer_cannot_be_accepted(self):
        data = chunked((GOLDEN / "valid.mcap").read_bytes())
        st = FrameStream(ForwardOnly(data))
        import stateaction_processing.frames as fr

        class Boom(fr.H264Decoder):
            def decode(self, units):
                for _ in super().decode(units):
                    pass
                raise DecodeError("E_DECODE_FAILED", "final flush")
                yield  # pragma: no cover

        orig, fr.H264Decoder = fr.H264Decoder, Boom
        try:
            with self.assertRaises(DecodeError):
                list(st)
        finally:
            fr.H264Decoder = orig
        self.assertTrue(st.capture.accepted)  # container + contract were fine...
        self.assertFalse(st.accepted)  # ...but the frame stream is not
        with self.assertRaises(Exception):
            st.require_accepted()

    def test_decoder_error_is_a_job_failure(self):
        from stateaction_processing.capture_stream import AccessUnit
        from stateaction_processing.h264_decode import H264Decoder

        au = AccessUnit(
            0,
            0,
            "0",
            0,
            "0",
            "0",
            "c",
            "0",
            {},
            "k",
            "r",
            "rgb",
            "f",
            True,
            "h",
            b"\x00\x00\x00\x01\x65garbage",
        )
        with self.assertRaises(DecodeError):
            list(H264Decoder().decode([au]))


if __name__ == "__main__":
    unittest.main()
