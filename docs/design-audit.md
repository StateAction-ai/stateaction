# MVP design audit and handoff status

Updated: 2026-10-31. Scope: architecture, all active components, local/cloud development and offline UI mocks. Engineering, PM and design reviewers participated; root checks rendered artifacts and documentation consistency. **Ready to implement; no production implementation or field-launch qualification is claimed.**

## Current decisions

One monorepo includes Flutter/native capture, Next.js/Node UI/API, shared contracts and Python processing. Render Workflows' official local runner executes the same processing task as production (the export task is follow-up); LocalExecutor/ModalExecutor changes only execution/provider configuration. Render Postgres stores durable job/catalog state, R2 stores payloads and Modal runs production processing/export.

Mandatory CPU MediaPipe produces 21 image landmarks with clearly labelled model-relative 3D estimates. Staff manages many-to-many datasets and reviews/approves clips. Customers inspect current approved members of granted datasets using the same Data browser and Rerun clip page. Dataset versions/export/download are deferred; no release/delivery page ships now. Curator/Ray/Lance, independent validators, extra workflow engines, organization administration, automatic processing retries and advanced annotation remain deferred.

## Review findings resolved

| Finding | Minimal correction |
| --- | --- |
| RGB-only/optional-hands wording contradicted the requirement | Hand inference is mandatory in the first real local and cloud flow; no silent RGB-only success |
| Custom runner would bypass the user's preferred Render local path | Official local Workflows server and shared task definitions; eight-hour task budget, no continuation engine |
| Expired multipart upload could strand a sealed recording | Stable logical file/hash, explicit transport epoch and fresh key after confirmed old-MPU retirement; full retransmission disclosed |
| Archive protocol needed size/SHA before streamed packing could supply them | Stage one complete TAR on bounded scratch, close/hash then upload; total release ceiling 32 GiB, not a per-shard allowance |
| MCAP memory/scratch claims conflicted | Explicit non-seeking file-order reader, bounded chunks/frames, source hash through EOF; no full-recording array/scratch promise |
| Exhausted controller retries had no credentialed automatic cleanup path | Operator inspects/cancels exact compute and records terminal resolution; uncertain admission stays reserved |
| Frozen approval could be withdrawn before publication | Publish rechecks latest approved revisions; stale draft requires another release; published bytes stay fixed |
| Idempotency/review concurrency were only prose | Persistent source-upload identity uniqueness and unique job/clip/review revision append |
| Model-code license was being confused with asset rights | Official linked MediaPipe model card and exact asset SHA/size; preserve notices; WiLoR/MANO are not cleared defaults |
| Overlapping groups and review navigation were unclear | Consistent Dataset/Recording/Clip vocabulary; Pipeline status plus Review clips handoff, approved-only Datasets, staff All clips queue, nine active domain tables with membership/access joins |
| External review incorrectly depended on a release UI | Live dataset grants plus current membership/latest approval support external review now; immutable whole-dataset versions/export later |
| A second custom renderer duplicated existing review tooling | Matched Rerun SDK/web-viewer 0.22.1, safe bounded clip RRD, self-hosted assets and one shared clip route; real Next/browser integration remains a gate |
| Internal quality panel listed provenance instead of results | Worker check rows for checksum/decode/mapping/arrays and measured coverage; no accuracy pass or inspection checkbox |
| Full phone could block repeated field use | Explicit original-owner local cleanup only after source verification/cloud-copy confirmation; pending/failed files retained |

UI state coverage and review results are in [MVP review](mvp-review.md); [UI design](components/ui-design.md) records the library decision and [clickable mocks](mocks/index.html) demonstrate all three roles.

## Remaining launch gates

| Evidence still required | Owner |
| --- | --- |
| Safe import of active mobile fixes; clean monorepo clone/build, device regression | Mobile/platform |
| Real-device auth, account switch, background/app-kill and representative two-hour upload | Mobile/backend |
| Representative repair/tool/glove/occlusion hand quality and honest missingness | Robotics/data operations |
| Bounded two-hour RAM/scratch/throughput; exact image/model and actual CPU cost | Robotics/platform |
| R2 consumed multipart/epoch/reconciliation and known/unknown Render/Modal execution behavior | Backend/platform |
| Real shared Rerun build/browser playback, dataset grant/approval denial and URL-filter/membership behavior | Backend/frontend/product |
| Follow-up: whole-dataset export, reader/checksums and stale membership/approval publication races | Backend/product |
| Permission evidence before collection/inference, export check, retention policy and database restore | Operations |

Only documentation, offline mock interactions, static syntax/links and rendered diagrams are verified in this change. The [historical receipt](validation/mvp-design-review-20261030.json) records the prior prototype checks; the [prior dataset-browser receipt](validation/dataset-browser-review-20261031.json) records the earlier Oct31 revision; the [approved-only review receipt](validation/approved-dataset-review-20261031.json) records this revision. See [implementation milestones](implementation-plan.md) for runtime evidence to collect. No source migration, model inference, cloud deployment or paid GPU run was performed.
