# Monorepo and local platform loop

Nx 24.0.3 owns the dependency graph, affected selection and local task cache. pnpm remains the TypeScript package manager; uv remains the Python package/build manager. Explicit `project.json` targets call native commands, so no language-specific Nx plugin or Nx Cloud is required. Exact pins and primary-source links are in [the toolchain receipt](../../config/platform-toolchain.json).

The graph contains web, jobs, server, contracts, processing, tooling, infra, automation, mobile, stera-recorder and mobile-tooling. The [mobile setup](../mobile/README.md) uses real Flutter/pub/Gradle targets and native lockfiles. Android checks run when mobile or its hook/toolchain inputs are affected and feed the same required CI gate. APK builds stay uncached because Flutter bundles local configuration; device tasks must also remain uncached.

## Setup and checks

Use Node 24.22.2 (`nvm install`), pnpm 10.33.0 and uv 0.13.6:

```sh
make install
make check
pnpm exec nx show projects --json
pnpm exec nx affected -t build,typecheck,syntax,test,format --base=origin/main --head=HEAD
```

`make check` checks all current projects. Repeating unchanged cacheable tasks reuses local `.nx/cache`; integration always executes. Private `.env`, build outputs and caches stay ignored. JavaScript helper and automation syntax targets are explicitly separate from TypeScript/mypy typechecks. CI uses all projects when the base predates Nx, then uses Nx affected for later changes. Workflow **CI** ends in the always-running **Required checks** gate; every relevant job must succeed. Ticket reference and merge automation are separate checks. CI can be dispatched on a PR branch with `pr_number` and verifies the dispatched SHA still matches that PR.

## Hooks

Lefthook 2.2.2 installs during pnpm setup in an ordinary clone. Its implicit package postinstall is disabled. `pnpm hooks:install` deliberately skips linked worktrees and preserves an existing custom hooks path; repeating it does not override either case.

For this owned linked worktree, configure an isolated ignored hooks directory explicitly:

```sh
git config extensions.worktreeConfig true
git config --worktree core.hooksPath "$PWD/.lefthook-hooks"
git config --show-origin --get core.hooksPath
git rev-parse --git-path hooks
```

Verify that both reported paths identify this worktree's owned `.lefthook-hooks`, then run `pnpm exec lefthook install --force`. Confirm that hooks were written there and shared hooks stayed unchanged. If the CLI refuses or reports another path, stop that installation and preserve the shared hooks. Never reset or force-install over an unrelated existing hooks path.

Pre-commit reads staged blobs directly from Git's index. Prettier and Ruff check stdin: filenames with spaces and partial staging work without stash, rewrites or auto-staging. Format the intended content and stage only intended hunks. The fast hook does not run the whole build. Pre-push rejects any ref update to `main`; publish one ticket branch/PR. Local hooks do not impose server-side branch protection.

Tests install the actual hooks in disposable repositories, check positive/negative commits and both partial-stage directions, then push to a disposable bare repository to prove the main-branch guard.

## Real local runtime

```sh
make render-cli
pnpm exec nx run infra:integration
```

`pnpm exec nx run server:catalog-integration` separately runs the catalog migration/constraint/concurrency tests on a throwaway Postgres bound to an ephemeral loopback port ([catalog](../../docs/components/catalog.md)); CI runs every affected `integration`, `auth-integration` (server) and `auth-e2e` (web) target in the Local runtime smoke job. All three are uncached and run again on every selection; the two auth targets use their own throwaway loopback Postgres containers.

The platform smoke checks local configuration, database migrations, object storage and registration of the Python `process-recording` task in the official loopback runner. The controller integration drives that task through real admission, local node execution, publication and retry with disposable data.

For interactive development, copy `.env.example` and `.env.workflows.example` to their ignored local counterparts, then run `make infra-up migrate storage-init`, `make web` and `make workflows` in separate terminals. Database and storage credentials stay out of the workflow environment. [Official local runtime](https://render.com/docs/workflows-local-development)

## Hosted (Render) mode

`APP_ENV=production` start reads only injected environment variables, binds `0.0.0.0:$PORT` and rejects mixed local/hosted settings; `scripts/platform/hosted-smoke.sh` proves this on `PORT=10000` against a disposable Postgres with a restricted role, then registers the workflow tasks without database/storage credentials. See [Render deployment](../../docs/components/render-deployment.md). Nothing is deployed.
