# Recording registration, seal and admission (SA-19)

Server module `packages/server/src/admission/` with additive migration `004_ingest_admission.sql`. It registers recordings, freezes the declared source inventory and runs the one eligibility transaction that queues the first processing job once every required input is uploaded. It runs no processing (no Render Workflow or Modal call). Its only storage-provider call is the bounded GET of the completed source manifest (≤ 1 MiB); it never reads MCAP/media and never proxies source bytes. Multipart reservation/signing/completion transport belongs to SA-20/SA-21; claims and execution belong to SA-25.

## Permission evidence

Before collection is enabled, an operator records pilot permission evidence covering capture **and** automated processing (approved design, `auth-and-access.md`). `ingest_permissions` holds one row per approval: `permission_ref` (revision label), immutable `owner_user_id`, `pilot_scope`, `covers_capture`, `covers_processing`, `evidence_ref` (a pointer to the operator's evidence document), `recorded_by`, and `status` `active` → `revoked` (one way; renewal is a new row and a new ref). At most one row per owner is active. Rows are never deleted and identity/coverage never changes (trigger, `SAC01`/`SAC04`).

Only the migration-owner credential writes evidence: `pnpm --filter @stateaction/server ingest-permission record|revoke|list` (`MIGRATION_DATABASE_URL`; local development may reuse the loopback owner `DATABASE_URL`). The web role can only `SELECT` the table and call `ingest_permission_ok(id, owner, need_processing)`, a `SECURITY DEFINER` helper that locks the row `FOR SHARE` and returns a boolean. No request field, client checkbox or collector role grants permission. This is not a policy engine or admin UI.

## Registration — `POST /api/v1/recordings`

Body: `http.recording-create.v1`, read with a 1 MiB bound before allocation (declared `Content-Length` and streamed bytes), then validated byte-exactly. The owner is the authenticated principal from the SA-15 Better Auth session; the body has no owner field.

- Requires an enabled `collector` role and the owner's active evidence covering capture (`403 forbidden` otherwise).
- Idempotency scope (owner, `recordings.create`, `clientRecordingId`) with the `sa-cjson-v1` digest of the exact request. An identical replay (any whitespace/key order) returns the original recording with 200. Any changed field is `409 idempotency_conflict`, including an equivalent but differently spelled `startedAt` (`…00Z` vs `…00.000Z`), because the published digest is defined over the request value, not the database instant. Another owner's identical client ID is a separate recording.
- `recording_registrations` (immutable) stores the digest and binds the approval (`ingest_permission_id`, `permission_ref`). A recording created by the SA-13 helper without this row is never adopted: a create with its client ID conflicts.
- Response data: published `http.recording-registration.v1` (registry `catalog.v3.json`) = `{ recording: <unchanged http.recording.v1>, collectionPermissionRef }`. The phone copies `collectionPermissionRef` into its `recording-source/v1` `collection_permission_ref`. It identifies server state and is never accepted back as authority; the create body has no owner or permission field (closed schema, 422).

## Seal — `POST /api/v1/recordings/{recordingId}/seal`

Body: `http.recording-seal.v1` (contract rules: unique file IDs; exactly one required `source_manifest`, one required `source_mcap`, at least one required `recorder_metadata`). Missing sidecars fail validation (422).

- The seal must equal the reserved live source inventory exactly (file ID, role, size, digest, requiredness); otherwise `409 conflict`. Other owners get 404.
- Order is not meaningful: the digest is `sa-cjson-v1` over the inventory sorted by `fileId`. An identical replay in any order returns the recording and re-runs the idempotent eligibility step; a changed seal is `409 idempotency_conflict`.
- The seal sets the SA-13 pointer (`source_manifest_file_id`/`sha256`), inserts the immutable `recording_seals` row and runs the eligibility step in the same transaction. SA-13 rules still apply: no file joins after seal, no declared file is retired after seal, transport restarts keep the logical file.
- Response data: `http.recording.v1`.

## Final completion and recovery

`recordSourceCompletion(deps, principal, {recordingId, fileId, expectedTransportEpoch, observedSizeBytes})` is the database side of completing a source file. SA-21 calls it only after the provider completed the multipart upload and the size was verified. It locks the recording, marks the current epoch completed (exact replay accepted; stale epoch/size conflicts) and runs the eligibility step in the same transaction. `admitRecording(deps, recordingId)` re-runs the step for recovery.

## Eligibility transaction

`admitInTransaction` is shared by seal, completion and recovery. Lock order: recording row `FOR UPDATE` → source file rows → evidence row `FOR SHARE`. Revocation only updates the evidence row, so it is ordered entirely before or after any admission and cannot deadlock with it.

1. An existing admission row is returned unchanged (idempotent).
2. Not sealed → `awaiting_seal`. Any required live file not completed → `awaiting_uploads`.
3. The completed manifest bytes are read **outside** the transaction through an `ObjectReader` with a 1 MiB bound (only for a completed or now-completing manifest; never MCAP/media/depth/frames). Inside the transaction the row must still name the same object key/epoch. Missing or failed reads → `awaiting_manifest_bytes` (retryable); a failed pre-read is retried once per call.

   Production uses `s3ObjectReader` (`src/admission/object-reader.ts`) on the existing backend S3/R2 client and settings. It requests `Range: bytes=0-<limit>` and refuses an object whose `Content-Range` total or `Content-Length` exceeds the limit before consuming any body byte. A body of unknown length (a store that ignores `Range` and sends no length) is counted and the stream is cancelled as soon as it would exceed the limit, never drained. 404, 5xx/throttling, timeouts (including a stalled body), connection resets and truncated bodies raise `ObjectReadUnavailableError`, so admission stays pending/retryable. Exact size and SHA-256 are verified afterwards against the pinned seal digest.

4. Evidence row `FOR SHARE`: not active or not covering capture + processing → `blocked_permission` (nothing durable).
5. Bytes whose size/SHA-256 do not match the pinned seal digest, or an oversized object → `manifest_unverified` (retryable, nothing durable).
6. With verified bytes: `validateBytes("artifacts.recording-source.v1")` (including the shared rule tying channel clocks to `clock_domains`), recording/client/owner identity, capture format and RGB profile equal to the registered recording, closed `close_status`, `collection_permission_ref` equal to the registered ref and `checkSealedInventory(seal, declaration)` (order independent). A failure here is deterministic for immutable bytes, so it is recorded once as a `rejected` admission with a stable code and the recording becomes `failed`. Declared `counts` are independent totals (dropped frames may exceed written frames) and are left to the worker.
7. Configuration-dependent last: an RGB profile outside the current `SUPPORTED_RGB_PROFILES` allowlist → `deferred` / `profile_unsupported` (retryable after a configuration change; nothing durable).
8. Otherwise one transaction inserts the `admitted` evidence row (manifest digest, capture format/profile, `capture_config_sha256`, close status, clock domains, declared files, calibration file IDs, counts, channel count, permission ref) naming a new job ID, the `queued` job pinned to the source digest and `PROCESSING_PROFILE_REVISION`, and `current_job_id`/status `uploaded`.

The worker still independently verifies source bytes and capture evidence later.

## Database enforcement

- `jobs_ingest_guard` (BEFORE INSERT on `jobs`) fails closed for every credential and helper: the recording needs a registration bound to active evidence covering capture and processing, and an `admitted` admission whose digest matches. The first attempt must be exactly the admitted job ID; retries need the same admitted recording. Records created before 004 or by the SA-13 helper without evidence stay readable but are not processable until an explicit operator/fixture step establishes evidence. Nothing is auto-adopted.
- `establishFixtureAdmission` (`src/admission/fixtures.ts`) is that explicit step for the local seed and SA-13 tests. It needs the owner credential (it writes `ingest_permissions`) and labels everything as fixture evidence.
- `recording_admissions_guard` re-checks the registered approval when an admitted row is written and refuses one after a job exists. Registration, seal and admission rows are immutable.
- `stateaction_grant_app_role` keeps the 003 body (renamed `stateaction_grant_app_role_003`) and additionally grants `SELECT` on the four new tables, `INSERT` on registrations/seals/admissions and `EXECUTE` on `ingest_permission_ok`. Functions pin `search_path = pg_catalog, public, pg_temp` and qualify relations. 001–003 bytes are unchanged.

## HTTP boundary

`recordingRoutes({pool, reader, config, authenticateCollector})` returns web-standard `Request → Response` handlers (`create`, `seal`, `get`). Construction fails without an authentication boundary; there is no unauthenticated fallback. Responses use the v1 success/error envelopes and private no-store headers; database messages never leave the server. Error mapping: 401, 403, 404, 409, 413, 422, 500, and 503 for an unavailable auth/configuration.

Production binding (`@stateaction/server/recordings`, `src/admission/next.ts`) serves `POST /api/v1/recordings`, `POST /api/v1/recordings/[recordingId]/seal` and `GET /api/v1/recordings/[recordingId]` from `apps/web/app/api/v1/recordings/`. `collectorAuthenticator` runs the SA-15 `authenticateHuman` guard with `anyRole: ["collector"]` on every request: the Better Auth session is re-read (refreshed `Set-Cookie` is forwarded on success and error responses), the enabled role is re-read from operator-managed `access` rows, mutations need a trusted `Origin`/same-origin Fetch Metadata (browsers) plus the `x-stateaction-client` header and a JSON body, and any `Authorization` header is refused. The routes share the auth runtime's restricted `stateaction_app` pool (same `applicationDatabaseUrl`, same Better Auth instance); no owner credential, fixture identity or test header exists in the service.

Configuration is explicit: `PROCESSING_PROFILE_REVISION` and `SUPPORTED_RGB_PROFILES` (`admissionConfigFromEnv`), web-only. `admissionDepsFromEnv(pool)` composes the restricted application-role pool, `s3ObjectReader(serverConfig())` and that config; local, development and Render differ only by injected environment. The hosted preflight (`hosted:preflight`, run by the Render start command) refuses to start without valid admission settings. `render.yaml` prompts for `PROCESSING_PROFILE_REVISION` per environment (`sync: false`, an operator decision, never defaulted) and sets `SUPPORTED_RGB_PROFILES=h264_mcap_v1`, the only profile the code accepts.

## Validation

`pnpm exec nx run server:integration` runs `test-integration/admission.test.ts` on a throwaway Postgres 17.9 with a NOSUPERUSER CREATEROLE migration owner and the restricted `stateaction_app` role. It covers registration replay/digest conflicts and concurrency, other-owner denial, missing sidecars, both seal/completion orders, 12-way concurrent seal/completion/recovery with exactly one job (5 rounds), manifest rejection codes, retryable digest/size/read failures and allowlist deferral, capture-only/revoked permission, revocation/admission lock serialization in both orders, injected database faults with rollback and retry, fail-closed job inserts for registered-without-admission and legacy recordings, and real-socket HTTP route shapes (201/200 replay, 401, 403, 404, 409, 413 declared and streamed, 422). Evidence: `artifacts/catalog-integration/admission-evidence.json`.

The same script also starts a throwaway SeaweedFS (pinned `infra/compose.yaml` image, ephemeral loopback port, random per-run identity). `test-integration/object-reader.test.ts` exercises the real `s3ObjectReader` against it, directly and through a fault-injecting proxy: exact bytes at and below 1 MiB and empty objects; known-length 1 MiB + 1 and 8 MiB objects refused with at most limit + 1 bytes transferred; an 8 MiB unknown-length chunked body cancelled mid-stream (upstream never drained); 503, stalled body (timeout), mid-body reset, missing object and unreachable endpoint as retryable unavailability; and admission through stored manifest bytes (transient failures stay pending then recover to exactly one job; oversized/tampered stored bytes never admit and recover once the genuine bytes are stored). Evidence: `artifacts/catalog-integration/object-reader-evidence.json`. Select files with `bash packages/server/scripts/catalog-integration.sh test-integration/<file>.test.ts`.

`pnpm exec nx run web:auth-e2e` also runs `apps/web/test-e2e/recordings.e2e.test.mjs`: the production `next build` served by `next start`, real Better Auth email/password sessions, a throwaway Postgres migrated by the published migrator (Next connects only as `stateaction_app`) and a throwaway SeaweedFS holding the manifest. It covers anonymous/bearer/cross-site/foreign-origin/header-less refusal, staff refusal, contract-valid create with exact replay (200), changed and differently spelled requests (409) and a smuggled owner field (422); another collector's 404 on read/seal/completion and an independent same client ID; seal-then-completion and completion-then-seal (four concurrent HTTP seals) each queuing exactly one job; an oversized stored manifest never admitting; permission revocation blocking create and admission with renewal as a new ref; role revocation on an existing session; refreshed-cookie forwarding; and no secret in responses or logs. Source reservation and completion call the SA-13 catalog and `recordSourceCompletion` directly.

**Not covered here:** real R2 reads (SeaweedFS only; R2 is exercised separately by the operator), the SA-20/21 multipart upload routes (which will call `recordSourceCompletion`), Google sign-in, the Android app against these routes, Tailscale and hosted Render qualification.
