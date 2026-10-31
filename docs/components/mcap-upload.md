# MCAP and worker output uploads

MVP design · 2026-10-30 · Not implemented/deployed. [Contracts](../contracts.md) defines wire fields; [storage](storage-and-data-model.md) owns keys/states; [jobs](job-orchestration.md) owns processing.

The Flutter app uploads directly to private R2. Next.js handles bounded JSON and signs part URLs; it never forwards video bytes. One manually configured pilot project has `collector`, `staff` and `customer` access. The API resolves ownership and eligibility from the authenticated account; request metadata cannot grant access or change a capture's owner.

The [mobile capture/upload audit](mobile-capture-and-upload-readiness.md) records the current implementation gaps: Android uploads are unsupported, iOS native retries/background completion need correction, and actual sensor/timestamp/calibration evidence is incomplete. The limits below are proposed settings, not measured current behavior. JPEG in MCAP is the existing source profile; hardware-encoded RGB is a qualification candidate requiring a versioned decoder/source contract.

## Phone flow

1. Finish capture: stop producers, drain and close MCAP, obtain the native closed-file acknowledgment and final metadata. Early `metadata.json` is not readiness. Stream the complete file's SHA-256 with bounded buffers; compare file identity/length before and after hashing. Never upload a growing file.
2. Persist an owner-bound local journal containing `clientRecordingId`, app-relative source URI, source size/hash and subsequent server IDs/part receipts. Register the recording and allocate its files. HTTP/DB failure preserves the same local identity for retry.
3. Seal the complete logical inventory with exact `fileId`, role, bytes, SHA-256 and requiredness. Require the MCAP and final recorder metadata; any referenced required calibration sidecar must also be present. Upload completion and sealing may arrive in either order. Changed content conflicts with the sealed identity.
4. Upload missing byte ranges to signed R2 part URLs, recording their exact ETags. After interruption, reconcile provider parts and renew missing URLs; keep uploaded progress. An account switch/logout pauses the original owner's work without reassigning it.
5. The API completes each provider multipart upload. A short transaction locks the recording and creates exactly one queued `process_recording` job when its inventory is sealed and every required file is uploaded. Both seal and completion call the same eligibility routine. After commit, the API makes a bounded initial Render Workflow request; the minute repair cron retries due/uncertain controller dispatch through the API. Job state remains durable if the initial request fails; no outbox or extra dispatch ledger is required.
6. The Node workflow controller submits/polls the CPU worker through the selected executor. The worker hashes every source, parses MCAP, estimates hands, prepares review media and runs inline QC. Only successful source integrity verification changes source files to verified. Processing/output acceptance follows the job contract; controller continuation does not resubmit a running worker.

Show **uploading → uploaded → processing → reviewable**, with explicit failure/reason states. Uploaded does not mean hash-verified or training-qualified. Keep local originals until verified acknowledgment and the chosen local retention policy; failed verification never deletes them. Resume requires the original account. Changed source content uses a new logical file/recording. An expired unfinished transfer can restart the same logical file through the protocol below; a completed object is never reopened.

## Local storage after verification

Keep pending, failed and unverified captures on the phone. After the server confirms source SHA-256 verification and staff confirms the retained cloud copy is available, the original owner may explicitly delete that recording's local copy to free space. Show recording ID, bytes freed and an irreversible local-delete confirmation; deleting local bytes does not delete cloud data. No automatic cleanup after upload completion. Low-disk state blocks a new capture without purging pending work. Pilot support can assist using recording/job IDs; no support console is required.

## Limits

| Setting | MVP default |
| --- | --- |
| Capture | Up to two hours; **100GiB per source file** transport cap |
| Part plan | **64MiB**, uniform except final part; maximum 10,000 parts |
| Device upload concurrency | One source file, two PUTs |
| Temporary chunk files | At most two active chunks plus one reserve; no whole-source duplicate |
| Sign request | At most 32 part numbers; one-hour URLs refreshed before expiry |
| Incomplete upload | Seven-day lifecycle from initiation; warn before day five |

Lengths/offsets are decimal strings; bounded part numbers/counts are JSON integers. The server freezes a part plan from the declared size; clients cannot choose arbitrary ranges or object keys. R2 allows 5MiB–5GiB parts and requires uniform non-final sizes. Its multipart age is measured from initiation, not the last progress; a heartbeat does not extend it. [R2 rules](https://developers.cloudflare.com/r2/objects/upload-objects/)

## HTTP surface

All success/error envelopes follow [contracts](../contracts.md). `recordingId`, `fileId`, `jobId` and `releaseId` are UUIDs; auth user IDs remain opaque. HTTP uses camelCase; manifests use snake_case. No separate upload-session entity is needed: the `files` row holds its provider upload ID, plan, receipts and state.

| Human route | Operation |
| --- | --- |
| `POST /api/v1/recordings` | Register `clientRecordingId` and capture provenance; exact replay returns the same recording |
| `GET /api/v1/recordings/{recordingId}` | Own recording inventory, progress and missing required files |
| `POST /api/v1/uploads` | Allocate source `fileId` from recording, persistent client upload identity, role, size and SHA-256; return plan |
| `POST /api/v1/recordings/{recordingId}/seal` | Freeze exact file inventory; changed replay returns conflict |
| `GET /api/v1/uploads/{fileId}` | Current plan and transfer state |
| `POST /api/v1/uploads/{fileId}/parts/sign` | Sign validated `partNumbers`; return URL, required headers, offsets/lengths and expiry |
| `PUT /api/v1/uploads/{fileId}/parts/receipts` | Journal up to 32 exact `{partNumber,etag,sizeBytes}` receipts |
| `POST /api/v1/uploads/{fileId}/reconcile` | Fully paginate provider parts and recover progress |
| `POST /api/v1/uploads/{fileId}/complete` | API verifies parts and consumes provider multipart ID; client supplies no completion list/key |
| `POST /api/v1/uploads/{fileId}/restart` | Restart a confirmed retired unfinished transport with `expectedTransportEpoch`; keep logical file/content identity, allocate new key/MPU |
| `POST /api/v1/uploads/{fileId}/cancel` | Persist cancellation and abort incomplete upload; completed files follow recording deletion policy |

Scope persistent client recording/upload identities to the owner and original request digest. Identical replay is safe; changed scope/content returns `409`. A DB outage returns retryable failure, never an untracked storage upload. Revoked/ineligible users cannot mint new URLs or finish an upload. No organization, invitation, assignment or tenant-management API is required for this pilot.

## Provider completion and recovery

Reserve the `files` row and unique key **before** creating a provider multipart upload. Save its provider ID before returning URLs. Serialize initialization/completion with short database claims; perform network requests outside transactions. An uncertain creation is reconciled for that exact key, never blindly repeated. Ambiguous state is visible and blocks completion.

Normal completion uses journaled UploadPart receipts and provider verification. List **all** pages and require exactly the frozen part numbers, individual lengths and total bytes, with matching ETags. Recover missing receipts only through the qualified provider-listing path. ETags are not SHA-256. Complete through the SDK, then HEAD the exact server-allocated object and verify size/file identity. S3 completion may carry an error within HTTP 200, so do not inspect status alone. [Multipart receipts](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html), [completion semantics](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CompleteMultipartUpload.html)

If completion's response/DB write is lost, reconcile the existing object and multipart ID. A matching finalized object can recover completion; absent or conflicting evidence is not success. The processing worker independently checks source SHA-256. No source hashing occurs on the API host.

### Expired source transport

Keep logical `fileId`, size/SHA and sealed source inventory stable across an **unfinished transport** restart. The `files` row holds `transportEpoch` and current key/MPU separately from that content identity. Every signing/receipt/complete/cancel/restart mutation supplies the expected epoch; stale requests return 409. Provider calls are serialized for that file outside short DB transactions.

When the old MPU is proven aborted/expired, no completion is in flight and any uncertain provider outcome has been reconciled, an owner may request restart. Increment the epoch and allocate a fresh never-used key/MPU. Never restart a completed/verified file or reopen its key. Preserve source bytes/hash; changed bytes are a content conflict. The device retains its original owner/source journal but resets part receipts for the new epoch: old provider parts cannot be reused, so the file must be transferred again. A lost completion must be reconciled before restart; uncertainty cannot be bypassed by an expired operation lease.

## Worker output protocol

Trusted CPU jobs use the same file reservation, part planning/signing, receipt/reconciliation and API completion implementation through **job-scoped service routes**:

- `POST /internal/v1/jobs/{jobId}/outputs` reserves a `fileId`, declared bytes/SHA/role and unique job output prefix.
- `GET /internal/v1/jobs/{jobId}/uploads/{fileId}` and the corresponding `/parts/sign`, `/parts/receipts`, `/reconcile`, `/complete`, `/cancel` routes expose the same transport operations as above.

A job capability authenticates these requests; human cookies cannot. The API checks current job ownership/state, permitted output roles, byte/count limits and prefix. Jobs receive read URLs and part URLs, **no broad R2 write credential**. Use one-part multipart even for small manifests. Only the API calls CompleteMultipartUpload; completion consumes that upload ID, so old part URLs cannot overwrite its finalized object. New attempts have new job IDs/prefixes. Accepted files cannot be reopened or reused.

The worker computes output hashes and inline QC; the API validates the bounded inventory against finalized `files` rows and the current job before accepting it. This MVP trusts the processor; it does not claim separate independent annotation validation. Export uses the same protocol. Cancelled/stale jobs cannot create/complete outputs or reopen a release; abort their unfinished multipart uploads and reconcile uncertain provider responses.

For each release, stage **one complete TAR, at most 32 GiB total**, on worker scratch. Close it and compute its exact size/SHA-256 before reserving the upload. Reject an oversize selection before export and ask staff to make smaller complete releases; never truncate or silently produce undisclosed archive parts. This uses the ordinary known-size multipart protocol, not a new unknown-length upload contract.

## Implementation and acceptance

Implement the shared service in `packages/server`, contracts in `packages/contracts`, Flutter integration in `apps/mobile`/`packages/stera_recorder`, and CPU workers in `workers/processing`. The current cloned Flutter upload coordinator/finalization tests are reuse evidence; migrating them into the proposed monorepo is separate implementation work. Keep the source checkout read-only while the recording-fix agent works.

Local end-to-end tests use Postgres + MinIO, the official Render local Workflows runner and `LocalExecutor`, with these same API-issued multipart calls; no direct-filesystem bypass. Production uses the same Node controllers with `ModalExecutor`. Then qualify actual R2/provider semantics and one representative two-hour cloud capture. Required checks cover app kill/backgrounding, low disk, URL expiry, account switching, source mutation, more than 1,000 listed parts, duplicate/uncertain start/completion, DB failure after provider success, seal/final-file races, missing sidecars, cancellation and forged/stale job output. Verify downloaded raw/output bytes and full release checksums. The 100GiB transport cap does not establish two-hour worker memory safety.
