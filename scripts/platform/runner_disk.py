#!/usr/bin/env python3
"""Disk headroom for this repository's ephemeral Ubuntu Android CI job only."""

import argparse
import json
import os
import platform
import re
import shutil
import signal
import subprocess
import tempfile
import time
from pathlib import Path

GIB = 1024**3
MINIMUM_FREE = 20 * GIB
LOG_RESERVE = GIB
STOP_FREE = 2 * GIB
ANDROID_SDK = Path("/usr/local/lib/android/sdk")
TOOLCHAIN = Path(__file__).resolve().parents[2] / "config/mobile-toolchain.json"
NDK_VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")
# Official runner-images installers own these fixed, unused language/tool paths.
# Never derive a deletion path from repository input or environment variables.
UNUSED_TOOLS = (
    Path("/usr/share/dotnet"),
    Path("/usr/local/.ghcup"),
    Path("/opt/hostedtoolcache/CodeQL"),
    Path("/usr/share/swift"),
)


def require_ephemeral_android_job() -> None:
    expected = {
        "GITHUB_ACTIONS": "true",
        "RUNNER_ENVIRONMENT": "github-hosted",
        "RUNNER_OS": "Linux",
        "ImageOS": "ubuntu24",
        "GITHUB_JOB": "android",
    }
    if any(os.environ.get(key) != value for key, value in expected.items()):
        raise SystemExit(
            "Refusing disk changes outside the GitHub-hosted Ubuntu24 Android job"
        )
    release = platform.freedesktop_os_release()
    if release.get("ID") != "ubuntu" or release.get("VERSION_ID") != "24.04":
        raise SystemExit("Refusing disk changes on a different operating system")


def report(workspace: Path, label: str) -> None:
    print(f"Android runner disk: {label}", flush=True)
    subprocess.run(["df", "-h", "--", str(workspace)], check=True)


def require_space(workspace: Path, required: int) -> None:
    free = shutil.disk_usage(workspace).free
    if free < required:
        raise SystemExit(
            f"Insufficient Android build space: {free / GIB:.2f} GiB free; need {required / GIB:.2f} GiB. Stopping before disk exhaustion."
        )


def validate_preinstalled_sdk() -> Path:
    for name in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
        value = os.environ.get(name)
        if (name == "ANDROID_HOME" and not value) or (
            value and Path(value) != ANDROID_SDK
        ):
            raise SystemExit(
                "Refusing NDK cleanup for a foreign or missing Android SDK path"
            )
    if not ANDROID_SDK.is_dir() or ANDROID_SDK.resolve() != ANDROID_SDK:
        raise SystemExit("Refusing NDK cleanup through a missing or symlinked SDK")
    return ANDROID_SDK


def unused_ndk_directories(sdk: Path, pinned: str) -> list[Path]:
    """Select real immediate version directories; preserve pins and unknown data."""
    if not isinstance(pinned, str) or NDK_VERSION.fullmatch(pinned) is None:
        raise SystemExit("Refusing NDK cleanup without a strict numeric pinned version")
    ndk = sdk / "ndk"
    if sdk.is_symlink() or ndk.is_symlink():
        raise SystemExit("Refusing NDK cleanup through a symlinked SDK or NDK root")
    if not ndk.is_dir():
        return []
    return sorted(
        path
        for path in ndk.iterdir()
        if path.name != pinned
        and NDK_VERSION.fullmatch(path.name)
        and not path.is_symlink()
        and path.is_dir()
    )


def publish_pinned_ndk(sdk: Path, pinned: str) -> None:
    output = os.environ.get("GITHUB_ENV")
    if not output:
        raise SystemExit(
            "Refusing NDK cleanup without the GitHub environment output file"
        )
    values = {
        name: str(sdk / "ndk" / pinned)
        for name in ("ANDROID_NDK", "ANDROID_NDK_HOME", "ANDROID_NDK_ROOT")
    }
    with Path(output).open("a") as destination:
        for name, value in values.items():
            destination.write(f"{name}={value}\n")
    os.environ.update(values)


def prepare(workspace: Path) -> None:
    require_ephemeral_android_job()
    sdk = validate_preinstalled_sdk()
    pinned_ndk = json.loads(TOOLCHAIN.read_text())["ndk"]
    unused_ndks = unused_ndk_directories(sdk, pinned_ndk)
    publish_pinned_ndk(sdk, pinned_ndk)
    report(workspace, "before removing unused preinstalled tooling")
    print(
        f"Preserving pinned NDK {pinned_ndk}; unused side-by-side NDKs: {[path.name for path in unused_ndks]}",
        flush=True,
    )
    present = [str(path) for path in UNUSED_TOOLS if path.exists() or path.is_symlink()]
    present.extend(str(path) for path in unused_ndks)
    if present:
        subprocess.run(["du", "-sh", "--", *present], check=False)
        subprocess.run(["sudo", "-n", "rm", "-rf", "--", *present], check=True)
    report(workspace, "after removing unused preinstalled tooling")


def stop_process_group(child: subprocess.Popen) -> None:
    # Descendants can outlive an already-exited group leader (e.g. a daemon).
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    try:
        child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    child.wait()


def guarded_build(
    workspace: Path,
    runner_temp: Path,
    command: list[str],
    *,
    minimum_free: int = MINIMUM_FREE,
    reserve_bytes: int = LOG_RESERVE,
    stop_free: int = STOP_FREE,
    poll_seconds: float = 5,
) -> int:
    """Run one owned process group; release real allocated log space before abort."""
    if not command:
        raise SystemExit("A build command is required")
    if workspace.stat().st_dev != runner_temp.stat().st_dev:
        raise SystemExit("Log reserve and workspace must be on the same filesystem")
    require_space(workspace, minimum_free + reserve_bytes)
    descriptor, filename = tempfile.mkstemp(
        prefix="stateaction-android-logs-", dir=runner_temp
    )
    reserve = Path(filename)
    child = None
    previous = {}

    def interrupted(signum, _frame):
        raise SystemExit(128 + signum)

    try:
        with os.fdopen(descriptor, "wb") as file:
            os.posix_fallocate(file.fileno(), 0, reserve_bytes)
        for signum in (signal.SIGTERM, signal.SIGINT):
            previous[signum] = signal.signal(signum, interrupted)
        require_space(workspace, minimum_free)
        report(
            workspace,
            f"before build; {reserve_bytes / GIB:.2f} GiB log reserve allocated",
        )
        child = subprocess.Popen(command, start_new_session=True)
        while child.poll() is None:
            if shutil.disk_usage(workspace).free <= stop_free:
                reserve.unlink(missing_ok=True)
                stop_process_group(child)
                print(
                    "Android build stopped at <=2 GiB free; released the log reserve and terminated its process group.",
                    flush=True,
                )
                return 1
            time.sleep(poll_seconds)
        return child.returncode if child.returncode >= 0 else 128 - child.returncode
    finally:
        reserve.unlink(missing_ok=True)
        if child is not None:
            stop_process_group(child)
        for signum, handler in previous.items():
            signal.signal(signum, handler)
        report(workspace, "after build; log reserve released")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "check", "run"))
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    require_ephemeral_android_job()
    workspace = Path(os.environ["GITHUB_WORKSPACE"])
    if args.action == "prepare":
        prepare(workspace)
    elif args.action == "check":
        report(workspace, "after bootstrap")
        require_space(workspace, MINIMUM_FREE + LOG_RESERVE)
    else:
        command = args.command[1:] if args.command[:1] == ["--"] else args.command
        raise SystemExit(
            guarded_build(workspace, Path(os.environ["RUNNER_TEMP"]), command)
        )


if __name__ == "__main__":
    main()
