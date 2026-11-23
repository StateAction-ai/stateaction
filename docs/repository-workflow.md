# Repository workflow

Repository: [timothywangdev/stateaction](https://github.com/timothywangdev/stateaction), private. Tracker: [StateAction.ai in Linear](https://linear.app/hw-personal-projects/project/stateactionai-collection-and-review-mvp-392311683a3e).

## Tooling decision

Use **Nx over pnpm, uv and Flutter/pub**, with **Lefthook** for staged checks. Nx provides an affected task graph and local caching across native commands, without requiring Nx Cloud. This meets the requirement for one cross-language workflow as the mobile, backend and processing packages grow. Turborepo also provides task caching; Nx's explicit multi-language project configuration is the selected fit here. This is a project decision, not a universal ranking. [Nx multi-language support](https://nx.dev/docs/features/multi-language-support), [Turborepo caching](https://turborepo.dev/docs/crafting-your-repository/caching), [Lefthook](https://lefthook.dev/).

Keep dependency resolution in the existing package managers. Cache deterministic builds/checks with declared toolchain, manifests, lockfiles and outputs. Real database/storage/workflow/device tests remain uncached. The graph includes the Node/Python packages, imported Flutter app/native recorder and their tooling. Mobile source/build provenance is in [the import record](../third_party/stera-app/IMPORT.md); [mobile setup](../scripts/mobile/README.md) runs the actual Flutter/pub/Gradle targets. Android checks are conditional on the affected graph and required when selected.

## One ticket, one PR

Fetch the ticket from Linear and use its exact `gitBranchName`, including the username prefix; never invent or shorten it. For SA-11 this is `wanghujie/sa-11-scaffold-the-typescript-and-python-packages-with-repeatable`. Use title `SA-11: Establish the monorepo workflow` and exactly one `Fixes SA-11` declaration (never `Refs`; merge only when every acceptance criterion is demonstrated, as a checklist in the PR body). Search every PR state before creating one; continue the original PR for that issue. Keep unfinished work in draft; an unmet criterion blocks the merge. Record its URL and evidence on the ticket. After merge, new work (not unfinished acceptance) requires a new ticket (with the user's say-so) and PR.

Agents verify the exact branch value in Linear. Hosted GitHub Actions are manual and optional; the required gate is the full local CI ([local-ci.md](local-ci.md)): rebase onto the latest `origin/main` first (single commit directly above it), then `pnpm ci:local` on that final head writes a receipt bound to that tree; if `origin/main` moves, rebase and rerun. The ticket-reference policy (branch ticket identifier, title, one primary reference, no additional PR for a previously used ticket) is applied locally by `pnpm ci:merge`. A later duplicate must not invalidate the original canonical PR.

## Merge and plan limit

The current GitHub plan rejects protected branches and native auto-merge for private repositories (verified HTTP 403). Keep the repository private. The PR owner lands a ready PR with one `ci` ticket, `agent-resource run --lane ci --key land-<pr>-<head> -- pnpm ci:land --pr <n>` (rebase if main moved, gate, merge; see [local-ci.md](local-ci.md)); `pnpm ci:merge --pr <n> --execute` is the manual path: it verifies the local receipt and ticket policy, then uses GitHub's squash merge with `--match-head-commit`. It never pushes `main` and never fakes a hosted status. Details: [local-ci.md](local-ci.md); the hosted merger in [automation](../scripts/automation/README.md) is optional and manual.

Each PR is rebased by its owner onto current `main` and lands as one squash commit with no merge commits; the merge path never refreshes a stale branch itself. After a rebase, the owner pushes with an exact `--force-with-lease` and the new head needs a fresh local receipt and review.

This plan cannot prevent a person from bypassing the workflow with a direct push. The pre-push hook and `AGENTS.md` forbid that path. Server-enforced protection requires a supported GitHub plan; no upgrade or visibility change is authorized by this setup. [GitHub protected-branch availability](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).

## Codex and Linear

Codex reads repository `AGENTS.md` instructions, with applicable files closer to the working directory adding more specific rules. Agent instructions guide behavior; hooks and CI implement the automated checks. [Official Codex documentation](https://learn.chatgpt.com/docs/agent-configuration/agents-md).

The GitHub repository link in Linear is separate from its native GitHub App integration. Install that integration for this repository and verify an actual PR appears on the ticket; a manual resource URL does not prove native status automation. [Linear GitHub integration](https://linear.app/docs/github).
