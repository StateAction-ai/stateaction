#!/usr/bin/env python3
"""Stage QA-only development collector credentials in Android user 0 via stdin."""

import argparse
import json
import subprocess
import sys
from datetime import UTC, datetime, timedelta
from urllib.parse import urlsplit

from android_personal_device import PersonalDevice, SafetyError

PACKAGE = "ai.stateaction.collector.qa"
REMOTE = (
    "run-as ai.stateaction.collector.qa --user 0 sh -c "
    "'umask 077; mkdir -p files && tmp=$(mktemp files/.qa-sign-in.XXXXXX) || exit 1; "
    'trap "rm -f $tmp" EXIT; cat > "$tmp" && mv -f "$tmp" files/qa-sign-in.json'
    "'"
)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serial", required=True)
    args = parser.parse_args()
    try:
        raw = sys.stdin.buffer.read(1025)
        if len(raw) > 1024:
            raise ValueError()
        credential = json.loads(raw)
        if (
            not isinstance(credential, dict)
            or set(credential) != {"origin", "email", "password"}
            or not all(
                isinstance(value, str) and value for value in credential.values()
            )
        ):
            raise ValueError()
        origin = urlsplit(credential["origin"])
        if (
            origin.path
            or origin.query
            or origin.fragment
            or origin.username
            or origin.password
            or not origin.hostname
            or not (
                (
                    origin.scheme in {"http", "https"}
                    and origin.hostname in {"localhost", "127.0.0.1", "::1", "10.0.2.2"}
                )
                or (origin.scheme == "https" and origin.hostname.endswith(".ts.net"))
            )
        ):
            raise ValueError()
        credential["expiresAt"] = (datetime.now(UTC) + timedelta(minutes=5)).isoformat()
        payload = json.dumps(credential, separators=(",", ":")).encode()
        if len(payload) > 1024:
            raise ValueError()
        device = PersonalDevice(args.serial, 0)
        before, present = device.scope(PACKAGE)
        if not present:
            raise SafetyError(
                "Install the signed QA build in verified personal user 0 first"
            )
        try:
            result = subprocess.run(
                [*device.prefix, "shell", "-T", REMOTE],
                input=payload,
                capture_output=True,
                check=False,
                timeout=20,
            )
            if result.returncode or result.stdout or result.stderr:
                raise SafetyError("QA credential staging did not confirm completion")
        finally:
            after, installed = device.scope(PACKAGE)
            if before != after or not installed:
                raise SafetyError(
                    "QA package scope changed; stop without automatic cleanup"
                )
        print("One-time QA credential staged in personal user 0")
    except (ValueError, UnicodeError, OSError, subprocess.TimeoutExpired):
        raise SystemExit("QA credential staging refused or did not finish") from None
    except SafetyError as error:
        raise SystemExit(str(error)) from None


if __name__ == "__main__":
    main()
