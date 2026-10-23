# MCAP capture handoff and resumable upload

Status: proposed implementation design; no application changes or cloud resources are created by this document. Design date: 2026-10-22. Ownership: mobile capture/upload and backend ingest engineers.

Read with the [main technical design](../technical-design.md), [authentication and access](auth-and-access.md), [storage and data model](storage-and-data-model.md), [cloud processing](cloud-processing.md), and [durable job orchestration](job-orchestration.md).

## 1. Decision and boundaries

Reuse the Flutter recording application's normalized Drift queue and native iOS background uploader only after their behavior passes the acceptance scenarios below. Use direct S3 multipart transport to private object storage, with R2 as the qualification target and AWS S3 as a fallback. The API carries small authenticated control requests, never the entire MCAP body.

The cloned Stera backend is an inspected protocol reference, **not the production baseline**. Existing Hono/Bun routes, Better Auth integration, database tables and R2 helpers provide evidence about today's client behavior; their presence does not select the production runtime, framework, identity implementation or deployment platform. Build the owned backend under root `backend/` after independent runtime/service review. Implement the contracts below there, and rewrite unsafe reference handlers rather than copying their failure behavior. Existing source links remain evidence and migration references.

The device finalizes files and transfers bytes. A cloud CPU worker independently verifies and reads MCAP. Subsequent extraction, pose estimation, annotation and dataset conversion run on cloud workers. No device-side inference is part of this plan.

An uploaded object is not a validated recording, a validated recording is not a reviewed episode, and an internally approved episode is not automatically a published delivery. This component ends at the verified ingest handoff; internal review and customer delivery are separate application workflows.

### Required invariants

1. Only a finalized, immutable source file can obtain a frozen multipart plan. A file still being written never enters the transferable queue.
2. Every local and server upload binds an authenticated creator, organization, recording, file identity and exact source-byte identity. Switching accounts never reassigns queued files.
3. The server generates object keys. Requests use opaque upload/file IDs rather than accepting arbitrary bucket names, storage keys or provider upload IDs.
4. One durable upload session owns one fixed source length, SHA-256, part size and provider multipart identity. Resuming cannot silently change the plan.
5. Database failure cannot degrade into an untracked fresh multipart upload.
6. Part receipts, provider reconciliation and byte length establish transport progress. A server-computed full SHA-256 and MCAP validation establish ingest eligibility.
7. Completed source keys are never overwritten. Replacement bytes receive a new file identity and key.
8. Transfer completion schedules processing only when the recording is sealed and every required file is uploaded. The first physical CPU job is `ingest_capture`; it performs validation, extraction, compact QC and preview creation using one raw download. GPU work remains blocked until accepted ingest verification and the processing policy permit it.

## 2. What exists today

These are observations of the current checkout, not claims that the proposed architecture is implemented or approved for production reuse. Another agent is modifying the application; implementation must recheck the latest source before applying changes. Mobile reuse is an audited, testable choice. Cloned server code remains a protocol/migration reference while the owned backend is designed independently.

| Existing implementation | Reuse and required extension |
| --- | --- |
| [MCAP finalization helper](../../stera-app/apps/mobile/lib/src/services/upload_service/utils/mcap_finalization.dart) checks trailing MCAP magic; [upload service](../../stera-app/apps/mobile/lib/src/services/upload_service/uploads_service.dart) rejects empty/unfinalized MCAP and refreshes the pre-plan file-size snapshot | Keep the local safety check. Add a writer-closed handoff and immutable-source/hash contract; trailing magic alone is not a complete MCAP validation. |
| [Drift sessions](../../stera-app/apps/mobile/lib/src/services/db/schema/upload_sessions.dart), [part rows](../../stera-app/apps/mobile/lib/src/services/db/schema/upload_parts.dart), [orchestrator](../../stera-app/apps/mobile/lib/src/services/upload_service/orchestrator/upload_orchestrator.dart) and [reconciler](../../stera-app/apps/mobile/lib/src/services/upload_service/reconcile/upload_reconciler.dart) persist progress and recover provider parts | Extend these rather than building another queue. Add owner/org/file IDs, source SHA-256 and the separate server-verification state. The existing path-derived idempotency key is not a content hash. |
| [Chunk sizer](../../stera-app/apps/mobile/lib/src/services/upload_service/chunk_plan/upload_chunk_sizer.dart) uses 16–64 MiB through 60 GiB and 128 MiB above; [planner](../../stera-app/apps/mobile/lib/src/services/upload_service/chunk_plan/upload_chunk_planner.dart) freezes contiguous ranges | Retain the established range planner and persist the negotiated plan version. Enforce the maximum part count on both sides. Its comment attributing the uniform-size requirement to both providers is too broad: the relevant stricter requirement is R2's. |
| [Presign manager](../../stera-app/apps/mobile/lib/src/services/upload_service/presign/presign_manager.dart) refreshes URLs just in time | Retain renewal of missing parts within the same multipart session. Bound requested part numbers and sign only authorized session ranges. |
| [Windowed coordinator](../../stera-app/apps/mobile/lib/src/services/upload_service/coordinator/windowed_upload_coordinator.dart) and [native background engine](../../stera-app/apps/mobile/ios/Runner/background_uploader/manager/ChunkWindowManager.swift) use a native journal and temporary chunk window | Keep the native lifecycle integration. Current coordinator defaults include a 16-part window and higher transfer concurrency; proposed pilot limits below are configuration changes that need physical testing. |
| [Hono upload routes](../../stera-app/apps/server/src/routes/upload.ts), [R2 adapter](../../stera-app/apps/server/src/lib/r2.ts) and [shared schemas](../../stera-app/packages/types/src/upload.ts) support multipart start, signing, ListParts, completion, finalization and abort | Introduce ID-based durable sessions; bind provider operations to their DB record. Existing start catches persistence errors and can create fresh untracked uploads. Existing finalize checks count, not an exact byte-range contract. |
| [Asset registration](../../stera-app/apps/server/src/routes/assets.ts) checks an owner-scoped path and inserts a pending asset | Replace its use as an ingest gate. An authorized path or an existing object does not prove valid MCAP, correct length or a verified source hash. |
| [Server schema](../../stera-app/packages/db/src/schema/app.ts) has basic `assets` and `upload_sessions` | Migrate compatibly to recordings/files/sessions and durable part receipts. Existing upload rows lack organization, expected length/hash, lifecycle state and verification evidence. |

Existing upload tests already exercise several recovery seams. Extend the [mobile upload test directory](../../stera-app/apps/mobile/test/src/services/upload_service/) and [DB migration tests](../../stera-app/apps/mobile/test/src/services/db/uploads_migration_test.dart); do not discard this coverage during API migration.

## 3. Recording package and immutable local handoff

### Logical package

One `recordings` row represents a capture session. Its `recording_files` include exactly one active `source_mcap` for the pilot and may include `capture_metadata`, `thumbnail` and explicit diagnostic sidecars. If a recorder produces multiple MCAP files, declare them as separate ordered file roles/segments; never concatenate them or infer segment ordering from lexicographic filenames.

Each file has `fileId`, role, original display filename, media type, expected bytes, expected SHA-256, actual server-observed bytes/hash, storage location, transfer state and verification state. Raw source filenames are display metadata; the storage key uses a generated safe name:

`{creatorUserId}/orgs/{organizationId}/recordings/{recordingId}/raw/{fileId}/source.mcap`

This preserves the application's `${userId}/…` owner-prefix rule while making organization ownership explicit. Bucket authorization still resolves database relationships; knowing a prefix is not permission. Other file roles receive separate generated keys and bounded allowed content types. Do not let a thumbnail PUT capability overwrite the source MCAP.

Before processing, the client explicitly seals the package's expected logical file inventory: role/segment identity, size, SHA-256, requiredness and approved processing-profile revision. For Android v3, the profile declares the required metadata/calibration inputs and whether they are embedded in MCAP or provided as sidecars. An omitted optional thumbnail is recorded explicitly. A late required metadata upload must not race an already-dispatched ingest job, and a metric profile must not silently become RGB-only because a required sidecar is missing.

The seal fixes source content and role identity. Transfer recovery may append an audited physical generation with a fresh file/key and the same role, bytes and hash; it cannot alter the sealed source identity. The finalized ingest input manifest resolves the exact accepted physical generations. Different source bytes or newly required files need a new sealed recording revision and new processing run; accepted earlier manifests remain immutable.

### Local handoff sequence

1. Recorder stops frame producers, drains its writer, finishes MCAP and closes all source handles. A native success event or a new atomic `ready` manifest confirms this handoff. Metadata creation by itself does not confirm that MCAP has finished.
2. Check both magic bytes, nonzero size and writer-close status; stat the file. Existing trailing-magic checks remain a useful compatibility fallback for older finalized sessions.
3. Create a local queue row with persisted random `clientRecordingId` and `clientUploadId`, creator user ID, organization ID, logical source role and a stable app-relative source URI. Persist IDs; do not derive the new IDs from an absolute sandbox path or an autoincrement row.
4. Stream the full source through SHA-256 once in a background isolate/native task with bounded buffers. Record byte count and the stat snapshot before and after hashing. If the file changed, discard the digest and leave it unready. A head/tail fingerprint or `SHA256(path:size)` remains a local lookup aid, not a full-file digest.
5. Ask the API to allocate/register the recording and each declared upload with its length/hash. Persist server identities and frozen part plans before scheduling transfers. Seal the expected inventory once all declared files are finalized/hashed; sealing may precede their byte transfer completion.
6. Stream or extract only the current bounded chunk window; retain the source untouched. Re-stat on resume and before creating more chunks. Source mutation, including a same-length replacement, invalidates the upload; mtime alone cannot prove byte identity. Any supported rewrite path must coordinate an exclusive immutable-file handle/version, or rehash before resuming after an unexplained change.

SHA-256 costs one sequential read, but avoids a second full file copy. A later optimization may calculate it in the recorder's finalized write path; that changes native code and needs its own validation. Do not hash a growing MCAP and call it the finalized digest.

The [MCAP specification](https://mcap.dev/spec) defines leading/trailing magic, a footer and valid record structure; optional summary sections and omitted optional CRCs must not cause false rejection. Local readiness is deliberately cheaper than the independent cloud parse.

### Owner and offline behavior

Recordings made offline bind to the last authenticated collector and selected organization. Cached membership permits local collection under that identity; it does not authorize an eventual upload after server membership has been revoked. If no identity has ever been established, an explicitly supported unassigned capture must remain unassigned until an internal recovery/import workflow handles it. Production must not silently use development no-auth mode.

Persist queue state across app restart, account logout and token expiry. Logout pauses scheduling, stops renewal and clears credentials; it does not delete raw files or reassign ownership. If destructive local cleanup is requested, expose it as a separate user action with explicit unsent-file status. On subsequent login, resume only queues owned by that same account and a still-authorized organization. A second user cannot upload, browse or clear the first user's pending captures through ordinary queue actions.

## 4. Multipart limits and pilot settings

R2 currently requires 5 MiB–5 GiB parts, at most 10,000 parts, and equal sizes for every non-final part; its documented multipart object maximum is 5 TiB. AWS documents the same part-count/part-size bounds but a larger current object maximum. Use the stricter common contract and an application cap rather than relying on provider limits as operational targets. [R2 upload requirements](https://developers.cloudflare.com/r2/objects/upload-objects/), [S3 limits](https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html)

| Setting | Proposed pilot default | Reason / qualification |
| --- | --- | --- |
| Maximum MCAP bytes | 100 GiB, configurable per organization | Far below provider maxima; confirm real capture lengths and device free-space behavior before increasing. Reject allocation before sending any bytes. |
| Part size | Reuse current 16–64 MiB adaptive plan through 60 GiB, 128 MiB above | Freeze once. Server verifies the plan and increases size if necessary to stay within 10,000 parts. Non-final parts are uniform. |
| Active source files per device | 1 | Protect capture responsiveness and avoid competing large-file disk reads. |
| Concurrent PUTs | 2 initially, at most 4 in pilot configuration | Tune on measured Wi-Fi/cellular performance and foreground/background behavior. Current code's higher concurrency is not evidence these pilot defaults were deployed. |
| Temporary chunk window | 4 initially; configurable independently from active PUTs | Disk budget is window bytes plus at least one extra chunk and reserve. Do not materialize an entire file's chunks. |
| Part URL batch | Up to 32 unique requested missing parts | Bound signing CPU, response size and capability exposure. Native backlog must be no larger than the qualified window. |
| URL validity | 60 minutes initially; refresh missing parts before the final 10 minutes | Resume renews individual part URLs; it never restarts a healthy multipart upload merely because URLs expired. |
| Idle multipart warning | 5 days from initiation | Give an explicit warning/restart path ahead of configured lifecycle expiry. A heartbeat cannot extend provider age automatically. |
| Incomplete multipart lifecycle | Explicit 7 days in pilot infrastructure configuration | Match the documented R2 default deliberately; use a different documented policy only if long offline uploads require it. |

The server computes expected part count, exact offset and expected final-part length from approved length and part size; the client checks this against its frozen plan. One small MCAP may use a one-part multipart upload, simplifying resumability and preventing general raw-object PUT overwrite capabilities. Tiny optional sidecars may use a dedicated, size-bounded single PUT to staging, followed by verified finalization into a fresh protected key. Alternatively use one-part multipart or defer acceptance until every write capability has expired. A verification gate alone does not prevent an unexpired PUT URL from overwriting accepted metadata. Follow the [immutable-file capability rules](storage-and-data-model.md).

R2 presigned URLs are bearer capabilities and support explicit expiry. Return server-calculated `expiresAt` and `requiredHeaders`, not a client guess; if signing credentials expire sooner, expose the shorter effective validity. Never log complete signed URLs. Browser uploads additionally need a narrow CORS origin policy and exposed ETag response header; native apps are not protected by CORS. [R2 presigned URL behavior](https://developers.cloudflare.com/r2/api/s3/presigned-urls/), [R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/)

## 5. API contract

All routes below are proposed contracts under `/api/v1` in the owned backend. The independently selected authentication service establishes the principal; live organization/project grants and the scoped recording/upload relationship authorize every call. Commit language-neutral request/response schemas, reject unknown keys, and validate bounded strings/arrays using the chosen runtime's validator. The cloned Zod definitions are reference inputs, not the production schema authority. Use an error envelope `{ "error": { "code", "message", "requestId", "retryable" } }`. Do not return raw storage-provider errors or secrets.

A collector can allocate, renew, reconcile and complete only their own recording in an authorized collecting organization. Internal operational roles may inspect/recover uploads within explicitly granted organizations, with an audit record. Membership alone does not permit operating another collector's upload; customer delivery roles cannot see pending recordings or obtain upload capabilities. Authorization details and support-role exceptions belong to [auth and access](auth-and-access.md).

Recording creation requires `projectId` in addition to `organizationId`, or an explicit assignment ID from which the server resolves both. The server verifies the project belongs to the organization, the principal has an active collecting grant for that project, and any task/subtask assignment belongs to the same project and permits that collector's capture. It records this resolved source-record assignment on the recording. Client-supplied task labels, cached grants and uploaded metadata cannot assign or move a recording into another project. Every subsequent file/upload inherits the recorded scope and rechecks live access; idempotent replays must match the original organization, project and assignment as well as the source identity.

All byte counts persisted as Postgres `bigint` use decimal strings in JSON. Nanosecond timestamps also use decimal strings with a named clock and explicit unit; never pass them through a JavaScript floating-point conversion. Integer part numbers/sizes are validated within the application's safe bounds.

### Routes

| Method and path | Request / action | Success and important errors |
| --- | --- | --- |
| `POST /recordings` | `organizationId`, `projectId`, `clientRecordingId`, device/app provenance, optional server-validated task/subtask assignment and capture-start wall time with provenance; an explicit assignment-ID variant may resolve organization/project server-side | `201` created; `200` idempotent replay; `409 idempotency_conflict` for a changed scope/source request under the same ID; inaccessible project/assignment returns `404` and creates no recording or storage capability. |
| `GET /recordings/:recordingId` | Return authorized transfer/ingest state and file summaries | `200`; `404` for absent or inaccessible recording. |
| `POST /recordings/:recordingId/seal` | Freeze logical file roles/segments, expected bytes/hashes, required/optional inventory and server-approved profile revision | `201` sealed; `200` identical replay; `409 sealed_inventory_conflict`; `422 required_file_missing` or `profile_requirements_unsatisfied`. If every required file is already uploaded, atomically create the ingest job/outbox event. |
| `POST /uploads` | Allocate a file/upload: recording ID, `clientUploadId`, role, filename, type, `sizeBytes`, `sha256`, requested supported plan version | `201` ready; `200` existing ready/complete session; `202` initialization/reconciliation still in progress; `413 file_too_large`; `409 source_identity_conflict`. |
| `GET /uploads/:uploadSessionId` | Return DB state plus last reconciliation summary; reconcile separately on explicit resume or stale state | `200`; no arbitrary provider key input. |
| `POST /uploads/:uploadSessionId/parts/sign` | Unique ascending `partNumbers`, at most 32; approved ranges only | `200` signed URL, expiry, exact offset/length and required headers per part; `409 upload_not_active` or `410 upload_expired`. |
| `PUT /uploads/:uploadSessionId/parts/receipts` | Batch native/client PUT receipts: part number, exact provider ETag, bytes and optional qualified checksum | `200` idempotent merge; `409 receipt_conflict` triggers provider reconciliation rather than silent overwrite. Receipts alone do not prove provider state. |
| `POST /uploads/:uploadSessionId/reconcile` | No key/count/ETag list from caller; request current provider verification | `200` with canonical part presence and missing numbers; `202` if a bounded reconciliation operation is still running; `410` if expired without a completed object. |
| `POST /uploads/:uploadSessionId/complete` | No client-supplied key, part count or completion list; optional expected session revision for concurrency | `202` transfer completion/ingest pending; response states whether seal/other files are still required; `200` previously verified terminal result; `409 parts_incomplete`, `source_changed` or `cancelled`; `422 integrity_mismatch` only once verification proves it. |
| `POST /uploads/:uploadSessionId/cancel` | Persist cancellation intent; stop scheduling and abort multipart | `202` cleanup pending; `200` already cancelled; completed objects require the recording deletion workflow. |
| `DELETE /recordings/:recordingId` | Authorized soft deletion and durable cleanup request | `202` deleting; retention/published-delivery conflicts follow the storage policy. |

Common errors: `400 invalid_request`, `401 unauthenticated`, `403 membership_revoked` for the caller's known active scope, `404 not_found` for unauthorized object IDs, `429 rate_limited` with `Retry-After`, and `503 dependency_unavailable` when DB/storage is unavailable. Returning a retryable error must preserve the existing session identity. A schema-valid unauthorized request must never generate a storage capability.

### Example upload allocation

Request:

```json
{
  "recordingId": "rec_opaque",
  "clientUploadId": "persisted-device-generated-uuid",
  "role": "source_mcap",
  "originalFilename": "session_data_20261022.mcap",
  "contentType": "application/octet-stream",
  "sizeBytes": "3221225472",
  "sha256": "<64 lowercase hexadecimal characters>",
  "planVersion": "uniform-v1"
}
```

The hash placeholder illustrates the field; it is not a valid request value. The server validates actual hexadecimal values and resolves organization/creator from the recording rather than trusting another owner field.

Ready response:

```json
{
  "data": {
    "uploadSessionId": "upl_opaque",
    "recordingId": "rec_opaque",
    "fileId": "file_opaque",
    "state": "uploading",
    "plan": {
      "version": "uniform-v1",
      "sizeBytes": "3221225472",
      "partSizeBytes": 16777216,
      "partCount": 192
    },
    "capabilities": ["renew-part-urls", "receipts", "reconcile", "complete-idempotent"],
    "uploadDeadlineAt": "2026-10-29T16:00:00Z"
  }
}
```

Signing responses contain one URL per approved part and use opaque server identities in their control paths. The URL necessarily reveals its own destination and provider upload parameters; those are transport details, not caller-selected authorization inputs.

### Idempotency and initialization across two systems

Use durable uniqueness for `(organization_id, creator_user_id, client_recording_id)` and `(organization_id, creator_user_id, client_upload_id)` with a canonical request hash. Retain mappings/tombstones for the lifetime of the recording plus the documented deletion retention period; do not silently forget identity after the current seven-day replay window. Changed source length/hash/recording/role under an existing identity returns conflict.

The seal body declares bounded `files` entries with `role`, optional segment number, `sizeBytes`, `sha256` and `required`, plus explicit omitted optional roles and the approved profile revision. The server validates the role set against the profile, matches entries to allocated file generations, canonicalizes this logical inventory and records its digest. Sealing and the final required-file completion both call the same transaction-level `maybeCreateIngest` operation. It requires a seal, all required files in `uploaded`, exact sealed content identities and an active recording, then uniquely creates one `ingest_capture` stage job/event. This closes both arrival orders without scheduling twice. Optional files missing at that point are explicit omissions in the immutable input manifest, not silently resolved later.

Reserve the DB row and server-generated unique key first, then acquire a short initialization lease. Create the provider multipart outside a long DB transaction and persist its upload ID before returning ready. Concurrent requests see the same `initializing` session and return/poll `202` rather than creating additional provider uploads.

Creation is not atomic across Postgres and object storage. If the provider accepted `CreateMultipartUpload` but the process lost its response or died before persisting it, mark the operation uncertain. A reconciler lists multipart candidates for that exact unique key, checks initiation time and its lease, adopts an unambiguous candidate and aborts proven duplicate orphans. Never repeat creation blindly. If reconciliation cannot establish identity, keep the session blocked for recovery or allocate a new generation with a new file/key and schedule old-generation cleanup. Provider lifecycle expiry is the final orphan backstop.

## 6. Part journal, resume and completion

### Receiving and reconciling part receipts

The native journal survives a Flutter process suspension. Flutter persists/journals each successful PUT's receipt and batches receipts to the server. Persist receipt provenance (`client_put_response` or `provider_recovered`), upload generation, part number, expected and observed bytes, ETag and observation time. Preserve the exact provider ETag required by completion; normalization for comparisons must not corrupt the value used by the SDK.

On launch/resume, drain native events first, then paginate provider ListParts through the backend. Validate each number/length against the frozen plan; incomplete pagination is an error rather than an apparently complete list. A provider part absent from the local journal can be adopted after matching the plan. A locally completed part missing from storage becomes pending. Conflicting receipts stop finalization until reconciled, and unknown/out-of-range provider parts invalidate completion.

AWS explicitly recommends retaining UploadPart response receipts and using ListParts for verification, rather than constructing ordinary completion requests directly from the listing. Keep that journal as the normal source of completion receipts. Recovery of a lost native receipt from a matching provider part is an explicit exception requiring integration qualification and final SHA-256 verification; it must remain visible as `provider_recovered`, not be described as an original PUT acknowledgement. The current finalize-only behavior must not be called fully qualified merely because it succeeds in a unit test. [AWS multipart lifecycle and receipt guidance](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html)

### Safe completion protocol

1. Authorize the session and recheck recording deletion/cancellation state. Acquire a renewable completion lease/fencing generation so only one logical completer proceeds. Do not hold a DB transaction open while storage performs a long complete operation.
2. Fetch every provider ListParts page. Require exactly the expected sequence `1..partCount`, correct length for every part, no extra numbers, no empty required ETags and exact total expected bytes. Compare the server receipt journal; reconcile discrepancies rather than trusting the caller.
3. Submit the validated ascending receipt list using a qualified storage SDK for the independently selected backend runtime. Do not use HTTP status alone as proof: S3 completion can embed an error in a `200 OK` response, which supported AWS SDKs handle. [CompleteMultipartUpload response semantics](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CompleteMultipartUpload.html)
4. HEAD the generated source key and require exact object length and the server-created file/session identity metadata recorded at initiation. Record its observed ETag and provider version identifier if the selected backend supports one. A bare `exists: true` is insufficient.
5. Atomically mark the `recording_files` transfer `uploaded` and verification `pending`. Call `maybeCreateIngest`: only a sealed recording with all required files uploaded may freeze its input manifest, create/deduplicate the `ingest_capture` stage job and insert its uniquely identified event into Postgres `event_outbox`. A durable relay emits that event to Inngest Cloud; an Inngest workflow invokes the private Modal worker and controls the downstream DAG. Subsequent dispatch, idempotency, leases and reconciliation follow [job orchestration](job-orchestration.md). A DB failure after object completion is recovered by HEAD and the same transaction; bytes are not uploaded again. A failed event send leaves the durable outbox row retryable rather than losing the processing trigger.
6. Return `202` with an explicit package state: waiting for seal, waiting for named required files, queued for ingest, or ingest running. Show “Uploaded; verifying” only after the package is ready for ingest. A repeated complete call returns the same pending or verified result and cannot create another logical ingest job.

If completion returns `NoSuchUpload`, inspect only this session's assigned key and expected identity. A matching complete object permits idempotent recovery; a missing object means expired/aborted/restart-required; a wrong-sized or wrong-identity object is quarantined and never adopted. If outcome remains uncertain after a network timeout, reconcile first, preserving identity. Do not allocate a replacement over an existing raw key.

After transfer completion, the session can no longer sign part URLs. Previously issued UploadPart URLs refer to the now-completed multipart ID and cannot serve as general overwrite PUTs; verify this behavior against the selected provider during qualification.

A still-valid part URL may race a provider listing before completion. Stop normal native scheduling before completing; do not claim the listing is a transactional lock on the bytes. The independent final source hash detects any intervening replacement. A mismatch remains quarantined even if the provider accepted completion.

## 7. Independent cloud verification and the ingest gate

The first physical CPU stage is `ingest_capture`. Its input is an active, sealed, fully uploaded package with expected client hashes; it does not require a pre-existing server-verification result. Internal substeps validate MCAP, extract capture data, produce compact QC and build preview artifacts in one invocation. The worker has a versioned parser image and a frozen job-bound manifest containing exact file generations, expected hashes/lengths and approved input locations. It accesses raw data through server-held, least-privilege worker credentials or scoped capabilities; clients cannot redirect it to an arbitrary URL. Download into a job-specific temporary path with disk/time/decompression limits. Compute SHA-256 while downloading, then reuse the downloaded file across these substeps to avoid a second raw download. Independent later reprocessing may require another download and must account for it.

Verification must record distinct results:

| Check | Result and failure policy |
| --- | --- |
| Exact source bytes | Compare downloaded count and SHA-256 with device expectation. Mismatch quarantines the file; no GPU work. Neither a multipart ETag nor an object HEAD proves full-file SHA-256. |
| Container structure | Parse leading magic, records, footer and trailing magic; verify available CRCs without requiring optional sections/checksums. Bound declared lengths, decompression expansion, message count and parser runtime. Invalid/truncated files are quarantined. |
| Stream inventory | Record actual schemas, channels, per-topic counts, encoding/decodability and timestamp ranges; compare claimed metadata to observations. No actual RGB means no ordinary visual processing job. Preserve diagnostic-only captures. |
| Capture contract | Identify platform and exact supported capture-geometry version; validate dimensions, intrinsics, frame association and declared coordinate conventions. Unknown versions remain inspectable but cannot produce certified geometry outputs. |
| Metadata consistency | Parse bounded JSON; retain supplied sidecar/embedded metadata as source claims, and separately produce server-derived facts and discrepancies. Missing metadata is not permission to invent it. |
| Provenance | Save source SHA-256, byte count, parser/config/image version, observation time, clock identities and a machine-readable verification report. |

R2 documents multipart ETags as a composition of part hashes; S3 states that completed object ETags need not equal the file's MD5. We use those values for provider identity and reconciliation, not as the source SHA-256. [R2 ETags](https://developers.cloudflare.com/r2/objects/upload-objects/#etags), [S3 ETag semantics](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html)

The worker reports through a fenced, authenticated job completion interface. A transaction verifies that the recording is still active, the sealed input-manifest identity is unchanged and the attempt's `claim_epoch` is current. Only then mark successfully validated files `verified` and accept the ingest result; the Inngest workflow may activate allowed downstream CPU/GPU stages after observing that durable accepted result. Postgres owns source identities, job attempts and artifact acceptance; workflow retries do not bypass those guards. Delivery eligibility still depends on internal review, licensing and export profile checks.

### Geometry and clock requirements specific to this project

The current [capture contract](../../scripts/capture_geometry.py), [geometry report](../../scripts/geometry_report.py) and [physical-capture regression report](../geometry-v3-capture-regression.md) distinguish acquisition from independently measured accuracy. Preserve that distinction in the cloud result schema.

- Android `android_arcore_cpu_v3` associates RGB with its acquiring ARCore Frame through declared provenance. RGB image, ARCore Frame, Android camera and depth timestamps retain their source-specific clocks. Do not require their numeric values to be equal or treat them as epoch time.
- Preserve raw timestamps, units and clock IDs. Mapping frames into video time requires an explicit derived timebase and reversible source-frame mapping. Ingest cannot claim RGB/depth timing calibration merely by subtracting unverified clocks.
- Per-frame dimensions/intrinsics and recorded RGB-to-depth pixel mappings can pass contract checks while `cross_stream_clock_verified`, `depth_time_verified` and `metric_accuracy_validated` remain false.
- Do not synthesize confidence, depth age, contact labels, world transforms or metric accuracy from absent metadata. Unsupported historical recordings may enter a deliberately limited RGB-only extraction profile after internal triage, preserving their missing-geometry status.
- User-supplied metadata cannot override authorization fields, source SHA-256, server verification results, processing policy or accuracy certification. Put untrusted claims in a clearly separated namespace.

## 8. State, cancellation and cleanup

Local transfer state continues to use the existing normalized state machine, with explicit account/network waiting reasons and a post-transfer server verification view. Avoid overloading a single `completed` boolean:

| Scope | Proposed states |
| --- | --- |
| Device | `queued`, `waitingForFinalization`, `hashing`, `waitingForAuth`, `preparing`, `registering`, `transferring`, `paused`, `waitingRetry`, `finalizing`, `uploadedAwaitingVerification`, `verified`, `failedTerminal`, `cancelled` |
| Server upload session | `initializing`, `uploading`, `completing`, `completed`, `cancel_requested`, `cancelled`, `expired`, `failed` |
| Recording file transfer | `registered`, `uploading`, `uploaded`, `aborted`, `expired` |
| Recording file verification | `pending`, `running`, `verified`, `quarantined`; unsupported schema/contract is a classified reason, not another verification enum |

These proposed wire names require a versioned mapping to existing Dart enums; renaming persisted enum strings in place without migration is unsafe. `completed` on the server upload means bytes exist; it does not mean the MCAP is approved. UI progress displays transferred bytes and then a separate verification phase. Retain the local source until verified acknowledgment plus the configured local grace/cleanup policy. Never auto-delete an unverified recording to free chunk-window space.

Pause stops refilling the native window and leaves resumable state. Cancellation durably prevents new signing/completion, stops native tasks, requests provider abort and only then marks cleanup successful. Revoked membership has the same no-new-capabilities rule. Unexpired signed URLs remain bearer capabilities until expiry; DB revocation cannot instantly invalidate them. Abort the multipart and guard finalization against late writes, then reconcile cleanup. Already completed sidecar PUTs and late in-flight writes require a later cleanup pass.

Recording deletion creates a tombstone and durable cleanup jobs, cancels processing through orchestration and immediately removes ordinary access. Raw retention, legal/customer delivery constraints and provenance retention are governed by [storage policy](storage-and-data-model.md). A collector cannot delete a published delivery by cancelling its historical upload. Never cascade-delete the only audit history on account deletion without executing the storage policy.

Run a bounded periodic sweeper to:

- Reconcile `initializing`, stale `completing` and cancellation-uncertain sessions.
- Find provider multipart uploads for known owned prefixes that have no live DB session, and abort only proven orphans after a grace period.
- Enforce the configured incomplete multipart lifecycle; expose initiation/deadline in the client. R2's documented default is seven days from initiation, so a week-long pause can lose provider parts even while the device journal survives. [R2 lifecycle configuration](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
- Retry deletion of cancelled sidecars and quarantined/staging objects after the applicable retention delay.
- Remove temporary chunks whose native tasks are no longer live, preserving the raw source and queued journal.

## 9. Failure and reconciliation matrix

| Failure or interruption | Required recovery | Must not happen |
| --- | --- | --- |
| App stops during writer finalization | Keep file outside transferable queue; inspect writer status/magic on next launch; offer diagnostic recovery for crash-truncated capture | Treat `metadata.json` existence as a finalized MCAP. |
| Offline / API outage before allocation | Keep owned local queue; jittered backoff and visible waiting reason | Lose the recording or move it to another logged-in account. |
| DB unavailable during multipart start | Return retryable `503` with the same client identity | Start untracked storage uploads as a fallback. |
| Provider creation succeeds, response is lost | Reconcile exact key/lease candidates; adopt unambiguous upload or isolate a new generation | Blindly repeat creation or overwrite an uncertain raw key. |
| PUT succeeds, device crashes before journal commit | Reconcile provider parts, validate length, recover receipt provenance and resume remaining parts | Upload all previously present parts merely because local progress reset. |
| URL expires during transfer | Refresh only the affected pending part URLs; continue the same session | Restart the recording or count URL expiry as exhausted transient-network retries. |
| Local file moves with sandbox path change | Resolve persisted app-relative URI; verify immutable source identity | Recompute identity from the new absolute path. |
| Source bytes/length change | Stop, fail source identity, require a new file/upload generation | Reuse an old digest or splice parts from two versions. |
| Device runs low on free disk | Stop preparing new chunks; remove acknowledged temp chunks; preserve source | Create the entire source's chunk set or delete unverified source bytes. |
| Storage throttles / transient network fails | Retry individual missing parts with jitter and bounded no-progress budget; honor server retry hints | Busy-loop or run unbounded parallel PUTs. |
| Complete succeeds, API/DB response is lost | HEAD exact session object, recover durable transfer state and run the same sealed-package ingest gate | Reupload the source or schedule duplicate logical jobs. |
| MCAP completes before required sidecar / seal | Keep source `uploaded`, report the missing package members and wait; final required-file completion or seal invokes the same deduplicated ingest gate | Validate against an incomplete package, resolve later mutable metadata or downgrade a metric profile silently. |
| Multipart gone, matching object absent | Mark session expired; explain restart and allocate a fresh generation after reconciliation | Claim success from stale local ETags. |
| Object exists with wrong size/identity/hash | Quarantine and retain diagnosis | Adopt it because HEAD returned success. |
| Logout/account switch/member removal | Stop signing, pause/cancel native work as appropriate, retain owner-bound queue; server rejects further control actions | Let new account renew old owner's URLs. |
| Cancel races with completion or validation | Cancellation/deletion fence blocks activation and downstream jobs; cleanup reconciles whichever provider operation won | Publish or launch GPU work after the logical recording is deleted. |
| Worker dies while validating | Reconcile Modal/attempt state; Inngest workflow retry resumes the same logical validation job after prior execution is terminal; discard uncommitted temp files | Mark valid from a stale worker, assume exactly-once execution, or start replacement compute merely because a lease expired. |
| Valid container lacks expected RGB/calibration | Preserve raw object and report actual inventory; quarantine/unsupported profile as appropriate | Spend on normal GPU annotation or invent missing sensor data. |

## 10. Implementation map and migration sequence

Coordinate mobile changes with the agent currently repairing the app. Production server targets are owned modules under root `backend/`; exact language, framework and filenames remain subject to independent runtime review. Cloned server/SDK sources below are evidence only. This document does not edit application code.

| Area | Specific files / additions | Work |
| --- | --- | --- |
| Shared API | New `backend/contracts/` recording/upload-session/receipt schemas; existing [upload schemas](../../stera-app/packages/types/src/upload.ts) are protocol evidence | Strict IDs, request hashes, decimal-byte/hash fields, capability version and discriminated states. Generate or validate mobile bindings and retain a compatibility response adapter while old clients exist. |
| Server DB | New owned migrations under `backend/migrations/` or selected migration tool's equivalent; existing [app schema](../../stera-app/packages/db/src/schema/app.ts) is import/mapping evidence | Implement organization/project-bound recordings/files, sealed logical inventory/digest and accepted physical generation references; safely import historical identities where needed; add upload/session/receipt constraints, plan/version/hash fields, leases, timestamps and deletion/verification evidence. Follow `event_outbox` and job/attempt contracts from orchestration. No Drizzle or cloned-table reuse is assumed. |
| API routes | New `backend/api/` and `backend/services/recordings/`, `backend/services/uploads/` equivalents; existing [upload route](../../stera-app/apps/server/src/routes/upload.ts) and [asset route](../../stera-app/apps/server/src/routes/assets.ts) are behavior references | Central authorization and source-record/project assignment checks; durable initialization, negotiated plans, bounded signing, receipts, reconciliation, package seal, shared `maybeCreateIngest`, complete/cancel and compatibility adapters. Rewrite fail-open or caller-key-authorized handlers. |
| Storage adapter | New `backend/adapters/object_storage/` equivalent; existing [R2 helper](../../stera-app/apps/server/src/lib/r2.ts) is compatibility evidence | Separate provider config from protocol; metadata-bound initialization, fully paginated reconciliation, SDK completion, exact HEAD and idempotent abort. Requalify checksum/signing behavior for the chosen runtime rather than assuming copied client settings transfer unchanged. |
| Mobile schema | Existing [session table](../../stera-app/apps/mobile/lib/src/services/db/schema/upload_sessions.dart), part table, schema migrations and DB helpers | Persist owner/org/device/server IDs, actual content SHA-256, immutable stat snapshot, plan version and server verification acknowledgment. Migrate existing rows without deleting source files. |
| Mobile orchestration | Existing [upload repository](../../stera-app/apps/mobile/lib/src/services/upload_service/data/repo/upload_repo.dart), coordinator, presign manager, reconciler and orchestrator | New ID-based API adapter; batch receipt acknowledgments, renew/resume without replaying good parts, account fencing and separate uploaded/verified UI state. |
| Native transport | Existing [iOS uploader](../../stera-app/apps/mobile/ios/Runner/background_uploader/) and Android lifecycle/foreground transfer adapter | Keep bounded temp files and event journal; propagate stable owner/session/generation identifiers, receipts, file-close acknowledgment and cancellation. Validate Android on actual target devices; iOS implementation presence does not establish Android parity. |
| Cloud CPU ingest | New processing worker module and manifest/report schema under the processing component's chosen directory | `ingest_capture` coalesces bounded download+SHA-256+MCAP parse, extraction, compact QC and preview; actual stream inventory/capture-contract validation; `claim_epoch`-fenced callback and durable workflow handoff. |
| Operations | Owned `backend/workflows/` and reconciliation command/service equivalents plus infrastructure lifecycle definition | Report orphan counts, stale uploads, expected deadlines, cleanup failures and verification latency; never print signed URLs or household metadata payloads. |

Implementation order:

1. Complete independent backend runtime/auth/storage service review, then implement durable identities, schema constraints and strict project/source-assignment authorization in the owned backend behind a versioned capability. Fail closed on persistence failure before widening rollout; the cloned server is not the production starting point.
2. Add client content hashing/owner binding and new session allocation/sign/receipt adapter. Retain existing native transfer internals.
3. Implement exact reconciliation/completion, idempotent package sealing, shared required-file gate, transactional `event_outbox` ingest trigger, durable event relay and Inngest-to-Modal handoff.
4. Deploy CPU verification and report states; prevent expensive downstream jobs until verified.
5. Migrate old pending sessions through a compatibility resolver that proves old owner/key/provider identity and constructs an explicit legacy-profile inventory/seal. Imported completed assets remain verification `pending` until checked. Missing hashes/required sidecars need an explicit recovery/import path; compatibility cannot bypass profile requirements. Ambiguous rows remain recoverable; do not silently certify or delete them.
6. Qualify on physical devices, then deprecate raw-key legacy completion/asset-registration routes once supported clients have migrated. Old and new code must not concurrently complete the same session through different state machines.

## 11. Acceptance scenarios and rollout evidence

Automated tests should cover the business risks, backed by actual R2/S3 integration and mobile lifecycle tests:

1. Finalizing MCAP cannot be queued from an early metadata file; a finalized file hashes and plans consistently. Malformed trailing bytes fail cloud validation despite a local readiness marker.
2. A 3 GiB fixture completes with exact source SHA-256; a 100 GiB generated transport fixture proves bounded disk/memory and part-count handling without committing household video to Git. Oversized allocation fails before provider creation.
3. Kill Flutter/native callbacks at selected points; relaunch, recover acknowledged provider parts and transfer only missing ranges. Repeat after URL expiry without a new multipart identity.
4. Race duplicate start and complete requests; create one logical session, one accepted file object and one validation job. Inject a DB outage after provider create and after provider complete; reconciliation converges without data loss or false success.
5. Attempt another user's session ID, another organization/project, a project ID outside the selected organization, an unassigned task/subtask, arbitrary part numbers, caller-selected keys, old-generation IDs and revoked membership/project grants. Creation and every subsequent operation enforce the resolved source-record scope; no storage capability or recording information is exposed.
6. Mutate source bytes at the same length, truncate it, change the final chunk, forge client size/hash or omit a middle provider part. Complete cannot produce a verified file; quarantine retains a diagnostic record.
7. Confirm full pagination beyond 1,000 parts, zero-length rejection, final-part exact length, duplicate/extra part rejection and receipt conflicts. Run transport contract tests against the chosen actual R2 backend and AWS S3 fallback before claiming interchangeability.
8. Test Wi-Fi loss, cellular policy, device reboot, low disk, background suspension, iOS force quit and Android process death on supported devices. Document observed platform behavior; a suspended process cannot renew URLs until execution resumes.
9. Cancel while PUT/complete/CPU verification is in flight; prove no downstream GPU job activates, then verify incomplete parts and late sidecars are eventually cleaned up. Revoked URLs' remaining capability window is recorded and bounded.
10. Feed valid MCAP with no RGB, unknown capture version, absent/broken metadata, mismatched intrinsics and independent v3 clocks. Preserve raw evidence; emit truthful capability/verification states without fabricated synchronization or metric accuracy.
11. Transfer success followed by failed verification leaves the local source intact. A verified acknowledgment permits configured local cleanup, while an unauthorized account cannot trigger it.
12. Race seal with the final required-file completion in both orders; emit exactly one logical ingest job/outbox event. Required metadata arriving later cannot mutate an accepted manifest. Optional missing thumbnails remain explicit. A restarted same-content physical generation is auditable and can satisfy the seal; changed content requires a new revision. Migration tests cover legacy inventory mapping, canonical enum mapping and missing required sidecars without deleting local raw files.

Pilot release evidence must include app build identity, API/schema version, storage endpoint/backend, settings, exact source/output hashes, native/background test results, failure-injection outcomes, MCAP/geometry reports and measured upload/validation resource use. Production claims are limited to the combinations actually exercised.

### Operational counters

Track queue age by state, bytes remaining, transferred-byte rate, URL renewals, no-progress retries, upload generations per recording, orphan multipart bytes/count, completion ambiguity, checksum mismatches, unsupported/corrupt MCAP, verification latency, cancellation cleanup age and client version distribution. Correlate by recording/file/session/job ID; keep auth tokens, presigned query strings, raw filenames containing personal information and video payloads out of ordinary logs.
