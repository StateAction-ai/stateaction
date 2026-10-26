# Backend implementation

Node reference option · reviewed 2026-10-26 · Not deployed. [Current hosting choices](hosting-evaluation.md) supersede the earlier Node/Lightsail recommendation; frontend Next.js is confirmed.

Parent: [Technical design](../technical-design.md). Shared wire contracts: [contracts](../contracts.md). Component contracts: [auth](auth-and-access.md), [storage](storage-and-data-model.md), [orchestration](job-orchestration.md).

## Build target

If selecting the standalone Node option, build one owned **Node.js 24 LTS / TypeScript / Fastify** service under `backend/`. Use Supabase PostgreSQL, one qualified identity authority, private object storage and the selected workflow engine. Next.js under `console/` may share that origin or have separate managed hosting. Python processing runs on Modal.

This document describes the Node option, not a finalized hosting choice. Supabase Edge/Deno remains the managed API alternative; Next.js server rendering does not require moving the domain API there. Implement one identity authority and domain-write path. The cloned Stera server supplies mobile protocol fixtures only; do not import its business logic.

Node 24 is an LTS line through April 2028. Temporal's TypeScript Workers officially require supported Node runtimes; Bun compatibility does not establish equivalent Worker support. Node keeps that alternative available without changing the API runtime. [Node schedule](https://github.com/nodejs/Release/blob/main/schedule.json), [Temporal requirements](https://github.com/temporalio/sdk-typescript#requirements)

## Modules and processes

Use a modular service, not separate microservices. Run the API and a supervised outbox/reconciler as separate entrypoints, initially on the same host. The latter publishes committed events and repairs incomplete external operations; Inngest owns workflow progression. Neither process decodes MCAP or runs models.

| Target | Responsibility |
| --- | --- |
| `backend/src/app.ts`, `api.ts` | Testable Fastify composition, startup, health and shutdown |
| `backend/src/modules/auth/`, `access/` | Better Auth adapter, enrollment, principal and authorization |
| `backend/src/modules/recordings/`, `uploads/` | Capture registration, seal, canonical multipart lifecycle |
| `backend/src/modules/processing/` | Admission, attempt claims, batch ownership and final acceptance |
| `backend/src/modules/reviews/`, `releases/`, `downloads/` | Exact-revision approval, publication and recipient access |
| `backend/src/db/` | Drizzle schema, reviewed migrations, bounded connection factories |
| `backend/src/adapters/` | Object storage, Modal and workflow provider clients |
| `backend/src/workflows/`, `workers/` | Inngest definitions, outbox/reconciliation entrypoint |
| `backend/src/contracts/`, `tests/` | Bindings/runtime validation generated from `processing/contracts/`; client fixtures and integration/fault tests |

Fastify provides route schemas, lifecycle hooks and module boundaries. Drizzle keeps SQL/transactions visible. Better Auth handles identity protocols; our code owns authorization. Pin supported library versions and test their actual Node integrations. Preserve multiple `Set-Cookie` headers, trusted external URLs and callback body formats in the auth adapter. [Fastify support](https://fastify.dev/docs/latest/Reference/LTS/), [Better Auth integration](https://better-auth.com/docs/integrations/fastify)

Domain services own short database transactions. Routes validate/adapt requests; repositories require explicit resource scope. Network calls occur outside transactions and finish through conditional commits. Do not add a generic framework that hides those boundaries.

## Compatibility and cutover

1. Capture credential-free mobile fixtures for auth cookies, errors, integer encoding and upload requests. Preserve required behavior, not unsafe implementation quirks.
2. Build against isolated database/buckets. Preserve existing opaque identity IDs and provider associations where real data exists; never remap recordings by email alone.
3. Move one complete route group at a time behind the same origin. Auth has one authority; every multipart session has one writing service for start through completion/abort.
4. Map legacy assets into canonical recording/file records as unverified. Disable direct user-delete bypasses and fail-open upload starts before enabling new writers.
5. Qualify signed iOS/Android builds: login, rotation, offline ownership, account switching, interrupted upload and cloud verification. Drain old sessions before retiring old credentials/server.

Acceptance requires a clean build without cloned-server imports, real Postgres isolation tests, safe shutdown/restart, compatible native sessions and the component fault tests. Hosting size, provider credentials and production rollout remain explicit implementation decisions; cost estimates live in [operations](operations-and-costs.md).
