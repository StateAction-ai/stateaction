"""Run a bounded operator command with one temporary Render Postgres ACL entry."""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
import re
import signal
import subprocess
import sys
import time
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen
from uuid import uuid4

DB = "dpg-dc2bek3rjlhs73ae5qg0-a"
ROUTE = f"postgres/{DB}"


def render_request(method: str, route: str, body: dict | None = None):
    key = os.environ.get("RENDER_CREATE_KEY") or os.environ.get("RENDER_API_KEY")
    if not key:
        config = (Path.home() / ".render/cli.yaml").read_text()
        found = re.search(r"^\s+key:\s+(\S+)$", config, re.MULTILINE)
        if not found:
            raise RuntimeError("The Render operator credential is unavailable")
        key = found.group(1).strip('"')
    request = Request(
        f"https://api.render.com/v1/{route}",
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
    )
    try:
        with urlopen(request, timeout=15) as response:
            data = response.read()
            return json.loads(data) if data else None
    except HTTPError as error:
        raise RuntimeError(f"Render {method} {route}: HTTP {error.code}") from None


def verified_owner_url() -> str:
    data = render_request("GET", f"{ROUTE}/connection-info")
    url = urlsplit(data["externalConnectionString"])
    return urlunsplit(
        url._replace(
            query=urlencode(
                {
                    **dict(parse_qsl(url.query)),
                    "sslmode": "verify-full",
                }
            )
        )
    )


def read_allowlist() -> list[dict]:
    response = render_request("GET", ROUTE)
    result = response["ipAllowList"]
    if not isinstance(result, list):
        raise TypeError("Invalid Render Postgres allowlist response")
    return [
        {"cidrBlock": rule["cidrBlock"], "description": rule["description"]}
        for rule in result
    ]


@contextmanager
def workstation_access(seconds: int):
    previous = read_allowlist()
    if previous:
        raise RuntimeError("Render Postgres already has an external allowlist entry")
    with urlopen("https://api.ipify.org", timeout=10) as response:
        address = ipaddress.IPv4Address(response.read(64).decode().strip())
    expiry = datetime.now(UTC) + timedelta(seconds=seconds)
    rule = {
        "cidrBlock": f"{address}/32",
        "description": f"stateaction-session {uuid4().hex[:12]} expires {expiry.isoformat(timespec='seconds')}",
    }
    try:
        render_request("PATCH", ROUTE, {"ipAllowList": [rule]})
        if read_allowlist() != [rule]:
            raise RuntimeError(
                "Render Postgres allowlist did not match the temporary rule"
            )
        yield
    finally:
        for attempt in range(4):
            try:
                current = read_allowlist()
                if rule in current:
                    render_request(
                        "PATCH",
                        ROUTE,
                        {"ipAllowList": [r for r in current if r != rule]},
                    )
                if read_allowlist() == previous:
                    print(
                        "Render Postgres allowlist restored and verified.",
                        file=sys.stderr,
                    )
                    break
            except (OSError, RuntimeError):
                if attempt == 3:
                    raise
            if attempt < 3:
                time.sleep(2)
        else:
            raise RuntimeError(
                "Render Postgres allowlist restoration requires operator attention"
            )


def command_for_window(
    command: list[str],
    seconds: int,
    owner_env: str | None = None,
    *,
    child_env: dict[str, str] | None = None,
) -> int:
    env = {
        key: val
        for key, val in (os.environ if child_env is None else child_env).items()
        if key not in ("RENDER_API_KEY", "RENDER_CREATE_KEY")
    }
    if owner_env:
        env[owner_env] = verified_owner_url()
    started = time.monotonic()
    with workstation_access(seconds):
        # Render acknowledges the rule before traffic is accepted. The child
        # owns any bounded database retries specific to its command.
        time.sleep(15)
        with subprocess.Popen(command, env=env, start_new_session=True) as process:
            try:
                return process.wait(
                    timeout=max(1, seconds - (time.monotonic() - started))
                )
            finally:
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGTERM)
                    try:
                        process.wait(timeout=20)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seconds", type=int, default=900)
    parser.add_argument("--owner-env", choices=("CACHED_IMPORT_OWNER_DATABASE_URL",))
    parser.add_argument("command", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    argv = args.command[1:] if args.command[:1] == ["--"] else args.command
    if not argv or not 60 <= args.seconds <= 3600:
        parser.error("Provide a command and a window between 60 and 3600 seconds")
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, stop)
    try:
        return command_for_window(argv, args.seconds, args.owner_env)
    except (
        OSError,
        RuntimeError,
        ValueError,
        subprocess.TimeoutExpired,
        KeyboardInterrupt,
    ) as error:
        print(f"Render Postgres session ended: {type(error).__name__}", file=sys.stderr)
        if isinstance(error, RuntimeError):
            print(str(error), file=sys.stderr)
        return 1


def stop(_signum, _frame):
    raise KeyboardInterrupt


if __name__ == "__main__":
    sys.exit(main())
