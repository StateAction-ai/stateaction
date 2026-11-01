#!/usr/bin/env python3
"""Fail-closed personal-user-only Android app operations. No ADB default target.

Source scripts/env.sh first. Example readonly preflight:
  python3 scripts/android_personal_device.py --serial SERIAL --user 0 check --package ai.stateaction.spike.capture
Use install --dry-run before installing; simulation/emulator qualification is a
separate prerequisite. Never use this helper to operate on a company/work profile.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable


class SafetyError(RuntimeError):
    """An unverified target, scope or outcome; never triggers automatic repair."""


@dataclass(frozen=True)
class User:
    user_id: int
    user_type: str
    current: bool
    ineligible: bool


PACKAGE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+")
KNOWN_TYPES = frozenset(
    {
        "full.SYSTEM",
        "full.SECONDARY",
        "full.GUEST",
        "full.DEMO",
        "full.RESTRICTED",
        "profile.MANAGED",
        "profile.CLONE",
        "profile.PRIVATE",
        "profile.COMMUNAL",
        "system.HEADLESS",
    }
)
USER_ROW = re.compile(
    r"(?P<index>\d+): id=(?P<id>\d+), name=(?P<name>.*?), "
    r"type=(?P<type>(?:android\.os\.usertype\.)?[A-Za-z][A-Za-z0-9_.]*), flags=(?P<flags>.*)"
)


def parse_users(output: str) -> list[User]:
    """Accept the AOSP `cmd user list -v` shape; refuse incomplete/OEM guesses."""
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    header = re.fullmatch(r"([1-9]\d*) users:", lines[0]) if lines else None
    if not header or len(lines) != int(header[1]) + 1:
        raise SafetyError(
            "User inventory is incomplete or its verbose format is unknown"
        )
    users = []
    for index, line in enumerate(lines[1:]):
        row = USER_ROW.fullmatch(line)
        if not row or int(row["index"]) != index or ", type=" in row["name"]:
            raise SafetyError("Ambiguous user inventory; no app operation is permitted")
        kind = row["type"].removeprefix("android.os.usertype.")
        if kind not in KNOWN_TYPES:
            raise SafetyError(
                "Unknown Android user type; no app operation is permitted"
            )
        flags = row["flags"]
        if flags.count("(current)") > 1:
            raise SafetyError("Ambiguous current-user flags")
        users.append(
            User(
                int(row["id"]),
                kind,
                "(current)" in flags,
                any(
                    marker in flags
                    for marker in (
                        "MANAGED_PROFILE",
                        "(partial)",
                        "(pre-created)",
                        "(device-owner)",
                        "(profile-owner)",
                    )
                ),
            )
        )
    if (
        len({user.user_id for user in users}) != len(users)
        or sum(user.current for user in users) != 1
    ):
        raise SafetyError("Duplicate user IDs or ambiguous current user")
    return users


Runner = Callable[..., subprocess.CompletedProcess[str]]


def execute(
    command: list[str], runner: Runner, operation: str, timeout: int = 30
) -> str:
    try:
        result = runner(
            command, capture_output=True, text=True, timeout=timeout, check=False
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise SafetyError(
            f"{operation} did not finish; do not retry a mutation blindly"
        ) from error
    if result.returncode:
        # Do not print raw device output, profile names, accounts or unrelated apps.
        raise SafetyError(
            f"{operation} failed (exit {result.returncode}); no automatic retry or cleanup"
        )
    if result.stderr.strip():
        raise SafetyError(
            f"{operation} returned unexpected diagnostics; target/outcome is not verified"
        )
    return result.stdout.strip()


class PersonalDevice:
    def __init__(
        self,
        serial: str,
        user_id: int,
        adb: str = "adb",
        runner: Runner = subprocess.run,
    ):
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]*", serial) or user_id < 0:
            raise SafetyError(
                "An explicit valid serial and numeric personal user are required"
            )
        self.prefix = [adb, "-s", serial]
        self.user_id = user_id
        self.runner = runner

    def adb(self, *arguments: str, operation: str, timeout: int = 30) -> str:
        return execute(self.prefix + list(arguments), self.runner, operation, timeout)

    def inventory(self) -> list[User]:
        users = parse_users(
            self.adb(
                "shell", "cmd", "user", "list", "-v", operation="Profile identification"
            )
        )
        target = next((user for user in users if user.user_id == self.user_id), None)
        # Guest/demo/restricted/headless users are not verified personal full users.
        if (
            target is None
            or target.user_type not in ("full.SYSTEM", "full.SECONDARY")
            or target.ineligible
        ):
            raise SafetyError(
                "Target is not a verified personal full user; work/managed profiles are forbidden"
            )
        current = self.adb(
            "shell", "am", "get-current-user", operation="Current-user verification"
        )
        if (
            not re.fullmatch(r"\d+", current)
            or int(current) != self.user_id
            or not target.current
        ):
            raise SafetyError(
                "Target must be the independently verified current personal full user"
            )
        return users

    def installed(self, user_id: int, package: str) -> bool:
        output = self.adb(
            "shell",
            "pm",
            "list",
            "packages",
            "--user",
            str(user_id),
            package,
            operation="Exact test-package scope verification",
        )
        lines = [line.strip() for line in output.splitlines() if line.strip()]
        if any(not re.fullmatch(r"package:" + PACKAGE.pattern, line) for line in lines):
            raise SafetyError(
                "Package query is unsupported or ambiguous; scope cannot be verified"
            )
        # Android's filter is a substring match. Ignore other matches and never log them.
        return f"package:{package}" in lines

    def scope(self, package: str) -> tuple[list[User], bool]:
        if not PACKAGE.fullmatch(package):
            raise SafetyError("An exact package name is required")
        users = self.inventory()
        present = False
        for user in users:
            installed = self.installed(user.user_id, package)
            if user.user_id == self.user_id:
                present = installed
            elif installed:
                # APK code updates are package-global: even another full user's
                # existing installation makes updating this package out of scope.
                raise SafetyError(
                    f"Exact test package exists in non-target user {user.user_id}; refusing all mutations"
                )
        return users, present

    def operate(
        self, action: str, package: str, arguments: list[str], *, dry_run: bool = False
    ) -> dict:
        before, present = self.scope(package)
        if action != "install" and not present:
            raise SafetyError(
                "Exact test package is not installed in the verified personal user"
            )
        result = {
            "action": action,
            "personalUser": self.user_id,
            "package": package,
            "targetInstalled": present,
            "nonTargetInstallations": False,
            "dryRun": dry_run,
        }
        if action == "check":
            return result
        command = self.prefix + arguments
        result["command"] = command
        if dry_run:
            return result
        mutation_error = None
        try:
            output = execute(
                command,
                self.runner,
                f"Personal-user {action}",
                timeout=180 if action == "install" else 30,
            )
            # `am` may emit Error while returning zero. Never report that as a launch.
            if action == "install" and (
                not output.splitlines() or output.splitlines()[-1] != "Success"
            ):
                raise SafetyError(
                    "Install did not explicitly report Success; do not retry blindly"
                )
            if re.search(
                r"(?im)^\s*(Error|Exception|SecurityException|Failure)\b", output
            ):
                raise SafetyError(
                    "App operation was rejected; no automatic repair or profile switch"
                )
            if action == "grant" and output:
                raise SafetyError(
                    "Permission outcome is ambiguous; no automatic repair"
                )
        except SafetyError as error:
            mutation_error = error
        # Also recheck an uncertain/failed mutation; its outcome may have been lost.
        try:
            after, installed = self.scope(package)
        except SafetyError as error:
            raise SafetyError(
                f"Post-{action} scope verification failed; the operation may already have run. Stop without automatic cleanup. {error}"
            ) from error
        if mutation_error is not None:
            raise SafetyError(
                f"{mutation_error}. Read-only scope was rechecked; no mutation was retried"
            ) from mutation_error
        if before != after or not installed:
            raise SafetyError(
                "Post-operation user/package scope changed; stop and inspect without automatic cleanup"
            )
        result["targetInstalled"] = True
        result["verifiedAfter"] = True
        return result


def find_aapt2(explicit: str | None) -> str:
    if explicit:
        return explicit
    found = shutil.which("aapt2")
    if found:
        return found
    sdk = os.environ.get("ANDROID_SDK_ROOT") or os.environ.get("ANDROID_HOME")
    if sdk:
        candidates = list((Path(sdk) / "build-tools").glob("*/aapt2"))
        if candidates:

            def version(path: Path) -> tuple[int, ...]:
                return tuple(
                    int(number) for number in re.findall(r"\d+", path.parent.name)
                )

            return str(max(candidates, key=version))
    raise SafetyError(
        "aapt2 is required to verify the APK's actual package; source scripts/env.sh or pass --aapt2"
    )


def apk_package(apk: Path, aapt2: str, runner: Runner) -> str:
    if not apk.is_file():
        raise SafetyError("APK file does not exist")
    output = execute(
        [aapt2, "dump", "badging", str(apk.resolve())],
        runner,
        "Local APK package identification",
    )
    packages = re.findall(r"(?m)^package: name='([^']+)'(?: |$)", output)
    if len(packages) != 1 or not PACKAGE.fullmatch(packages[0]):
        raise SafetyError("APK package identity is ambiguous")
    return packages[0]


def main(argv: list[str] | None = None, runner: Runner = subprocess.run) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--serial", required=True)
    parser.add_argument(
        "--user",
        required=True,
        type=int,
        help="Explicit verified personal full-user ID; never all/current",
    )
    parser.add_argument("--adb", default="adb")
    commands = parser.add_subparsers(dest="action", required=True)
    check = commands.add_parser(
        "check",
        help="Read-only; requires exact package in personal user and absent elsewhere",
    )
    check.add_argument("--package", required=True)
    install = commands.add_parser(
        "install",
        help="Update preserving data, only after actual APK identity and scope checks",
    )
    install.add_argument("--package", required=True)
    install.add_argument("--apk", required=True, type=Path)
    install.add_argument("--aapt2")
    install.add_argument("--test-apk", action="store_true")
    install.add_argument("--dry-run", action="store_true")
    start = commands.add_parser(
        "start", help="Launch only in current verified personal user"
    )
    start.add_argument("--component", required=True)
    start.add_argument("--dry-run", action="store_true")
    grant = commands.add_parser(
        "grant", help="Grant one runtime permission in personal user only"
    )
    grant.add_argument("--package", required=True)
    grant.add_argument("--permission", required=True)
    grant.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    try:
        device = PersonalDevice(args.serial, args.user, args.adb, runner)
        scoped = ["--user", str(args.user)]
        if args.action == "install":
            actual = apk_package(args.apk, find_aapt2(args.aapt2), runner)
            if actual != args.package:
                raise SafetyError(
                    "APK's actual package differs from --package; refusing installation"
                )
            command = (
                ["install", *scoped, "-r"]
                + (["-t"] if args.test_apk else [])
                + [str(args.apk.resolve())]
            )
            package = actual
        elif args.action == "start":
            component = re.fullmatch(
                r"(" + PACKAGE.pattern + r")/(\.?[A-Za-z_][A-Za-z0-9_.]*)",
                args.component,
            )
            if not component:
                raise SafetyError("Exact package/activity component is required")
            package = component[1]
            command = ["shell", "am", "start", *scoped, "-n", args.component]
        elif args.action == "grant":
            if not re.fullmatch(
                r"android\.permission\.[A-Z][A-Z0-9_]*", args.permission
            ):
                raise SafetyError("Exact Android runtime permission is required")
            package = args.package
            command = ["shell", "pm", "grant", *scoped, package, args.permission]
        else:
            package = args.package
            command = []
        result = device.operate(
            args.action, package, command, dry_run=getattr(args, "dry_run", False)
        )
        print(json.dumps(result, indent=2))
        return 0
    except SafetyError as error:
        print(f"Refused: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
