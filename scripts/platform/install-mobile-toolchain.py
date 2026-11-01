#!/usr/bin/env python3
"""Install pinned public Linux Android build tools into ignored local artifacts.

The JDK is supplied by setup-java in CI or JAVA_HOME locally. No emulator,
device, signing key, Google account or private build cache is used.
"""

import argparse
import hashlib
import json
import os
import platform
import shlex
import shutil
import subprocess
import tempfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PINS = json.loads((ROOT / "config/mobile-toolchain.json").read_text())


def run(command: list[str], env: dict[str, str], **kwargs: object) -> str:
    print("+", shlex.join(command), flush=True)
    return subprocess.check_output(command, env=env, text=True, **kwargs)


def properties(path: Path) -> dict[str, str]:
    return dict(
        (key.strip(), value.strip())
        for line in path.read_text().splitlines()
        if "=" in line and not line.startswith("#")
        for key, value in [line.split("=", 1)]
    )


def download(spec: dict[str, str], directory: Path) -> Path:
    path = directory / spec["url"].rsplit("/", 1)[1]
    if not path.exists():
        pending = path.with_suffix(path.suffix + ".partial")
        print(f"Downloading {spec['url']}", flush=True)
        with urllib.request.urlopen(spec["url"], timeout=120) as response:
            with pending.open("wb") as destination:
                shutil.copyfileobj(response, destination)
        pending.rename(path)
    with path.open("rb") as archive:
        digest = hashlib.file_digest(archive, "sha256").hexdigest()
    if digest != spec["sha256"]:
        raise SystemExit(f"Checksum mismatch: {path}; remove it before retrying")
    return path


def verify(flutter: Path, sdk: Path, env: dict[str, str]) -> None:
    version = json.loads(
        run([str(flutter / "bin/flutter"), "--version", "--machine"], env)
    )
    for actual, wanted in (
        (version["frameworkVersion"], PINS["flutter"]),
        (version["frameworkRevision"], PINS["flutterRevision"]),
        (version["dartSdkVersion"], PINS["dart"]),
        (
            properties(sdk / "cmdline-tools/latest/source.properties")["Pkg.Revision"],
            PINS["androidCommandLineTools"],
        ),
        (
            properties(
                sdk / f"platforms/android-{PINS['androidApi']}/source.properties"
            )["Pkg.Revision"],
            PINS["androidPlatformRevision"],
        ),
        (
            properties(
                sdk / f"build-tools/{PINS['androidBuildTools']}/source.properties"
            )["Pkg.Revision"],
            PINS["androidBuildTools"],
        ),
        (
            properties(sdk / f"ndk/{PINS['ndk']}/source.properties")["Pkg.Revision"],
            PINS["ndk"],
        ),
    ):
        if actual != wanted:
            raise SystemExit(
                f"Mobile toolchain mismatch: expected {wanted}, got {actual}"
            )
    print(
        f"Verified Flutter {PINS['flutter']}, Dart {PINS['dart']}, JDK {PINS['java']}, Android {PINS['androidApi']}, NDK {PINS['ndk']}"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--verify-only",
        action="store_true",
        help="Validate tools already selected by PATH, JAVA_HOME and ANDROID_HOME",
    )
    args = parser.parse_args()
    if platform.system() != "Linux" or platform.machine() != "x86_64":
        raise SystemExit("This checksum-pinned bootstrap supports Linux x86-64 only")
    env = dict(os.environ)
    java_home = Path(env.get("JAVA_HOME", "/missing-java-home"))
    java_version = properties(java_home / "release").get("JAVA_VERSION", "").strip('"')
    if java_version != PINS["java"]:
        raise SystemExit(
            f"Set JAVA_HOME to Temurin {PINS['javaBuild']} before bootstrapping"
        )
    env["PATH"] = f"{java_home / 'bin'}:{env['PATH']}"
    tools = ROOT / "artifacts/platform-tools/mobile"
    if args.verify_only:
        executable = shutil.which("flutter", path=env["PATH"])
        if not executable or not env.get("ANDROID_HOME"):
            raise SystemExit("Select existing Flutter and Android SDK paths first")
        flutter = Path(executable).resolve().parents[1]
        sdk = Path(env["ANDROID_HOME"])
    else:
        tools.mkdir(parents=True, exist_ok=True)
        flutter = tools / "flutter"
        sdk = tools / "android-sdk"
        if not flutter.exists():
            archive = download(PINS["flutterLinuxX64"], tools)
            with tempfile.TemporaryDirectory(dir=tools) as temporary:
                subprocess.run(
                    ["tar", "-xJf", str(archive), "--no-same-owner", "-C", temporary],
                    check=True,
                )
                (Path(temporary) / "flutter").rename(flutter)
        command_tools = sdk / "cmdline-tools/latest"
        if not command_tools.exists():
            archive = download(PINS["androidCommandLineToolsLinuxX64"], tools)
            command_tools.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(dir=tools) as temporary:
                with zipfile.ZipFile(archive) as release:
                    release.extractall(temporary)
                (Path(temporary) / "cmdline-tools").rename(command_tools)
            for executable in (command_tools / "bin").iterdir():
                executable.chmod(executable.stat().st_mode | 0o111)
        env["ANDROID_HOME"] = str(sdk)
        env["ANDROID_SDK_ROOT"] = str(sdk)
        env["ANDROID_USER_HOME"] = str(sdk / ".android")
        manager = str(command_tools / "bin/sdkmanager")
        print(run([manager, f"--sdk_root={sdk}", "--licenses"], env, input="y\n" * 100))
        print(
            run(
                [
                    manager,
                    f"--sdk_root={sdk}",
                    f"platforms;android-{PINS['androidApi']}",
                    f"build-tools;{PINS['androidBuildTools']}",
                    f"ndk;{PINS['ndk']}",
                ],
                env,
            )
        )
    env["PATH"] = f"{flutter / 'bin'}:{java_home / 'bin'}:{env['PATH']}"
    verify(flutter, sdk, env)
    if not args.verify_only:
        print(run([str(flutter / "bin/flutter"), "precache", "--android"], env))
        exports = {
            key: env[key]
            for key in ("ANDROID_HOME", "ANDROID_SDK_ROOT", "ANDROID_USER_HOME")
        }
        # Preserve the caller's current Node/pnpm/uv PATH when sourced later.
        path_prefix = f"{flutter / 'bin'}:{java_home / 'bin'}:"
        (tools / "env.sh").write_text(
            "".join(
                f"export {key}={shlex.quote(value)}\n" for key, value in exports.items()
            )
            + f'export PATH={shlex.quote(path_prefix)}"$PATH"\n'
        )
        if env.get("GITHUB_ENV"):
            with Path(env["GITHUB_ENV"]).open("a") as destination:
                for key in ("ANDROID_HOME", "ANDROID_SDK_ROOT", "ANDROID_USER_HOME"):
                    destination.write(f"{key}={env[key]}\n")
        if env.get("GITHUB_PATH"):
            with Path(env["GITHUB_PATH"]).open("a") as destination:
                destination.write(f"{flutter / 'bin'}\n")
        print(f"For this shell: source {shlex.quote(str(tools / 'env.sh'))}")


if __name__ == "__main__":
    main()
