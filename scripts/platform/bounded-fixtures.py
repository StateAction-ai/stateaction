#!/usr/bin/env python3
"""Prepare pinned local PG/S3 binaries; actual services run in guarded user scopes.

Docker is used only to export an existing pinned image from a NEVER STARTED
container. No Docker process runs the database or S3 tests outside our cgroup.
All extracted files are public image bytes in ignored artifacts, not QA data.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts/mobile"))
import resource_guard as guard  # noqa: E402

BASE = ROOT / "artifacts/bounded-fixtures"


def run(*args: str) -> None:
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL)


def prepare() -> None:
    if not guard.inside_guard():
        raise RuntimeError("Run prepare through agent-resource run --")
    if not shutil.which("bwrap"):
        raise RuntimeError("bubblewrap is required for the pinned Alpine runtime")
    compose = (ROOT / "infra/compose.yaml").read_text()
    images = {
        name: re.search(rf"image: ({name}[^\s]+@sha256:[0-9a-f]{{64}})", compose)[1]
        for name in ("postgres:", "chrislusf/seaweedfs:")
    }
    BASE.mkdir(parents=True, exist_ok=True)
    for name, image in images.items():
        run("docker", "image", "inspect", image)
        marker = BASE / (
            "postgres-image.json" if name == "postgres:" else "storage-image.json"
        )
        if marker.exists():
            if json.loads(marker.read_text())["image"] != image:
                raise RuntimeError(
                    "Fixture image changed; preserve and review existing runtime"
                )
            continue
        container = "stateaction-export-only-" + uuid.uuid4().hex[:12]
        try:
            run("docker", "create", "--name", container, image)
            if name == "postgres:":
                rootfs = BASE / "postgres-rootfs"
                if rootfs.exists():
                    raise RuntimeError(
                        "Incomplete extraction exists; review before retry"
                    )
                archive = BASE / "postgres-rootfs.tar"
                run("docker", "export", "--output", str(archive), container)
                rootfs.mkdir()
                run("tar", "-xf", str(archive), "--no-same-owner", "-C", str(rootfs))
                archive.unlink()
                with (rootfs / "etc/passwd").open("a") as file:
                    file.write(
                        f"\nagentfixture:x:{os.getuid()}:{os.getgid()}:Fixture:/tmp:/bin/sh\n"
                    )
            else:
                run("docker", "cp", f"{container}:/usr/bin/weed", str(BASE / "weed"))
                (BASE / "weed").chmod(0o755)
            marker.write_text(
                json.dumps({"image": image, "startedContainer": False}) + "\n"
            )
        finally:
            subprocess.run(
                ["docker", "rm", container], stdout=subprocess.DEVNULL, check=False
            )
    (BASE / "data").mkdir(exist_ok=True, mode=0o700)
    (BASE / "postgres-rootfs/data").mkdir(exist_ok=True)
    (BASE / "storage").mkdir(exist_ok=True)
    (BASE / "config").mkdir(exist_ok=True)
    shutil.copyfile(ROOT / "infra/seaweedfs-master.toml", BASE / "config/master.toml")
    config = {
        "identities": [
            {
                "name": "bounded-local-fixture",
                "credentials": [
                    {
                        "accessKey": "stateaction-local",
                        "secretKey": "stateaction-local-only-secret",
                    }
                ],
                "actions": ["Admin", "Read", "List", "Write"],
            }
        ]
    }
    (BASE / "s3.json").write_text(json.dumps(config))
    if not (BASE / "data/PG_VERSION").exists():
        run(
            *postgres_command(
                "/usr/local/bin/initdb",
                "-D",
                "/data",
                "-U",
                "bootstrap",
                "--auth=trust",
            )
        )
    print(
        json.dumps({"prepared": True, "path": str(BASE), "servicesRequireGuard": True})
    )


def postgres_command(*args: str) -> list[str]:
    return [
        "bwrap",
        "--unshare-user",
        "--unshare-pid",
        "--die-with-parent",
        "--ro-bind",
        str(BASE / "postgres-rootfs"),
        "/",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/dev/shm",
        "--tmpfs",
        "/tmp",
        "--bind",
        str(BASE / "data"),
        "/data",
        "--chdir",
        "/tmp",
        "--",
        *args,
    ]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["prepare", "postgres", "storage"])
    args = parser.parse_args()
    if args.action == "prepare":
        prepare()
        return
    if not guard.guarded_pid():
        raise RuntimeError(
            "Actual fixture services must run inside the enforced shared cgroup"
        )
    if args.action == "postgres":
        command = postgres_command(
            "/usr/local/bin/postgres",
            "-D",
            "/data",
            "-p",
            "54340",
            "-h",
            "127.0.0.1",
            "-k",
            "/tmp",
            "-c",
            "shared_buffers=64MB",
            "-c",
            "max_connections=30",
            "-c",
            "work_mem=2MB",
        )
    else:
        os.chdir(BASE / "storage")
        command = [
            str(BASE / "weed"),
            f"-config_dir={BASE / 'config'}",
            "server",
            "-ip=127.0.0.1",
            "-ip.bind=127.0.0.1",
            f"-dir={BASE / 'storage'}",
            # Every isolated test bucket owns a collection (at least one volume).
            # Keep capacity finite without changing the 1 GiB service cgroup.
            "-volume.max=256",
            "-master.volumeSizeLimitMB=64",
            "-master.port=19333",
            "-volume.port=18080",
            "-filer",
            "-filer.port=18888",
            "-s3",
            "-s3.port=19000",
            f"-s3.config={BASE / 's3.json'}",
        ]
    os.execvpe(command[0], command, os.environ)


if __name__ == "__main__":
    main()
