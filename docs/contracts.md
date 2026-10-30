# Shared wire and manifest contracts

Updated: 2026-10-30. MVP contract target. Implement JSON Schemas/API definitions and small conformance fixtures in `packages/contracts`; use the same two Render task definitions locally and in the cloud; no generic DAG/independent-validator/Lance schema is required.

## Encoding and HTTP

HTTP uses **camelCase**, durable manifests **snake_case**. Recording, file, job, review and release IDs are UUIDs; identity-provider user IDs are opaque strings. Timestamps in nanoseconds, byte sizes/offsets and large counters are decimal strings, never JavaScript floating-point numbers. Part numbers, bounded array lengths and review revisions are safe JSON integers. SHA-256 is 64 lowercase hex characters. Wall time is RFC 3339 UTC; native clock IDs remain separate.

Reject unknown fields on commands, nonfinite JSON numbers, unsafe paths, arbitrary URLs/provider keys and counts beyond the configured limits. JSON missing numeric observations are null with masks; NPZ arrays may use NaN plus masks. Hash the exact stored UTF-8 manifest bytes; store its digest outside that document. Never self-embed a manifest's own digest or modify a document already referenced by hash.

Success: `{data, requestId}`. Failure: `{error: {code, message, retryable}, requestId}`; use 401 unauthenticated, 403 forbidden, 404 absent/inaccessible, 409 identity/revision conflict, 413 oversized, 422 invalid evidence/config, 429 bounded admission, 503 temporary provider failure. Preserve the same operation identity on retry. Better Auth retains its pinned library protocol.

Creation uses a persistent client ID or `Idempotency-Key`, scoped to actor/operation and exact request digest. Exact replay returns the same object; changed content returns 409. Database commits precede external side effects. Mutating cookie-authenticated routes enforce the configured origin/CSRF rules. Service routes use scoped credentials, never browser sessions.

## API groups

| Principal | Routes / operation |
| --- | --- |
| Human | `/api/auth/*`, `/api/v1/me`; Better Auth identity plus enabled pilot role |
| Collector | `/api/v1/recordings` and `/api/v1/uploads`; exact resumable source protocol in [upload](components/mcap-upload.md#http-surface) |
| Staff | `/api/v1/internal/recordings` and `/:id/review`; list jobs/clips, append review using `jobId`, `manifestSha256`, `clipId`, `expectedRevision`, decision and task label/notes |
| Staff | `/api/v1/internal/jobs/:id/cancel` and `/retry`; retry creates a new job/prefix after old execution is resolved |
| Staff | `/api/v1/internal/releases`, `/:id/publish`, `/:id/revoke`; freeze exact approved review IDs and recipients; publish requires expected ready manifest hash |
| Customer | `/api/v1/releases`, `/:id`, `/:id/download`; authorize live grant and published state before issuing storage URLs |
| Workflow controller | `/internal/v1/control/*`; claim controller ownership, record compute submission/call state, poll candidates and finalize; restricted controller credential |
| Repair cron | `/internal/v1/control/*`; list due workflow dispatches, repair abandoned controllers and record trigger acknowledgement; separate narrow credential |
| Worker | `/internal/v1/jobs/:id/{claim,heartbeat,result}` plus `/outputs`, `/uploads/*` and `/seal`; bootstrap then invocation-bound capability, current job only |

Source upload mutations carry `expectedTransportEpoch`; an expired unfinished MPU can restart with the same logical file/content identity and fresh epoch/key after safe retirement. Old epoch receipts cannot complete the new transport. Source-upload route fields/methods are specified once in the [upload contract](components/mcap-upload.md). Before implementation, materialize the remaining route groups into the versioned API definition; do not invent a second public route surface inside the old Stera server. Metadata requests/manifests must have explicit byte/count limits. The initial proposal is 1 MiB per control document and 2,000 file entries; qualify or lower these against real two-hour/release inventories. Frame rows live in bounded external shards, not control documents.

## Task and result handoff

| Contract | Required fields |
| --- | --- |
| `TaskInput` | `schemaVersion`, `jobId`, `kind` (`process_recording` or `export_release`), target ID, source-manifest OR frozen-selection digest, processing/profile revision. Secret-free references only. |
| Worker claim | Exact job, executor kind, fresh physical-execution `invocationNonce`, actual local execution reference OR Modal call ID. Bootstrap capability is transported separately. |
| Authoritative claim response | Input file/read access, fixed start/execution deadlines, source/selection/code/image/model/config digests, resource/output limits and invocation-bound service capability. No database URL/general storage keys. |
| `ResultCandidate` | `schemaVersion`, `jobId`, invocation identity, `manifestFileId`, `manifestSha256`, compact QC/outcome/usage summary. Provisional until API observes terminal execution and checks sealed inventory/current refs. |

Render controller input is the secret-free `{jobId}`; task names are `process-recording` and `export-release`. Dispatch key `job:{jobId}` binds that exact task/input; conflict fails. Compute `TaskInput` is one positional argument; the private bootstrap token is separate. A local subprocess receives it over stdin or a private file; Modal receives it only through the private invocation. Do not persist plaintext credentials in task/diagnostic manifests or logs. A worker may repair the missing Modal call ID during claim; an unknown unclaimed submission never authorizes blind resubmission.

Use job states `queued`, `submitting`, `submit_unknown`, `running`, `result_pending`, `succeeded`, `failed`, `cancel_requested`, `cancelled`, `needs_attention`. API conditional transactions own transitions. A processing retry is another row linked by `previousJobId`. Workflow controller retries recover that same row and known compute call; they do not create another processing attempt. Store the workflow task, fixed dispatch key, admitted run ID, controller nonce/lease and first-admission deadline on the job row. The same Render run may retry its controller; a different duplicate run exits. There are no planned continuations or controller generations. `recordings.currentJobId` / `releases.exportJobId` prevent a stale callback from selecting older results. [Recovery](components/job-orchestration.md)

## Durable documents

| Document | Required content |
| --- | --- |
| `recording-source/v1` | Recording/owner/client capture identity, exact sealed file IDs/roles/requiredness/bytes/hashes, capture version, native channel/calibration/clock inventory and collection permission reference. Source verification starts pending. |
| `processing-result/v1` | Job and source digest, code/image/model/config/profile, server-verified source hashes, required output file IDs/bytes/hashes, clip inventory, frame-map/pose-array schema refs, QC/errors and limitations. No mutable `latest` or arbitrary URL. |
| `hand-observations/v1` | Exact source-frame mapping and joint order; up to two predicted sides; 21 image `(x,y)` landmarks and model-relative `(x,y,z)` estimates; units/raster/model frame, detection/finite masks, handedness score and explicit unknown visibility. Never manufacture per-joint confidence. |
| `review/v1` | Successful job/result hash/clip, reviewer/revision/time, approved/rejected decision, whole-clip task label and notes. Append a revision; no last-write-wins approval. |
| `release-selection/v1` | Frozen approved review revisions, exact source/result/label/file references, recipients, permitted-use evidence and exporter/schema revision. Immutable once export queues; publication additionally rechecks each frozen review is still the latest approved revision for that job/clip. Withdrawal/label changes block a stale draft and require another release. |
| `release/v1` | Release/selection digest, all approved clip/video/pose/mapping/label files with safe relative paths/bytes/SHA, reader/schema/model provenance, rights/notices and limitations. Archive reference/hash sits outside the archive's own inventory to avoid recursion. |

The source declaration and server-verified result are distinct hashed documents. A frame-map row preserves native event/frame ID and integer timestamps/clock domains, raster/crop/rotation/mirror transforms, associated sensor IDs and clip PTS/time base. Preserve unverified timing/metric flags; model-local 3D is not calibrated camera/world pose. The format README defines array dimensions, missingness, joint order and coordinate conventions.

The portable TAR contains all approved selected files, its file manifest and small reader/README. A separate checksum file covers the TAR. Customer APIs expose release-safe summaries and logical file IDs, not internal notes or contributor identities. Output manifests may reference only completed files owned by that job/approved selection. Never delete referenced files as temporary scratch.

## Conformance evidence

Test large integer round trips through TypeScript/Dart/Python, manifest-byte hash stability, joint/raster/frame mapping, null/NaN masks, bounded requests and owner-bound idempotency conflicts. Test a local real-model package through the actual reader, plus a cloud CPU canary. Fake models verify control flow only. [Monorepo](components/monorepo.md), [local acceptance](components/local-development.md).
