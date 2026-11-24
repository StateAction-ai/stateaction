"""Verify a dashboard-issued R2 Object Read credential for local preview."""

from __future__ import annotations

import os
import re
import subprocess
import sys

from dev_hosted import ROOT, SETTINGS, private_env


def r2_settings(name: str) -> dict[str, str]:
    return {
        key: value.strip("\"'") for key, value in private_env(SETTINGS / name).items()
    }


def main() -> None:
    db_settings = private_env(SETTINGS / "hosted-dev-db.env")
    reader = r2_settings("r2-prod-read.env")
    production = r2_settings("r2-prod.env")
    target = SETTINGS / "hosted-dev.env"
    if target.exists():
        raise RuntimeError("Hosted dev credentials already exist")
    if set(db_settings) != {"DATABASE_URL", "HOSTED_DEV_STAFF_ID"}:
        raise ValueError("Hosted dev database settings are incomplete")

    endpoint = reader["R2_ENDPOINT"]
    if (
        reader["R2_BUCKET"] != "stateaction-prod"
        or production["R2_BUCKET"] != "stateaction-prod"
        or endpoint != production["R2_ENDPOINT"]
        or not re.fullmatch(
            r"https://[a-f0-9]{32}\.r2\.cloudflarestorage\.com/?", endpoint
        )
        or not re.fullmatch(r"[a-f0-9]{32}", reader["R2_ACCESS_KEY_ID"])
        or not re.fullmatch(r"[a-f0-9]{64}", reader["R2_SECRET_ACCESS_KEY"])
    ):
        raise ValueError("Expected a production bucket Object Read credential")
    if reader["R2_ACCESS_KEY_ID"] == production["R2_ACCESS_KEY_ID"]:
        raise ValueError("Use a dedicated R2 Object Read credential")

    r2 = {
        "S3_ENDPOINT": endpoint,
        "S3_ACCESS_KEY_ID": reader["R2_ACCESS_KEY_ID"],
        "S3_SECRET_ACCESS_KEY": reader["R2_SECRET_ACCESS_KEY"],
    }
    subprocess.run(
        ["node", str(ROOT / "scripts/platform/probe-hosted-r2-reader.mjs")],
        env={**os.environ, **r2},
        check=True,
        timeout=60,
    )
    created = False
    try:
        with open(
            target, "x", opener=lambda path, flags: os.open(path, flags, 0o600)
        ) as out:
            created = True
            out.writelines(
                f"{key}={value}\n" for key, value in {**db_settings, **r2}.items()
            )
    except BaseException:
        if created:
            target.unlink(missing_ok=True)
        raise
    print("Private hosted reader settings verified and saved in hosted-dev.env.")


if __name__ == "__main__":
    try:
        main()
    except (
        OSError,
        RuntimeError,
        ValueError,
        KeyError,
        subprocess.SubprocessError,
    ) as error:
        print(f"Hosted reader setup stopped ({type(error).__name__}).", file=sys.stderr)
        sys.exit(1)
