# Internal review and customer delivery

Status: proposed implementation. Updated: 2026-10-22.

Parent: [Technical design](../technical-design.md). Related: [auth](auth-and-access.md), [storage/data model](storage-and-data-model.md), [processing](cloud-processing.md), [orchestration](job-orchestration.md).

## Product contract

Ship both workflows in the first deployed version. **Our team reviews, corrects, approves and publishes. Robotics customers inspect published deliveries and download the complete released training package.** Customers have no episode accept/reject task and cannot edit internal labels or processing state.

Use one small role-aware web application, proposed at `console/`, with shared components and separate internal/customer route groups. A static React/Vite application is sufficient. The standalone Node variant can serve its compiled assets and API under the same HTTPS origin; the Supabase Edge variant requires a static host and qualified cross-origin auth/API configuration. This is a new implementation target, not an existing console. Select one identity authority and API hosting path as described in the [technical design](../technical-design.md).

The API enforces every permission. Hiding a button or choosing a customer route is not authorization. Staff assignment and recipient release grants are defined in [auth](auth-and-access.md).

## Internal workflow

| Surface | User action | Durable result |
| --- | --- | --- |
| Collection/project dashboard | Inspect upload progress, ingest failures and recording coverage | Filtered server records; no direct storage listing |
| Review queue | Open a ready recording; assign reviewer | Assignment/audit history; exact processing run selected |
| Episode review | Play proxy, inspect QC/missingness, edit semantic intervals/tool/object/outcome labels | Immutable label revision with taxonomy and source-time references |
| Geometry inspection | Enable available overlays, see transform/clock/validity evidence | Explicit qualification notes; no automatic conversion of estimates into measurements |
| Review decision | Request correction, reject for a named use, or approve exact revision/profile | Append-only review tied to run, artifact hashes and label revision |
| Release builder | Select approved items/profile/splits, validate inventory, request packaging | Frozen release selection plus outbox event |
| Publication | Inspect completed package/loader test, publish and grant customer access | Published immutable manifest and explicit recipient grants |

Keep corrections as new label revisions. A revision has parent revision, author, interval data, taxonomy version and annotation object hash. Use optimistic concurrency (`expectedRevision` or an ETag backed by the DB revision); a concurrent edit returns `409 revision_conflict`. Do not overwrite another reviewer's edits silently.

Approval requires the currently selected revision. An edit after approval makes the new revision unapproved; it does not mutate the prior approval or an existing release. Reprocessing produces another run with its own review. `latest` may help navigation but is never a release dependency.

Internal admins own publication and customer grants. Reviewers can approve assigned items without automatically gaining publication power. For a two-person pilot, the same human may hold both grants; record that fact rather than claim independent review happened.

## Time-aware review

The preview is a presentation artifact. The timeline maps preview PTS/frame index to source frame IDs and native timestamps using the exported mapping. Label intervals carry their clock domain and integer timestamp values as decimal strings. If displaying elapsed seconds, retain the exact underlying source endpoints and mapping version.

Do not apply a fixed-FPS MP4 timestamp to depth, IMU or camera pose without a verified relationship. Show unsupported alignment as unknown. Geometry overlays must specify input coordinate frame, projection/orientation transform, model version and validity; an overlay that looks plausible is not an accuracy qualification.

Use HTML video with Range-enabled signed access and a canvas overlay for the initial 2D viewer. Render only the visible time window; fetch paginated/downsampled overlay data. Large arrays, Rerun replays and detailed per-frame diagnostics are on-demand internal tools, not default browser payloads. See [cloud processing](cloud-processing.md) for compact QC and diagnostic size controls.

## Reuse boundaries

Own the small catalog, review forms, access checks, release builder and download UI. Reuse selected Apache-licensed Open-AoE projection/timeline/rendering code only after copying its notices and isolating asset/model dependencies. HFlow's catalog/provenance patterns can inform the schema without adopting a second job/catalog database. Curator is processing infrastructure, not this product UI.

Pareto is a reference rather than the default UI dependency given the maintenance concern already raised. Do not import MANO files, learned model weights, dataset samples or a full renderer package merely because an enclosing project has an Apache license. Open-AoE's code, datasets and external assets have separate terms. [Open-AoE visualization source](https://github.com/ant-research/Open-AoE/tree/3504ac7e0639963cf9103ff29579504fc00989bd/aoe-visualization), [MANO terms](https://mano.is.tue.mpg.de/license.html).

## Release profiles

Every release names a supported use and tested consumer. Required channels and qualification gates belong to a versioned profile.

| Proposed profile | Required evidence/artifacts | Publication limit |
| --- | --- | --- |
| `rgb_semantics_v1` | Decodable oriented RGB, source-time mapping, reviewed temporal labels, taxonomy, rights/provenance, grouped split and tested loader | May support visual/semantic training; does not claim metric actions |
| `geometry_estimates_v1` | Above plus declared calibration/frames/clocks, camera and optional hand estimates with validity masks and model provenance | Explicitly estimated/unqualified channels stay identified; no blanket metric-accuracy claim |
| Customer-specific motion profile | Named action representation, timing/geometry error budget, independent qualification and consumer adapter | Block until measurements and applicable commercial model rights exist |

These are proposed product contracts, not published robotics procurement standards. Raw videos and estimated hands do not automatically supply robot actions. Never fabricate gripper commands, forces, contact labels or body motion to satisfy an export shape. A valid empty/masked prediction is preferable to silently invented supervision.

The existing [qualification requirements](../training-qualification-requirements.md) define the evidence gaps. Current Pixel capture success does not establish metric hand accuracy or downstream policy benefit.

## Release build protocol

1. Authorize an internal publication request. Freeze selected run/artifact/label/review IDs, split assignments, profile, rights policy and export/loader revision in one transaction. Insert an export job and outbox event.
2. Inngest runs the cloud CPU `export_release` stage. The worker reads accepted artifact IDs through scoped capabilities, validates required channels and rights, and streams immutable shards plus indexes. No packaging on a collector phone or the API host.
3. Emit a release manifest listing every required file/shard with SHA-256 and bytes, item counts, schema and limitations. Include dataset card, attribution, taxonomy, split/group policy and the runnable loader/adapter. Use relative release paths and stable logical IDs.
4. The trusted promotion service validates the entire object reference closure, performs checksum/loader checks, and copies outputs into the protected release namespace. No manifest may retain hidden dependencies on mutable worker scratch or expiring URLs.
5. Mark the release `ready`. An internal admin confirms the validated selection and publishes it with recipient grants. The final publication transaction rechecks ready state, frozen manifest/selection digests, current internal authority, rights/profile eligibility and valid recipient grants. If cancellation/deletion/revocation wins during packaging, publication fails safely. Publishing is an audited state change; already published bytes/selection are immutable.
6. Corrections create a new release version. Revocation disables new access and records a reason; it does not rewrite prior checksums or erase the audit trail.

For a small release, individual immutable files plus one manifest are acceptable. At larger sizes, use independent proposed 1–4 GiB shards so a broken connection does not restart a single enormous archive. Tune shard size with real downloads. Stream packing and multipart writes; do not hold a full dataset in RAM. Video is already compressed, so avoid spending GPU/CPU on unnecessary recompression.

Use portable Parquet/JSON/video and documented array schemas as the canonical evidence package. Add a LeRobot/Open-AoE/other adapter only for a specified, tested consumer/version. Passing a loader smoke test establishes format usability, not improved robot learning. Release contents are the full approved training package defined by its profile; optional raw MCAP access requires a separate grant/product decision.

## Customer experience

The customer sees releases explicitly granted to their user or recipient organization. They do not need membership in the producer organization. Recheck active recipient membership, identity eligibility, grant expiry/revocation and release publication before metadata or URL access.

| Page | Contents |
| --- | --- |
| Delivery list | Dataset/release version, publication date, usable item counts/hours, profile, size and availability |
| Delivery details | Dataset card, coverage, schema, QC/qualification summary, limitations, sample playback, changelog and loader instructions |
| Episode inspection | Published video/annotations/allowed overlays and provenance summary; read-only |
| Download all | Complete manifest, total bytes/files, resumable downloader instructions and short-lived URL batches |
| Download status | Local resume/checksum guidance, expired-URL refresh and clear revoked/unavailable errors |

No internal reviewer notes, unreviewed attempts, raw worker paths, private identity metadata or unrelated recordings appear in customer APIs. Customer feedback can be recorded separately but never changes approval/release contents automatically.

## API contracts

All routes below are proposed. Human API prefix: `/api/v1`. The narrowly scoped CLI capability routes use `/api/download` and separate middleware. Use shared runtime schemas and the auth component's error envelope. Tenant/resource lookup must not leak other tenants' IDs.

| Endpoint | Authorization and semantics |
| --- | --- |
| `GET /internal/review-queue` | Assigned internal staff; cursor filters by project/profile/state |
| `GET /internal/recordings/:id/review-package` | Assigned staff; exact selected run and available artifact metadata |
| `POST /internal/recordings/:id/label-revisions` | Assigned reviewer; parent revision required; append-only |
| `POST /internal/recordings/:id/reviews` | Assigned reviewer; exact run/labels/profile; reason required for negative decision |
| `POST /internal/releases` | Internal admin; freezes approved selection and queues export; `Idempotency-Key` required |
| `POST /internal/releases/:id/publish` | Internal admin; only validated `ready` package; explicit recipient grant |
| `POST /internal/releases/:id/revoke` | Internal admin; audited reason; blocks new download capabilities |
| `GET /releases` | Customer; cursor of granted published deliveries only |
| `GET /releases/:id` | Live grant; public-facing card/manifest summary |
| `GET /releases/:id/items` | Live grant; paginated immutable item inventory |
| `POST /releases/:id/download-sessions` | Live grant; session bound to requester/grant/release/manifest digest |
| `POST /api/download/sessions/:id/urls` | Release-scoped capability; recheck live identity/recipient membership/grant; bounded file-ID batch/cursor; exact signed Range GET URLs |

Use opaque file IDs, not caller-supplied bucket/key/URL. Add `GET /api/download/sessions/:id/manifest` for capability-authenticated manifest retrieval. Register these routes outside the global human-cookie middleware and require the hashed random download capability in a redacted Authorization header. A session ID alone never grants access. Load and recheck bound requester eligibility, recipient membership, live grant, release publication, manifest digest, expiry and revocation on every call. Browser creation/renewal remains authenticated through `/api/v1`. The capability cannot access normal user APIs or a different release.

A download URL response includes file ID, relative path, expected bytes/hash and expiry. Proposed default: ten-minute download URLs, refreshed as needed, bounded batches of 100. Test long transfers and provider signature behavior; expiry and Range retries must preserve download correctness. URLs are bearer capabilities and remain usable until expiry even after grant revocation, subject to provider behavior. Do not promise immediate revocation of issued URLs or already downloaded data.

All required file IDs must be discoverable through the full manifest/pagination. The UI must not limit “download all” to previews or the first result page. Rate limits protect URL minting but must permit the documented downloader to finish.

## Resumable downloader contract

Provide a small versioned Python CLI or documented API client with the release. It authenticates through a specifically approved customer credential flow, never a Modal/R2 parent key. For v1, the browser can create a short-lived, release-scoped download-session capability after login; the CLI consumes it without receiving the human session cookie. Store only a hash server-side, allow revocation/renewal through the logged-in portal, redact it from logs, and do not place the secret in a shell command recorded in history. Final credential UX is a required implementation task, not an already shipped CLI.

The downloader fetches the immutable manifest, checks safe relative paths, downloads files with bounded concurrency, persists progress and Range offsets, refreshes expired URLs, verifies SHA-256 and writes a local completion receipt. It must reject path traversal, mismatched files and revoked sessions. Counts and hashes determine completion, not the number of URLs issued.

URL issuance and provider reads are different events. Audit grants/session creation/URL minting without claiming the customer completed a download unless the client submits a verified receipt; even a receipt is client-reported evidence. Never log signed query strings.

## Acceptance and implementation sequence

Build the role-aware shell and auth first, then internal queue/video/timeline/corrections, then immutable export/publication, then customer inspection/download. Both roles must pass the same end-to-end pilot gate before deployment to collectors.

- A customer cannot cancel processing/export or publication; it may revoke its own download session. A customer cannot access an internal URL, mutate review state or enumerate unpublished artifacts.
- Two reviewers editing the same revision get a conflict, and approval is bound to exact accepted artifacts.
- Reprocessing/corrections leave an already published release byte-identical.
- Export rejects missing required files, uncleared model-dependent outputs, unapproved labels and mutable external references.
- A full download traverses multiple inventory/URL pages and verifies every required training artifact, including masks and mappings.
- Interrupt and resume multi-shard downloads; rotate/expire URLs; revoke a recipient grant; show honest residual URL lifetime.
- A sample loader can read the entire bounded release with timestamps, masks, coordinate conventions and splits intact.
- Publication and download work after workflow trace retention expires because application metadata and objects remain durable.

Detailed implementation work and dependencies are in [implementation plan](../implementation-plan.md).
