"""SA-86: MP4 -> labelled h264_mcap_simulation_v1 MCAP converter. Synthetic media only (no HomER data)."""

import hashlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

from indexed_fixture import flat_records

TOOLS = Path(__file__).resolve().parents[1] / "tools"
GOLDEN = Path(__file__).resolve().parents[3] / "packages/contracts/capture/golden"

try:
    import av
    import numpy as np

    HAVE_DECODE = True
except ImportError:
    HAVE_DECODE = False


def load_tool():
    sys.path.insert(0, str(TOOLS))
    try:
        import mp4_to_sim_mcap

        return mp4_to_sim_mcap
    finally:
        sys.path.remove(str(TOOLS))


def make_mp4(
    path: Path, frames: int = 24, bframes: int = 0, w: int = 64, h: int = 48
) -> None:
    """A tiny synthetic H.264 MP4 (moving gradient); `bframes` > 0 forces B slices."""
    with av.open(str(path), "w") as c:
        st = c.add_stream("libx264", rate=30)
        st.width, st.height, st.pix_fmt = w, h, "yuv420p"
        st.codec_context.options = {
            "x264-params": f"bframes={bframes}:b-adapt=0:keyint=10:min-keyint=10:scenecut=0:threads=1",
        }
        for i in range(frames):
            arr = np.zeros((h, w, 3), np.uint8)
            arr[..., 0] = (np.arange(w)[None, :] * 3 + i * 7) % 256
            arr[..., 1] = (np.arange(h)[:, None] * 5 + i * 3) % 256
            arr[..., 2] = (i * 11) % 256
            fr = av.VideoFrame.from_ndarray(arr, format="rgb24")
            fr.pts = i
            fr.time_base = st.codec_context.time_base
            for pk in st.encode(fr):
                c.mux(pk)
        for pk in st.encode(None):
            c.mux(pk)


@unittest.skipUnless(HAVE_DECODE, "decode dependency group not installed")
class SimMcapTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tool = load_tool()
        cls.tmp = tempfile.TemporaryDirectory()
        cls.dir = Path(cls.tmp.name)
        cls.plain = cls.dir / "plain.mp4"
        cls.bframe = cls.dir / "bframe.mp4"
        make_mp4(cls.plain, 24, bframes=0)
        make_mp4(cls.bframe, 24, bframes=2)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def decode(self, data: bytes):
        from stateaction_processing.frames import FrameStream

        fs = FrameStream(io.BytesIO(data), source_profile="h264_mcap_simulation_v1")
        frames = list(fs)
        report = fs.require_accepted()
        return frames, report

    def test_remux_keeps_access_units_order_and_count(self):
        out = self.dir / "plain.mcap"
        conv = self.tool.convert(self.plain, out)
        self.assertFalse(conv["transcoded"])
        frames, report = self.decode(out.read_bytes())
        self.assertEqual(len(frames), 24)
        self.assertEqual(
            report.frame_counts,
            {"acquired": 24, "submitted": 24, "written": 24, "dropped": 0},
        )
        src = self.tool.read_source(self.plain, "never")
        self.assertEqual(
            [f.access_unit.data for f in frames], [u.data for u in src.units]
        )
        self.assertEqual(
            [f.access_unit.source_frame_id for f in frames], [str(i) for i in range(24)]
        )
        self.assertEqual([f.access_unit.index for f in frames], list(range(24)))
        self.assertTrue(frames[0].access_unit.is_idr)

    def test_b_frame_source_is_reencoded_and_labelled_transcoded(self):
        src = self.tool._remux(self.bframe)
        self.assertIsInstance(src, list, "B-frame MP4 must not be remuxable")
        self.assertTrue(any("E_B_FRAME" in p for p in src))
        with self.assertRaises(self.tool.ConvertError):
            self.tool.read_source(self.bframe, "never")
        out = self.dir / "bframe.mcap"
        conv = self.tool.convert(self.bframe, out)
        self.assertTrue(conv["transcoded"])
        self.assertEqual(conv["access_units"], 24)
        frames, _ = self.decode(out.read_bytes())
        self.assertEqual(len(frames), 24)
        pts = [f.access_unit.encoder_pts_us for f in frames]
        self.assertEqual(pts, sorted(set(pts)))
        # re-encoded stream still has no B slices and IDR at the start
        self.assertTrue(frames[0].access_unit.is_idr)

    def test_output_is_deterministic(self):
        a, b = self.dir / "d1.mcap", self.dir / "d2.mcap"
        self.tool.convert(self.plain, a)
        self.tool.convert(self.plain, b)
        self.assertEqual(
            hashlib.sha256(a.read_bytes()).digest(),
            hashlib.sha256(b.read_bytes()).digest(),
        )

    def test_profile_and_marker_are_simulation_only_and_unknown_stays_unknown(self):
        out = self.dir / "marker.mcap"
        self.tool.convert(self.plain, out, camera_label="WGO-Bench")
        _, report = self.decode(out.read_bytes())
        p = report.profile
        self.assertEqual(p["rgb_profile"], "h264_mcap_simulation_v1")
        self.assertEqual(p["qualification"], "simulation_only")
        self.assertEqual(p["mapped_timeline_semantics"], "simulation_transport_only")
        self.assertIs(p["production_qualified"], False)
        self.assertEqual(p["encoder"]["b_frames"], 0)
        self.assertNotIn("name", p["encoder"])
        self.assertNotIn("hardware", p["encoder"])
        marker_bytes = out.with_suffix(".simulation.json").read_bytes()
        from stateaction_contracts import validate_bytes

        verdict = validate_bytes("artifacts.simulation-provenance.v1", marker_bytes)
        self.assertTrue(verdict.valid, verdict)
        m = json.loads(marker_bytes)
        self.assertEqual(
            m["provenance"]["camera"], {"status": "known", "label": "WGO-Bench"}
        )
        self.assertEqual(m["provenance"]["encoder"], {"status": "unknown"})
        self.assertEqual(m["provenance"]["clock"], {"status": "unknown"})

    def test_hardware_profile_reader_refuses_the_simulation_file(self):
        from stateaction_processing.frames import FrameStream

        out = self.dir / "refuse.mcap"
        self.tool.convert(self.plain, out)
        fs = FrameStream(io.BytesIO(out.read_bytes()), source_profile="h264_mcap_v1")
        # match on the error code: other suites reload worker modules, so class identity is not stable
        with self.assertRaises(Exception) as e:
            list(fs)
        self.assertEqual(getattr(e.exception, "code", None), "E_SOURCE_PROFILE")

    def test_channel_definitions_match_the_committed_sa50_golden(self):
        header, golden = flat_records((GOLDEN / "valid.mcap").read_bytes())
        out = self.dir / "defs.mcap"
        self.tool.convert(self.plain, out)
        _, mine = flat_records_from_chunked(out.read_bytes())
        defs = lambda rs: [(op, body) for op, body in rs if op in (0x03, 0x04)]  # noqa: E731
        self.assertEqual(defs(mine), defs(golden))

    def test_profile_keys_follow_the_golden_profile(self):
        golden_profile = json.loads(golden_message("/stateaction/capture_profile"))
        out = self.dir / "keys.mcap"
        self.tool.convert(self.plain, out)
        _, report = self.decode(out.read_bytes())
        self.assertTrue(
            set(report.profile) <= set(golden_profile) | {"mapped_timeline_semantics"}
        )

    def test_sha256_in_conversion_receipt_matches_inputs_and_outputs(self):
        out = self.dir / "receipt.mcap"
        conv = self.tool.convert(self.plain, out)
        self.assertEqual(
            conv["source_sha256"], hashlib.sha256(self.plain.read_bytes()).hexdigest()
        )
        self.assertEqual(
            conv["mcap_sha256"], hashlib.sha256(out.read_bytes()).hexdigest()
        )
        on_disk = json.loads(out.with_suffix(".conversion.json").read_text())
        self.assertEqual(on_disk["mcap_sha256"], conv["mcap_sha256"])


def flat_records_from_chunked(data: bytes):
    """Schema/Channel/Message record bodies of a chunked MCAP (chunks are uncompressed)."""
    import struct

    pos, header, out = 8, None, []

    def walk(buf: bytes, base: int, end: int):
        p = base
        while p < end:
            op = buf[p]
            (n,) = struct.unpack_from("<Q", buf, p + 1)
            body = buf[p + 9 : p + 9 + n]
            p += 9 + n
            yield op, body

    for op, body in walk(data, pos, len(data) - 8):
        if op == 0x01:
            header = body
        elif op == 0x06:
            (_, _, _, _) = struct.unpack_from("<QQQI", body)
            off = 28
            (cl,) = struct.unpack_from("<I", body, off)
            off += 4 + cl
            (usize,) = struct.unpack_from("<Q", body, off)
            off += 8
            out.extend(
                (o, b)
                for o, b in walk(body, off, off + usize)
                if o in (0x03, 0x04, 0x05)
            )
        elif op == 0x0F:
            break
    return header, out


def golden_message(topic: str) -> bytes:
    import struct

    _, recs = flat_records((GOLDEN / "valid.mcap").read_bytes())
    channels = {}
    for op, body in recs:
        if op == 0x04:
            cid = struct.unpack_from("<H", body)[0]
            (n,) = struct.unpack_from("<I", body, 4)
            channels[cid] = body[8 : 8 + n].decode()
    for op, body in recs:
        if op == 0x05 and channels[struct.unpack_from("<H", body)[0]] == topic:
            return body[22:]
    raise KeyError(topic)


if __name__ == "__main__":
    unittest.main()
