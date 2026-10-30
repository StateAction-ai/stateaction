# Render deployment specification

MVP design · updated 2026-10-30 · Not implemented or deployed.

Parent: [technical design](../technical-design.md). See [backend](backend-architecture.md), [jobs](job-orchestration.md), [storage](storage-and-data-model.md) and [operations](operations-and-costs.md).

## Four Render services

| Service | Starting configuration | Responsibility |
| --- | --- | --- |
| `repair-web` / Web Service | Node.js 24, one 1CPU/2GB instance; $25/month | Next.js UI/API, Better Auth, all database mutations and multipart issuance/completion |
| `repair-db` / paid Postgres | PostgreSQL 17, 1GB RAM; $19/month plus roughly $3 for 10GB disk | Identity and seven domain tables; built-in PITR |
| `repair-workflows` / Workflow | Node.js 24; two bounded task definitions | Orchestrate `process-recording` / `export-release` through APIs and the execution adapter |
| `repair-jobs` / Cron Job | Every minute UTC; bounded pass, 45-second application deadline | Request bounded dispatch/status reconciliation through the API |

R2 stores files; Modal runs CPU functions `process_recording` and `export_release`. Mandatory hand inference uses the qualified MediaPipe CPU profile. No default GPU, backup cron or separate queue service is required. Cron has a $1/month floor; workflow active CPU/RAM is additional. Polling is not assumed to suspend billing. Base web/database allowance is **about $47/month**, plus cron/workflows/R2/Modal; Render Pro adds $25 if needed. [Next hosting](https://render.com/docs/deploy-nextjs-app), [workflow billing](https://render.com/docs/workflows-limits), [prices](https://render.com/pricing)

## Repository and builds

The [monorepo plan](../implementation-plan.md) owns migration order. These are target paths, not moves authorized during recording fixes:

- `apps/web`: Next app; `apps/jobs`: shared workflow definitions/executors and repair-cron entrypoint.
- `packages/server`: domain/auth/DB/R2 code and migrations; `packages/contracts`: schemas/fixtures.
- `apps/mobile`, `packages/stera_recorder`, `packages/stera-sdk`: existing Flutter/plugin/SDK sources.
- `workers/processing`: Python/uv; `infra/render.yaml`: future Render definition.

Use a root pnpm workspace/lockfile for TypeScript, separate Flutter pub/Python uv locks. Leave Render Root Directory blank for shared packages. Web builds include web/server/contracts; workflow and cron builds include jobs/contracts with distinct entrypoints. Build filters include shared dependencies, root lock/config and relevant infrastructure changes. Verify production tracing; no Turbo/Nx/Melos layer is needed.

## Networking and secrets

Place services in the same workspace/region. Bind Next to `0.0.0.0` and Render's `PORT`. Public HTTPS handles users/Modal callbacks. Workflow/cron use the web service's private origin where supported, with service authentication. Readiness checks DB/schema briefly, starting no processing. Qualify workflow private connectivity before enabling network-isolated environments. [Private networking](https://render.com/docs/private-network)

| Secret/configuration | Holder |
| --- | --- |
| `APP_ORIGIN`, Better Auth/Google configuration, `API_DATABASE_URL`, R2 signing credentials | Web only |
| Controller internal token; matching verifier | Workflow service; verifier in web |
| Repair internal token; matching verifier | Cron; verifier in web |
| Workflow dispatch credentials/client origin | Web only; official local client in development |
| Modal control credentials and pinned function/environment references | Hosted workflow service only |
| `INTERNAL_API_ORIGIN`, public callback origin | Intended workflow/repair configuration |
| Scoped job capability, fresh execution nonce, public callback origin | Specific Python invocation only; no DB/general storage/control credentials |
| Migration URL | Explicit migration command only |

Keep credentials out of browser variables/shared secret groups. [Storage](storage-and-data-model.md#database-access) owns DB role/TLS details. Private pages/routes use current authorization; media transfers go directly to R2.

## Development and activation

Run the same TypeScript tasks with Render's official local Workflows runner on port 8120. `EXECUTION_BACKEND=local|modal` selects Python `LocalExecutor` or `ModalExecutor`. Postgres/MinIO use `infra/compose.yaml`; MediaPipe CPU needs no GPU. An optional qualified CUDA profile uses local hardware. [Local development](local-development.md)

After deployment authorization, migrate once, configure origins/allowlisted users and deploy Python functions/web/workflows/cron. Keep admission disabled until signed-device uploads, controller/submission recovery, hand quality/license, export/download and PITR restore checks pass. Preview environments receive no production secrets. Rollback pauses starts and preserves active calls, rows and files.
