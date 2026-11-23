# Runbook: rewrite the personal author email before going public

Status: NOT executed and cancelled by the owner (published as is, personal author email accepted). Kept as documentation of a dry-run-verified plan. The real rewrite happens
only after every agent and worktree is quiescent and the owner says go. Agents
must never rewrite or force-push `main` (AGENTS.md); the owner runs steps 4 to 6.

## What changes

One mailmap rule (`history-mailmap.txt`): author/committer/tagger
`timothywangdev@gmail.com` becomes `5894018+timothywangdev@users.noreply.github.com`,
name `Timothy Wang` unchanged. The third-party author (`ekakshjanweja`) and
`github-actions[bot]` are untouched. Trees and file content do not change.

## Dry run result (2026-11-23, remote refs of `StateAction-ai/stateaction`)

Run `scripts/release/history-rewrite-dry-run.sh <mirror> <workdir>` on a throwaway
`git clone --mirror` plus `git fetch origin '+refs/pull/*:refs/pull/*'`.
Result: `DRY_RUN_PASS`.

- 293 commits compared old to new through filter-repo's commit map: 293 identical trees, 0 mismatches.
- Objects containing the old address after the rewrite: 0. Remaining identities: Timothy Wang noreply (196 own plus 92 GitHub-committed), `ekakshjanweja` (1), `github-actions[bot]` (4).
- Impact: all 119 refs get new tips (21 branches, 1 tag, 97 `refs/pull/*/head`) because every descendant commit hash changes (292 of 293 commits). Only the root commit keeps its hash.
- Signatures: 291 of 293 commits carry a GitHub or other signature; all signatures are dropped by the rewrite, so no commit shows "Verified" afterwards. This cannot be avoided with a history rewrite.
- Open PRs, `ci:land` receipts keyed to commit SHAs, local clones, worktrees and the `deploy/*` tag history all refer to old hashes.

## Hard limit: GitHub pull refs

`refs/pull/*` are hidden refs. Pushing to them is refused, so a mirror push leaves
the 97 old PR head commits, including the old address on the personal-email
commits, reachable on GitHub even after the branches are rewritten. Choose one:

A. Create a NEW repository (for example `StateAction-ai/stateaction`
renamed first, or a fresh name), push only branches and tags from the rewritten
mirror, and make that one public. History is clean; issues, PR conversations,
stars and Actions secrets/environments must be recreated or are lost.
B. Rewrite in place, then ask GitHub Support to purge the old PR refs and cached
views (sensitive-data removal request). Slow and not under our control until done.
C. Accept that the address stays reachable through the old PR refs.

Recommendation: A. Decision belongs to the owner; the rest of this runbook
works for A and B.

## Real run (owner only)

1. Quiesce: every agent stopped, no in-flight `ci:land`, all PR branches that
   must survive are merged or listed. Record `git ls-remote origin` as the backup index.
2. Fresh bare backup: `git clone --mirror <repo> backup.git; git -C backup.git fetch origin '+refs/pull/*:refs/pull/*'`, keep it offline.
3. Fresh mirror for the rewrite: `git clone --mirror <repo> rewrite.git`, then in it
   `uvx git-filter-repo --mailmap scripts/release/history-mailmap.txt --force`.
4. Verify in `rewrite.git`: no object contains the old address, every commit tree equals
   its old tree via `filter-repo/commit-map` (the dry-run script does this check).
5. Temporarily allow the owner to force push (branch ruleset/bypass), then push:
   `git push --force --mirror <target>` for option B (branches and tags only succeed;
   `refs/pull/*` is rejected), or a plain push to the new repository for option A.
6. Re-enable the ruleset. Contributors and agents: delete old clones and worktrees,
   re-clone, re-create any open branch with `git rebase --onto` or cherry-pick.
   Re-run `pnpm ci:local` on the new `main`; old receipts are void.
7. Only then run the visibility command in `docs/open-source-release.md`.
