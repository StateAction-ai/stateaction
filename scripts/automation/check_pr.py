#!/usr/bin/env python3
"""Read-only PR identity check. All PR text stays data; nothing is sent to a shell."""

import json
import os
import sys

from github_policy import GitHub, PolicyError, get_validated_pr


def main():
    try:
        number = int(os.environ["PR_NUMBER"])
        if number < 1:
            raise ValueError("invalid PR number")
        api = GitHub(
            os.environ["GITHUB_REPOSITORY"],
            os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN", ""),
        )
        pr, ticket = get_validated_pr(api, number)
        if pr["head"]["sha"] != os.environ["EXPECTED_HEAD_SHA"]:
            raise PolicyError("PR head changed; rerun policy for the current head.")
        print(
            json.dumps(
                {
                    "pr": number,
                    "ticket": ticket,
                    "head": pr["head"]["sha"],
                    "policy": "passed",
                }
            )
        )
        return 0
    except (KeyError, ValueError, PolicyError) as error:
        print(f"PR policy failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
