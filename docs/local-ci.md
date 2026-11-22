# Local CI gate

Hosted GitHub Actions are optional and manual. The required gate is a full local run, bound to the exact Git tree, executed inside the machine-wide `agent-resource` budget.

## Commands

| Command                                           | Purpose                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------- |
| `pnpm hooks:install-local`                        | Install the pre-commit and pre-push hooks for this worktree only.         |
| `python3 scripts/local-ci/install.py --uninstall` | Remove this worktree's hook path.                                         |
| `pnpm ci:local`                                   | The single required whole-suite pass, on the final head after the rebase. |
| `pnpm ci:verify`                                  | Validate the receipt for `HEAD` against the latest `origin/main`.         |
| `pnpm ci:merge --pr <n> [--execute]`              | Verify, apply the ticket policy, then squash merge (dry run default).     |

Rebase onto the latest origin/main first (single commit directly above it); each PR must then pass the full local CI (`pnpm ci:local` on that final head) before merge; if origin/main moves, rebase and rerun. `ci:verify` and `ci:merge` reject a head that is not a single commit directly above the latest `origin/main`, or whose receipt names another base.

Set `STATEACTION_LOCAL_FIXTURES=<env file>` for the bounded loopback PostgreSQL and S3 fixtures. Without it the fixture-backed stages fail; Docker is never started.

## What a commit runs

The pre-commit hook runs the previous hook or `node scripts/platform/check-staged.mjs` only. It never starts `local_ci.py`; the whole suite is the explicit `pnpm ci:local` run.

## What the gate runs

`scripts/local-ci/stages.json` declares the stages. The runner:

1. refuses unless the process is inside the verified `agent-work.slice` / `agent-mobile-build.scope` cgroup (at most 6 GiB per job, 12 GiB aggregate, no swap); it re-executes itself under `agent-resource run --` when needed and refuses if the launcher is missing;
2. exports the head tree to a private temporary directory, so ignored files such as real `.env` credentials never take part, and installs dependencies against that export;
3. runs each stage serially, with the Nx/Gradle caches limited to deterministic stages (see Caching) and every integration/E2E/smoke stage uncached, with `NX_DAEMON=false`, Nx `--parallel=1`, Node `--test-concurrency<=2`, Flutter `--concurrency=2`, two-thread math libraries, a per-stage time limit and an output cap, with `docker`/`podman` shimmed to fail;
4. re-reads the tree after every stage, snapshots the exported tracked files and fails a stage that changed the tree, rewrote tracked source or left a process behind;
5. becomes a child subreaper, so detached (`setsid`) descendants re-parent to the runner. After every stage, and on failure, timeout or interruption (SIGINT/SIGTERM/SIGHUP), it terminates and reaps exactly its own descendants and fails the stage if their exit cannot be proved. After a successful Android tooling stage, a Gradle daemon gets up to five seconds to finish cache cleanup and exit on its own. Other service or emulator scopes are never touched;
6. before the first stage (so a dead fixture fails in seconds), probes the PostgreSQL and S3 fixtures and proves from `ss` and the kernel cgroup files that the loopback PostgreSQL and S3 listeners are served from `agent-service-postgres.scope` / `agent-service-storage.scope` inside the same 12 GiB, no-swap slice with a finite cap of at most 1 GiB. Otherwise the run fails with `agent-resource serve --name <postgres|storage>` instructions; the sanitized facts are recorded in the receipt.

No environment variable skips the hooks. A new full attempt first deletes any receipt for the same tree and records itself as the latest attempt, so a failed, cancelled or refused rerun can never leave an older PASS usable. The root `tests/test_*.py` unit suites run on the pinned CPU dependencies of `requirements-stera.txt` (Python 3.11 via `uv`); they need the `stera-sdk` submodule commit, which the runner exports from the checkout, `<git-dir>/modules`, or a directory named by `STATEACTION_LOCAL_CI_SUBMODULES`.

If the machine-wide `agent-resource` heavy-job slot is busy, `pnpm ci:local` prints `waiting for the heavy-job slot (held by ...)` and retries with backoff (5 s growing to 30 s, Ctrl-C acts within about a second) instead of exiting 75, naming the holder's process, project root and age. The wait is bounded (60 minutes by default, `STATEACTION_LOCAL_CI_WAIT_MIN`); on expiry it exits 76 and touches nothing. Waiting runs poll and race, so their order is not guaranteed. A waiting run never deletes a receipt: only a run that actually starts supersedes the receipt of its tree; the guard's non-blocking slot is unchanged, so two heavy jobs never run at once. Other admission failures (no cgroup, no memory) still fail closed with exit 75. `pnpm ci:merge` is the only merge gate: it merges only when `ci:verify` finds a valid receipt for the exact head, and neither waits for nor is blocked by a running `ci:local`.

Every run, PASS, FAIL or INTERRUPTED, ends with a per-stage wall time table (stage, status, seconds, Nx cache hits/tasks) and the total; `run.json` keeps each stage's `durationSec`. Median seconds per stage, as a budget reference: `server-tooling` 40, `catalog-integration` 108, `jobs-controller-integration` 105, `runtime-smoke` 70, `server-auth-integration` 11, `local-ci-self-test` 35, `mobile-android-dart` 78, `mobile-backend-e2e` 110, `web-auth-e2e` 135.

Logs and `run.json` go to `~/.cache/stateaction-local-ci/logs/<run>/` (override with `STATEACTION_LOCAL_CI_HOME`). Fixture secrets are redacted from logs and never written to receipts.

## Jobs controller integration

The `jobs-controller-integration` stage runs `pnpm --filter @stateaction/jobs test:integration` (four real cases: happy path, controller loss, runner loss, and lost acknowledgement with an uncertain child) after the build, `python-sync` and `render-cli` stages. It uses the exported tree's checksum-pinned official Render CLI (`artifacts/platform-tools/render/render`) as a loopback `workflows dev` runner and the locked `workers/processing/.venv`, the production Next API, and a ledgered database and bucket on the bounded fixtures (no Docker, no cloud or provider calls). The processing pipeline is the local no-output fixture: this proves controller, executor and claim plumbing only, not hand-pose output, hosted or physical qualification. It never calls `apps/jobs/test-integration/run.sh`, which installs, rebuilds and rewrites tracked source. The stage is never cached, and the runner reaps every detached child it leaves. Each case tears down its own Next API, runner, controller and child when it ends: the whole stage runs in one guard scope capped at 256 tasks (threads included), and keeping every case's processes alive until the end of the file exhausted that cap, so Node aborted with SIGABRT and no output when libuv could not start a worker thread (`clone3` EAGAIN). A controller process that dies now reports its exit code and signal instead of an empty `crashed` result.

## Caching

Speed comes only from existing mechanisms; no custom task cache exists.

- **Nx task cache.** Only the deterministic stages `server-tooling` and `mobile-android-dart` (build, typecheck, syntax, unit tests, format) may hit it. Every exported tree shares one private `NX_CACHE_DIRECTORY` (`~/.cache/stateaction-local-ci/nx-cache`), Nx Cloud stays off, and hits depend on Nx's input hashes: project sources, dependencies, lockfiles, `nx.json`/`package.json`/workflow inputs and the runtime commands listed in `sharedGlobals` (`node`, `pnpm`, `python3`, `uv`, `java`, `flutter` versions). A changed source, dependency, lockfile or toolchain therefore misses.
- **Never cached.** Every fixture-backed stage (catalog/storage integration, auth, Next HTTP E2E, mobile backend E2E, jobs controller integration, runtime and hosted smoke) and the Android capture spike build always run with `--skip-nx-cache` and fresh isolated fixtures. The runner appends the flag itself to any Nx stage that does not declare `"cache": "nx"`.
- **Dependency stores.** `pnpm install --frozen-lockfile --prefer-offline` hardlinks from the shared pnpm store, `uv`, pub and Gradle's `GRADLE_USER_HOME` caches are reused, and nothing is installed or downloaded twice. Gradle's task output cache is on only for `mobile-android-dart` (`-Dorg.gradle.caching=true`, same fixed export path). The first cold run showed a cached `testDebugUnitTest` skipping an undeclared fixture (`native-writer.mcap`) that the spike verifier reads, so `spikes/android/capture/app/build.gradle.kts` now declares `build/spike-fixtures` as a test-task output and a cache hit restores it. The configuration cache stays off and no daemon persists. The spike's `android-build` target runs once, uncached, as a dependency of `android-capture-spike-native:build`; stage deadlines are 10-30 minutes and Nx stages use `--nxBail`.
- **Export.** Each run gets a fresh export at a fixed path under the CI home, protected by a lock. A cache hit that rewrites a tracked source file still fails the stage.
- **Receipt.** Each stage records `cacheMode`, `gradleBuildCache` and, for Nx, how many tasks were cache hits versus executed (with names); the receipt records `fresh`, the toolchain and its hash, and the total duration.
- **Forcing cold.** `python3 scripts/local-ci/local_ci.py run --tree HEAD --fresh` bypasses the Nx and Gradle caches. Compare its `totalDurationSec` with a following normal run for cold-versus-warm timing.

## Receipt

`~/.cache/stateaction-local-ci/receipts/<tree>.json` (outside Git, mode 0600) exists only after every stage passed on an unchanged tree. It records the tree and head, `origin/main` at test time, SHA-256 of the stage list and runner, each stage's command hash, status and log hash, toolchain versions, guard limits with the measured cgroup peak, fixture endpoints (no credentials) and the unautomated qualifications.

`ci:verify` / `ci:merge` accept a head only when: the receipt's tree equals the head tree; the stage list and runner in the head are the ones that ran; every declared stage passed with its declared command; the receipt is the latest attempt for the tree and was produced for this commit context (tree run on this head). Merge-time checks (exactly one non-merge commit directly above `origin/main`, `--match-head-commit`, merged-commit postcondition) are unchanged; the head contains the latest fetched `origin/main` as its direct parent and is exactly one non-merge commit. After a rebase the tree changes, so run `pnpm ci:local` again. `ci:merge` also requires the active `gh` account `timothywangdev`, the local `HEAD` to equal the PR head and the ticket policy, then calls `gh pr merge --squash --match-head-commit`. `main` is never pushed to.

## Not automated

Physical-device capture and company-profile operations, iOS hardware and hosted-provider (Render, R2) qualification are listed in every receipt under `unautomated`. They are never reported as passed.
