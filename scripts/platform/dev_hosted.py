"""Start the loopback Next development server against the hosted catalog."""

from __future__ import annotations

import argparse
import os
import re
import signal
import stat
import sys
from getpass import getpass
from pathlib import Path

from render_db_session import command_for_window, stop

ROOT = Path(__file__).resolve().parents[2]
SETTINGS = Path.home() / ".config/stateaction"
PROFILE_KEYS = {
    "DATABASE_URL",
    "S3_ENDPOINT",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
    "HOSTED_DEV_STAFF_ID",
}


def private_env(path: Path) -> dict[str, str]:
    """Each private setting is one unquoted KEY=value line. Never source it."""
    with open(path, opener=private_fd) as stream:
        result = {}
        for line in stream:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            name, separator, value = line.partition("=")
            if (
                not separator
                or not re.fullmatch(r"[A-Z][A-Z0-9_]*", name)
                or name in result
            ):
                raise ValueError(f"Invalid setting in {path.name}")
            result[name] = value
        return result


def private_fd(path, flags):
    fd = os.open(path, flags | os.O_NOFOLLOW)
    info = os.fstat(fd)
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_IMODE(info.st_mode) != 0o600
        or info.st_uid != os.getuid()
    ):
        os.close(fd)
        raise PermissionError(
            "Configuration must be owned by this user and have mode 0600"
        )
    return fd


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--allow-writes", action="store_true")
    parser.add_argument("--seconds", type=int, default=1800)
    parser.add_argument("--port", type=int, default=3008)
    args = parser.parse_args()
    if os.environ.get("CI") or not sys.stdin.isatty():
        parser.error("This command requires an interactive terminal outside CI")
    if not 60 <= args.seconds <= 3600 or not 1024 <= args.port <= 65535:
        parser.error("Window must be 60 to 3600 seconds and port must be 1024 to 65535")
    fixtures = os.environ.get("STATEACTION_LOCAL_FIXTURES")
    if not fixtures:
        parser.error(
            "Set STATEACTION_LOCAL_FIXTURES to the local fixture configuration for auth"
        )
    config_file = SETTINGS / (
        "hosted-dev-write.env" if args.allow_writes else "hosted-dev.env"
    )
    values = private_env(config_file)
    if values.keys() != PROFILE_KEYS or not all(values.values()):
        parser.error(f"Check settings in {config_file}")
    for sig in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, stop)
    password = getpass("Temporary local staff password (12 or more characters): ")
    if len(password) < 12:
        parser.error("Use a local password of at least 12 characters")
    env = {
        key: os.environ[key] for key in ("HOME", "PATH", "LANG") if key in os.environ
    }
    env.update(
        **values,
        APP_ENV="development",
        NODE_ENV="development",
        STATEACTION_LOCAL_FIXTURES=fixtures,
        AUTH_LOCAL_PASSWORD="true",
        STATEACTION_HOSTED_DEV_MODE="allow-writes"
        if args.allow_writes
        else "read-only",
        HOSTED_DEV_AUTH_PASSWORD=password,
        S3_REGION="auto",
        S3_BUCKET="stateaction-prod",
        STATEACTION_WEB_HOST="127.0.0.1",
        STATEACTION_ENV_FILE=str(ROOT / "scripts/platform/no-dotenv"),
        NEXT_TELEMETRY_DISABLED="1",
        BETTER_AUTH_URL=f"http://127.0.0.1:{args.port}",
        PORT=str(args.port),
    )
    operator = SETTINGS / "render-write.env"
    if operator.exists():
        os.environ["RENDER_CREATE_KEY"] = private_env(operator)["RENDER_API_KEY"]
    os.chdir(ROOT / "packages/server")
    return command_for_window(
        [
            "node",
            "--conditions=react-server",
            "--import",
            "tsx",
            "../../scripts/platform/dev-hosted.mjs",
        ],
        args.seconds,
        child_env=env,
    )


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (
        OSError,
        RuntimeError,
        ValueError,
        TimeoutError,
        KeyboardInterrupt,
    ) as error:
        # An invalid URL may contain a password. Report only the error class.
        print(f"Hosted data session ended ({type(error).__name__}).", file=sys.stderr)
        sys.exit(1)
