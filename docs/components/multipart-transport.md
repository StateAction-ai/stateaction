# Multipart transport (SA-20)

Status, 2026-11-02: **control plane implemented and bound to Next routes on top of merged SA-19 (`cb5edee`, migration 004).** Tested against real Postgres (restricted role), real SeaweedFS and the production `next start` build with real Better Auth sessions. Real R2 behaviour is not qualified by this ticket's workers; the root runs the scoped R2 probe. The worker output contracts are **published in `catalog.v5`** (`http.output-create.v1`, `http.output-plan.v1`) on top of merged SA-16 `catalog.v4`.

All media moves directly between the client and private object storage through short-lived presigned `UploadPart` PUTs. The API only handles bounded JSON control bodies.

## What exists

`packages/server/src/transport/`

| File           | Responsibility                                                                                                                                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plan.ts`      | The frozen plan: 64 MiB parts, at most 10,000, 100 GiB transport cap, at most 32 numbers per control request. Pure functions.                                                                                    |
| `provider.ts`  | `MultipartProvider` interface and the S3-compatible implementation (SeaweedFS locally, R2 hosted): exact-key upload listing, create, paginated `ListParts`, presigned `UploadPart`.                              |
| `authority.ts` | Live authorization. A caller is `owner` (collector session) or `job` (worker principal). Every call re-reads role, session, recording owner and job state.                                                       |
| `service.ts`   | `allocateSourceUpload`, `allocateJobOutput`, `initializeTransport`, `getUploadPlan`, `signParts`, `journalReceipts`.                                                                                             |
| `http.ts`      | Framework-neutral Web `Request`/`Response` handlers, the bounded JSON reader and the published error envelope.                                                                                                   |
| `next.ts`      | Next binding (`@stateaction/server/uploads`): owner authority from the Better Auth session guard, worker authority from `authenticateService(job:output)`; 404 for malformed IDs, 503 for configuration failure. |
| `runtime.ts`   | `transportDepsFromEnv` (same `S3_*`/database settings as the rest of the server) and `JobCapabilityStore`, which resolves a worker bearer only against the live `running` job row.                               |

Routes (`apps/web/app/api/`):

| Route                                                                                                                                             | Caller                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `POST /api/v1/uploads`, `GET /api/v1/uploads/{fileId}`, `POST …/parts/sign`, `PUT …/parts/receipts`                                               | collector session (cookie), never a bearer                     |
| `POST /internal/v1/jobs/{jobId}/outputs`, `GET …/outputs/{fileId}`, `POST …/outputs/{fileId}/parts/sign`, `PUT …/outputs/{fileId}/parts/receipts` | worker bearer bound to that job (`job:output`), never a cookie |

Migration: `packages/server/migrations/005_multipart_transport.sql` (see [Migration](#migration)).

## Guarantees

1. **Reserve before provider.** `reserveSourceFile` (SA-13) or the output reservation inserts the `files` row with the server-chosen key `recordings/<rec>/sources/<file>/e<epoch>/<role>` or `jobs/<job>/outputs/<file>/e<epoch>/<slot>` before any provider call. Clients never send keys, buckets, owners, job IDs, ranges or part sizes.
2. **Provider ID persisted before URLs.** Creation runs outside any DB transaction behind a leased claim. The upload ID is written to `files` (write-once per epoch, enforced by a trigger) before `signParts` will issue anything. An uncertain earlier creation (lost response, DB failure after provider success) is reconciled by listing the exact key and adopting the single upload. It is never blindly repeated. Several uploads for one key are `provider_ambiguous` and block progress.
3. **Server-validated plan.** Part numbers (integers, unique, within the frozen plan, at most 32), offsets, lengths, count and byte caps, role and `expectedTransportEpoch` are checked on every request. Each presigned URL binds the exact part length (`content-length` is a signed header; a longer body is refused by the provider). Small manifests and worker outputs also use multipart (one part).
4. **Receipts are exact, durable, idempotent and corroborated.** `{partNumber, etag, sizeBytes}` is checked against the planned length, then confirmed against the provider's `ListParts` before it is journaled in `file_part_receipts`, so a client cannot invent receipts. An identical replay is a no-op. A different ETag for a journaled part is accepted only when the provider confirms it (a re-uploaded part); otherwise it conflicts. The database independently rejects receipts outside the plan or epoch.
5. **No revived authority.** Owner calls need an unexpired session row of that user, an enabled `collector` role, an owned, non-deleted recording and the recording's registered collection permission still active (`ingest_permission_ok`, so revoking the evidence stops uploads at once). Job calls need a `running` job inside its deadline, and the file's own `job_id`. Humans cannot reach output files and workers cannot reach source files. A stale epoch is `409`. A restart (SA-21) starts a new epoch with no receipts.
6. **Worker outputs.** Idempotent per server-validated `slot` (a safe relative path unique within the job). Caps: 32 GiB per file, 64 GiB and 512 files per job. The route layer calls `authenticateService({ kinds: ["worker"], scope: "job:output", jobId })` against `JobCapabilityStore`: the bearer's SHA-256 must equal `jobs.capability_token_sha256` of a `running` job inside its `execution_deadline` (no deadline means no authority), for audience `stateaction-api`. Issuing the capability is the controller's (SA-21) job; this ticket only consumes it and adds the `job:output` scope.
7. **JSON only.** `readBoundedJson` requires `application/json`, rejects a declared length over 16 KiB, and cuts an undeclared stream off at the bound without buffering it. Responses carry `cache-control: no-store` because they hold bearer URLs. URLs are never logged or persisted.

## Not claimed

- **ETags and the R2 multipart ETag are provider receipts**, not the whole-file SHA-256. The declared `sha256` is stored immutably and verified later by processing (SA-21/22). Nothing here marks a file `verified`.
- Completion, reconcile, cancel and restart are SA-21. These tests complete an object directly with the SDK only to prove the journal is usable.
- SeaweedFS lists a re-uploaded part number more than once, so a receipt is corroborated by any exactly matching entry. S3 and R2 list one entry per part. Qualify R2 behaviour separately.
- `http.upload-plan.v1` enumerates source roles only and stays exactly as published. Worker outputs use the closed `http.output-create.v1` request (`{slot, role, sizeBytes, sha256}`, 4 KiB cap; the job comes from the path and credential, never the body) and `http.output-plan.v1` response (the upload-plan shape with `outputFileRole`, 16 KiB cap, same `upload_plan` part-count rule), added by the additive `catalog.v5` (`/internal/v1`). The Next handlers read the request with `http.output-create.v1` and check every plan they return against `http.upload-plan.v1` (human) or `http.output-plan.v1` (job); there is no unregistered body path. Server-enforced limits the schema cannot express: 32 GiB per file, 64 GiB and 512 files per job, slot idempotency (same slot with different content is `409`).
- Remaining outside this ticket: real R2 qualification (root probe), hosted CI and the Render deployment of the routes. No new environment variables or services are needed.

## Migration

`005` follows the published `004` and is applied by the real migrator; `001`-`004` are byte-identical to main (hash-pinned in `migrations.test.ts`). `grantAppRole` calls `stateaction_grant_transport` when present, so the restricted role gets exactly: `SELECT, INSERT` on receipts and output slots, `UPDATE (etag, corroborated_at, updated_at)` on receipts, and full access to the claim table. It gets no `DELETE` on receipts or slots; `transport-grants.test.ts` asserts the matrix and idempotent re-granting.

## Tests

`pnpm --filter @stateaction/server test` covers plan arithmetic and the bounded reader with no services. `pnpm exec nx run server:integration` (uncached) starts a throwaway Postgres and a real SeaweedFS on ephemeral loopback ports and runs the transport suites with the catalog suites: direct presigned PUTs, signed-length enforcement, receipts, completion of the journaled object, provider outage/lost response/ambiguity/DB failure, concurrent initializers and receipt writers, revoked sessions and roles, stale epochs, output caps and database-level guards.

The Next layer is covered by `test/transport-next.test.ts` (authority resolution, fail-closed configuration) and `apps/web/test-e2e/uploads.e2e.test.mjs` (`nx run web:auth-e2e`, uncached): owner, other-collector, wrong-role, pending, disabled, expired and deleted sessions, revoked role and permission, worker capability (other job, expired deadline, finished job, cookies), malformed/oversized/truncated bodies, duplicate and racing requests, and a paused provider.
