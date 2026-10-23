# Internal review and customer delivery

Proposed implementation, 2026-10-23. Owner: backend/frontend/data operations. Both workflows ship in the first deployed product.

**Our team corrects, approves and publishes. Robotics customers inspect granted releases and download the complete training package.** Customers never accept/reject episodes or change processing/labels.

Build one static React/Vite console against the owned Node.js 24/TypeScript/Fastify API. Enforce permissions server-side. Follow [shared contracts](../contracts.md), [auth](auth-and-access.md), [storage](storage-and-data-model.md), [processing](pipeline-execution-and-data-flow.md) and [orchestration](job-orchestration.md).

## What internal reviewers do

| Surface | Action and durable result |
| --- | --- |
| Project dashboard | Inspect uploads, ingest failures and coverage within assigned projects. |
| Review queue | Open a ready review package pinned to its processing run, batch dataset versions, selection/result-contract digests and artifacts. |
| Episode viewer | Play proxy, inspect QC/overlays and edit semantic intervals, tools, objects and outcomes. |
| Save labels | Create an immutable revision with parent, author, taxonomy, exact source endpoints and annotation digest. |
| Decide | Request changes, reject for a named use, or approve exact package/label/profile revisions. |
| Release builder | Freeze approved items, rights/profile and grouped splits; request cloud packaging. |
| Publish | An authorized internal admin publishes the independently validated package and recipient grants. |

Saving uses compare-and-set on `expectedRevision`, a safe JSON integer; concurrent edits return `409 revision_conflict`. New labels are unapproved until reviewed. Old approvals and published releases remain unchanged. Reprocessing creates a new run/review package. `latest` helps navigation only; it is never a release dependency.

Reviewer and publisher grants are separate. The same pilot operator may hold both; audit the actual actor rather than claim independent human review occurred. [Role rules](auth-and-access.md)

## Review evidence and product gates

The preview timeline maps PTS/frame positions to exact source-frame IDs and native clock values. Label intervals are half-open `[start,end)` in one declared native clock/segment, with decimal-string nanoseconds and a pinned mapping revision. Never join depth/IMU/pose by preview FPS or promote plausible overlays to measured accuracy. Display missing alignment and per-field validity explicitly. HTML video/Range access plus a canvas overlay is sufficient; fetch only the visible/downsampled window. Large diagnostic replays remain on demand.

Every source/run/release references `rights_policy_revision`, supporting evidence and permitted processing/export scopes. Review must resolve required privacy treatment, restricted household/customer information and allowed uses before publication. Redaction outputs need their own hashes/transforms; customers receive only the approved variant. A collector assertion, reviewer approval or runnable model does not independently establish commercial rights.

Deletion/withdrawal requests revoke affected new access and follow the dependency-aware retention process, including releases/backups. Already issued URLs and downloaded files cannot be recalled instantly; show that limitation and record obligations. [Storage/deletion](storage-and-data-model.md)

| Profile | Required package and limitation |
| --- | --- |
| `rgb_semantics_v1` | Decodable oriented RGB, exact source-time mapping, reviewed temporal labels, taxonomy, rights/provenance and tested loader. No metric-action claim. |
| `geometry_estimates_v1` | Above plus declared frames/calibration/clocks and available camera/hand estimates with masks/model provenance. Unqualified channels remain identified. |
| Customer motion profile | Named action representation, error budget, independent accuracy evidence, commercial rights and tested adapter. Block until established. |

The profile defines “complete trainable data.” Missing robot actions, forces, contacts or valid hands are not fabricated to satisfy an export shape. A loader test proves usability, not training benefit. [Existing qualification gaps](../training-qualification-requirements.md)

Split by correlated source groups before making train/validation/test selections: all clips from one recording stay together; include task/session/retake and agreed site/worker grouping when available. Check exact duplicates and available near-duplicate signals across splits. Store the group/split policy revision and overlap report; keep sensitive grouping identities private. If evidence cannot support the promised separation, reject that claim or release profile rather than randomly split adjacent clips.

## Release build and publication

1. An internal admin freezes run/batch versions, selection/contract digests, artifact/label/review IDs, split assignments, rights/profile and exporter/loader revisions. One transaction creates the release/export job and outbox event.
2. Inngest invokes Modal CPU `export_release`. It reads only accepted references and writes portable shards into a unique **unpublished release destination**. It never mutates canonical Lance or packages on the phone/API host.
3. The release manifest lists every file's relative path, SHA-256 and bytes, plus item inventory, schema/loader, masks/mappings, taxonomy, grouped splits, dataset card, attribution and limitations. No expiring URL or hidden scratch dependency belongs in the package.
4. Close the export writer before validation: prohibit capability renewal, confirm exporter termination, retire or wait for expiry of **all** destination write capabilities, then reconcile pending writes and observed object visibility. Persist a write-barrier generation and its evidence. A catalog state change never revokes storage permission. If retirement/visibility is uncertain, block validation/publication; use a new destination for a later export attempt.
5. A separate finite trusted CPU validator reads the complete reference closure, checks hashes/profile/rights and runs the loader. Its compact receipt binds the manifest/input digests and exact write-barrier generation/evidence. Do not copy the entire release again by default; copy only when isolation/portability requires it.
6. Short API acceptance marks the package `ready` only if current claim, frozen inputs, validated write barrier and non-cancelled/non-deleted state still match. Internal publication rechecks the same barrier generation/receipt, current authority, exact ready manifest/selection, rights/privacy eligibility and recipients before atomically publishing/granting access. Never regrant writes to that accepted destination.
7. Corrections create another release version; revocation blocks new grants/URLs without rewriting historical checksums. Customers cannot cancel export/publication.

Prefer independent 1–4 GiB shards initially, tuned with downloads; stream packing/multipart writes. Portable video/Parquet/JSON and documented arrays are sufficient. Add a LeRobot/Open-AoE adapter only for a named tested consumer/version. Raw MCAP requires a separate grant/product decision. Never ship unapproved predictions or omit required masks because the preview looks complete.

## API and downloader contract

All paths are absolute. Human routes use `/api/v1`; download-capability routes use `/api/download` and separate middleware. Shared schema/envelope/encoding rules are in [contracts](../contracts.md).

| Endpoint | Required scope / key fields |
| --- | --- |
| `GET /api/v1/internal/review-queue` | Assigned staff; project/profile/state filters and cursor. |
| `GET /api/v1/internal/recordings/:id/review-package` | Assigned staff; return exact package/run/snapshots and selected label revision. |
| `POST /api/v1/internal/recordings/:id/label-revisions` | Reviewer; `processingRunId`, `reviewPackageDigest`, safe-integer `expectedRevision`, `taxonomyRevision`, bounded `intervals`. Append-only; `409` on stale parent. |
| `POST /api/v1/internal/recordings/:id/reviews` | Reviewer; exact package/run, `labelRevisionId`, `profileRevision`, decision and reason for changes/rejection. |
| `POST /api/v1/internal/releases` | Admin; `projectId`, `profileRevision`, exact approved item references and `splitPolicyRevision`; require `Idempotency-Key`. |
| `POST /api/v1/internal/releases/:id/publish` | Admin; `expectedManifestSha256` and validated recipient grants; `409` if package/state changed. |
| `POST /api/v1/internal/releases/:id/revoke` | Admin; audited reason. |
| `GET /api/v1/releases` and `GET /api/v1/releases/:id` | Live recipient grant; published inventory/card only. |
| `GET /api/v1/releases/:id/items` | Live grant; cursor through immutable items. |
| `POST /api/v1/releases/:id/download-sessions` | Live grant; bind requester/recipient/release/manifest; return session ID, scoped capability and expiry. |
| `GET /api/download/sessions/:id/manifest` | Download capability; immutable complete manifest. |
| `POST /api/download/sessions/:id/urls` | Capability; at most 100 file IDs/cursor; return relative paths, bytes/hashes and expiring Range GET URLs. |

Each interval supplies `id`, `sourceSegmentId`, `startSourceFrameId`, `endSourceFrameId`, `clockId`, decimal-string `startTimestampNs`/`endTimestampNs`, and taxonomy-valid `labels`. Endpoints follow `[start,end)` and the pinned source mapping: the end frame is the first excluded frame; at segment end it is null and the mapping must supply an explicit terminal boundary. Require ordered boundaries in the same native clock/segment; split cross-segment intervals. Review `decision` is `needs_changes`, `approved` or `rejected`. Release `items` specify `recordingId`, `processingRunId`, `batchSnapshotIds`, `labelRevisionId` and `reviewId`; resolve these server-side rather than accepting storage URLs. Commit these request schemas before implementation.

A session ID is not a credential. Browser login creates the existing release-scoped random capability; store its hash server-side and deliver it to the CLI without shell-history/log exposure. Download middleware rechecks bound identity eligibility, recipient membership, grant, publication, manifest digest and expiry/revocation on every request. The recipient need not join the producer organization. Normal customer APIs reveal no internal notes, unreviewed/raw paths or unrelated identities.

Provide a versioned Python downloader: fetch the whole manifest, reject unsafe paths, download with bounded concurrency, journal Range offsets, renew expired URLs and verify every SHA-256 before a local completion receipt. Default signed URLs last ten minutes; test large transfers and retries. Grant revocation stops renewal; existing URLs may survive until expiry. Audit URL issuance separately from client-reported download completion.

## Implementation and acceptance

Own `console/`, backend review/release/download services and `processing/export/`. Reuse visualization code only after pinned code/assets/notices are cleared; Pareto remains a reference, not a default dependency. Do not adopt another framework/catalog merely to render timelines.

Before pilot: prove cross-project/customer isolation; label CAS/half-open endpoint mapping and immutable approval; rights/redaction and correlated-split checks; stale/cancelled export rejection; delayed writes or renewed exporter capabilities block validation/publication; complete multi-page downloads with masks/mappings; expiry/revocation/resume/hash verification; and entire-package loader checks after workflow trace retention expires. Internal review and customer delivery must both pass the collector-to-customer canary.
