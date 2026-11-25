"""Claim exactly one local fixture stage, then exit with a deliberate failure."""

import json
import secrets
import sys

from api import JobsApi


def main() -> int:
    bootstrap = json.load(sys.stdin)
    api = JobsApi(bootstrap["apiUrl"], bootstrap["bootstrapToken"])
    try:
        api.claim(
            bootstrap["jobId"], secrets.token_urlsafe(32), bootstrap["executionRef"]
        )
    finally:
        api.close()
    return 7


if __name__ == "__main__":
    sys.exit(main())
