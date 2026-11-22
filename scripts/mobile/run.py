#!/usr/bin/env python3
"""Nx adapters for real Flutter/pub and Android host checks; never select a device."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PROJECTS = {
    "mobile": ROOT / "apps/mobile",
    "stera-recorder": ROOT / "packages/stera_recorder",
}


def run(*command: str, cwd: Path) -> None:
    subprocess.run(command, cwd=cwd, check=True)


def ensure_no_auth_asset(app: Path) -> None:
    """Create a harmless local asset only when absent; preserve private settings."""
    path = app / ".env"
    try:
        with path.open("x") as file:
            file.write("NO_AUTH_MODE=true\n")
    except FileExistsError:
        pass


def format_sources(directory: Path, language_version: str) -> None:
    """Check Git-visible source, including tools/examples, without build caches."""
    paths = (
        subprocess.check_output(
            [
                "git",
                "ls-files",
                "--cached",
                "--others",
                "--exclude-standard",
                "-z",
                "--",
                str(directory.relative_to(ROOT)),
            ],
            cwd=ROOT,
        )
        .decode()
        .split("\0")
    )
    generated = {"build", ".dart_tool", ".gradle", ".kotlin", ".cxx"}
    sources = sorted(
        path
        for path in set(paths)
        if path
        and (ROOT / path).is_file()
        and not generated.intersection(Path(path).parts)
    )
    dart = [path for path in sources if Path(path).suffix == ".dart"]
    prettier = [
        path
        for path in sources
        if Path(path).suffix.lower()
        in {
            ".js",
            ".mjs",
            ".cjs",
            ".jsx",
            ".ts",
            ".tsx",
            ".json",
            ".yaml",
            ".yml",
            ".md",
            ".css",
            ".html",
        }
    ]
    if dart:
        run(
            "dart",
            "format",
            "--output=none",
            "--set-exit-if-changed",
            f"--language-version={language_version}",
            *dart,
            cwd=ROOT,
        )
    if prettier:
        run("pnpm", "exec", "prettier", "--check", *prettier, cwd=ROOT)


def prepare(project: str) -> None:
    directory = PROJECTS[project]
    if project == "mobile":
        ensure_no_auth_asset(directory)
    run("flutter", "pub", "get", "--enforce-lockfile", cwd=directory)
    if project == "mobile":
        # Direct Gradle library checks need this before the app's first APK build.
        properties = directory / "android/local.properties"
        if not properties.exists():
            executable = shutil.which("flutter")
            sdk = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
            if not executable or not sdk:
                raise RuntimeError(
                    "Flutter and ANDROID_HOME/ANDROID_SDK_ROOT are required"
                )
            flutter = Path(executable).resolve().parents[1]
            properties.write_text(f"sdk.dir={sdk}\nflutter.sdk={flutter}\n")


def main() -> None:
    # Hosted CI has its own ephemeral-runner limits. Local runs must use the
    # installed shared cgroup, also for generated Flutter/Gradle spike projects.
    hosted = (
        os.environ.get("GITHUB_ACTIONS") == "true"
        and os.environ.get("RUNNER_ENVIRONMENT") == "github-hosted"
        and str(ROOT).startswith("/home/runner/work/")
    )
    if not hosted:
        from resource_guard import inside_lane

        # Inside any lane ticket (the ci gate or an android-build job) the work is flattened
        # under that one ticket; otherwise take the android-build lane, never a second lane.
        if not inside_lane():
            guard = Path.home() / ".local/bin/agent-resource"
            if not guard.is_file():
                raise RuntimeError(
                    "Install scripts/mobile/resource_guard.py first; no unbounded local builds"
                )
            os.execv(
                str(guard),
                [
                    str(guard),
                    "run",
                    "--lane",
                    "android-build",
                    "--",
                    sys.executable,
                    str(__file__),
                    *sys.argv[1:],
                ],
            )
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project", choices=PROJECTS)
    parser.add_argument(
        "target", choices=["prepare", "typecheck", "test", "format", "build"]
    )
    args = parser.parse_args()
    directory = PROJECTS[args.project]
    toolchain = json.loads((ROOT / "config/mobile-toolchain.json").read_text())
    version = json.loads(
        subprocess.check_output(["flutter", "--version", "--machine"], text=True)
    )
    if version["frameworkVersion"] != toolchain["flutter"]:
        raise RuntimeError(
            f"Use pinned Flutter {toolchain['flutter']}; found {version['frameworkVersion']}"
        )
    if args.target == "prepare":
        prepare(args.project)
    elif args.target == "typecheck":
        run("flutter", "analyze", "--no-pub", cwd=directory)
    elif args.target == "test":
        run("flutter", "test", "--no-pub", "--concurrency=2", cwd=directory)
    elif args.target == "format":
        format_sources(directory, toolchain["dartFormatLanguageVersion"])
    elif args.project == "mobile":
        run(
            "flutter",
            "build",
            "apk",
            "--debug",
            "--target-platform",
            "android-x64",
            "--no-pub",
            cwd=directory,
        )
    else:
        run(
            "./gradlew",
            ":stera_recorder:testDebugUnitTest",
            ":stera_recorder:assembleDebugAndroidTest",
            "--no-daemon",
            "--max-workers=2",
            "--console=plain",
            cwd=PROJECTS["mobile"] / "android",
        )


if __name__ == "__main__":
    main()
