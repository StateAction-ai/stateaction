# MVP review: engineering, product and design

Date: 2026-10-30. Review scope: implementation design and offline UI prototype. **Verdict: ready to implement, subject to the launch evidence below.** The prototype is synthetic; the pipeline, monorepo migration and hosted services have not been implemented by this change.

## Reviewed by three roles

| Role | Review result |
| --- | --- |
| Senior backend/robotics engineering | Fixed source-transport expiry, archive staging/size, streaming-reader consistency, controller exhaustion and idempotency/review constraints. No remaining design blocker identified. |
| Product management | Both staff and customer workflows remain in v1; hand inference stays mandatory. Recovery, permission evidence, stale approval, local cleanup and complete delivery are specified. |
| Product design/frontend | Selected shadcn/ui + Tailwind/Radix for Next.js, existing Flutter widgets/theme for mobile. Built five clickable screens with 34 named scenarios; no paid UI framework or hosted design tool is required. |

Root reviewed rendered diagrams and desktop/phone mock layouts, checked interaction behavior and documentation consistency, and resolved the review findings. This is not an independent test of production authentication, GPU accuracy or cloud durability.

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
| Staff: jobs and faults | Queue/progress/errors, known-terminal manual retry, cancel, unknown submission/operator reconciliation; no blind duplicate processing |
| Staff: review/correct | RGB/hand overlay, source-frame mapping, whole-clip label/notes, approve/reject with revision conflict |
| Staff: release build | Approved frozen selection, complete TAR at most 32 GiB total, exact recipient and export status; oversize blocks selection |
| Staff: publish/withdraw | Explicit publish; latest approved revisions rechecked; changed approval blocks stale draft; new release for corrections |
| Customer: inspect/download | Only granted published deliveries, approved samples, complete TAR plus manifest/checksum/reader; no per-episode approval |
| Customer: expiry/revocation | Renew only with live grant; expired/empty/revoked states; existing archive URL can survive until its stated expiry |
| Engineer: local end-to-end | Official Render local runner and same two tasks/contracts; real CPU first, optional local GPU profile, then small Modal CPU/R2 canary |
| Operations: rights/support/recovery | Manual pilot permission evidence before collection/inference, separate export check, recording/job error IDs, PITR and safe external-state reconciliation |

See [UI component/state contract](components/ui-design.md), [scenario inventory](mocks/README.md), [clickable prototype](mocks/index.html) and [implementation acceptance](implementation-plan.md).

## Deliberate MVP limits

One pilot project, three manual roles, one admitted processing/export execution, no automatic costly retries, one delivery format and operator-assisted recovery. Automatic captions/embeddings, Curator/Ray/Lance, organization/invitation UI, per-joint correction, verified metric trajectories, multiple training adapters and a custom downloader are deferred. These cuts do not remove automatic hand inference or either review/delivery interface.

## Evidence needed before real collection

Demonstrate hand usefulness on repair/tool/glove/occlusion footage; signed-device auth and a representative two-hour background/resumable upload; bounded processing RAM/scratch/time; real R2 multipart retirement and known/unknown workflow/worker recovery; permission/retention decisions; database restore; and a complete downloaded real package read with every checksum verified. Start with the small model locally. No cloud GPU is necessary for the agreed baseline, and no paid GPU run was performed for this review.

[Verification receipt](validation/mvp-design-review-20261030.json) records 34 scenarios at each of two widths, inspected screenshots/diagrams, static syntax and local-link checks. Mock checks are separate from real pipeline qualification.
