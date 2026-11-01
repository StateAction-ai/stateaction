#!/usr/bin/env python3
"""Trusted default-branch merger; never checks out or executes a PR's code."""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

from github_policy import (
    SHA,
    WORKFLOWS,
    ApiError,
    GitHub,
    PolicyError,
    get_validated_pr,
    successful_workflows,
    validate_pr,
)


def main_sha(api) -> str:
    sha = api.request("GET", "git/ref/heads/main")["object"]["sha"]
    if not SHA.fullmatch(sha):
        raise PolicyError("Invalid main branch SHA.")
    return sha


def merge_one(
    api, number: int, expected_head: str | None = None, sleep=time.sleep
) -> dict:
    pr, ticket = get_validated_pr(api, number)
    head = pr["head"]["sha"]
    result = {"pr": number, "ticket": ticket, "head": head}
    if expected_head and head != expected_head:
        return result | {
            "action": "waiting",
            "reason": "PR head changed since the triggering run",
        }
    if pr.get("draft"):
        return result | {"action": "waiting", "reason": "PR is a draft"}
    ready, reason = successful_workflows(api, pr)
    if not ready:
        return result | {"action": "waiting", "reason": reason}
    base = main_sha(api)
    comparison = api.request("GET", f"compare/{base}...{head}")
    if comparison.get("merge_base_commit", {}).get("sha") != base:
        # A tested head must include the current main. Update atomically, then test
        # the resulting head. Explicit dispatch avoids GITHUB_TOKEN event limits.
        api.request("PUT", f"pulls/{number}/update-branch", {"expected_head_sha": head})
        for _ in range(30):
            current = api.request("GET", f"pulls/{number}")
            if current["head"]["sha"] != head:
                break
            sleep(1)
        else:
            raise PolicyError(
                "Branch update accepted but its new head is not visible; rerun the merger after it completes."
            )
        current, _ = get_validated_pr(api, number)
        for filename, _, _ in WORKFLOWS:
            api.request(
                "POST",
                f"actions/workflows/{filename}/dispatches",
                {"ref": current["head"]["ref"], "inputs": {"pr_number": str(number)}},
            )
        return result | {
            "action": "updated",
            "new_head": current["head"]["sha"],
            "reason": "both workflows dispatched; waiting for new CI",
        }
    # Re-read everything that can invalidate eligibility immediately before the
    # expected-SHA merge. A serialized merger prevents races with our other merges.
    current, _ = get_validated_pr(api, number)
    if current["head"]["sha"] != head or current.get("draft"):
        return result | {
            "action": "waiting",
            "reason": "PR head, draft status, or main changed during validation",
        }
    ready, reason = successful_workflows(api, current)
    if not ready:
        return result | {"action": "waiting", "reason": reason}
    # Keep the base read as the final API call before the merge, after the more
    # expensive workflow/job queries. The merge API guards the head atomically;
    # Free private repositories do not offer an atomic expected-base merge guard.
    if main_sha(api) != base:
        return result | {
            "action": "waiting",
            "reason": "main changed during validation",
        }
    merged = api.request(
        "PUT",
        f"pulls/{number}/merge",
        {
            "sha": head,
            "merge_method": "merge",
            "commit_title": f"{current['title']} (#{number})",
        },
    )
    if not merged.get("merged"):
        raise PolicyError("GitHub refused the guarded merge; no retry was attempted.")
    return result | {"action": "merged", "merge_sha": merged["sha"]}


def candidates(api, event: dict) -> list[int]:
    run = event.get("workflow_run", {})
    head = run.get("head_sha", "")
    branch = run.get("head_branch", "")
    if (
        not SHA.fullmatch(head)
        or run.get("head_repository", {}).get("full_name", "").lower()
        != api.repo.lower()
    ):
        raise PolicyError("Trigger must be a workflow run from this repository.")
    if run.get("name") not in {workflow[1] for workflow in WORKFLOWS}:
        raise PolicyError("Unexpected triggering workflow.")
    if not branch:
        raise PolicyError("Triggering workflow has no branch.")
    # A concurrency group retains only one pending invocation. Sweep every ready
    # candidate so another PR's replaced trigger cannot strand a passing PR.
    pulls = api.pages(
        "pulls", state="open", base="main", sort="created", direction="asc"
    )
    numbers = []
    for pr in pulls:
        try:
            validate_pr(pr, api.repo, [])
        except PolicyError:
            continue
        numbers.append(pr["number"])
    return numbers


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--pr",
        type=int,
        help="Validate and merge one PR (also used for the initial bootstrap).",
    )
    parser.add_argument(
        "--event-file", type=Path, default=os.environ.get("GITHUB_EVENT_PATH")
    )
    args = parser.parse_args()
    try:
        api = GitHub(
            os.environ["GITHUB_REPOSITORY"],
            os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN", ""),
        )
        if args.pr is not None:
            if args.pr < 1:
                raise PolicyError("PR number must be positive.")
            numbers = [args.pr]
        elif args.event_file:
            numbers = candidates(api, json.loads(args.event_file.read_text()))
        else:
            raise PolicyError("Provide --pr or a workflow_run event file.")
        for number in numbers:
            try:
                print(json.dumps(merge_one(api, number)))
            except ApiError:
                raise
            except PolicyError as error:
                if args.pr is not None:
                    raise
                print(
                    json.dumps(
                        {"pr": number, "action": "blocked", "reason": str(error)}
                    )
                )
        if not numbers:
            print(
                json.dumps(
                    {"action": "waiting", "reason": "no eligible open ticket PRs"}
                )
            )
        return 0
    except (KeyError, ValueError, PolicyError) as error:
        print(f"Automatic merge refused: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
