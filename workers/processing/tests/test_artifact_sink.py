import errno
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from stateaction_processing.artifact_types import (
    MANIFEST_NAME,
    ExportError,
    LocalDirectorySink,
    make_output,
)


class LocalDirectorySinkTests(unittest.TestCase):
    def test_cross_device_seal_publishes_a_complete_copy_atomically(self):
        with tempfile.TemporaryDirectory() as directory:
            scratch = Path(directory) / "scratch"
            scratch.write_bytes(b"complete manifest")
            sink = LocalDirectorySink(Path(directory) / "result")
            out = make_output("result_manifest_json", MANIFEST_NAME, scratch, None)
            final = sink.root / MANIFEST_NAME
            link = os.link

            def cross_device(source, destination):
                self.assertFalse(final.exists())
                if source == scratch:
                    raise OSError(errno.EXDEV, "cross-device scratch")
                self.assertEqual(source.parent, final.parent)
                self.assertEqual(source.read_bytes(), b"complete manifest")
                link(source, destination)

            with patch("stateaction_processing.artifact_types.os.link", cross_device):
                receipt = sink.seal(out)

            self.assertEqual(receipt.sha256, out.sha256)
            self.assertEqual(final.read_bytes(), b"complete manifest")
            self.assertEqual(list(sink.root.iterdir()), [final])
            self.assertFalse(scratch.exists())

    def test_cross_device_seal_rejects_changed_bytes_and_discards_temporary_copy(self):
        with tempfile.TemporaryDirectory() as directory:
            scratch = Path(directory) / "scratch"
            scratch.write_bytes(b"expected")
            sink = LocalDirectorySink(Path(directory) / "result")
            out = make_output("result_manifest_json", MANIFEST_NAME, scratch, None)
            scratch.write_bytes(b"replaced")

            with patch(
                "stateaction_processing.artifact_types.os.link",
                side_effect=OSError(errno.EXDEV, "cross-device scratch"),
            ):
                with self.assertRaises(ExportError) as failure:
                    sink.seal(out)

            self.assertEqual(failure.exception.code, "E_OUTPUT_COPY_MISMATCH")
            self.assertEqual(list(sink.root.iterdir()), [])
            self.assertEqual(scratch.read_bytes(), b"replaced")
