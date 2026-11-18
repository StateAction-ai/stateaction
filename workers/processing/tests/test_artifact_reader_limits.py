import hashlib
import io
import json
import sys
import tempfile
import unittest
import zipfile
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

try:
    import numpy as np

    from stateaction_processing import artifact_reader as reader
except ImportError as exc:
    raise unittest.SkipTest(
        "NumPy is required for the portable artifact reader"
    ) from exc


class ArtifactReaderLimitTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name) / "out"
        self.root.mkdir()
        self.paths = {
            "hand_arrays_npz": self.root / "hand-arrays.npz",
            "frame_map_json": self.root / "frame-map.json",
            "hand_observations_json": self.root / "hand-observations.json",
            "rgb_mp4": self.root / "rgb.mp4",
        }
        self.clip = reader.Clip(
            self.root,
            {
                "clip_id": "clip",
                "frame_count": 1,
                "raster": {"width": 1, "height": 1},
                "hand_arrays": {
                    "arrays": [
                        {"name": name, "dtype": dtype, "shape": [1, *tail]}
                        for name, dtype, tail in reader.ARRAYS
                    ]
                },
            },
            self.paths,
            "job",
        )

    def _open_result_fixture(self):
        """Open the reader's inventory with only the contract-validator call mocked."""
        self.paths["frame_map_json"].write_bytes(
            b'{"clip_id":"clip","job_id":"job","frame_count":1,"rows":[{"clip_pts":"0"}]}'
        )
        self.paths["hand_observations_json"].write_bytes(
            b'{"clip_id":"clip","job_id":"job","frame_count":1,"frames":[]}'
        )
        self.paths["rgb_mp4"].write_bytes(b"verified mp4 fixture")
        np.savez_compressed(self.paths["hand_arrays_npz"], **self._normal_arrays())
        outputs = []
        for key, path in self.paths.items():
            data = path.read_bytes()
            outputs.append(
                {
                    "relative_path": path.name,
                    "file_id": key,
                    "size_bytes": str(len(data)),
                    "sha256": hashlib.sha256(data).hexdigest(),
                }
            )
        meta = {**self.clip.meta, "files": {key: key for key in self.paths}}
        manifest = {
            "schema": "stateaction.processing_result.v1",
            "outputs": outputs,
            "clips": [meta],
            "job_id": "job",
        }
        (self.root / reader.MANIFEST_NAME).write_text(json.dumps(manifest))
        with patch.object(reader, "_contract_check", return_value=True) as validate:
            result = reader.open_result(self.root)
        return result.clips[0], validate

    def test_manifest_symlink_and_symlinked_root_are_rejected_before_read(self):
        outside = self.root.parent / "outside.json"
        outside.write_bytes(b"untrusted manifest contents")
        manifest = self.root / reader.MANIFEST_NAME
        manifest.symlink_to(outside)
        alias = self.root.parent / "alias"
        alias.symlink_to(self.root, target_is_directory=True)
        for root in (self.root, alias):
            with (
                self.subTest(root=root),
                self.assertRaises(reader.ArtifactError) as err,
            ):
                reader.open_result(root)
            self.assertEqual(err.exception.code, "E_UNSAFE_PATH_SYMLINK")

    def test_manifest_and_sidecar_bound_actual_read_even_after_small_stat(self):
        (self.root / reader.MANIFEST_NAME).write_bytes(b"x" * 40)
        self.paths["frame_map_json"].write_bytes(b"x" * 40)
        self.paths["hand_observations_json"].write_bytes(b"x" * 40)
        mode = self.paths["frame_map_json"].stat().st_mode
        with (
            patch.object(reader, "_MAX_MANIFEST_BYTES", 32),
            patch.object(reader, "_MAX_SIDECAR_BYTES", 32),
            patch.object(
                reader.os,
                "fstat",
                return_value=SimpleNamespace(st_size=0, st_mode=mode),
            ),
        ):
            for read in (
                lambda: reader.open_result(self.root),
                self.clip.frame_map_document,
                self.clip.hand_observations,
            ):
                with (
                    self.subTest(read=read),
                    self.assertRaises(reader.ArtifactError) as err,
                ):
                    read()
                self.assertEqual(err.exception.code, "E_OUTPUT_LIMIT")

    def test_sidecar_reopened_through_symlink_is_rejected(self):
        outside = self.root.parent / "outside.json"
        outside.write_bytes(b"{}")
        self.paths["frame_map_json"].symlink_to(outside)
        with self.assertRaises(reader.ArtifactError) as err:
            self.clip.frame_map_document()
        self.assertEqual(err.exception.code, "E_UNSAFE_PATH_SYMLINK")

    def _normal_arrays(self):
        arrays = {
            name: np.zeros((1, *tail), dtype=dtype)
            for name, dtype, tail in reader.ARRAYS
        }
        arrays["image_landmarks_px"].fill(np.nan)
        arrays["model_relative_joints"].fill(np.nan)
        arrays["handedness"].fill(-1)
        return arrays

    def test_accepts_numpy_compressed_archive(self):
        np.savez_compressed(self.paths["hand_arrays_npz"], **self._normal_arrays())
        arrays = self.clip.arrays()
        np.testing.assert_array_equal(arrays["frame_index"], np.array([0]))
        self.assertFalse(arrays["hand_detected"].any())

    def test_lazy_parsers_reject_same_size_ordinary_file_replacements(self):
        clip, validate = self._open_result_fixture()
        validate.assert_any_call(
            "artifacts.frame-map.v1",
            self.paths["frame_map_json"].read_bytes(),
            required=False,
        )
        validate.assert_any_call(
            "artifacts.hand-observations.v1",
            self.paths["hand_observations_json"].read_bytes(),
            required=False,
        )
        self.assertEqual(clip.frame_map()[0]["clip_pts"], "0")
        self.assertEqual(clip.hand_observations()["frames"], [])
        self.assertEqual(clip.arrays()["frame_index"][0], 0)
        for key, read in (
            ("frame_map_json", clip.frame_map),
            ("hand_observations_json", clip.hand_observations),
            ("hand_arrays_npz", clip.arrays),
        ):
            with self.subTest(key=key):
                path = self.paths[key]
                replacement = self.root / "replacement"
                data = path.read_bytes()
                replacement.write_bytes(bytes([data[0] ^ 1]) + data[1:])
                replacement.replace(path)
                with self.assertRaises(reader.ArtifactError) as err:
                    read()
                self.assertEqual(err.exception.code, "E_OUTPUT_SHA256")

    def test_mp4_verifier_hashes_before_demux_and_detects_in_place_edit(self):
        clip, _ = self._open_result_fixture()
        path = self.paths["rgb_mp4"]
        original = path.read_bytes()
        altered = b"x" + original[1:]
        av_open = Mock()
        with patch.dict(sys.modules, {"av": SimpleNamespace(open=av_open)}):
            path.write_bytes(altered)
            with self.assertRaises(reader.ArtifactError) as err:
                clip.verify_mp4()
            self.assertEqual(err.exception.code, "E_OUTPUT_SHA256")
            av_open.assert_not_called()

            path.write_bytes(original)
            stream = SimpleNamespace(
                time_base=SimpleNamespace(numerator=1, denominator=1_000_000),
                codec_context=SimpleNamespace(name="h264", width=1, height=1),
            )

            def open_verified(file):
                self.assertEqual(file.read(), original)
                path.write_bytes(altered + b"!")
                return nullcontext(
                    SimpleNamespace(
                        streams=SimpleNamespace(video=[stream]),
                        demux=lambda _: [SimpleNamespace(pts=0, size=1)],
                    )
                )

            av_open.side_effect = open_verified
            with self.assertRaises(reader.ArtifactError) as err:
                clip.verify_mp4()
            self.assertEqual(err.exception.code, "E_OUTPUT_CHANGED_DURING_READ")

    def test_mp4_verifier_stops_at_the_first_packet_outside_the_frame_map(self):
        clip, _ = self._open_result_fixture()

        def demux(_stream):
            yield SimpleNamespace(pts=0, size=1)
            yield SimpleNamespace(pts=1, size=1)
            raise AssertionError("Read past the first excess packet")

        video = SimpleNamespace(streams=SimpleNamespace(video=[None]), demux=demux)
        av = SimpleNamespace(open=lambda _file: nullcontext(video))
        with (
            patch.dict(sys.modules, {"av": av}),
            self.assertRaises(reader.ArtifactError) as err,
        ):
            clip.verify_mp4()
        self.assertEqual(err.exception.code, "E_MP4_PTS")

    def test_rejects_oversized_npz_member_and_npy_header_before_numpy(self):
        huge_header = (
            b"\x93NUMPY\x02\x00" + (2**32 - 1).to_bytes(4, "little") + bytes(8)
        )
        wrong_shape = io.BytesIO()
        np.save(wrong_shape, np.zeros((1, 1), dtype="int64"), allow_pickle=False)
        for member, code in (
            (bytes(30_000), "E_NPZ_MEMBER_SIZE"),
            (huge_header, "E_NPZ_HEADER"),
            (wrong_shape.getvalue(), "E_NPZ_SHAPE"),
        ):
            with self.subTest(code=code):
                with zipfile.ZipFile(
                    self.paths["hand_arrays_npz"], "w", compression=zipfile.ZIP_DEFLATED
                ) as archive:
                    for name, array in self._normal_arrays().items():
                        data = io.BytesIO()
                        np.save(data, array, allow_pickle=False)
                        archive.writestr(
                            name + ".npy",
                            member if name == "frame_index" else data.getvalue(),
                        )
                with patch.object(reader.np, "load") as load:
                    with self.assertRaises(reader.ArtifactError) as err:
                        self.clip.arrays()
                    self.assertEqual(err.exception.code, code)
                    load.assert_not_called()
