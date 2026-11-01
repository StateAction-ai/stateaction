"""Disk cleanup and SDK reuse safety checks; no network or SDK mutation."""

import hashlib
import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location(
    "mobile_bootstrap", Path(__file__).with_name("install-mobile-toolchain.py")
)
bootstrap = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bootstrap)


class BootstrapDiskTests(unittest.TestCase):
    def test_removes_only_owned_checksum_verified_archive(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            archive = directory / "sdk.tar.xz"
            archive.write_bytes(b"verified public SDK")
            unrelated = directory / "unrelated.zip"
            unrelated.write_bytes(b"keep")
            spec = {
                "url": "https://example.invalid/sdk.tar.xz",
                "sha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
            }
            bootstrap.remove_verified_archive(spec, directory)
            self.assertFalse(archive.exists())
            self.assertEqual(unrelated.read_bytes(), b"keep")

    def test_checksum_mismatch_keeps_archive(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            archive = directory / "sdk.zip"
            archive.write_bytes(b"unexpected")
            with self.assertRaisesRegex(SystemExit, "Checksum mismatch"):
                bootstrap.remove_verified_archive(
                    {"url": "https://example.invalid/sdk.zip", "sha256": "0" * 64},
                    directory,
                )
            self.assertEqual(archive.read_bytes(), b"unexpected")

    def test_absent_archive_does_not_download(self):
        with tempfile.TemporaryDirectory() as temporary:
            with patch.object(
                bootstrap.urllib.request,
                "urlopen",
                side_effect=AssertionError("network forbidden"),
            ):
                bootstrap.remove_verified_archive(
                    {"url": "https://example.invalid/sdk.zip", "sha256": "0" * 64},
                    Path(temporary),
                )

    def test_old_sdk_manager_preserved_and_owned_version_selected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            properties = root / "sdk/cmdline-tools/latest/source.properties"
            properties.parent.mkdir(parents=True)
            properties.write_text("Pkg.Revision = 12.0\n")
            self.assertEqual(
                bootstrap.select_command_tools(root / "sdk", root / "tools"),
                root / "tools/cmdline-tools/23.0",
            )
            self.assertEqual(properties.read_text(), "Pkg.Revision = 12.0\n")

    def test_matching_sdk_manager_reused(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            properties = root / "sdk/cmdline-tools/latest/source.properties"
            properties.parent.mkdir(parents=True)
            properties.write_text("Pkg.Revision=23.0\n")
            self.assertEqual(
                bootstrap.select_command_tools(root / "sdk", root / "tools"),
                properties.parent,
            )

    def test_runner_platform_and_build_tools_reused_only_missing_ndk_selected(self):
        with tempfile.TemporaryDirectory() as temporary:
            sdk = Path(temporary)
            for directory, revision in [
                ("platforms/android-36", "2"),
                ("build-tools/36.0.0", "36.0.0"),
            ]:
                path = sdk / directory / "source.properties"
                path.parent.mkdir(parents=True)
                path.write_text(f"Pkg.Revision = {revision}\n")
            self.assertEqual(
                bootstrap.missing_android_packages(sdk), ["ndk;28.2.13676358"]
            )


if __name__ == "__main__":
    unittest.main()
