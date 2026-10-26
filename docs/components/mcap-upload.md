# MCAP upload and ingest handoff

Selected Render implementation design, 2026-10-26. Owner: mobile/backend. No application code or infrastructure is implemented by this document.

Implement these contracts in Next.js Node route handlers on Render using the shared TypeScript domain services. Reuse the Flutter queue/native uploader only after qualification. The cloned server is protocol evidence. R2 is the storage candidate, with a qualified S3 fallback. Files travel directly from phone to storage; extraction/annotation run on Modal cloud workers. [Deployment](render-deployment.md)

Shared definitions: [wire contracts](../contracts.md), [auth](auth-and-access.md), [storage/states](storage-and-data-model.md), [workflow](job-orchestration.md), [processing flow](pipeline-execution-and-data-flow.md).

## End-to-end behavior

1. Stop producers, drain/finish MCAP and close its writer. Require nonzero length, leading/trailing magic and a native closed-file acknowledgment. An early `metadata.json` is not readiness; cloud parsing remains authoritative.
2. Persist an owner-bound local queue entry with random `clientRecordingId`/`clientUploadId`, organization/project, app-relative file URI and source version. Stream full SHA-256 with bounded buffers; compare file identity/size before and after. Never hash a growing file or substitute a path/head-tail fingerprint.
3. Register the recording and allocate each file's upload. Persist server IDs and the frozen byte-range plan before starting PUTs. A server failure leaves the same local identity retryable.
4. Seal the logical inventory: file roles/segments, expected sizes/hashes, requiredness and profile. Uploads may finish before or after sealing. The profile defines required metadata/calibration; missing required inputs cannot silently downgrade a geometry profile.
5. Transfer a bounded chunk window directly to signed URLs. Journal PUT receipts, reconcile storage and renew only missing parts. Account switches pause the original owner's queue; they never reassign it.
6. Complete each file after exact provider-part verification. Only a sealed recording with every required file uploaded can create one `ingest_capture` job and transactional outbox event.
7. Modal CPU independently verifies hashes/MCAP, extracts bounded evidence, produces compact QC/preview and reports through fenced acceptance. Show separate uploaded/verifying/verified states. GPU stages require accepted ingest and policy admission.

Keep local originals until verified acknowledgment and the configured local retention policy. Failed/quarantined verification never triggers automatic source deletion. Preserve journals across expiry/logout; require the original account and current project access to resume. [Auth lifecycle](auth-and-access.md)

## Ownership, content identity and limits

The server resolves the collector, organization/project grant and any task/subtask assignment. Reject projects outside the organization and assignments belonging to another project/collector. Store server-resolved `rights_policy_revision`, evidence and permitted processing/export scopes; metadata and collector assertions cannot grant rights. Collection authorization and any required privacy treatment are launch gates, checked again before inference/export.

A sealed logical source is identified by role/segment, bytes and SHA-256. Same-content recovery may append an audited physical generation with a fresh `fileId`/key; changed content requires a new sealed revision/run. Completed source keys are never overwritten. The ingest manifest freezes exact selected physical generations.

Only the server chooses bucket/key/upload ID. Example source key:

`{userId}/orgs/{orgId}/recordings/{recordingId}/raw/{fileId}/source.mcap`

Use one-part multipart for small canonical files too. Optional single-PUT sidecars must first land in staging and finalize into a fresh protected key, or wait until every write capability expires before acceptance. Hash verification alone cannot prevent an unexpired PUT from overwriting accepted metadata.

| Setting | Pilot default |
| --- | --- |
| Source MCAP cap | 100 GiB; reject before creating storage upload |
| Part plan | Existing 16–64 MiB sizing through 60 GiB, 128 MiB above; server enforces uniform non-final parts and at most 10,000 |
| Device concurrency | One source file; two PUTs, configurable maximum four |
| Temporary chunks | Four-part window plus one chunk/reserve; never duplicate the entire source |
| URL signing | At most 32 unique parts/request; 60-minute validity, refresh before final ten minutes |
| Multipart age | Warn at day five; explicit seven-day incomplete-upload lifecycle |

R2 requires uniform non-final parts within its 5 MiB–5 GiB bounds. Its lifecycle deadline is measured from initiation, not last progress. Qualify these defaults on real devices; a heartbeat cannot extend provider expiry. [R2 multipart rules](https://developers.cloudflare.com/r2/objects/upload-objects/)

## API surface

All paths are absolute. Human requests use Better Auth through Next.js Node route handlers; responses, decimal-string bytes/timestamps, hash format, validation limits and error envelopes follow [contracts](../contracts.md). Success responses contain `data`; rejected requests expose no foreign-resource information or provider secrets.

| Endpoint | Required fields / result |
| --- | --- |
| `POST /api/v1/recordings` | `organizationId`, `projectId`, `clientRecordingId`, device/app provenance; optional validated `assignmentId`. Return recording ID. `201` create, `200` identical replay, `409 idempotency_conflict` for changed scope/content. |
| `GET /api/v1/recordings/:id` | Return scoped inventory, transfer/ingest state and missing required files. |
| `POST /api/v1/uploads` | `recordingId`, `clientUploadId`, `role`, optional `segmentIndex`, `originalFilename`, `contentType`, `sizeBytes`, `sha256`, `planVersion`. Return `uploadSessionId`, `fileId`, state, frozen `plan` and `uploadDeadlineAt`. `201` ready, `200` replay, `202` initializing, `413 file_too_large`, `409 source_identity_conflict`. |
| `POST /api/v1/recordings/:id/seal` | `profileRevision`, `files[{role,segmentIndex?,sizeBytes,sha256,required}]`, explicit `omittedOptionalRoles`. Server matches approved profile/allocated generations and stores inventory digest. `201` sealed, `200` identical replay, `409 sealed_inventory_conflict`, `422 profile_requirements_unsatisfied`. |
| `GET /api/v1/uploads/:id` | Return state, plan and latest reconciliation summary; no caller-selected provider identifiers. |
| `POST /api/v1/uploads/:id/parts/sign` | `partNumbers` within the frozen plan. Return `{partNumber,offsetBytes,lengthBytes,url,expiresAt,requiredHeaders}` entries. `409 upload_not_active`, `410 upload_expired`. |
| `PUT /api/v1/uploads/:id/parts/receipts` | `parts[{partNumber,etag,sizeBytes}]`, bounded to 32. Idempotently journal PUT receipts; conflicting receipt returns `409 receipt_conflict` and requires reconciliation. |
| `POST /api/v1/uploads/:id/reconcile` | No body identifiers. Return canonical part presence/missing numbers and observed completion. `200` result; `202` includes `operation: "reconcile"` while its leased operation runs, preserving the session state; `410` gone without matching complete object. |
| `POST /api/v1/uploads/:id/complete` | No caller part list/count/key. Return `202` with waiting-for-seal/files, ingest-queued/running state; `200` terminal replay. `409 parts_incomplete`, `source_changed` or `cancelled`; proven integrity mismatch is `422`. |
| `POST /api/v1/uploads/:id/cancel` | Persist intent and abort provider upload. `202` cleanup pending; `200` cancelled replay. Completed sources use recording deletion. |
| `DELETE /api/v1/recordings/:id` | Authorized tombstone/cleanup request; `202`. Apply retention/published-release policy. |

`plan` contains `version`, `sizeBytes`, `partSizeBytes`, `partCount`; offsets/lengths are byte counts. Exact ranges derive from file size, with only the last part shorter. Presigned URLs are transport capabilities, not authorization inputs. Common auth/rate/dependency errors are centralized; specifically, DB failure returns retryable `503`, never an untracked upload.

Session responses contain `state` and optional `operation`. `upload_sessions.state` is `initializing`, `ready`, `uploading`, `completing`, `completed`, `cancel_requested`, `cancelled`, `expired` or `blocked`; [storage](storage-and-data-model.md) owns this enum. Reconciliation uses the leased `operation: "reconcile"`, not a new lifecycle state. `blocked` preserves progress with `blockedReason` and `resumeState`. Provider-proven completion sets session `completed` and file transfer `uploaded`; confirmed abort/cleanup sets session `cancelled` and file transfer `aborted`. These coarse file-transfer states remain separate from session/control state and file verification.

Persist unique `(owner_user_id, client_recording_id)` and `(owner_user_id, client_upload_id)` mappings with canonical request hashes including organization/project/assignment. Retain them/tombstones for the recording's retention period. A replay cannot move a recording between projects. [Canonical schema](storage-and-data-model.md)

## Durable storage protocol

**Start:** reserve the DB session/key before provider creation; claim a short initialization lease. Create multipart outside the transaction, then persist provider identity before returning ready. Concurrent starts reuse the reservation. If creation succeeds but its response/persistence is lost, reconcile candidates for that exact key before repeating anything. Adopt an unambiguous candidate; otherwise block recovery or allocate a fresh generation and clean proven orphans. Never overwrite an uncertain key.

**Resume:** drain native journal events, then fully paginate provider ListParts. Compare numbers and lengths with the frozen plan. Adopt matching provider parts missing locally; demote locally completed parts absent remotely. Preserve receipt provenance (`client_put_response` or qualified `provider_recovered`). A URL expiry renews the same part/session; it does not reset uploaded progress. Source mutation stops transfer and requires a new content identity.

AWS recommends preserving UploadPart response receipts and using ListParts for verification. Use that journal normally; recovery from provider listings is an explicit integration-tested exception followed by full-file verification. Neither part nor multipart ETag is our source SHA-256. [AWS receipt guidance](https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html)

**Complete:**

1. Stop ordinary PUT scheduling; authorize and claim completion. Fetch every provider page; require exactly `1..partCount`, exact individual/total bytes, valid matching receipts and no extra parts.
2. Complete through the qualified SDK; parse success through SDK semantics, because S3 can embed an error in HTTP 200. HEAD must match expected length and server-created file/session identity metadata. [S3 completion semantics](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CompleteMultipartUpload.html)
3. In a short transaction, recheck current completion claim, generation, source identity and non-cancelled/non-deleted state. Mark transfer `uploaded`, verification `pending`; call `maybeCreateIngest`.
4. `maybeCreateIngest` runs both on sealing and file completion. It locks the recording, requires the sealed complete required inventory, freezes exact input generations, and uniquely creates the run/`ingest_capture` job plus `event_outbox`. The minute Render cron relays its deterministic dispatch to the `ingest-run` Render task. A DB failure after provider completion recovers through the same HEAD/transaction, without reuploading.

A lost completion response or `NoSuchUpload` triggers reconciliation: matching complete object permits recovery; absent object means restart-required; wrong identity/size quarantines. A bare successful HEAD is insufficient. A still-valid PUT may race ListParts before completion; independent cloud SHA-256 catches altered final bytes.

**Ingest acceptance:** the frozen input manifest admits the first CPU validator without requiring prior server verification. Hash every required source while downloading, parse MCAP and verify available CRCs without requiring optional summaries. Bound decompression/dimensions/runtime; derive actual channels and metadata discrepancies. Preserve native clocks/calibration; never infer RGB/depth synchronization or metric accuracy. Acceptance checks current `claim_epoch`, owner, input digest, writer/lifecycle state and validated outputs before setting files `verified` or enabling GPU successors. [Processing contracts](cloud-processing.md)

## Cancellation, cleanup and implementation

Cancel/revocation stops signing and blocks final acceptance; abort provider multipart, stop native tasks and reconcile late writes. Issued URLs remain usable until expiry/provider invalidation, so cleanup must account for outstanding capabilities. A collector cannot delete a published release by cancelling its former upload. Retention/deletion obligations, storage cleanup and restore replay follow [storage](storage-and-data-model.md).

Implement `backend/src/` recording/upload services, routes, schema migrations and storage adapter; extend existing Flutter Drift/native seams. Use the [finalization helper](../../stera-app/apps/mobile/lib/src/services/upload_service/utils/mcap_finalization.dart), [queue/coordinator](../../stera-app/apps/mobile/lib/src/services/upload_service/coordinator/windowed_upload_coordinator.dart) and [existing tests](../../stera-app/apps/mobile/test/src/services/upload_service/) as audited reuse candidates. Replace unsafe cloned backend behavior. Import legacy rows as verification `pending`; ambiguous owner/hash/sidecars require recovery, never automatic certification or local deletion.

Required acceptance evidence:

- Early metadata/unclosed file is not transferable; full hash detects same-length mutation.
- App kill, URL expiry, account switch and low disk preserve ownership/progress with bounded chunk space.
- Duplicate/uncertain start and completion, DB outage after provider success, missing/extra parts and pagination beyond 1,000 converge safely.
- Seal/final-file races create one ingest; missing sidecars cannot activate it; changed-content generations cannot satisfy an old seal.
- Cross-project IDs/assignments and revoked grants mint no capabilities.
- Cancellation wins before final commit; late PUTs/sidecars cannot resurrect accepted data.
- Corrupt MCAP/hash mismatch/unsupported geometry remain diagnosed; local originals survive failed verification.
- Real-device large-file/background tests and exact R2/S3 transport tests pass before rollout. The 100 GiB transport cap does not establish long-recording processing memory safety.
