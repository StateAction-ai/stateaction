# Repository workflow

Repository: [timothywangdev/stateaction](https://github.com/timothywangdev/stateaction), private. Tracker: [StateAction.ai in Linear](https://linear.app/hw-personal-projects/project/stateactionai-collection-and-review-mvp-392311683a3e).

## Tooling decision

Use **Nx over pnpm, uv and Flutter/pub**, with **Lefthook** for staged checks. Nx provides an affected task graph and local caching across native commands, without requiring Nx Cloud. This meets the requirement for one cross-language workflow as the mobile, backend and processing packages grow. Turborepo also provides task caching; Nx's explicit multi-language project configuration is the selected fit here. This is a project decision, not a universal ranking. [Nx multi-language support](https://nx.dev/docs/features/multi-language-support), [Turborepo caching](https://turborepo.dev/docs/crafting-your-repository/caching), [Lefthook](https://lefthook.dev/).

Keep dependency resolution in the existing package managers. Cache deterministic builds/checks with declared toolchain, manifests, lockfiles and outputs. Real database/storage/workflow/device tests remain uncached. The graph includes the Node/Python packages, imported Flutter app/native recorder and their tooling. Mobile source/build provenance is in [the import record](../third_party/stera-app/IMPORT.md); [mobile setup](../scripts/mobile/README.md) runs the actual Flutter/pub/Gradle targets. Android CI is conditional on the affected graph and required when selected.

## One ticket, one PR

Fetch the ticket from Linear and use its exact `gitBranchName`, including the username prefix; never invent or shorten it. For SA-11 this is `wanghujie/sa-11-scaffold-the-typescript-and-python-packages-with-repeatable`. Use title `SA-11: Establish the monorepo workflow` and exactly one `Refs SA-11` declaration (`Fixes` only when all acceptance criteria are met). Search every PR state before creating one; continue the original PR for that issue. Keep unfinished work in draft; track outstanding device/provider qualification on the ticket. Record its URL and evidence on the ticket. After merge, new work requires a new ticket and PR.

Agents verify the exact branch value in Linear; CI validates the branch ticket identifier, title and primary reference, and rejects an additional PR for a previously used ticket. A later duplicate must not invalidate the original canonical PR. CI includes affected build/type/test/format checks and a stable final `Required checks` gate that fails if a required job fails, cancels or is missing.

## Automatic merge and plan limit

The current GitHub plan rejects protected branches and native auto-merge for private repositories (verified HTTP 403). Keep the repository private and use the free Actions merger. It executes trusted default-branch code, reads the latest PR metadata and actual workflow runs/jobs, and merges only a non-draft same-repository PR with successful current-head `Required checks` and `Ticket reference` gates. It never checks out or runs a PR artifact with its write token.

Each PR is rebased by its owner onto current `main` and lands as one squash commit. The tested head must be a merge-commit-free descendant of current `main`; otherwise automation waits with `rebase-required` and never refreshes the branch itself. After a rebase, the owner pushes with an exact `--force-with-lease` and the new head needs fresh CI, policy checks and review. Merging supplies the expected head SHA; merge operations are serialized and the squash parent is verified afterwards. A PR changing the merger is bootstrapped by running its reviewed guard after hosted checks pass. See [automation](../scripts/automation/README.md).

This plan cannot prevent a person from bypassing the workflow with a direct push. The pre-push hook and `AGENTS.md` forbid that path. Server-enforced protection requires a supported GitHub plan; no upgrade or visibility change is authorized by this setup. [GitHub protected-branch availability](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches), [workflow dispatch behavior](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).

## Codex and Linear

Codex reads repository `AGENTS.md` instructions, with applicable files closer to the working directory adding more specific rules. Agent instructions guide behavior; hooks and CI implement the automated checks. [Official Codex documentation](https://learn.chatgpt.com/docs/agent-configuration/agents-md).

The GitHub repository link in Linear is separate from its native GitHub App integration. Install that integration for this repository and verify an actual PR appears on the ticket; a manual resource URL does not prove native status automation. [Linear GitHub integration](https://linear.app/docs/github).
