# Ticket PR automation

Each ticket owns one PR, including after that PR is closed. Fetch the issue in Linear and use its **exact `gitBranchName`**, including the username prefix; never invent or shorten it. SA-11's provided name is `wanghujie/sa-11-scaffold-the-typescript-and-python-packages-with-repeatable`. Use title `SA-11: Short description` and exactly one body line `Refs SA-11` or `Fixes SA-11`. `Refs` links work in progress; use `Fixes` when merging completes every acceptance criterion. Other ticket IDs belong in dependency prose. A mistaken PR should be corrected or reopened, rather than replaced.

`PR policy / Ticket reference` checks the live PR metadata and searches all PRs, including closed and merged PRs, for an earlier claim. The lowest-number original remains canonical. It checks a username-prefixed branch with the matching issue ID. With no Linear API secret, it cannot verify the exact `gitBranchName`, issue existence or acceptance criteria. Agents must fetch and verify those in Linear before creating a branch or publishing.

`Merge passing ticket PRs` runs trusted scripts from `main` after either `CI` or `PR policy` completes. It serially sweeps eligible open PRs, because GitHub concurrency can replace a pending invocation. Each PR must have a trusted author, a branch in this repository, a `main` target, and successful latest `CI / Required checks` and `PR policy / Ticket reference` jobs for its exact current head. Missing, failed, cancelled, skipped, stale, or incomplete checks wait. Drafts wait.

Every PR lands as **one squash commit on `main`** (`merge_method=squash`, title `SA-n: Title (#PR)`, message `Refs|Fixes SA-n` plus the tested head SHA). The repository settings also allow only squash merging. The merger requires the tested head to be a strict linear descendant of the current `main`: the compare API must report `ahead`, zero `behind`, `main` as merge base, a complete list of at most 250 commits ending at the head, and no merge commits. Otherwise it reports `waiting` with `rebase-required` and makes **no write**: it never calls GitHub's branch-update API, never creates a merge commit on the PR branch and never dispatches workflows. Immediately before merging, it rechecks the live PR, both workflows and, last, `main`; the merge API receives the expected head SHA, so a concurrent push is refused. After merging it verifies that the squash commit's only parent is the tested `main`; if `main` moved in the final unguarded interval it fails loudly without retrying. Already merged history keeps its original merge commits and is never rewritten. No untrusted code, downloaded artifacts, dependency installation, or caches run with the merger's write token.

### Refreshing a stale PR (branch owner)

Only the PR's owner rebases, locally, and only their own branch:

```sh
BRANCH=wanghujie/sa-11-example          # your own PR branch, from Linear
git fetch origin main "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
OLD_HEAD="$(git rev-parse "origin/$BRANCH")"     # the published PR head, not local HEAD
git merge-base --is-ancestor "$OLD_HEAD" HEAD    # stop if the remote has commits you lack
git branch "backup/${BRANCH##*/}-${OLD_HEAD:0:12}" "$OLD_HEAD"
git rebase origin/main                           # resolve conflicts; optionally squash
git push --force-with-lease="refs/heads/$BRANCH:$OLD_HEAD" origin "HEAD:refs/heads/$BRANCH"
```

The ancestry check proves the rewrite does not drop another pushed commit, the local backup keeps the previous head, and the exact lease refuses the push if the branch changed meanwhile. Record `OLD_HEAD` in the ticket evidence. The new head needs fresh `CI` and `PR policy` runs (the push triggers them) and review of the rebased result before it is ready. Never force-push `main`, merged history or another worker's branch; privileged automation never rebases or force-pushes.

This uses the default `GITHUB_TOKEN`; no paid app or personal access token secret is required. On GitHub Free private repositories, this is repository automation, **not server-enforced branch protection**. An administrator can still push or merge manually, change metadata to erase a prior ticket claim, or race an external update to `main` in the final API interval. The no-direct-push hook and `AGENTS.md` rules cover authorized development; supported branch protection is the upgrade path if stronger enforcement becomes necessary. Only trusted repository collaborators' PRs are automatically merged. Workflow changes therefore remain trusted code changes.

## Local checks

```sh
python3 -m unittest discover -s tests/automation -p 'test_*.py' -v
```

A PR that introduces or changes the merger cannot be merged by the old default-branch copy (for example, the squash policy replacing the earlier merge-commit merger). After that PR's hosted CI and policy checks succeed and it is reviewed, a maintainer runs the **PR's reviewed guard** locally, using the `timothywangdev` GitHub CLI credential. Other accounts may be active in this workspace, so pin every `gh` command to that user and `--repo timothywangdev/stateaction`. This is a bootstrap of the same guard, not a check bypass; the workflow itself contains no bootstrap path:

```sh
export GITHUB_REPOSITORY=timothywangdev/stateaction
GH_TOKEN="$(gh auth token --user timothywangdev)" python3 scripts/automation/auto_merge.py --pr 1
```

Replace `1` with the actual canonical PR number. Do not print or persist the token. A refused or waiting result must be resolved; do not substitute an admin merge. To retry later, dispatch `auto-merge.yml` from `main` with input `pr_number`.

If a rebased head has no workflow runs (for example, after a missed push event), retrying the merger alone waits. After verifying the rebased head, explicitly dispatch **both checks on that branch**, then retry the merger after they succeed:

```sh
export GH_TOKEN="$(gh auth token --user timothywangdev)"   # in memory only; unset afterwards
PR_NUMBER=1
PR_BRANCH="$(gh pr view "$PR_NUMBER" --repo timothywangdev/stateaction --json headRefName --jq .headRefName)"
gh workflow run checks.yml --repo timothywangdev/stateaction --ref "$PR_BRANCH" -f "pr_number=$PR_NUMBER"
gh workflow run pr-policy.yml --repo timothywangdev/stateaction --ref "$PR_BRANCH" -f "pr_number=$PR_NUMBER"
```

After both succeed, `gh workflow run auto-merge.yml --repo timothywangdev/stateaction --ref main -f "pr_number=$PR_NUMBER"` rechecks the guard. API failures and external base changes also fail closed; investigate before retrying.

## Primary references

- [GitHub: events caused by GITHUB_TOKEN and explicit dispatch](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)
- [GitHub: workflow_run trust and default-branch requirements](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run)
- [GitHub: workflow run API](https://docs.github.com/en/rest/actions/workflow-runs)
- [GitHub: expected-head update and merge APIs](https://docs.github.com/en/rest/pulls/pulls)
- [Linear: GitHub linking and magic words](https://linear.app/docs/github)
