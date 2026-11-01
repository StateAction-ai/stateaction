# Local platform loop

Use the exact versions in [the toolchain receipt](../../config/platform-toolchain.json): Node 24.22.2 (`nvm install`), pnpm 10.33.0, Python 3.12.13 and uv 0.13.6. `make render-cli` downloads the official Render 2.34.0 Linux x86-64 CLI and verifies its fixed SHA-256. Other platforms use [Render's installer](https://render.com/docs/cli#setup).

From the repository root:

```sh
cp .env.example .env
cp .env.workflows.example .env.workflows.local
# Replace LOCAL_SMOKE_TOKEN in .env with a random local value, at least 24 characters.
make install
make infra-up migrate storage-init
pnpm storage:check
make check
make render-cli
make web
```

In another terminal run `make workflows`, then `make smoke` in a third. The smoke verifies Postgres/storage readiness and Next → official local Render runner → Node LocalExecutor → installed Python worker identity. No Render account or cloud token is needed. Database/storage authority stays in the web process; `.env.workflows.local` contains only local execution settings.

The workflow uses Render's [documented local runtime](https://render.com/docs/workflows-local-development); it is not a replacement queue. All manual Render list/start commands must include `--local`. To inspect registration:

```sh
artifacts/platform-tools/render/render workflows tasks list --local -o json
```

`ci-smoke.sh` runs the same path in an isolated checkout with unused ports and no existing `.env` files, using the separate `stateaction-smoke` Compose project, then stops its own processes/services while retaining data volumes. It refuses to overwrite local settings. GitHub Actions checks changed platform/mobile toolchains; a hosted CI run is only evidence after the workflow actually runs remotely.
