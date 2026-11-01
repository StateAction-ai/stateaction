"""Local bootstrap must never overwrite a collector's private asset."""

import tempfile
import unittest
from pathlib import Path

from run import ensure_no_auth_asset


class AssetBootstrapTest(unittest.TestCase):
    def test_new_checkout_gets_only_no_auth_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory)
            ensure_no_auth_asset(app)
            self.assertEqual((app / ".env").read_text(), "NO_AUTH_MODE=true\n")

    def test_existing_private_bytes_are_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory)
            original = b"EXAMPLE_PRIVATE_VALUE=do-not-copy\r\n"
            (app / ".env").write_bytes(original)
            ensure_no_auth_asset(app)
            self.assertEqual((app / ".env").read_bytes(), original)
