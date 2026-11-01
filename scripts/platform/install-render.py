#!/usr/bin/env python3
"""Install only the pinned official Linux x86-64 Render CLI into ignored artifacts."""
import hashlib
import io
import os
import platform
import urllib.request
import zipfile
from pathlib import Path

VERSION = "2.34.0"
SHA256 = "6774a558bc3972b3487d851873d8ea6eeeb5a2b003a4696e6ba5c6a7f20736ad"
if platform.system() != "Linux" or platform.machine() != "x86_64":
    raise SystemExit("This checksum-pinned installer supports Linux x86-64 only. See Render's official CLI installation guide for your platform.")
root = Path(__file__).resolve().parents[2]
response = urllib.request.urlopen(f"https://github.com/render-oss/cli/releases/download/v{VERSION}/cli_{VERSION}_linux_amd64.zip", timeout=60)
archive = response.read(64 * 1024 * 1024 + 1)
if len(archive) > 64 * 1024 * 1024 or hashlib.sha256(archive).hexdigest() != SHA256:
    raise SystemExit("Render release checksum mismatch")
destination = root / "artifacts/platform-tools/render/render"
destination.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(io.BytesIO(archive)) as release:
    destination.write_bytes(release.read(f"cli_v{VERSION}"))
os.chmod(destination, 0o755)
print(destination)
