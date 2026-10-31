# MVP review: engineering, product and design

Updated: 2026-10-31. Review scope: implementation design and offline UI prototype. **Verdict: ready to implement the revised capture-to-review scope, subject to the qualification evidence below.** The prototype is synthetic; the pipeline, monorepo migration and hosted services have not been implemented by this change. Real internal/external inspection is required initially; frozen dataset publication/export and customer Download all are explicitly deferred.

## Reviewed by three roles

| Role | Review result |
| --- | --- |
| Senior backend/robotics engineering | Reviewed upload expiry, streaming extraction, controller/worker recovery and immutable review constraints. Archive/publication safety remains specified for the follow-up rather than an initial feature. |
| Product management | Mandatory hands, staff review and real shared read-only external inspection remain. Pipeline is status/errors only; Data browser groups immutable clips into datasets. Operators manage dataset grants through the allowlist. No sharing/release UI or substitute publishing tool ships now. |
| Product design/frontend | shadcn/ui + Tailwind/Radix for Next.js; existing Flutter widgets/theme for mobile. One shared Rerun clip page, staff-only review controls and the same Data browser structure for both roles. The mock remains synthetic. |

The earlier root review inspected rendered diagrams and desktop/phone mock layouts. The revised dataset/shared-viewer mock requires its own receipt; the historical scenario count does not validate the current artifact. Neither review is a test of production authentication, pose accuracy or cloud durability.

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
| Staff: Pipeline and faults | Status/progress/errors, URL status filter, known-terminal manual retry, cancel and unknown-submission/operator reconciliation; no duplicate data-review browser or blind processing retry |
| Shared Data browser | Dataset list by default, video grid with `datasetId=<UUID>`; refresh/deep-link/empty/denied states; many-to-many membership without copying or mutating clip evidence |
| Staff: shared clip review | Same `/clips/[clipId]` Rerun component as customers; RGB/21 points, clearly marked estimated 3D and frame mapping; Automatic quality checks, task label, optional notes and approve/reject with revision conflict |
| Customer: initial inspection | Real read-only access to current approved members/labels of granted datasets; live `dataset_access` and approval/membership checked before fresh viewer URL issuance; no staff controls, draft/rejected clips, QC, private RRD entities or per-episode approval |
| Staff/customer: package delivery | **Follow-up:** freeze the whole dataset, export one complete TAR at most 32 GiB total, recheck current approvals, publish and Download all with live dataset access; no separate release page now |
| Customer: later download recovery | **Follow-up:** complete manifest/checksum/reader, Range/expiry behavior, live-grant renewal and revocation; issued URLs may remain usable until expiry |
| Engineer: local end-to-end | Official Render local runner and identical `process-recording` task/contracts; real CPU first, optional local GPU profile, then small Modal CPU/R2 canary; exporter uses the same pattern when added |
| Operations: rights/support/recovery | Manual permission evidence before collection/inference, recording/job error IDs, PITR and safe external-state reconciliation; export permission checked again in the follow-up |

See [UI component/state contract](components/ui-design.md), [scenario inventory](mocks/README.md), [clickable prototype](mocks/index.html) and [implementation acceptance](implementation-plan.md).

## Deliberate MVP limits

One pilot project, three manual roles, one admitted execution, no automatic costly retries and operator-assisted recovery. The initial nine domain tables include immutable clips, datasets, membership and `dataset_access`; the later `releases` table brings the planned total to ten. A clip can belong to multiple datasets. Dataset organization does not change source ownership or processing evidence.

Frozen-version creation/publication and customer package download are a follow-up with a whole-dataset snapshot and one documented TAR format. No Releases/Deliveries screen, sharing UI or new operator publishing tool is included now. Current external inspection uses approved dataset members and current labels; future frozen versions retain their pinned membership/labels while still checking live dataset access. Automatic captions/embeddings, Curator/Ray/Lance, organization/invitation UI, per-joint correction, verified metric trajectories, multiple training adapters and a custom downloader are also deferred. Mandatory hand inference and real internal/external browser/viewer access remain in scope.

## Evidence needed before real collection

Demonstrate hand usefulness on repair/tool/glove/occlusion footage; signed-device auth and a representative two-hour background/resumable upload; bounded processing RAM/scratch/time and clip RRD bytes; real R2 multipart retirement and known/unknown workflow/worker recovery; permission/retention decisions; database restore; actual pinned Rerun production build/browser behavior; real external dataset/clip isolation, live grants/current approvals and staff revision safety. Start with the small model locally. No cloud GPU is necessary for the agreed baseline, and no paid GPU run was performed for this review.

Before customer package delivery, separately implement and qualify the whole-dataset release backend, frozen approvals/live grants and complete downloaded package with every checksum verified. A working read-only mock establishes neither initial production inspection nor that later download gate.

The [2026-10-30 verification receipt](validation/mvp-design-review-20261030.json) records **34 historical scenarios** at each of two widths for the earlier prototype. The [2026-10-31 receipt](validation/dataset-browser-review-20261031.json) records 31 named scenarios, 84 independent root responsive checks and 19 interaction checks, plus eight inspected screenshots and both diagrams. The UI agent separately reported 100 responsive checks. Do not reuse the historical count as current evidence. Mock checks remain separate from real pipeline qualification.
