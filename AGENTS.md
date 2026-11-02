# StateAction.ai agent instructions

## Cost-effective models and orchestration

- Default to the most cost-effective model capable of completing the task reliably, including subagents and orchestration workers.
- Use cheaper models for easy and medium tasks with well-scoped tickets, clear acceptance criteria and established patterns. For the current Claude workers, default to `sonnet`; use a comparable economical option with other providers. Do not default every worker to a flagship model.
- Reserve stronger models such as `opus` for work requiring deeper reasoning, deeper investigation, difficult design decisions or unresolved ambiguity. Routine implementation, tests, documentation, writing and PR maintenance do not require a top-tier model merely because they are delegated.
- Escalate only when a concrete difficulty warrants it, and briefly record the reason in the task or dispatch. Return well-defined follow-up work to a cheaper model.
- Keep delegation bounded with explicit ownership and validation. Avoid unnecessary agents, duplicate investigation and repeated checks; keep the coordinator context focused on orchestration, synthesis and judgment.

## PR history and merge policy: mandatory

- Rebase each PR onto the latest published `origin/main` before merging.
- Squash all commits in the PR into **one commit on main**. Do not create merge commits or preserve the PR's individual commits with GitHub's rebase-merge option.
- After a rebase, require review and a fresh local full-suite PASS receipt on the exact new head tree. Merge ready PRs; do not leave reviewed, tested work in draft. Keep remaining device, provider and deployment qualifications explicit on the ticket.
- When an owned PR branch needs a rewritten push, preserve its previous head and use `--force-with-lease` with the exact expected remote head. Never force-push or rewrite main, already merged history or another worker's branch.
- Automated merging must enforce squash merging and wait for the branch owner to rebase stale PRs; it must not refresh them with a merge commit.

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

## Accelerated emulator defaults: mandatory

Use [`scripts/start_capture_emulator.sh`](scripts/start_capture_emulator.sh) for every emulator task; do not hand-start `emulator`. On this Linux x86_64 workstation the default is KVM (`-accel on`), an x86_64 guest and host GPU rendering (`-gpu host`, the RTX 3090). Software rendering is never a silent default or fallback.

- ARCore work uses `--ar`: the pinned API33 x86_64 AVD `stera_ar_api33` (`emulator-5582`) with emulator 36.4.10 and Vulkan off. Do not reset or reinstall the AVD, update the global SDK, or replace the pinned emulator for speed. Keep the separate API35 `stera_ar_api35` (`emulator-5580`) for ordinary tests.
- Reuse one warm dedicated emulator. The launcher reuses a running instance only after verification: a `/dev/kvm` descriptor open in the qemu process, `-accel on -gpu host`, and a guest renderer (`dumpsys SurfaceFlinger` GLES line) naming the host NVIDIA GPU with no SwiftShader, llvmpipe or lavapipe. A running instance that fails is not reused; `--replace` restarts only the dedicated emulator. `nvidia-smi` alone is not proof.
- Camera, lifecycle and recovery tests keep the default cold boot (`-no-snapshot`). `--quick-boot` is opt-in for ordinary app tests only. Default warm reuse is fine for routine loops; for a cold-start case (camera, lifecycle, recovery) pass explicit `--force-cold-start`, which stops and restarts even a healthy warm dedicated instance (and overrides `--quick-boot`).
- Display: honor a caller-provided `DISPLAY`/`XAUTHORITY`; otherwise the launcher discovers a working same-user display using `xdpyinfo` and fails closed with instructions. Never `xhost +`, change display-server or desktop policy, read or print authority cookies, or hardcode an authority file name.
- `--software` (or `CAPTURE_EMULATOR_PROFILE=software`) is the explicit CI/compatibility override. Its output and evidence carry the label `software-rendering-not-accelerated` and must never be cited as accelerated evidence. Earlier software-rendered results stay valid but labeled as such.
- Report acceleration as rendering only: the guest video encoder stays software, and emulator results are never physical-device qualification. Make no speedup claim without comparable timings of the same task.
- Run expensive emulator, Flutter and Gradle work under `flock /tmp/stateaction-mobile-validation.lock`, use incremental builds, and do not weaken recorder assertions for speed. Verification evidence is written to the ignored `artifacts/emulator-verification/`.

## Local CI gate: mandatory

The user replaced mandatory hosted GitHub Actions with a full local gate ([docs/local-ci.md](docs/local-ci.md)). Hosted workflows stay manual and optional; do not change account billing or privileges.

- Install the hook per worktree with `pnpm hooks:install-local` (worktree-scoped `core.hooksPath`; shared hooks and shared hook config are never edited). Every normal commit then runs the whole declared suite from an export of the staged tree, serially, with only deterministic build/typecheck/unit/format tasks allowed to use valid Nx/Gradle cache hits (every DB/auth/upload/E2E/smoke stage runs uncached on fresh fixtures), inside the `agent-resource` budget, and refuses partial staging. Do not use `--no-verify`.
- `pnpm ci:local` runs the same suite on a clean checked-out head and records a machine-readable receipt outside Git. Only a run in which every declared stage passed, on an unchanged tree, counts. Failure, interruption, a stale tree/stage list/runner or an unrelated base never counts.
- Fail closed: no verified `agent-resource` cgroup (6 GiB per job, no swap, one heavy job) means no run. Never start Docker, an emulator or a paid service from the gate; fixture-backed stages use the bounded external fixtures named in `STATEACTION_LOCAL_FIXTURES`.
- Physical-device, company-profile, iOS hardware and hosted-provider qualification are listed in the receipt as unautomated; they are never reported as passed.

## Linear and pull request traceability

- Canonical private repository: `timothywangdev/stateaction`. Verify the active GitHub account before changing remote settings or publishing. When several CLI accounts/sessions exist, pin each repository mutation to the `timothywangdev` credential; do not print or persist its token.
- Each ticket produces exactly one PR, and each PR has exactly one primary Linear ticket. Before creating a PR, search all existing PRs, including closed/merged ones, for that ticket. Update or reopen the original PR; never create a replacement or catch-all PR. After a PR merges, follow-up work needs a new ticket and its own PR.
- Before creating or naming a ticket branch, fetch that issue from Linear and use its exact `gitBranchName`, including the username prefix. Never invent, shorten or regenerate the branch name from the title. If Linear does not provide a branch name, resolve that missing value before branching. Use a title such as `SA-11: Scaffold platform foundations` and one `Refs SA-11` or `Fixes SA-11` declaration in its body. Other issues may be described as dependencies, not additional implementation references.
- Keep acceptance criteria, actual evidence and remaining gates on the ticket. Use `Fixes` only when all criteria are demonstrated. Keep unfinished code or unresolved review/test failures in draft; do not make a PR ready merely to trigger a merge. Track remaining device, provider and deployment qualification on the ticket rather than holding reviewed, tested isolated code in draft.
- Every ready PR is squash merged only after its current head is a single commit directly above the latest fetched `origin/main` (no merge commits) and carries a valid local full-suite PASS receipt plus the ticket policy. Merge with `pnpm ci:merge --pr <n> --execute` (see the local CI gate below); it uses GitHub's squash merge with `--match-head-commit`, never pushes `main` and never fakes a hosted status. Hosted `CI` / `PR policy` workflows are manual and optional because hosted billing must not block merging. Never bypass a failed or missing local receipt or use an admin merge.
- Use ticket branches and PRs for all new implementation. Never push directly to `main`, force push `main`, or rewrite merged history; rewritten pushes are limited to your own PR branch with an exact `--force-with-lease` as described above. GitHub Free private repositories do not provide server-enforced protected branches; the pre-push hook and these instructions are required until a supported plan is explicitly selected.
- Record the actual PR URL on its ticket and verify native GitHub integration separately. A pasted URL/hash is traceability, not proof that the GitHub App is installed.

## Monorepo commands and checks

- Nx coordinates tasks and affected checks; pnpm manages TypeScript dependencies, uv manages Python, and Flutter/pub/Gradle retain native mobile builds. Do not introduce another task orchestrator or a paid remote cache. The mobile and recorder projects use actual Flutter/pub/Gradle targets; mobile-tooling covers their local adapters and profile-safety helper.
- Use the pinned versions and committed lockfiles. Run `pnpm install --frozen-lockfile`, the documented uv sync, `pnpm check` and relevant integration commands. Use `pnpm affected --base=<base> --head=<head>` for affected checks; first setup must also pass a clean full run.
- Install Lefthook with the documented setup (`pnpm hooks:install`). Pre-commit checks validate staged content without auto-staging unrelated edits; pre-push rejects `main`. Do not routinely disable hooks. Fix locally reproducible failures before publishing.
- Cache deterministic builds and isolated checks only. Real uploads, database/workflow integration, device simulations and provider mutations must run and must not replay a cached success. Never cache or commit private recordings, images, credentials or raw worker payloads.
- Report local test results and hosted CI separately. Keep paid deployment, hardware qualification and feature completion distinct from a passing scaffold test.
