"""Exercise the actual merger decisions against an injectable GitHub API."""

import sys
import unittest
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts" / "automation"))

from auto_merge import (  # noqa: E402
    MAX_COMPARE_COMMITS,
    MergedOnUntestedBase,
    candidates,
    merge_one,
)
from github_policy import ApiError, GitHub, PolicyError, validate_pr  # noqa: E402

REPO = "StateAction-ai/stateaction"
HEAD = "a" * 40
BASE = "b" * 40
NEW = "c" * 40
LINEAR_BRANCH = (
    "wanghujie/sa-11-scaffold-the-typescript-and-python-packages-with-repeatable"
)


def pull(number=11, ticket="SA-11"):
    return {
        "number": number,
        "title": f"{ticket}: Set up the monorepo",
        "body": f"Fixes {ticket}\n\n- [x] criterion one: evidence\n\nDepends on SA-12 for the next increment.",
        "state": "open",
        "draft": False,
        "author_association": "OWNER",
        "base": {"ref": "main", "repo": {"full_name": REPO}},
        "head": {
            "ref": LINEAR_BRANCH
            if ticket == "SA-11"
            else f"wanghujie/{ticket.lower()}-test-fixture",
            "sha": HEAD,
            "repo": {"full_name": REPO},
        },
    }


class FakeGitHub:
    repo = REPO

    def __init__(self):
        self.pr = pull()
        self.other_prs = []
        self.writes = []
        self.base = BASE
        self.behind = False
        # Candidate commits between main and the PR head, oldest first.
        self.candidate_commits = [
            {"sha": "f" * 40, "parents": [{"sha": BASE}]},
            {"sha": HEAD, "parents": [{"sha": "f" * 40}]},
        ]
        self.compare_override = None
        self.squash_parents = None
        self.pr_reads = 0
        self.base_reads = 0
        self.calls = []
        self.on_pr_read = lambda _: None
        self.on_base_read = lambda _: None
        self.workflows = {}
        self.runs = {}
        self.jobs = {}
        for workflow_id, (filename, name, job) in enumerate(
            [
                ("checks.yml", "CI", "Required checks"),
                ("pr-policy.yml", "PR policy", "Ticket reference"),
            ],
            1,
        ):
            path = f".github/workflows/{filename}"
            self.workflows[filename] = {
                "id": workflow_id,
                "path": path,
                "name": name,
                "state": "active",
            }
            run_id = workflow_id * 100
            self.runs[workflow_id] = [
                {
                    "id": run_id,
                    "run_attempt": 1,
                    "workflow_id": workflow_id,
                    "path": path,
                    "name": name,
                    "head_sha": HEAD,
                    "head_branch": self.pr["head"]["ref"],
                    "head_repository": {"full_name": REPO},
                    "event": "pull_request",
                    "pull_requests": [{"number": 11}],
                    "status": "completed",
                    "conclusion": "success",
                }
            ]
            self.jobs[run_id] = [
                {"name": job, "status": "completed", "conclusion": "success"}
            ]

    def request(self, method, path, body=None):
        self.calls.append((method, path))
        if method != "GET":
            self.writes.append((method, path, deepcopy(body)))
            if path.endswith("/merge"):
                return {"merged": True, "sha": "d" * 40}
            # update-branch and workflow dispatch are no longer merger operations.
            raise AssertionError((method, path))
        if path == "pulls/11":
            self.pr_reads += 1
            self.on_pr_read(self.pr_reads)
            return deepcopy(self.pr)
        if path == "git/ref/heads/main":
            self.base_reads += 1
            self.on_base_read(self.base_reads)
            return {"object": {"sha": self.base}}
        if path.startswith("compare/"):
            if self.compare_override is not None:
                return deepcopy(self.compare_override)
            commits = deepcopy(self.candidate_commits)
            return {
                "status": "diverged" if self.behind else "ahead",
                "ahead_by": len(commits),
                "behind_by": 1 if self.behind else 0,
                "total_commits": len(commits),
                "merge_base_commit": {"sha": "e" * 40 if self.behind else BASE},
                "commits": commits,
            }
        if path == "commits/" + "d" * 40:
            parents = self.squash_parents or [self.base]
            return {"sha": "d" * 40, "parents": [{"sha": sha} for sha in parents]}
        if path.startswith("actions/workflows/"):
            return deepcopy(self.workflows[path.rsplit("/", 1)[1]])
        raise AssertionError((method, path))

    def pages(self, path, key=None, **query):
        self.calls.append(("PAGES", path))
        if path == "pulls":
            return deepcopy([self.pr] + self.other_prs)
        if path.endswith("/runs"):
            workflow_id = int(path.split("/")[2])
            return deepcopy(self.runs[workflow_id])
        if path.endswith("/jobs"):
            run_id = int(path.split("/")[2])
            return deepcopy(self.jobs[run_id])
        raise AssertionError((path, key, query))


class IdentityTests(unittest.TestCase):
    def test_valid_one_ticket_with_dependency_prose(self):
        self.assertEqual(validate_pr(pull(), REPO, []), "SA-11")

    def test_closed_or_merged_original_blocks_duplicate(self):
        for state in ("open", "closed"):
            original = pull(number=3)
            original["state"] = state
            with self.assertRaisesRegex(PolicyError, "PR #3"):
                validate_pr(pull(), REPO, [original])

    def test_original_remains_canonical_after_later_duplicate(self):
        self.assertEqual(validate_pr(pull(), REPO, [pull(number=15)]), "SA-11")

    def test_previous_claim_detected_when_title_or_branch_was_mistyped(self):
        original = pull(number=3)
        original["title"] = "A legacy title"
        original["head"]["ref"] = "legacy-branch"
        with self.assertRaisesRegex(PolicyError, "PR #3"):
            validate_pr(pull(), REPO, [original])

    def test_title_branch_and_primary_reference_must_match(self):
        variants = [
            ("title", "Fix setup"),
            ("title", "SA-11:    "),
            ("title", "SA-11: Description "),
            ("title", "SA-11: \t"),
            ("title", "SA-11: Depends on SA-12"),
            ("body", "Fixes SA-11\nFixes SA-12\n- [x] a"),
            ("body", "Fixes SA-11 and SA-12\n- [x] a"),
            ("body", "Fixes SA-011\n- [x] a"),
            ("body", "No reference"),
        ]
        for field, value in variants:
            with self.subTest(field=field, value=value):
                pr = pull()
                pr[field] = value
                with self.assertRaises(PolicyError):
                    validate_pr(pr, REPO, [])
        pr = pull()
        pr["head"]["ref"] = "wanghujie/sa-12-different-ticket"
        with self.assertRaises(PolicyError):
            validate_pr(pr, REPO, [])

    def test_linear_provided_prefixed_branch_is_accepted(self):
        pr = pull()
        self.assertEqual(pr["head"]["ref"], LINEAR_BRANCH)
        self.assertEqual(validate_pr(pr, REPO, []), "SA-11")

    def test_missing_malformed_or_wrong_issue_linear_prefix_is_rejected(self):
        for branch in (
            "sa-11-invented-branch",
            "/sa-11-missing-username",
            "wanghujie//sa-11-extra-slash",
            "wanghujie/sa-12-wrong-issue",
            "wanghujie/SA-11-wrong-case",
            "wanghujie/sa-11-",
        ):
            with self.subTest(branch=branch):
                pr = pull()
                pr["head"]["ref"] = branch
                with self.assertRaisesRegex(PolicyError, "exact gitBranchName"):
                    validate_pr(pr, REPO, [])

    def test_only_fixes_is_supported_and_refs_is_rejected(self):
        pr = pull()
        pr["body"] = "Fixes SA-11\n- [x] criterion: evidence"
        self.assertEqual(validate_pr(pr, REPO, []), "SA-11")
        for verb in ("Refs", "refs"):
            pr["body"] = f"{verb} SA-11\n- [x] criterion: evidence"
            with self.assertRaisesRegex(PolicyError, "Refs. is not allowed"):
                validate_pr(pr, REPO, [])

    def test_criteria_checklist_must_exist_and_be_fully_met(self):
        bodies = {
            "none": "Fixes SA-11",
            "unchecked": "Fixes SA-11\n- [x] a: ev\n- [ ] b: pending",
            "only unchecked": "Fixes SA-11\n* [ ] b",
            "empty box": "Fixes SA-11\n- [x] a: ev\n-   []  b",
            "empty item": "Fixes SA-11\n- [x]",
            "plus bullet": "Fixes SA-11\n- [x] a: ev\n+ [ ] b",
            "numbered": "Fixes SA-11\n- [x] a: ev\n1. [ ] b",
            "quoted": "Fixes SA-11\n- [x] a: ev\n> - [ ] b",
            "literal comment opener in code": "Fixes SA-11\n- [x] a: ev\nuse `<!--` here\n- [ ] b",
            "checked only in a fence": "Fixes SA-11\n```\n- [x] a: ev\n```",
            "unedited template": (ROOT / ".github/pull_request_template.md")
            .read_text()
            .replace("SA-<ticket number>", "SA-11"),
        }
        for name, body in bodies.items():
            with self.subTest(name):
                pr = pull()
                pr["body"] = body
                with self.assertRaisesRegex(PolicyError, "checklist"):
                    validate_pr(pr, REPO, [])
        pr = pull()
        pr["body"] = "Fixes SA-11\n* [X] a: ev\n  - [x] nested: ev\n2) [x] n: ev"
        self.assertEqual(validate_pr(pr, REPO, []), "SA-11")
        pr["body"] = (
            "Fixes SA-11\r\n- [x] a: ev\r\n```\r\n- [ ] sample in a fence\r\n```\r\nsee `- [ ]` syntax"
        )
        self.assertEqual(validate_pr(pr, REPO, []), "SA-11")

    def test_hidden_comments_do_not_satisfy_primary_reference(self):
        for body in (
            "<!--\nFixes SA-11\n-->\n- [x] a",
            "<!-- Fixes SA-11 -->\n- [x] a",
            "<!--\nFixes SA-11\n- [x] a",
        ):
            pr = pull()
            pr["body"] = body
            with self.assertRaises(PolicyError):
                validate_pr(pr, REPO, [])

    def test_hidden_template_reference_does_not_add_an_extra_ticket(self):
        pr = pull()
        pr["body"] = "Fixes SA-11\n- [x] a\n<!--\nFixes SA-123\n- [ ] hidden\n-->"
        self.assertEqual(validate_pr(pr, REPO, []), "SA-11")

    def test_forks_untrusted_authors_and_wrong_base_are_refused(self):
        for key, value in (
            ("head_repo", "outsider/fork"),
            ("author", "CONTRIBUTOR"),
            ("base", "release"),
        ):
            api = FakeGitHub()
            if key == "head_repo":
                api.pr["head"]["repo"]["full_name"] = value
            elif key == "author":
                api.pr["author_association"] = value
            else:
                api.pr["base"]["ref"] = value
            with self.assertRaises(PolicyError):
                merge_one(api, 11)
            self.assertEqual(api.writes, [])


class MergeTests(unittest.TestCase):
    def test_ready_rebased_pr_squash_merges_once_with_expected_sha(self):
        api = FakeGitHub()
        result = merge_one(api, 11)
        self.assertEqual(
            (result["action"], result["merge_sha"], result["base"]),
            ("merged", "d" * 40, BASE),
        )
        self.assertEqual(len(api.writes), 1)
        method, path, body = api.writes[0]
        self.assertEqual((method, path), ("PUT", "pulls/11/merge"))
        self.assertEqual(body["sha"], HEAD)
        self.assertEqual(body["merge_method"], "squash")
        self.assertEqual(body["commit_title"], "SA-11: Set up the monorepo (#11)")
        self.assertEqual(body["commit_message"], f"Fixes SA-11\n\nTested head: {HEAD}")
        # The base is the last read before the merge; the squash parent is checked after.
        self.assertEqual(
            api.calls[-3:-1], [("GET", "git/ref/heads/main"), ("PUT", "pulls/11/merge")]
        )
        self.assertEqual(api.calls[-1], ("GET", "commits/" + "d" * 40))

    def test_merge_method_is_squash_only_and_no_branch_refresh_exists(self):
        source = (ROOT / "scripts/automation/auto_merge.py").read_text()
        self.assertEqual(source.count('"merge_method"'), 1)
        self.assertIn('"merge_method": "squash"', source)
        for disallowed in (
            "update-branch",
            "/dispatches",
            '"rebase"',
            '"merge_method": "merge"',
        ):
            self.assertNotIn(disallowed, source)

    def test_fixes_declaration_is_normalized_into_squash_message(self):
        api = FakeGitHub()
        api.pr["body"] = "fixes SA-11\n\n- [x] a: ev\n\nDepends on SA-12."
        merge_one(api, 11)
        self.assertEqual(
            api.writes[-1][2]["commit_message"], f"Fixes SA-11\n\nTested head: {HEAD}"
        )

    def test_failed_cancelled_skipped_neutral_or_missing_final_job_never_merges(self):
        for workflow_id in (1, 2):
            for conclusion in (
                "failure",
                "cancelled",
                "skipped",
                "neutral",
                "timed_out",
                None,
            ):
                with self.subTest(workflow_id=workflow_id, conclusion=conclusion):
                    api = FakeGitHub()
                    api.jobs[workflow_id * 100][0]["conclusion"] = conclusion
                    self.assertEqual(merge_one(api, 11)["action"], "waiting")
                    self.assertEqual(api.writes, [])
            api = FakeGitHub()
            api.jobs[workflow_id * 100] = []
            self.assertEqual(merge_one(api, 11)["action"], "waiting")
            self.assertEqual(api.writes, [])

    def test_missing_incomplete_or_failed_workflow_never_merges(self):
        for change in ("missing", "queued", "failure", "cancelled", "skipped"):
            api = FakeGitHub()
            if change == "missing":
                api.runs[1] = []
            elif change == "queued":
                api.runs[1][0]["status"] = change
            else:
                api.runs[1][0]["conclusion"] = change
            self.assertEqual(merge_one(api, 11)["action"], "waiting")
            self.assertEqual(api.writes, [])

    def test_newest_failed_run_overrides_earlier_success(self):
        api = FakeGitHub()
        newer = deepcopy(api.runs[1][0])
        newer.update(id=101, conclusion="failure")
        api.runs[1].append(newer)
        self.assertEqual(merge_one(api, 11)["action"], "waiting")
        self.assertEqual(api.writes, [])

    def test_latest_attempt_must_pass(self):
        api = FakeGitHub()
        newer_attempt = deepcopy(api.runs[1][0])
        newer_attempt.update(run_attempt=2, conclusion="failure")
        api.runs[1].append(newer_attempt)
        self.assertEqual(merge_one(api, 11)["action"], "waiting")
        self.assertEqual(api.writes, [])

    def test_spoofed_workflow_path_id_event_repo_branch_or_pr_is_ignored(self):
        mutations = [
            ("path", ".github/workflows/fake.yml"),
            ("workflow_id", 999),
            ("event", "push"),
            ("head_branch", "main"),
            ("head_repository", {"full_name": "outsider/fork"}),
            ("head_sha", NEW),
            ("pull_requests", [{"number": 99}]),
        ]
        for key, value in mutations:
            with self.subTest(key=key):
                api = FakeGitHub()
                api.runs[1][0][key] = value
                self.assertEqual(merge_one(api, 11)["action"], "waiting")
                self.assertEqual(api.writes, [])

    def test_disabled_or_renamed_workflow_is_refused(self):
        for key, value in (
            ("state", "disabled_manually"),
            ("name", "Fake CI"),
            ("path", "fake.yml"),
        ):
            api = FakeGitHub()
            api.workflows["checks.yml"][key] = value
            self.assertEqual(merge_one(api, 11)["action"], "waiting")
            self.assertEqual(api.writes, [])

    def test_dispatch_run_can_be_used_after_owner_rebase(self):
        api = FakeGitHub()
        for runs in api.runs.values():
            runs[0].update(event="workflow_dispatch", pull_requests=[])
        self.assertEqual(merge_one(api, 11)["action"], "merged")

    def test_draft_and_stale_trigger_wait_without_writes(self):
        api = FakeGitHub()
        api.pr["draft"] = True
        self.assertEqual(merge_one(api, 11)["action"], "waiting")
        self.assertEqual(api.writes, [])
        api.pr["draft"] = False
        self.assertEqual(merge_one(api, 11, expected_head=NEW)["action"], "waiting")
        self.assertEqual(api.writes, [])

    def test_head_changes_during_validation_waits(self):
        api = FakeGitHub()
        api.on_pr_read = lambda count: (
            api.pr["head"].update(sha=NEW) if count == 2 else None
        )
        self.assertEqual(merge_one(api, 11)["action"], "waiting")
        self.assertEqual(api.writes, [])

    def test_main_changes_during_validation_waits(self):
        api = FakeGitHub()

        def update_base(count):
            if count == 2:
                api.base = NEW

        api.on_base_read = update_base
        self.assertEqual(merge_one(api, 11)["action"], "waiting")
        self.assertEqual(api.writes, [])

    def test_stale_base_waits_for_owner_rebase_without_any_write(self):
        api = FakeGitHub()
        api.behind = True
        result = merge_one(api, 11)
        self.assertEqual(result["action"], "waiting")
        self.assertTrue(result["reason"].startswith("rebase-required"))
        self.assertIn("--force-with-lease", result["reason"])
        self.assertEqual(result["base"], BASE)
        self.assertEqual(api.writes, [])
        self.assertFalse(any("update-branch" in path for _, path in api.calls))

    def test_ancestor_main_with_merge_commit_in_range_is_refused(self):
        # "Merge origin/main into branch" keeps main as merge base but is not a rebase.
        api = FakeGitHub()
        api.candidate_commits[-1]["parents"].append({"sha": "9" * 40})
        result = merge_one(api, 11)
        self.assertEqual(result["action"], "waiting")
        self.assertIn("not linear", result["reason"])
        self.assertEqual(api.writes, [])

    def test_identical_behind_or_inconsistent_compare_is_refused(self):
        def compare(**changes):
            commits = [{"sha": HEAD, "parents": [{"sha": BASE}]}]
            response = {
                "status": "ahead",
                "ahead_by": 1,
                "behind_by": 0,
                "total_commits": 1,
                "merge_base_commit": {"sha": BASE},
                "commits": commits,
            }
            return response | changes

        too_many = MAX_COMPARE_COMMITS + 1
        for override in (
            compare(status="identical", ahead_by=0, total_commits=0, commits=[]),
            compare(status="behind", behind_by=2),
            compare(behind_by=1),
            compare(merge_base_commit={"sha": NEW}),
            compare(total_commits=too_many, ahead_by=too_many),
            compare(ahead_by=2, total_commits=2),
            compare(commits=None),
            compare(commits=[{"sha": NEW, "parents": [{"sha": BASE}]}]),
            compare(commits=[{"sha": HEAD, "parents": []}]),
        ):
            with self.subTest(override=override):
                api = FakeGitHub()
                api.compare_override = override
                self.assertEqual(merge_one(api, 11)["action"], "waiting")
                self.assertEqual(api.writes, [])

    def test_main_moving_in_final_interval_is_reported_after_squash(self):
        api = FakeGitHub()
        api.squash_parents = [NEW]
        with self.assertRaises(MergedOnUntestedBase) as raised:
            merge_one(api, 11)
        self.assertEqual(raised.exception.outcome["parents"], [NEW])
        self.assertEqual(raised.exception.outcome["merge_sha"], "d" * 40)
        self.assertEqual(len(api.writes), 1)

    def test_title_is_data_and_never_executed_by_a_shell(self):
        api = FakeGitHub()
        api.pr["title"] = "SA-11: $(touch /tmp/never) `echo unsafe`"
        with patch("subprocess.run", side_effect=AssertionError("No shell is allowed")):
            self.assertEqual(merge_one(api, 11)["action"], "merged")
        self.assertEqual(api.writes[-1][2]["commit_title"], api.pr["title"] + " (#11)")

    def test_api_read_failure_refuses_without_any_mutation(self):
        api = FakeGitHub()
        with (
            patch.object(api, "pages", side_effect=ApiError("GitHub API unavailable")),
            self.assertRaises(ApiError),
        ):
            merge_one(api, 11)
        self.assertEqual(api.writes, [])

    def test_merge_refusal_is_not_retried(self):
        api = FakeGitHub()
        request = api.request

        def refuse_merge(method, path, body=None):
            if path.endswith("/merge"):
                api.writes.append((method, path, body))
                return {"merged": False}
            return request(method, path, body)

        with (
            patch.object(api, "request", side_effect=refuse_merge),
            self.assertRaisesRegex(PolicyError, "no retry"),
        ):
            merge_one(api, 11)
        self.assertEqual(len(api.writes), 1)

    def test_head_race_after_final_checks_is_rejected_by_expected_sha(self):
        # GitHub returns 409 when the head no longer matches the supplied sha.
        api = FakeGitHub()
        request = api.request

        def head_moved(method, path, body=None):
            if path.endswith("/merge"):
                api.writes.append((method, path, body))
                raise ApiError("GitHub PUT pulls/11/merge: HTTP 409")
            return request(method, path, body)

        with (
            patch.object(api, "request", side_effect=head_moved),
            self.assertRaisesRegex(ApiError, "409"),
        ):
            merge_one(api, 11)
        self.assertEqual(len(api.writes), 1)
        self.assertEqual(api.writes[0][2]["sha"], HEAD)

    def test_event_discovery_refuses_fork_trigger(self):
        api = FakeGitHub()
        event = {"workflow_run": deepcopy(api.runs[1][0])}
        self.assertEqual(candidates(api, event), [11])
        event["workflow_run"]["head_repository"]["full_name"] = "outsider/fork"
        with self.assertRaises(PolicyError):
            candidates(api, event)

    def test_event_sweeps_other_eligible_heads_to_handle_replaced_pending_triggers(
        self,
    ):
        api = FakeGitHub()
        other = pull(number=12, ticket="SA-12")
        other["head"]["sha"] = NEW
        fork = pull(number=13, ticket="SA-13")
        fork["head"]["repo"]["full_name"] = "outsider/fork"
        api.other_prs = [other, fork]
        event = {"workflow_run": deepcopy(api.runs[1][0])}
        self.assertEqual(candidates(api, event), [11, 12])

    def test_privileged_workflow_checks_out_only_main_and_no_artifacts_or_dependencies(
        self,
    ):
        workflow = (ROOT / ".github/workflows/auto-merge.yml").read_text()
        self.assertIn("ref: refs/heads/main", workflow)
        self.assertIn("persist-credentials: false", workflow)
        for disallowed in (
            "download-artifact@",
            "setup-node@",
            "pip install",
            "pnpm install",
            "head.sha",
            "pull_request_target:",
            "actions: write",
        ):
            self.assertNotIn(disallowed, workflow)
        self.assertIn("actions: read", workflow)


class ApiTests(unittest.TestCase):
    def test_missing_token_is_refused(self):
        with self.assertRaises(PolicyError):
            GitHub(REPO, "")

    def test_api_error_does_not_log_a_response_body_or_token(self):
        api = GitHub(REPO, "not-a-real-token")
        error = HTTPError("https://api.github.com/", 403, "private response", {}, None)
        with (
            patch("github_policy.urlopen", side_effect=error),
            self.assertRaises(ApiError) as caught,
        ):
            api.request("GET", "pulls/11")
        self.assertEqual(str(caught.exception), "GitHub GET pulls/11: HTTP 403")

    def test_repository_identity_rejects_path_injection(self):
        for repo in ("owner/repo/path", "../repo", "https://evil.example/repo"):
            with self.assertRaises(PolicyError):
                GitHub(repo, "not-a-real-token")

    def test_pagination_includes_closed_claims_on_later_pages(self):
        api = GitHub(REPO, "not-a-real-token")
        first = [
            pull(number=100 + index, ticket=f"SA-{100 + index}") for index in range(100)
        ]
        second = [pull(number=3)]
        with patch.object(api, "request", side_effect=[first, second]) as request:
            prs = api.pages("pulls", state="all")
        self.assertEqual(len(prs), 101)
        self.assertIn("page=2", request.call_args_list[1].args[1])
        with self.assertRaisesRegex(PolicyError, "PR #3"):
            validate_pr(pull(), REPO, prs)


if __name__ == "__main__":
    unittest.main()
