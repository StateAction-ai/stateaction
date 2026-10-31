# MVP review: engineering, product and design

Updated: 2026-10-31. Review scope: implementation design and offline UI prototype. **Verdict: ready to implement the revised capture-to-review scope, subject to the qualification evidence below.** The prototype is synthetic; the pipeline, monorepo migration and hosted services have not been implemented by this change. Real internal/external inspection is required initially; frozen dataset publication/export and customer Download all are explicitly deferred.

## Reviewed by three roles

| Role | Review result |
| --- | --- |
| Senior backend/robotics engineering | Reviewed upload expiry, streaming extraction, controller/worker recovery and immutable review constraints. Archive/publication safety remains specified for the follow-up rather than an initial feature. |
| Product management | Mandatory hands, staff review and real read-only external inspection remain. Staff reviews accepted clips before adding them to approved-only datasets; operators manage view grants. No sharing/release UI or substitute publishing tool ships now. |
| Product design/frontend | shadcn/ui + Tailwind/Radix for Next.js; existing Flutter widgets/theme for mobile. Pipeline rows open recording details with stage visualization and all actions; Review clips opens all clips for that recording, then the shared Rerun clip page with review/assignment controls. Both roles retain the default dataset browser. The mock remains synthetic. |

Earlier root reviews inspected rendered diagrams and desktop/phone mock layouts. The approved-only dataset/review-assignment revision requires its own receipt; prior scenario counts do not validate the current artifact. These reviews do not test production authentication, pose accuracy or cloud durability.

## MVP use-case coverage

“Covered” below means specified and represented in the prototype/acceptance plan; it does not mean production implementation exists.

| Actor / use case | Coverage / required behavior |
| --- | --- |
| Collector: login and enrollment | Google login, pending/denied access; original identity owns capture/journal |
| Collector: offline recording | Authorized offline capture, camera permission denial, low disk, interrupted/unclosed MCAP and explicit finalization |
| Collector: large upload | Two-hour target, bounded chunks/direct multipart, app-kill/background recovery, source mutation/hash failure |
| Collector: distinct expiry cases | Same-owner reauthentication; part URL refresh retains parts; seven-day MPU restart resets parts with disclosed full retransmission |
| Collector: account switch/storage | Another user cannot adopt pending capture; confirmed verified local original may be deleted explicitly, cloud source retained |
| Processing: mandatory hands | Actual 21-landmark CPU inference, labelled 3D estimates, missing/occluded observations and provenance; no RGB-only fallback on model error |
| Staff: Pipeline and faults | Status/search filters without a scenario selector; progress/errors, safe recovery and clickable rows to a per-recording stage/action detail, with Review clips linking to `/data-browser?recordingId=<UUID>`; no blind processing retry |
| Staff: All clips | Explicit `view=clips` includes accepted pending/rejected/unassigned clips; recording/review/search filters persist in the URL; cards open the shared `/clips/[clipId]` page |
| Shared Data browser | Dataset list by default, approved-only video grid with `datasetId=<UUID>` for both roles; deep links/empty/denied states; many-to-many membership without media copies |
| Staff: review and assignment | Same Rerun viewer as customers; Automatic quality checks, task label, optional notes and optional Datasets multiselect. Approve commits decision/selected memberships atomically; blank label or stale review/dataset revision changes nothing |
| Staff: reject/withdraw/reapprove | Reject/withdraw removes all working memberships and bumps dataset revisions in the same transaction. Reapproval never restores removed memberships automatically; assignment/rejection races preserve approved-only membership |
| Customer: initial inspection | Real read-only access to latest-approved members/labels of granted datasets; live grant/membership/approval checked before viewer URL issuance; All clips/recording-wide access is forbidden; no staff controls, QC/notes or per-episode approval |
| Staff/customer: package delivery | **Follow-up:** freeze the whole dataset, export one complete TAR at most 32 GiB total, recheck current approvals, publish and Download all with live dataset access; no separate release page now |
| Customer: later download recovery | **Follow-up:** complete manifest/checksum/reader, Range/expiry behavior, live-grant renewal and revocation; issued URLs may remain usable until expiry |
| Engineer: local end-to-end | Official Render local runner and identical `process-recording` task/contracts; real CPU first, optional local GPU profile, then small Modal CPU/R2 canary; exporter uses the same pattern when added |
| Operations: rights/support/recovery | Manual permission evidence before collection/inference, recording/job error IDs, PITR and safe external-state reconciliation; export permission checked again in the follow-up |

See [UI component/state contract](components/ui-design.md), [scenario inventory](mocks/README.md), [clickable prototype](mocks/index.html) and [implementation acceptance](implementation-plan.md).

## Deliberate MVP limits

One pilot project, three manual roles, one admitted execution, no automatic costly retries and operator-assisted recovery. The initial nine domain tables include immutable clips, datasets, membership and `dataset_access`; the later `releases` table brings the planned total to ten. Only latest-approved clips can belong to working datasets, including staff views. One clip may belong to several datasets or remain approved/unassigned. Pending/rejected clips remain available through staff All clips; dataset organization never changes source ownership or processing evidence.

Frozen-version creation/publication and customer package download are a follow-up with a whole-dataset snapshot and one documented TAR format. No Releases/Deliveries screen, sharing UI or new operator publishing tool is included now. Current external inspection uses approved dataset members and current labels; future frozen versions retain their pinned membership/labels while still checking live dataset access. Automatic captions/embeddings, Curator/Ray/Lance, organization/invitation UI, per-joint correction, verified metric trajectories, multiple training adapters and a custom downloader are also deferred. Mandatory hand inference and real internal/external browser/viewer access remain in scope.

## Evidence needed before real collection

Demonstrate hand usefulness on repair/tool/glove/occlusion footage; signed-device auth and a representative two-hour background/resumable upload; bounded processing RAM/scratch/time and clip RRD bytes; real R2 multipart retirement and known/unknown workflow/worker recovery; permission/retention decisions; database restore; actual pinned Rerun production build/browser behavior; the Pipeline recording-detail review entrypoint; atomic approve/assign and reject/remove races; and real external dataset/clip isolation. Start with the small model locally. No cloud GPU is necessary for the agreed baseline, and no paid GPU run was performed for this review.

Before customer package delivery, separately implement and qualify the whole-dataset release backend, frozen approvals/live grants and complete downloaded package with every checksum verified. A working read-only mock establishes neither initial production inspection nor that later download gate.

The [2026-10-30 receipt](validation/mvp-design-review-20261030.json) and [earlier 2026-10-31 dataset-browser receipt](validation/dataset-browser-review-20261031.json) are **historical evidence for earlier revisions**. Their scenario/check counts do not validate the approved-only dataset/review-assignment revision. The [approved-only review receipt](validation/approved-dataset-review-20261031.json) records 24 independent root responsive checks, 22 interactions and eight visually inspected screenshots. The UI agent separately reported 124 responsive checks; this is distinct from real integration testing. Mock checks remain separate from real pipeline qualification.

The [Pipeline recording-detail receipt](validation/pipeline-recording-details-20261031.json) supersedes earlier Pipeline layout/navigation evidence: 56 responsive checks, 16 action/navigation cases and seven recordingId-only follow-up checks. Stage telemetry remains a prototype.
