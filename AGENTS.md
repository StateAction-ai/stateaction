# StateAction.ai agent instructions

Android capture/upload, backend processing and web review of robot recordings for researchers.
Private repo `timothywangdev/stateaction`. Nx monorepo: pnpm (TypeScript), uv (Python), Flutter/pub/Gradle (mobile).
Read the linked doc before working in its area.

## Current scope ([full text](docs/delivery-scope.md))

- A recording of up to about two hours yields action segments, a caption per segment and hand pose, reviewed in the web UI (Rerun for hand pose).
- Keep it simple. Geometry/depth/mesh and iOS stay deferred.
- Segmentation and captioning start with NVIDIA FLORA (non-commercial licence, proof only). Keep it behind a replaceable interface.
- Record model name, revision, weights hash, prompt, decoding parameters and GPU type with every segment and caption.
- Never cut hour-scale input into independent short chunks that split segments. Use a downscaled proxy only after it is shown equivalent.
- Preserve raw source and frame/timestamp identity. Keep truthful no-hand/failed results: store failed model windows and captions as failed, never empty.
- Never fabricate detections or silently weaken thresholds.
- Stay deployable on Render. Create no paid resource (GPU compute, model downloads to paid storage) without authorization and a recorded spend cap.

## Commands

- Setup: `pnpm install --frozen-lockfile` and the documented uv sync. Hook and gate details: see [local-ci.md](docs/local-ci.md).
- Check: `pnpm check`. Affected only: `pnpm affected --base=<base> --head=<head>`.
- Full gate: `pnpm ci:local`. Receipt: `pnpm ci:verify`. Land (rebase, gate, merge in one ticket): `pnpm ci:land --pr <n>`; manual merge: `pnpm ci:merge --pr <n> --execute`.
- Every local command goes through `agent-resource run [--lane ci|android-build|emulator] -- <command>`. Edits, git, lint, typecheck, targeted tests, servers and reviews are Free (no `--lane`): no slot, no wait, a capped scope each (`--mem` lowers it).
- Gates, Flutter/Gradle builds and emulator sessions take their lane: `ci` and `android-build` one ticket per repository, `emulator` one machine-wide. FIFO via the pinned `agentqueue`; a ticket outlives a killed agent and Ctrl-C only detaches. Lanes never nest; work inside a ticket runs under it. Other projects' roots are never queued. Details: [workstation-resource-guard.md](docs/components/workstation-resource-guard.md).
- Emulator: `bash scripts/supervise_capture_emulator.sh` in a persistent terminal, not under `agent-resource run`.
- Verify the warm emulator: `agent-resource run -- bash scripts/start_capture_emulator.sh --ar --verify-only`.
- Physical phone: `python3 scripts/android_personal_device.py --serial S --user <verified personal id> ...`.

## Hard safety rules

- NEVER install, update, launch or test any app, APK, test package or spike in the user's company/work profile. Permission to use the phone does not override this.
- Never reinstall `ai.stateaction.spike.capture` in the work profile.
- Before any physical-device mutation run `adb -s "$ANDROID_SERIAL" shell cmd user list -v` and verify the personal full user (user 0, work user 10 on 2026-10-31; recheck every session).
- Every install, launch, grant, force-stop, data clear and uninstall passes that explicit `--user`. Never unscoped, never `--user all`.
- Never alter work-profile policy or enumerate company accounts/apps. If targeting is ambiguous, stop and report.
- Exactly one Android emulator across all projects, AVDs, ports and agents. Use the guarded launcher only.
- Never run `emulator.agent-vendor` directly, bypass the machine-wide lock, reset the AVD, update the global SDK, replace the pinned emulator or run `xhost +`.
- If the `agent-resource` guard is missing or refuses admission, stop. No unbounded retry.
- Zero swap, 6 GiB per lane or Free job, 1 GiB per service, host RAM under 80% (the aggregate cap is dynamic and at most 24 GiB; numbers in the guard doc). Lane jobs need the 20% reserve plus 8 GiB available; the watchdog stops our workloads below the reserve. Never nest lanes or add ad hoc lock files.
- Gradle: pinned JDK21, heap at most 2 GiB, two workers, no persistent daemons. Clean leftover processes after tests.
- Emulator rendering is KVM plus host GPU. Software rendering is never a silent default. Label it `software-rendering-not-accelerated`; never cite it as accelerated evidence.
- Emulator results are never physical-device qualification.
- Before handing a build to the user, run simulations and local end-to-end tests, including the changed camera/encoder/recording path where the simulator supports it.
- Ask for physical testing only for a named hardware-only limit. Physical capture needs an intentional user Start.
- Raw recordings, captured images, credentials and raw worker payloads stay out of Git and out of caches. Never print or persist credentials.
- Never push to, force-push or rewrite `main` or merged history, or touch another worker's branch.
- Never use `--no-verify` or an admin merge. Never merge without a valid local receipt.
- Pin repository mutations to the `timothywangdev` GitHub account. Do not change billing or account privileges.
- Cache only deterministic builds and isolated checks. Uploads, DB/workflow integration, device simulations and provider mutations run uncached.

## Workflow

- One ticket, one PR, one primary Linear ticket. Search all PRs (including closed/merged) first and update the original. Follow-up work gets a new ticket and PR.
- Branch name is the exact `gitBranchName` fetched from Linear. Never invent or shorten it.
- PR title `SA-n: <Linear title>`. Body has one `Refs SA-n`; use `Fixes` only when all acceptance criteria are demonstrated.
- Rebase onto the latest `origin/main`, squash to one commit, no merge commits. A rebase that changes no patch (same patch-id, no conflict) keeps the earlier review valid (the gate still reruns on the new head); any other rebase needs a fresh review (`ci:land` refuses with `needs_review`).
- Rewriting an owned PR branch: keep the old head, push with `--force-with-lease=<branch>:<exact remote head>`.
- Local CI ([local-ci.md](docs/local-ci.md)): rebase onto the latest origin/main first (single commit directly above it); each PR must then pass the full local CI (`pnpm ci:local` on that final head) before merge; if origin/main moves, rebase and rerun.
- Install the hook per worktree with `pnpm hooks:install-local`; a normal commit runs only the fast staged-content checks, not the whole suite. Never use `--no-verify`.
- `pnpm ci:local` is the single required full-suite pass per ticket. `pnpm ci:local`, `ci:merge --execute` and `ci:land` enter the `ci` lane themselves (or run inside the lane ticket you wrapped them in, e.g. the `ci:land` form below); they queue FIFO behind other gates (no polling, no second gate). `ci:merge` also takes the merge lock and checks the merged tree.
- Only a full PASS on an unchanged tree counts. Never start a second run on the same tree.
- The gate fails closed without the verified cgroup (6 GiB per job, no swap, one ticket per lane) and never starts Docker, an emulator or a paid service.
- Each implementer lands its own ready PR with one ticket: `agent-resource run --lane ci --key land-<pr>-<head> -- pnpm ci:land --pr N` (own `wanghujie/sa-<n>-*` branch only; rebases if main moved, gates, merges; result JSON via `agent-resource find --key K`). After any non-zero exit read `reason` and fix; resubmit with a new key suffix (`-r2`); codes 3 and 11: stop and report. Exit codes and rules: [local-ci.md](docs/local-ci.md). No separate CI runner. Keep unfinished or failing work in draft.
- Do not hold reviewed, tested work in draft for device/provider/deploy qualification. Record criteria, evidence, remaining gates and the PR URL on the ticket.
- Report local results and hosted CI separately. Physical-device, company-profile, iOS-hardware and hosted-provider qualification are never reported as passed.
- A scaffold pass is not feature completion.
- Workers default to `sonnet`. Use `opus` only for deep reasoning, with the reason recorded. Keep delegation bounded.

## Where details live

- Scope: [delivery-scope.md](docs/delivery-scope.md).
- Local gate and receipts: [local-ci.md](docs/local-ci.md).
- PR, merge and Linear rules: [pr-and-linear.md](docs/agent-rules/pr-and-linear.md).
- Commands and caching: [monorepo-commands.md](docs/agent-rules/monorepo-commands.md).
- Android profile: [android-device-profile.md](docs/agent-rules/android-device-profile.md); helper: [ANDROID_PERSONAL_DEVICE.md](scripts/ANDROID_PERSONAL_DEVICE.md).
- Emulator and simulation: [emulator-and-simulation.md](docs/agent-rules/emulator-and-simulation.md), [linux-recording-test-loop.md](docs/linux-recording-test-loop.md).
- Resource guard numbers: [workstation-resource-guard.md](docs/components/workstation-resource-guard.md).
- Models and orchestration: [models-and-orchestration.md](docs/agent-rules/models-and-orchestration.md).
- Repository workflow overview: [repository-workflow.md](docs/repository-workflow.md).
- Mobile app conventions: [apps/mobile/CLAUDE.md](apps/mobile/CLAUDE.md).
