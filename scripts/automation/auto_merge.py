#!/usr/bin/env python3
"""Trusted default-branch merger; never checks out or executes a PR's code."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from github_policy import (
    SHA,
    WORKFLOWS,
    ApiError,
    GitHub,
    PolicyError,
    get_validated_pr,
    primary_declaration,
    successful_workflows,
    validate_pr,
)


def main_sha(api) -> str:
    sha = api.request("GET", "git/ref/heads/main")["object"]["sha"]
    if not SHA.fullmatch(sha):
        raise PolicyError("Invalid main branch SHA.")
    return sha


# GitHub's compare API lists at most 250 commits; a longer range cannot be verified.
MAX_COMPARE_COMMITS = 250
REBASE_REQUIRED = (
    "rebase-required: the branch owner must rebase onto current main, push with "
    "--force-with-lease=<branch>:<previous head>, and wait for fresh exact-head checks"
)


def linear_candidate(api, base: str, head: str) -> tuple[bool, str]:
    """A squashable head is a strict, merge-free descendant of the current main.

    The merger never refreshes a stale branch: a GitHub branch-update merge commit would
    put an untested combination and a merge commit into the PR's history.
    """
    comparison = api.request("GET", f"compare/{base}...{head}")
    commits = comparison.get("commits")
    if (
        comparison.get("merge_base_commit", {}).get("sha") != base
        or comparison.get("status") != "ahead"
        or comparison.get("behind_by") != 0
    ):
        return False, REBASE_REQUIRED
    ahead = comparison.get("ahead_by")
    if (
        not isinstance(commits, list)
        or not isinstance(ahead, int)
        or ahead < 1
        or ahead > MAX_COMPARE_COMMITS
        or comparison.get("total_commits") != ahead
        or len(commits) != ahead
    ):
        return False, (
            f"candidate range must list 1..{MAX_COMPARE_COMMITS} commits completely; "
            "squash locally into fewer commits and push with an exact lease"
        )
    for commit in commits:
        if len(commit.get("parents") or []) != 1:
            return False, (
                f"{REBASE_REQUIRED}; commit {str(commit.get('sha', ''))[:12]} is a merge "
                "or root commit, so the branch history is not linear"
            )
    if commits[-1].get("sha") != head:
        return False, "compare response does not end at the tested head"
    return True, "head is a linear descendant of current main"


def merge_one(api, number: int, expected_head: str | None = None) -> dict:
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
    linear, reason = linear_candidate(api, base, head)
    if not linear:
        # Fail closed without any write: no branch update, workflow dispatch or merge.
        return result | {"action": "waiting", "reason": reason, "base": base}
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
            "merge_method": "squash",
            "commit_title": f"{current['title']} (#{number})",
            "commit_message": f"{primary_declaration(current)}\n\nTested head: {head}",
        },
    )
    if not merged.get("merged") or not SHA.fullmatch(str(merged.get("sha", ""))):
        raise PolicyError("GitHub refused the guarded merge; no retry was attempted.")
    # Detect the unguardable final-interval main race after the fact: a squash
    # commit must have exactly the tested base as its only parent.
    commit = api.request("GET", f"commits/{merged['sha']}")
    parents = [parent.get("sha") for parent in commit.get("parents") or []]
    outcome = result | {"action": "merged", "merge_sha": merged["sha"], "base": base}
    if parents != [base]:
        raise MergedOnUntestedBase(
            outcome | {"parents": parents},
            "Squash commit parent is not the tested main; main moved in the final "
            "interval. Investigate and verify main's CI; nothing was retried.",
        )
    return outcome


class MergedOnUntestedBase(PolicyError):
    """The merge happened, but not on the tested base; surface it loudly."""

    def __init__(self, outcome: dict, message: str):
        super().__init__(message)
        self.outcome = outcome


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
        help="Validate and squash merge one PR (also used for a policy bootstrap).",
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
            except MergedOnUntestedBase as error:
                print(json.dumps(error.outcome | {"reason": str(error)}))
                raise
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
