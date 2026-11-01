# StateAction.ai agent instructions

## Android device profile: mandatory

**Never install, update, launch or test apps in the user's company/work profile.** The user explicitly requires personal-profile-only operations. This applies to all agents, scripts, APKs and test packages, including spike apps. Permission to open the phone or test an app does not override this restriction.

Before a physical-device app mutation, identify profiles with `adb -s "$ANDROID_SERIAL" shell cmd user list -v` and verify the personal full user. On the Pixel checked on 2026-10-31, personal is **user 0** and the managed Work profile is **user 10**. Recheck each session rather than assuming these IDs on another device.

- Install/update only with an explicit verified target: `adb -s "$ANDROID_SERIAL" install --user 0 -r "$APK"`.
- Launch only with `adb -s "$ANDROID_SERIAL" shell am start --user 0 -n "$COMPONENT"`.
- Include the verified personal `--user` for permission grants, force-stop, data clearing and uninstall. Never use unscoped app mutations or `--user all`.
- Verify the exact test package is installed in the personal profile and absent from work/managed profiles. Do not enumerate company accounts or unrelated company apps.
- Never alter work-profile policies/security. If targeting is ambiguous or unsupported, stop and report it.
- The accidental work-profile copy of `ai.stateaction.spike.capture` was removed and its absence verified. Do not reinstall it there.

## Simulation before user testing

Always run and iterate on simulations/emulators and local end-to-end tests before handing a build to the user. Test the actual changed camera/encoder/recording path where the simulator supports it; build/unit/protocol checks alone do not qualify that path. Reproduce and fix accessible failures without asking the user to keep retrying. Ask for physical testing only for a clearly identified hardware-only limitation after local checks pass, and report simulation coverage honestly.

The existing Stera checkout is **our temporary work**, not another engineer's active changes. Use its existing recorder as the starting point rather than rebuilding working app behavior unnecessarily. Preserve our existing work and unrelated edits; use an isolated branch/worktree when appropriate. Standalone test package IDs remain useful to avoid replacing the collector.

Capture on the physical phone requires an intentional user Start action. Raw recordings and captured images stay in ignored local directories, never in Git.

## Linear and pull request traceability

- Canonical private repository: `timothywangdev/stateaction`. Verify the active GitHub account before changing remote settings or publishing. When several CLI accounts/sessions exist, pin each repository mutation to the `timothywangdev` credential; do not print or persist its token.
- Each ticket produces exactly one PR, and each PR has exactly one primary Linear ticket. Before creating a PR, search all existing PRs, including closed/merged ones, for that ticket. Update or reopen the original PR; never create a replacement or catch-all PR. After a PR merges, follow-up work needs a new ticket and its own PR.
- Before creating or naming a ticket branch, fetch that issue from Linear and use its exact `gitBranchName`, including the username prefix. Never invent, shorten or regenerate the branch name from the title. If Linear does not provide a branch name, resolve that missing value before branching. Use a title such as `SA-11: Scaffold platform foundations` and one `Refs SA-11` or `Fixes SA-11` declaration in its body. Other issues may be described as dependencies, not additional implementation references.
- Keep acceptance criteria, actual evidence and remaining gates on the ticket. Use `Fixes` only when all criteria are demonstrated. Keep the same PR in draft while required non-CI checks are outstanding; do not make it ready merely to trigger a merge.
- Every ready PR is merged automatically only after the current head passes the CI `Required checks` and PR policy `Ticket reference` gates. The repository automation rechecks metadata, workflow/job identity, head SHA and current base before merging. Let it merge; never bypass failed/missing checks or use an admin merge.
- Use ticket branches and PRs for all new implementation. Never push directly to `main` or force push/rewrite existing implementation history. GitHub Free private repositories do not provide server-enforced protected branches; the pre-push hook and these instructions are required until a supported plan is explicitly selected.
- Record the actual PR URL on its ticket and verify native GitHub integration separately. A pasted URL/hash is traceability, not proof that the GitHub App is installed.

## Monorepo commands and checks

- Nx coordinates tasks and affected checks; pnpm manages TypeScript dependencies, uv manages Python, and Flutter/pub/Gradle retain native mobile builds. Do not introduce another task orchestrator or a paid remote cache. The mobile and recorder projects use actual Flutter/pub/Gradle targets; mobile-tooling covers their local adapters and profile-safety helper.
- Use the pinned versions and committed lockfiles. Run `pnpm install --frozen-lockfile`, the documented uv sync, `pnpm check` and relevant integration commands. Use `pnpm affected --base=<base> --head=<head>` for affected checks; first setup must also pass a clean full run.
- Install Lefthook with the documented setup (`pnpm hooks:install`). Pre-commit checks validate staged content without auto-staging unrelated edits; pre-push rejects `main`. Do not routinely disable hooks. Fix locally reproducible failures before publishing.
- Cache deterministic builds and isolated checks only. Real uploads, database/workflow integration, device simulations and provider mutations must run and must not replay a cached success. Never cache or commit private recordings, images, credentials or raw worker payloads.
- Report local test results and hosted CI separately. Keep paid deployment, hardware qualification and feature completion distinct from a passing scaffold test.
