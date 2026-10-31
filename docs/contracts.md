# Shared wire and manifest contracts

Updated: 2026-10-31. MVP contract target. Implement JSON Schemas/API definitions and small conformance fixtures in `packages/contracts`; use the same processing task locally and in the cloud, adding export in the follow-up; no generic DAG/independent-validator/Lance schema is required.

## Encoding and HTTP

HTTP uses **camelCase**, durable manifests **snake_case**. Recording, file, job, clip, dataset, review and future release IDs are UUIDs; identity-provider user IDs are opaque strings. Timestamps in nanoseconds, byte sizes/offsets and large counters are decimal strings, never JavaScript floating-point numbers. Part numbers, bounded array lengths and review revisions are safe JSON integers. SHA-256 is 64 lowercase hex characters. Wall time is RFC 3339 UTC; native clock IDs remain separate.

Reject unknown fields on commands, nonfinite JSON numbers, unsafe paths, arbitrary URLs/provider keys and counts beyond the configured limits. JSON missing numeric observations are null with masks; NPZ arrays may use NaN plus masks. Hash the exact stored UTF-8 manifest bytes; store its digest outside that document. Never self-embed a manifest's own digest or modify a document already referenced by hash.

Success: `{data, requestId}`. Failure: `{error: {code, message, retryable}, requestId}`; use 401 unauthenticated, 403 forbidden, 404 absent/inaccessible, 409 identity/revision conflict, 413 oversized, 422 invalid evidence/config, 429 bounded admission, 503 temporary provider failure. Preserve the same operation identity on retry. Better Auth retains its pinned library protocol.

Creation uses a persistent client ID or `Idempotency-Key`, scoped to actor/operation and exact request digest. Exact replay returns the same object; changed content returns 409. Database commits precede external side effects. Mutating cookie-authenticated routes enforce the configured origin/CSRF rules. Service routes use scoped credentials, never browser sessions.

## API groups

| Principal | Routes / operation |
| --- | --- |
| Human | `/api/auth/*`, `/api/v1/me`; Better Auth identity plus enabled pilot role |
| Collector | `/api/v1/recordings` and `/api/v1/uploads`; exact resumable source protocol in [upload](components/mcap-upload.md#http-surface) |
| Staff | `GET /api/v1/internal/recordings?status=...`; Pipeline processing state/progress/errors and bounded job details |
| Staff/customer | `GET /api/v1/datasets` and `GET /api/v1/datasets/:datasetId/clips`; bounded authorized dataset list or thumbnail grid, with URL-backed filters |
| Staff | `GET /api/v1/internal/clips?q=...&recordingId=...&reviewStatus=...&cursor=...`; staff All clips/review queue; the Add clips picker MUST request approved candidates only |
| Staff | `POST /api/v1/datasets`, `PATCH /api/v1/datasets/:datasetId`, `POST /api/v1/datasets/:datasetId/clips`, `DELETE /api/v1/datasets/:datasetId/clips/:clipId`; create/rename or bounded add/remove membership using `expectedRevision` |
| Staff/customer | `GET /api/v1/clips/:clipId`; shared safe clip metadata and server capabilities; `POST /api/v1/clips/:clipId/viewer-access` rechecks access and signs the clip's allocated RRD only |
| Staff | `POST /api/v1/clips/:clipId/reviews`; append with exact job/result hash, `expectedRevision`, decision, task label, optional notes and optional `datasetSelection` for atomic approval/assignment |
| Staff | `/api/v1/internal/jobs/:id/cancel` and `/retry`; retry creates a new job/prefix after old execution is resolved |
| Staff, follow-up only | `/api/v1/internal/releases`, `/:id/publish`, `/:id/revoke`; freeze one whole dataset revision and every approved member/review; publish requires expected ready manifest hash |
| Customer, follow-up only | `/api/v1/releases`, `/:id`, `/:id/download`; authorize live dataset grant and published version state before issuing storage URLs |
| Workflow controller | `/internal/v1/control/*`; claim controller ownership, record compute submission/call state, poll candidates and finalize; restricted controller credential |
| Repair cron | `/internal/v1/control/*`; list due workflow dispatches, repair abandoned controllers and record trigger acknowledgement; separate narrow credential |
| Worker | `/internal/v1/jobs/:id/{claim,heartbeat,result}` plus `/outputs`, `/uploads/*` and `/seal`; bootstrap then invocation-bound capability, current job only |

Source upload mutations carry `expectedTransportEpoch`; an expired unfinished MPU can restart with the same logical file/content identity and fresh epoch/key after safe retirement. Old epoch receipts cannot complete the new transport. Source-upload route fields/methods are specified once in the [upload contract](components/mcap-upload.md). Before implementation, materialize the remaining route groups into the versioned API definition; do not invent a second public route surface inside the old Stera server. Metadata requests/manifests must have explicit byte/count limits. The initial proposal is 1 MiB per control document and 2,000 file entries; qualify or lower these against real two-hour/release inventories. Frame rows live in bounded external shards, not control documents.

## Browser and review responses

The [Data browser contract](components/data-browser-and-datasets.md) defines `/data-browser`, `datasetId`, staff-only `view=clips`/`recordingId`, `q`, `label`, staff-only `reviewStatus` and pagination; `/pipeline` uses `status`. Omitted `datasetId` lists datasets unless staff explicitly choose All clips; customers cannot use that global view. Review-status filtering belongs to All clips; Dataset grids are implicitly approved-only. Completed Pipeline rows link to the recording-scoped All clips queue; an invalid/inaccessible supplied ID never broadens the result. Count/hours use distinct authorized clips and exact clip durations. All Dataset memberships, including staff views, require the latest review to be approved. Customer list/search/counts additionally use only current members with latest approved reviews and a live `dataset_access` grant. Use cursor pagination (default 24, maximum 100), bounded search/filter values and signed thumbnail references issued only after list authorization. Staff membership batches are at most 100 unique clip IDs and run in one revision-checked transaction, locking/checking each clip’s latest Approved review before insertion. Accepted-but-unreviewed or rejected clips return 409 without partial changes. No role or grant is trusted from query parameters.

A clip response contains friendly title, duration/raster, exact job/result digest, safe observation semantics and `capabilities.canReview`. Staff additionally receive current review revision/draft fields and `automaticQualityChecks`; customers receive the exact latest approved task label and authorized dataset names, never internal notes/QC or collector identity. Working-dataset review is live and does not require a future release. Read grants/membership/latest review in one consistent database snapshot, then recheck on viewer URL issuance. A future Dataset version instead resolves frozen reviewed evidence, without redirecting it to newer working labels.

For Approve, optional `datasetSelection` contains the complete desired `datasetIds` and `expectedRevisions` for the union of currently assigned and selected Datasets. Validate a nonblank label, exact review revision, Dataset existence/revisions and bounded IDs before committing the appended approval plus membership changes atomically. Omission preserves existing memberships; an explicit empty selection removes them. For Reject/withdraw, remove all working memberships and increment affected Dataset revisions in the same review transaction. Reapproval never resurrects old membership implicitly. Clip/review and affected Dataset locks must follow one consistent order; race tests must prove direct add cannot follow a rejection with stale eligibility. Future published version references are immutable and are not deleted by this working-membership cleanup.

`viewer-access` accepts no arbitrary URL/storage key; the clip row selects the allocated RRD file. Response includes `url`, `expiresAt`, file ID/hash, RRD schema and SDK version. Clip/grid thumbnails use the same authorization and short-lived signed-read policy. Initial URL TTL is 15 minutes; reauthorize on reload. Return 404 for absent/inaccessible clips. Collection IDs are not an API alias: use **datasetId** consistently.

Processing manifests assign immutable clip UUIDs, stable ordinals, source bounds, RGB/pose/frame-map/thumbnail/RRD file IDs, duration and raster. Accepting a result inserts `clips` transactionally, unique `(jobId, clipOrdinal)`; no whole-manifest scans per page or `latest` alias. Reprocessing yields different IDs; dataset membership stays explicit. Titles are friendly display metadata, separate from reviewed task labels.

Each automatic check has `code`, `status` (`pass|warn|fail|measured|not_evaluated`), concise `message` and bounded optional measurements/rule revision. Required codes cover source checksum, decode, frame mapping, landmark shape/finite masks and detection coverage/missing frames. Coverage includes observed/total frame counts and denominator semantics; percentages alone are measured, not proof of anatomical accuracy. Blocking integrity/decode failure rejects the result. Quiet viewer semantics label model-relative 3D; no reviewer acknowledgement checkbox is required.

## Task and result handoff

| Contract | Required fields |
| --- | --- |
| `TaskInput` | `schemaVersion`, `jobId`, `kind` (`process_recording` or `export_release`), target ID, source-manifest OR frozen-selection digest, processing/profile revision. Secret-free references only. |
| Worker claim | Exact job, executor kind, fresh physical-execution `invocationNonce`, actual local execution reference OR Modal call ID. Bootstrap capability is transported separately. |
| Authoritative claim response | Input file/read access, fixed start/execution deadlines, source/selection/code/image/model/config digests, resource/output limits and invocation-bound service capability. No database URL/general storage keys. |
| `ResultCandidate` | `schemaVersion`, `jobId`, invocation identity, `manifestFileId`, `manifestSha256`, compact QC/outcome/usage summary. Provisional until API observes terminal execution and checks sealed inventory/current refs. |

Initially register/deploy `process-recording`; `export-release` is the follow-up Dataset-version task. Both retain the same controller contract. Render controller input is the secret-free `{jobId}`; task names are `process-recording` and `export-release`. Dispatch key `job:{jobId}` binds that exact task/input; conflict fails. Compute `TaskInput` is one positional argument; the private bootstrap token is separate. A local subprocess receives it over stdin or a private file; Modal receives it only through the private invocation. Do not persist plaintext credentials in task/diagnostic manifests or logs. A worker may repair the missing Modal call ID during claim; an unknown unclaimed submission never authorizes blind resubmission.

Use job states `queued`, `submitting`, `submit_unknown`, `running`, `result_pending`, `succeeded`, `failed`, `cancel_requested`, `cancelled`, `needs_attention`. API conditional transactions own transitions. A processing retry is another row linked by `previousJobId`. Workflow controller retries recover that same row and known compute call; they do not create another processing attempt. Store the workflow task, fixed dispatch key, admitted run ID, controller nonce/lease and first-admission deadline on the job row. The same Render run may retry its controller; a different duplicate run exits. There are no planned continuations or controller generations. `recordings.currentJobId` / `releases.exportJobId` prevent a stale callback from selecting older results. [Recovery](components/job-orchestration.md)

## Durable documents

| Document | Required content |
| --- | --- |
| `recording-source/v1` | Recording/owner/client capture identity, exact sealed file IDs/roles/requiredness/bytes/hashes, capture version, native channel/calibration/clock inventory and collection permission reference. Source verification starts pending. |
| `processing-result/v1` | Job and source digest, code/image/model/config/profile, server-verified source hashes, required output file IDs/bytes/hashes, immutable clip inventory including safe RRD/thumbnail file references and pinned Rerun SDK version, frame-map/pose-array schema refs, automatic check records/errors and limitations. No mutable `latest` or arbitrary URL. |
| `hand-observations/v1` | Exact source-frame mapping and joint order; up to two predicted sides; 21 image `(x,y)` landmarks and model-relative `(x,y,z)` estimates; units/raster/model frame, detection/finite masks, handedness score and explicit unknown visibility. Never manufacture per-joint confidence. |
| `review/v1` | Successful job/result hash/clip, reviewer/revision/time, approved/rejected decision, whole-clip task label and notes. Append a revision; no last-write-wins approval. |
| `release-selection/v1` | Follow-up only: dataset ID/revision/name, ALL member clip IDs and frozen approved review revisions, exact source/result/label/file references, permitted-use evidence and exporter/schema revision. Immutable once export queues; freeze blocks any unapproved member or oversized whole dataset; publication rechecks dataset revision and each frozen review is still the latest approved revision for that job/clip. Withdrawal/label changes block a stale draft and require another release. |
| `release/v1` | Follow-up only: dataset/version and release/selection digest, all approved clip/video/pose/mapping/label files with safe relative paths/bytes/SHA, reader/schema/model provenance, rights/notices and limitations. Archive reference/hash sits outside the archive's own inventory to avoid recursion. |

The source declaration and server-verified result are distinct hashed documents. A frame-map row preserves native event/frame ID and integer timestamps/clock domains, raster/crop/rotation/mirror transforms, associated sensor IDs and clip PTS/time base. Preserve unverified timing/metric flags; model-local 3D is not calibrated camera/world pose. The format README defines array dimensions, missingness, joint order and coordinate conventions.

In the Dataset-version follow-up, the portable TAR contains all approved selected files, its file manifest and small reader/README. A separate checksum file covers the TAR. Customer APIs expose release-safe summaries and logical file IDs, not internal notes or contributor identities. Output manifests may reference only completed files owned by that job/approved selection. Never delete referenced files as temporary scratch.

## Conformance evidence

Test large integer round trips through TypeScript/Dart/Python, manifest-byte hash stability, joint/raster/frame mapping, null/NaN masks, bounded requests and owner-bound idempotency conflicts. Test a local real-model package through the actual reader, plus a cloud CPU canary. Fake models verify control flow only. [Monorepo](components/monorepo.md), [local acceptance](components/local-development.md).
