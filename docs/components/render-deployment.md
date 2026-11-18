# Render deployment (prepared, not deployed)

The web/API and workflow scaffold that runs locally is the same source Render builds from `render.yaml`. Nothing here has created a Render resource; applying the Blueprint creates **paid** resources and needs explicit approval.

## Environments

|                | local                     | development                  | production                       |
| -------------- | ------------------------- | ---------------------------- | -------------------------------- |
| `APP_ENV`      | `local`                   | `development`                | `production`                     |
| Postgres       | Compose, loopback         | local or tailnet             | Render Postgres, restricted role |
| Object storage | SeaweedFS, loopback       | private R2 `stateaction-dev` | private R2 production bucket     |
| Config source  | ignored `.env` (optional) | ignored env file or injected | injected only; no file read      |
| Dispatch route | enabled with smoke token  | disabled                     | disabled (404)                   |

`serverConfig()` rejects mixed settings: local refuses R2 and non-loopback databases; development/production require HTTPS R2 and refuse the local example keys; production refuses loopback databases and the `-dev` bucket. Hosted startup runs `hosted:preflight` (this validation) before listening. `assertLocalDispatch` and the loopback-only bootstrap guards are unchanged.

## Process model

- **web** (`stateaction-web`): `node` runtime, build `corepack enable && pnpm install --frozen-lockfile --prod=false && pnpm --filter "@stateaction/web..." build`; start binds `0.0.0.0:$PORT`. `healthCheckPath: /api/v1/live` is dependency-free so an R2 or database blip cannot restart healthy instances; `/api/v1/health` is the readiness report (503 when degraded).
- **workflow** (`stateaction-workflow`): the same `@stateaction/jobs` task code that the local official runner loads. Its env has no database, storage or Render API credentials; SA-26 adds only `STATEACTION_API_URL` and the operator-issued `CONTROLLER_CAPABILITY_TOKEN` (jobs:status, jobs:reconcile), and `EXECUTION_BACKEND=modal` is refused (fail closed) until a qualified ModalExecutor exists. `verify-platform` refuses to run outside `APP_ENV=local`; the production processor (Modal) is deferred and is not represented by any health smoke.
- **Postgres** (`stateaction-db`): `ipAllowList: []`.
- Region `ohio` for all three (listed as valid for workflows in the current Blueprint spec). Plans are proposals: `starter` web, `basic-256mb` Postgres; check current pricing before applying.

## Database roles and migration order

Render one-off jobs inherit the service's environment (no per-job injection), so owner credentials are **not** given to any service. The owner path is explicit and operator-run:

1. Apply the Blueprint (below). The web service starts; `/api/v1/live` is 200, `/api/v1/health` is 503 until migrated.
2. Temporarily add your operator IP `/32` to the database access list (Dashboard → database → Access Control). Remove it afterwards; a later Blueprint sync also resets it to `[]`.
3. From a trusted machine, using the **External Database URL** and the same `APP_DB_PASSWORD` you gave the web service:
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
| operator shell | `MIGRATION_DATABASE_URL`                   | owner external URL; never stored in Render env                                                                                  |

`BETTER_AUTH_SECRET` is `generateValue: true` (distinct per environment, web only). Literal config in the Blueprint: `NODE_VERSION=24.22.2`, `APP_ENV=production`, `S3_REGION=auto`, `SUPPORTED_RGB_PROFILES=h264_mcap_v1`; `PROCESSING_PROFILE_REVISION` is prompted (`sync: false`, web only) because the pinned processing profile revision is an operator decision per environment, and preflight refuses to start without it; `DATABASE_HOST/PORT/NAME` come from `fromDatabase`. Job admission (SA-25) records a permanent input identity on every admitted job: the four `PROCESSING_*` rows above are prompted (`sync: false`, web only, never defaulted or placeholders) and `PROCESSING_MODEL_SHA256` is the literal accepted CPU model pin (MediaPipe Hand Landmarker full float16 task bundle v1). `hosted:preflight` refuses to start without all five, and `/api/v1/health` reports `checks.jobs=false` (status degraded, 503) outside local development when any is missing, so a reachable database and bucket never read as a working pipeline. Controller and cron credentials are not Blueprint values: an operator issues them with the owner credential (`issue-service-capability`), then enters each token once as a secret of the service that uses it (SA-26 wires the controller; this ticket deploys no workflow, Modal or cron resource). R2 credentials are backend-only and never reach the mobile app or the workflow.

Simulated emulator capture (SA-71) is **never** enabled on Render: `ALLOW_SIMULATED_CAPTURE_INPUTS` must not appear in the Blueprint or any hosted environment (the server treats its presence outside `APP_ENV` local/development, or alongside Render-injected variables, as a startup configuration error that `hosted:preflight` reports), and `SUPPORTED_RGB_PROFILES` stays `h264_mcap_v1`. See [simulated-capture-admission.md](simulated-capture-admission.md).

## Authentication settings (web only)

The Blueprint carries the auth settings contract of the SA-15 `authConfig`: `APP_ENV`, `BETTER_AUTH_URL` (HTTPS public origin), `BETTER_AUTH_SECRET` (≥32 random chars), optional `AUTH_TRUSTED_ORIGINS` (exact HTTPS origins, no wildcards) and `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` (both or neither). `AUTH_LOCAL_PASSWORD` (seeded email/password) is local/development only, refused on Render, and is never in the Blueprint. The unsupported overrides `BETTER_AUTH_TRUSTED_ORIGINS` and `BETTER_AUTH_SECRETS` must never be set. The workflow service receives none of these, nor database, R2 or Google credentials (enforced by `infra/test/blueprint.test.mjs`).

SA-15 is **not merged**; this branch contains no auth code and does not show that auth works. Integration contract to apply when both land: `authConfig(env, { resolveDatabaseUrl: applicationDatabaseUrl })`, where `applicationDatabaseUrl` is exported from `@stateaction/server` (builds the `stateaction_app` DSN from `DATABASE_HOST/PORT/NAME` + `APP_DB_PASSWORD`; production rejects any other role). Before relying on per-client rate limits behind Render's proxy, its forwarded-IP header behavior must be measured; it has not been. Until then the auth ingress mode on Render is an open gate.

## Exact eventual commands

```sh
render whoami && render workspace current         # tea-dbfshol9fdbs73c5408g (stateaction)
render blueprints validate render.yaml
# Dashboard: New → Blueprint → timothywangdev/stateaction → render.yaml (fill the sync:false prompts)
render workflows versions list <workflow-id> -o text
render workflows tasks list <ready-workflow-version-id> -o text
```

Prerequisites found by validation on 2026-11-01: the workspace has no payment information (`need_payment_info`) and the private GitHub repository is not connected to the workspace (`cannot find repo`, `branch main could not be found`). Result: `valid: false`. Structural and plan checks passed (probe with a deliberately wrong field/plan reports schema errors first), but repository- and billing-dependent checks were not fully reached, so full validation is pending account setup. **No resources were deployed.** No Render API key is provisioned; add a least-privilege one only when a dispatch feature needs it. Auto deploy is `off`, so a merge never ships by itself.

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
pnpm exec nx run infra:integration --skip-nx-cache   # local runner smoke + presign + hosted-mode smoke
bash scripts/platform/hosted-smoke.sh                # hosted mode only: PORT=10000, injected env, no .env
```
