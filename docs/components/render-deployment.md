# Render deployment

The web/API and workflow scaffold that runs locally is the same source Render builds from `render.yaml`. SA-41 deployed the production stack on 2026-11-23 (see [Hosted production stack](#hosted-production-stack-sa-41)). Creating or resizing Render resources is **paid** and is bounded by the monthly cap below.

## Environments

|                | local                     | development                  | production                       |
| -------------- | ------------------------- | ---------------------------- | -------------------------------- |
| `APP_ENV`      | `local`                   | `development`                | `production`                     |
| Postgres       | Compose, loopback         | local or tailnet             | Render Postgres, restricted role |
| Object storage | SeaweedFS, loopback       | private R2 `stateaction-dev` | private R2 production bucket     |
| Config source  | ignored `.env` (optional) | ignored env file or injected | injected only; no file read      |
| Dispatch route | enabled with smoke token  | disabled                     | disabled (404)                   |

`serverConfig()` rejects mixed settings. Local refuses R2 and non-loopback databases. Development and production require HTTPS R2 and refuse the local example keys. Production refuses loopback databases and the `-dev` bucket. Hosted startup runs `hosted:preflight` before listening. The local task starter requires an explicit loopback HTTP runner.

## Process model

- **web** (`stateaction-web`): `node` runtime, build `corepack enable && pnpm install --frozen-lockfile --prod=false && pnpm --filter "@stateaction/web..." build`; start binds `0.0.0.0:$PORT`. `healthCheckPath: /api/v1/live` is dependency-free so an R2 or database blip cannot restart healthy instances; `/api/v1/health` is the readiness report (503 when degraded).
- **Workflow** (`stateaction-workflow`) runs `stateaction_controller.workflow`. The Python task and its local Render runner use the same entry point. The workflow gets the controller API capability and Modal credential. The web service gets the compiled graph's binding configuration and the Render-start credential. The repair process gets only its API capability.
- **Postgres** (`stateaction-db`): `ipAllowList: []`.
- Region `ohio` for all three (listed as valid for workflows in the current Blueprint spec). Plans are priced in `config/render-deploy.json` (see Spend cap); a plan change needs a new estimate.

## Database roles and migration order

Render one-off jobs inherit the service's environment (no per-job injection), so owner credentials are **not** given to any service. The owner path is explicit and operator-run:

1. Apply the Blueprint (below). The web service starts; `/api/v1/live` is 200, `/api/v1/health` is 503 until migrated.
2. Temporarily add your operator IP `/32` to the database access list (Dashboard → database → Access Control). Remove it afterwards; a later Blueprint sync also resets it to `[]`.
3. (`scripts/deploy/render-deploy.sh` and `render-deploy.mjs migrate` automate steps 2-3 and always close the allow list.) From a trusted machine, using the **External Database URL** and the same `APP_DB_PASSWORD` you gave the web service:
   ```sh
   read -rs MIGRATION_DATABASE_URL; export MIGRATION_DATABASE_URL   # paste URL ending ?sslmode=require
   read -rs APP_DB_PASSWORD; export APP_DB_PASSWORD
   pnpm install --frozen-lockfile && pnpm --filter @stateaction/server build
   APP_ENV=production pnpm --filter @stateaction/server hosted:migrate
   ```
   In one owner transaction, under the published migrator's advisory lock, it applies the checksummed SA-13 migrations (`001` platform foundations, `002` auth, `003` catalog) through `applyMigrations`, creates the `stateaction_app` role if absent (plain `LOGIN`, no `SUPERUSER`/`CREATEDB`/`CREATEROLE`; a pre-existing privileged role fails closed) and sets its password, then calls `stateaction_grant_app_role('stateaction_app')`. That helper is the only source of grants: table-specific SELECT/INSERT/column UPDATE, no DDL, no review/clip mutation, no role-access escalation, and it revokes any old broad table, sequence or function default ACLs. Re-running is idempotent; a version-1 database from the earlier SA-14 scaffold adopts its checksum. The migrator needs a `CREATEROLE` owner that owns the database (the helper revokes `TEMPORARY`); this is proven locally with a `NOSUPERUSER CREATEROLE` owner, **not** on Render (see first-deployment checks).
4. Confirm `GET https://<web>/api/v1/health` returns `{"status":"ok"}`.

## Secrets map (`sync: false`, entered once at Blueprint creation)

| Service        | Key                                        | Value                                                                                                                           |
| -------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| web            | `APP_DB_PASSWORD`                          | random ≥32 chars chosen by the operator; also used for the migration                                                            |
| web            | `BETTER_AUTH_URL`                          | the web service's public HTTPS origin (onrender.com or custom domain)                                                           |
| web            | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | production Google web client (**Google gate still open**)                                                                       |
| web            | `S3_ENDPOINT`                              | `https://<account>.r2.cloudflarestorage.com`                                                                                    |
| web            | `S3_BUCKET`                                | production bucket (never `stateaction-dev`)                                                                                     |
| web            | `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | production bucket-scoped R2 token (not the dev token)                                                                           |
| web            | `PROCESSING_PROFILE_REVISION`              | processing profile revision pinned on admitted jobs (operator choice)                                                           |
| web            | `PROCESSING_EXECUTION_BACKEND`             | `local` or `modal` job execution backend (operator choice)                                                                      |
| web            | `PROCESSING_CODE_REVISION`                 | deployed worker git revision recorded on every admitted job                                                                     |
| web            | `PROCESSING_IMAGE_SPEC_SHA256`             | SHA-256 of the locked worker image build spec (from build tooling)                                                              |
| web            | `PROCESSING_CONFIG_SHA256`                 | the exporter `config_sha256(ExportLimits, StreamLimits)` digest (ruleRevision 2), see [output acceptance](output-acceptance.md) |
| workflow       | `EXECUTION_BACKEND`                        | `modal` in production (the local executor is refused outside `APP_ENV=local`)                                                   |
| workflow       | `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`     | Modal API credential for the controller only (never web, cron or the processing container)                                      |
| operator shell | `MIGRATION_DATABASE_URL`                   | owner external URL; never stored in Render env                                                                                  |

`BETTER_AUTH_SECRET` is `generateValue: true` (distinct per environment, web only). Literal config in the Blueprint: `NODE_VERSION=24.22.2`, `APP_ENV=production`, `S3_REGION=auto`, `SUPPORTED_RGB_PROFILES=h264_mcap_v1`; `PROCESSING_PROFILE_REVISION` is prompted (`sync: false`, web only) because the pinned processing profile revision is an operator decision per environment, and preflight refuses to start without it; `DATABASE_HOST/PORT/NAME` come from `fromDatabase`. Job admission (SA-25) records a permanent input identity on every admitted job: the four `PROCESSING_*` rows above are prompted (`sync: false`, web only, never defaulted or placeholders) and `PROCESSING_MODEL_SHA256` is the literal accepted CPU model pin (MediaPipe Hand Landmarker full float16 task bundle v1). `hosted:preflight` refuses to start without all five, and `/api/v1/health` reports `checks.jobs=false` (status degraded, 503) outside local development when any is missing, so a reachable database and bucket never read as a working pipeline. Controller and cron credentials are not Blueprint values: an operator issues them with the owner credential (`issue-service-capability`), then enters each token once as a secret of the service that uses it (SA-26 wires the controller; SA-41 deploys the workflow and cron services; Modal is not deployed). R2 credentials are backend-only and never reach the mobile app or the workflow.

Simulated emulator capture (SA-71) is **never** enabled on Render: `ALLOW_SIMULATED_CAPTURE_INPUTS` must not appear in the Blueprint or any hosted environment (the server treats its presence outside `APP_ENV` local/development, or alongside Render-injected variables, as a startup configuration error that `hosted:preflight` reports), and `SUPPORTED_RGB_PROFILES` stays `h264_mcap_v1`. See [simulated-capture-admission.md](simulated-capture-admission.md).

## Authentication settings (web only)

The Blueprint carries the auth settings contract of the SA-15 `authConfig`: `APP_ENV`, `BETTER_AUTH_URL` (HTTPS public origin), `BETTER_AUTH_SECRET` (≥32 random chars), optional `AUTH_TRUSTED_ORIGINS` (exact HTTPS origins, no wildcards) and `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` (both or neither). `AUTH_LOCAL_PASSWORD` (seeded email/password) is local/development only, refused on Render, and is never in the Blueprint. `AUTH_TRUSTED_PROXIES` (sign-in limiter proxy trust) stays unset until the Render proxy ranges are measured; see "Client IP and ingress" in `auth-and-access.md`. The unsupported overrides `BETTER_AUTH_TRUSTED_ORIGINS` and `BETTER_AUTH_SECRETS` must never be set. The workflow service receives none of these, nor database, R2 or Google credentials (enforced by `infra/test/blueprint.test.mjs`).

SA-15 is **not merged**; this branch contains no auth code and does not show that auth works. Integration contract to apply when both land: `authConfig(env, { resolveDatabaseUrl: applicationDatabaseUrl })`, where `applicationDatabaseUrl` is exported from `@stateaction/server` (builds the `stateaction_app` DSN from `DATABASE_HOST/PORT/NAME` + `APP_DB_PASSWORD`; production rejects any other role). Before relying on per-client rate limits behind Render's proxy, its forwarded-IP header behavior must be measured; it has not been. Until then the auth ingress mode on Render is an open gate.

## Commands

```sh
render whoami && render workspace current         # tea-dbfshol9fdbs73c5408g (stateaction)
render blueprints validate render.yaml
# Dashboard: New → Blueprint → StateAction-ai/stateaction → render.yaml (fill the sync:false prompts)
render workflows versions list <workflow-id> -o text
render workflows tasks list <ready-workflow-version-id> -o text
```

The Blueprint validates against the workspace (`render blueprints validate render.yaml`: database `stateaction-db`, services `stateaction-web` and `stateaction-repair`, workflow `stateaction-workflow`). Render's own `autoDeployTrigger` stays `off` so GitHub Actions (`.github/workflows/deploy.yml` calling `scripts/deploy/render-deploy.sh`) remains the single orchestrated deploy driver with migrations, smoke checks, and rollback.

## Repository location (SA-137)

The repository moved to the `StateAction-ai` GitHub organization. `render.yaml` and `config/render-deploy.json` name `https://github.com/StateAction-ai/stateaction`; the single slug read by the local tooling is `config/repository.json`. The live services (`srv-dc2bfl6c6qcc73df90e0`, `crn-dc2bflrrjlhs73ae9jt0`, `wfl-dc2bermc6qcc73df6890`) were created from the old URL and still point at it until an operator with a write-scoped Render key and the Render GitHub app installed on the organization PATCHes `repo` on each service and triggers a manual deploy of the live commit (`render.env` in `~/.config/stateaction/` holds a read-only key: `PATCH /v1/services/{id}` returns `insufficient_token_scope`, `services.read_write` required). Until then the services keep the old URL; whether Render can still pull through GitHub's redirect is unverified.

## Hosted production stack (SA-41)

| Resource                        | Id                           | Plan                   | Notes                                                           |
| ------------------------------- | ---------------------------- | ---------------------- | --------------------------------------------------------------- |
| Postgres `stateaction-db`       | `dpg-dc2bek3rjlhs73ae5qg0-a` | basic-256mb, 1 GB, v17 | `ipAllowList: []`; owner URL never stored on a service          |
| Web `stateaction-web`           | `srv-dc2bfl6c6qcc73df90e0`   | starter                | `https://stateaction-web.onrender.com`, HTTPS only (HTTP 301)   |
| Cron `stateaction-repair`       | `crn-dc2bflrrjlhs73ae9jt0`   | starter                | suspended until a dispatch key is configured (repair would 503) |
| Workflow `stateaction-workflow` | `wfl-dc2bermc6qcc73df6890`   | flex tasks             | region ohio; no run happens until ingest is activated           |

All four are in region `ohio`. Web and cron reach Postgres over the private network (`DATABASE_HOST` is the internal host). The workflow calls the API by its public HTTPS URL.

### Spend cap and stop conditions

Monthly cap **30 USD** (user, 2026-11-23). `config/render-deploy.json` holds the prices read from render.com/pricing on 2026-11-23; `node scripts/platform/render-deploy.mjs estimate` prices the plans in `render.yaml` and fails on plan drift or when the worst case exceeds the cap, and `provision` runs it before any create. Worst case 25.21 USD: Postgres 6.30, web 7.00, cron 6.91 (every-minute billing ceiling), workflow tasks 5.00 (20 task-hours of 1 CPU + 1 GB). Expected idle bill about 14-16 USD (cron far below its ceiling; suspended cron bills nothing). Assumes the workspace is on the Hobby plan (no 25 USD workspace fee). Stop conditions: a plan change, extra service, disk, replica or add-on; a measured month-to-date bill above 25 USD; a non-Hobby workspace plan. No default GPU, warm worker, extra API, outbox or additional engine. Render offers no spend-alert API; the control is the plan pin plus this estimate gate and a manual month-to-date check in the Dashboard (Billing). `RENDER_CREATE_KEY` (operator machine only, the user's short-lived CLI login) may substitute for the deploy key while the scoped key lacks `services` write; it is never set in CI. A Cloudflare R2 spend alert is not configured (storage is under the free tier at this stage).

### Credential boundaries

- **web** alone holds `S3_*` (production bucket key), `APP_DB_PASSWORD` (restricted `stateaction_app` role) and, when configured, a **dedicated** Render dispatch key (`RENDER_DISPATCH_API_KEY` secret mapped to the web service's `RENDER_API_KEY` plus `PROCESS_RECORDING_TASK_SLUG`). The deploy key is never copied to a service. Until that dedicated workflow-run key exists, dispatch is unavailable and ingest stays disabled (fail closed; `/internal/v1/jobs/*` answers 503 `provider_unavailable`).
- **cron** holds only `STATEACTION_API_URL` and a `jobs:repair` capability. **workflow** holds `STATEACTION_API_URL`, a `jobs:status,jobs:reconcile` capability, `EXECUTION_BACKEND=modal` and, when supplied, `MODAL_TOKEN_ID/SECRET`. `infra/test/blueprint.test.mjs` and `scripts/platform/render-deploy.test.mjs` enforce this placement.
- Production rejects loopback API origins and the local executor. The local smoke starts the official Render loopback runner, verifies Python task registration, and verifies rejection when a production task lacks its required configuration.
- Capabilities live at most 24 hours. Re-run `scripts/deploy/render-deploy.sh production <sha>` (or its `migrate` step) to issue new ones; there is no scheduled rotation yet.
- Production uses only the bucket-scoped key for `stateaction-prod`. The `stateaction-stage` and `stateaction-dev` keys never reach a production service. No staging stack is hosted: a second stack would exceed the cap. Staging and production secrets are separate GitHub environments/files by construction (`~/.config/stateaction/r2-stage.env` versus `r2-prod.env`).

### Private R2

`config/r2-bucket-policy.json` and `scripts/platform/r2-bucket-policy.mjs` (operator-only, needs the temporary Cloudflare admin token, never given to the app or the workflow): CORS exact origin `https://stateaction-web.onrender.com` (GET, HEAD, PUT; no wildcard) on `stateaction-prod`, a 7-day abort-incomplete-multipart lifecycle on prod and stage, and a check that the managed `r2.dev` domain is disabled and no custom domain exists. Buckets are private; the app signs URLs and never proxies media.

### Deploy workflow and script

`.github/workflows/deploy.yml` runs on `push` to `main`, explicit `deploy/*` tags, and manual `workflow_dispatch` (`environment`: `dev` = validate, price and plan only with no secrets; `production`; `mode`: `components` or `full`; `components`: `auto`, `web`, `migrations`, `cron`, `workflow`, `all`). `StateAction-ai/stateaction` is a public repository, so standard GitHub-hosted `ubuntu-24.04` runners and GitHub Environment protections are available without paid Actions minutes.

- **Kill-switch (`AUTO_DEPLOY_ENABLED`):** Automatic `push` deploys on `main` run **only** when the repository variable `AUTO_DEPLOY_ENABLED` is `'true'` (default unset/off). While unset or false, every push to `main` still runs the read-only `validate` job (no secrets) and logs which components would have deployed. This keeps fenced cutovers such as SA-159 protected until explicitly enabled and gives an instant pause switch for future migrations or incidents.
- **Change-only per-component deploys (`mode: components`, `scripts/platform/deploy-scope.mjs`):**
  - `migrations` (`packages/server/migrations/**`, `packages/server/src/migrations.ts`): runs `render-deploy.mjs migrate --schema-only` (temporary `/32` DB allow-list, owner migration, allow-list always closed) _before_ `web` without rotating controller/cron capabilities.
  - `web` (`apps/web/**`, `packages/server/**`, TypeScript/API/recipe `packages/contracts/**`, `recipes/compiled/**`, `examples/compiled/**`, `modules/*/module.lock.json`, `scripts/platform/web.mjs`, `scripts/platform/rerun-assets.mjs`, root Node lockfile/workspace files; excluding tests, docs, migrations, and Python/Dart/capture-only contract subtrees): deploys **only** `stateaction-web` at exact `ref`, runs live/health/R2 smoke checks, and rolls back **only** `web` on failure — without touching `cron`, `workflow`, unrelated env vars, or `PROCESSING_CODE_REVISION`.
  - `cron` (`workers/controller/**`, `packages/contracts/python/**`, `packages/contracts/api/**`) and `workflow` (same plus `packages/contracts/recipe/**`, `packages/modal-verifier/**`, `modules/*/module.lock.json`; excluding tests/docs): deploys `stateaction-repair` (preserving its existing suspended/resumed state) and releases a new `stateaction-workflow` version at `ref`.
  - `workers/processing/**` (Modal), `apps/mobile/**`, tests, and docs select **no** Render components; Modal processing stays manual until its secrets and contract pins are automated.
  - Inside the `production` job, `auto` queries `render-deploy.mjs live-refs` and diffs each component against its currently live deployed SHA (falling back to `before..head`) so a previously failed or paused run catches up automatically on the next relevant push or manual `auto` dispatch.
- **Full-stack deploys (`mode: full` or `deploy/*` tags):** Runs `scripts/deploy/render-deploy.sh production <ref>` (`provision`, `configure`, `migrate` + 24 h capability rotation, `deploy` all Render services, `smoke`, with web rollback on failure).
- **Security boundaries:** Actions are pinned to commit SHAs, the token is read-only (`contents: read`), the ref must be an ancestor of `main` (and equal to `origin/main` tip for production), and the `production` GitHub environment holds the secrets (`RENDER_API_KEY`, `S3_*`, `APP_DB_PASSWORD`; optional `RENDER_DISPATCH_API_KEY`, `MODAL_TOKEN_*`, `GOOGLE_CLIENT_*`). Install and build run without secrets (`prepare`) only when migrations may execute; the `if: always()` `restore-allowlist` step verifies the DB allow-list is empty (no-op when already empty).
- **Prerequisites before setting `AUTO_DEPLOY_ENABLED=true` (after SA-159):** (1) Complete the fenced SA-159 cutover so live production is caught up with migration `025` and SA-154; (2) verify the `RENDER_API_KEY` secret in the GitHub `production` environment has `services.read_write` scope; (3) verify the live Render services point to `https://github.com/StateAction-ai/stateaction`.

### What is and is not demonstrated (2026-11-23)

Demonstrated: backend, `/api/v1/live` and `/api/v1/health` (database, storage, jobs), Postgres migrations and the restricted role, private R2 round trip from the deployed web service, HTTPS redirect, credential placement and the deploy/rollback script. **Not demonstrated and not working: the web console.** No sign-in method exists yet (`[auth] configuration error: No sign-in method is configured`; the page shows "Temporarily unavailable. We could not check your access."): local password is refused on Render and Google OAuth (SA-80) is not configured. No criterion of SA-41 claims a usable signed-in UI.

To enable it, after the user creates the Google web client (redirect URI `https://stateaction-web.onrender.com/api/auth/callback/google`) and stores `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `~/.config/stateaction/google-oauth.env` (0600): `scripts/deploy/google-oauth.sh apply` (sets both on the web service and redeploys), sign in once with Google (first login shows _Access pending_), then `scripts/deploy/google-oauth.sh grant-staff <email>` (enables the `staff` role through the owner connection with a temporary, verified-closed allow-list entry).

### Rollback

`node scripts/platform/render-deploy.mjs rollback --state artifacts/render-deploy-state.json` rolls web back to the previous live deploy (Render cannot roll back cron jobs, which hold no state) recorded by `deploy`. Migrations are forward-only and additive; a schema rollback is a restore from the Postgres backup, not a script.

## First-deployment checks (unverified until a real build/migration)

- `corepack enable` in the Render Node build command works with the pinned pnpm (`packageManager`).
- The Render Postgres owner role has `CREATEROLE` (the explicit migration creates `stateaction_app`); verify before relying on it.
- Production `DATABASE_URL`, if ever set, must use `stateaction_app` (rejected otherwise); never wire `fromDatabase.connectionString` (owner).
- Production needs its own R2 bucket and token: `serverConfig()` rejects any bucket ending `-dev`; `stateaction-dev` is development only.
- `S3_PUBLIC_ENDPOINT` outside local must equal `S3_ENDPOINT` (private R2 origin).
- `RENDER=true` (injected by Render) makes `pnpm web start` ignore `.env` and bind `0.0.0.0:$PORT` even for `APP_ENV=development` services.

## Development origins (Tailscale) and signing

Development against real private R2 uses `APP_ENV=development`, the private bucket endpoint, local Postgres, and (with SA-15) seeded email/password on the same Better Auth instance. The backend binds **loopback** (`STATEACTION_WEB_HOST` default `127.0.0.1`) and Tailscale Serve terminates HTTPS in front of it; the proposed origin is `https://tim-work-pc.taila68f99.ts.net:8444`. Ports 443 and 8443 belong to other services and are preserved; this change does not configure Serve. Measured with Tailscale 1.104.1 (host to its own Serve only, `/tmp` probe by root): Serve overwrote `X-Forwarded-For` (single client address), `X-Forwarded-Proto` and `X-Forwarded-Host`, but a forged `X-Real-IP` passed through, so auth must trust only `X-Forwarded-For` in this mode. `STATEACTION_DEV_ORIGINS` adds extra Next dev origins. **No phone reachability or auth flow has been tested; ADB had no device.**

Presigned URLs use `S3_PUBLIC_ENDPOINT` (default: `S3_ENDPOINT`). Set it only when the signer origin differs, such as a tailnet name for local SeaweedFS; real R2 uses one endpoint. The local smoke signs for `localhost:9000` while the server talks to `127.0.0.1:9000` and checks the issued URLs use the public origin.

## Local evidence commands

```sh
pnpm exec nx run infra:integration   # local runner smoke + presign + hosted-mode smoke
bash scripts/platform/hosted-smoke.sh                # hosted mode only: PORT=10000, injected env, no .env
```
