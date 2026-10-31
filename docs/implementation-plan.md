# MVP implementation milestones

Updated: 2026-10-31. Target: [technical design](technical-design.md). All paths/commands are implementation targets, not newly shipped services. Automatic 21-point hand inference, staff review and real read-only external review in the shared dataset/clip browser remain required. **Frozen dataset versions/publication and customer Download all are a follow-up, not part of this increment.**

## Build sequence

| Milestone | Deliverable | Exit evidence |
| --- | --- | --- |
| M0. Monorepo and contracts | Coordinate the active mobile fixes; import Flutter/native plugin/SDK into one root repository. Pin Node/pnpm, Flutter and Python/uv; add local Postgres/MinIO configuration, official Render local task server and shared schemas. Define nine active domain tables, immutable review clips, approved-only many-to-many dataset membership and operator-managed `dataset_access`. | Clean clone without submodules; Flutter/native regression checks; Node/Python builds; cross-language fixtures, latest-approval/membership/grant and clip identity constraints |
| M1. Local login and upload | Next.js UI/API, Better Auth, manual allowlist with pilot collection/processing permission evidence, owner-bound mobile journals, direct resumable multipart transfer and sealed file inventory. | Real-device login/expiry/account-switch tests; killed app/expired URL/lost completion resumes without changing ownership or duplicating a recording |
| M2. Local complete processor | The same `process-recording` Render task invokes LocalExecutor for the shared streaming extractor, mandatory MediaPipe CPU hand inference, pose arrays/masks/frame maps, bounded customer-safe RRDs and inline checks. Jobs, controller recovery and API-controlled output uploads follow the production contract. | Short real MCAP through upload → processing → review; corrupt input/missing hand/stale callback failures; bounded memory, scratch and RRD size on a representative two-hour input |
| M3. Local dataset browser and review | Pipeline has status/search filters and compact clickable rows opening `/pipeline/[recordingId]` with stage visualization and all actions. Its **Review clips** links to `/data-browser?recordingId=<UUID>`. Staff All clips includes accepted unreviewed/rejected/unassigned clips; default Data browser still lists datasets, and `datasetId=<UUID>` opens an approved-only grid for either role. The shared `/clips/[clipId]` Rerun form has Automatic quality checks, task label, optional notes, optional Datasets multiselect and approve/reject. Approval and chosen memberships commit together. | Pipeline row → recording detail → recording clip grid → shared clip page; approval/assignment atomicity and stale-input rollback; rejection removes all working memberships; no reapproval restore; same clip in multiple datasets; recorded external-review permission; customer grant isolation and All clips denial; safe real RRD playback |
| M4. Small cloud CPU canary | Render web/Postgres/Workflows/minute repair cron, private R2, Modal CPU wrapper over the same processing core, native Google sign-in configuration. | Known/unknown submission recovery, duplicate physical worker claim, cancel/timeout, output write closure, direct transfer, backup restore and measured gross cost |
| M5. Collection/review pilot | Signed mobile build, confirmed collection/processing/sharing permissions and retention policy; repair-footage hand-quality review; representative two-hour upload/cloud processing, staff review and authorized external inspection. | Recorded device/build/model/image/input versions, latency/resources/bytes/cost and reviewer decisions; external users can inspect approved granted data; customer package download remains unavailable until F1 |
| F1. Whole-dataset delivery follow-up | Implement frozen dataset versions using the specified release backend, add `releases`, and run `export-release` through the same official local runner/executor pattern. Freeze the whole dataset, export one complete TAR, publish and enable Download all with live dataset access. No separate Releases/Deliveries page is required by this plan. | Complete dataset → frozen approved snapshot → archive → authorized customer download; every checksum/reader passes; stale approval blocks publication and previous published bytes stay fixed |
| Later, if needed | Optional local CUDA model profile, then explicit cloud GPU qualification. Curator/Lance only after workload measurements justify another system. | Cleared weights/dependencies; stable 21-joint semantics, quality comparison, peak VRAM/throughput and authorized cloud cost cap |

M2 and M3 must pass without cloud GPU access. Stub models are useful for protocol tests but never substitute for real hand inference in the end-to-end acceptance run. An optional local GPU uses the same processor contract. Real external inspection is an initial acceptance gate; operators manage dataset grants through the allowlist, without a sharing UI. F1 retains the specified `export-release` task/TAR format but is not an initial deployment gate or an operator publishing workaround.

## Minimum acceptance cases

| Inject | Required outcome |
| --- | --- |
| Logout, expired session or account switch mid-upload | Original owner's files/journal retained; new user cannot claim them |
| Lost part/complete response, required sidecar/seal race | Same logical upload reconciles; one queued job only when all required sources are complete |
| Corrupt MCAP, unsupported clock/raster or oversized input | Explicit failure/limitation; no silent sensor reassociation or GPU escalation |
| Lost spawn acknowledgement or dispatcher crash | Existing claim/call ID reconciled; no blind spawn or automatic costly retry |
| Container replay, late old-job result or cancelled job | One admitted worker; stale result cannot replace the current job |
| Write after output seal | Denied; completed bytes cannot be reopened through an old worker upload capability |
| Occlusion, gloves, missing hand or ambiguous handedness | Visible missingness/limitations; no fabricated valid joints or validated metric claim |
| Dataset add/picker or one clip in two datasets | Only clips whose latest review is approved can enter a dataset, for every role; the picker excludes pending/rejected clips; membership changes never copy/mutate clip evidence |
| Pipeline row/detail and direct review link | The row opens its recording detail with all actions and stages; **Review clips** there opens staff All clips filtered to all that recording's clips; grid cards open the same shared clip page, without a Review sidebar item |
| Pipeline/Data navigation and URL refresh | Status/search, staff `view=clips`/recording/review filters and selected dataset survive refresh/Back/Forward; no Pipeline scenario selector |
| Approve with selected datasets | Nonblank label, expected review revision and every affected dataset revision validate before one decision/membership transaction commits; optional empty selection permits approved unassigned clips |
| Blank approval label, stale review/dataset revision or failed assignment | Entire approval/assignment rolls back; no new decision, partial membership or revision change |
| Reject/withdraw an assigned clip | Append the decision, remove every working dataset membership and bump affected dataset revisions in one transaction; new customer access ends; frozen versions remain pinned |
| Reapprove or race approval/add against rejection | Reapproval does not restore old memberships; assignments are explicit. Concurrent writes cannot leave a pending/rejected clip in any working dataset |
| Viewer denial, expired URL, load failure or browser teardown | Current access checked before safe RRD URL issuance; actionable retry; no private staff payload or leaked previous viewer |
| Customer dataset access, All clips or approval changes | Customer All clips/recording-wide browsing is forbidden; only latest-approved members/labels of a live granted dataset are visible. Removed/rejected clips and revoked grants cannot obtain fresh viewer URLs; no staff QC/notes or review mutations |
| Database restore | Reconcile external jobs/uploads and reapply revocations before resuming new work |

F1 separately proves whole-dataset freeze, changed-approval/membership publication rejection, the **32 GiB total** archive ceiling, complete extraction/checksums, Range/expiry/revocation behavior and authorized customer Download all. Defensively recheck every member's current approval; block rather than silently drop a member. Frozen versions pin membership and labels rather than following the mutable dataset; live dataset grants still apply. An oversized dataset must be split into smaller complete datasets before creating another version; never silently truncate or export a selected subset as the whole dataset.

Use synthetic data/fake providers for faults, short real MCAP for the full local flow, then a representative long capture. Reuse meaningful existing capture/geometry tests. Record the same input/model/config versions across local and cloud comparisons. Do not repeat expensive model runs when a contract fixture answers the question.

## Ownership

[Monorepo](components/monorepo.md) defines the exact target paths. Mobile owns capture/auth/journal transport; backend owns access/catalog/uploads/jobs/datasets/reviews and the follow-up release backend; robotics owns streaming extraction, model outputs, safe RRD generation and the later exporter; platform owns workflow definitions, executor adapters, local services, Render/Modal configuration and recovery. No second API, identity authority or catalog is needed.

The [contract](contracts.md), [component index](README.md) and [local development plan](components/local-development.md) are the implementation entrypoints. No source relocation, production deployment or paid processing is performed by this planning change.
