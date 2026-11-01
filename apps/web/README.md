# Web and API foundation

Node 24 / Next.js App Router. From the repository root, `pnpm --filter @stateaction/web... build` builds this app and its shared dependencies; `pnpm --filter @stateaction/web typecheck` generates route types and checks TypeScript.

`GET /api/v1/health` checks migrated Postgres and the configured S3 bucket. It returns only readiness booleans, never credentials/provider errors. `POST /api/v1/development/workflows/verify` is a bounded, bearer-protected local smoke endpoint. It refuses production and non-loopback workflow endpoints. It is not product authentication or a recording job API.

Start with `make web` after the setup in [local tooling](../../scripts/platform/README.md). `@stateaction/server` uses Next's `server-only` guard; provider code must not be imported into client components.
