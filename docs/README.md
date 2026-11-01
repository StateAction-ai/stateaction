# Engineering handoff

Updated: 2026-11-01. **Build the simplified MVP**, beginning with the [technical design](technical-design.md), [implementation milestones](implementation-plan.md) and [shared contracts](contracts.md). The [engineering/PM/design review](mvp-review.md) records scope coverage and remaining launch gates. Automatic hands, Pipeline monitoring, many-to-many datasets and shared staff/customer clip review are initial scope. Whole-dataset versions/export/download are follow-up work; no Releases or Deliveries page is required now.

## Implementation documents

| Document | Owns |
| --- | --- |
| [Linear project and backlog](project-management/README.md) | Live project link, milestone gates, scoped tickets/dependencies and delivery standards |
| [Monorepo](components/monorepo.md) | Flutter/mobile/native source, Node/Python packages, migration and independent builds |
| [Local development](components/local-development.md) | Full local CPU end-to-end testing, optional local GPU, Render's local workflow tooling and cloud canary |
| [UI design and library](components/ui-design.md) | shadcn/ui web choice, Flutter theme, role/state/component map |
| [Pipeline monitoring](components/pipeline-monitoring.md) | Compact recording rows, per-recording stages and all processing/review actions |
| [Data browser and names](components/data-browser-and-datasets.md) | Approved-only datasets, staff All clips review queue, URL filters and product vocabulary |
| [Rerun clip review](components/rerun-clip-review.md) | Shared clip URL, pinned SDK/viewer, safe bounded RRD and automatic quality results |
| [Clickable UI mocks](mocks/index.html) | Offline collector/staff/customer prototype and demo states |
| [Backend](components/backend-architecture.md) | Next.js/Node modules and provider boundaries |
| [Auth](components/auth-and-access.md) | Manual allowlist, three roles, account Settings/sign-out, native login and capture ownership |
| [Mobile implementation](components/mobile-app-implementation.md) | Flutter/native bridge, capture/auth/transfer states, offline ownership, recovery and signed-device acceptance |
| [Android H.264 implementation](components/android-h264-implementation.md) | Existing-recorder integration, explicit build flags, local capture→CPU→Rerun checks and remaining hardware gates |
| [Android feasibility spikes](spikes/android-feasibility.md) | Isolated capture, CPU/Rerun and native upload harnesses; measured results and remaining device/auth gates |
| [Capture format](components/capture-format.md) | H.264 MCAP profile, mixed schemas, frame/clock evidence, hardware encoder/EOS and conformance fixtures |
| [Mobile capture/upload audit](components/mobile-capture-and-upload-readiness.md) | Current Android/iOS blockers, required sensor evidence, JPEG/video options and volume qualification |
| [Upload](components/mcap-upload.md) | Resumable direct multipart, required-file seal and source integrity |
| [Storage](components/storage-and-data-model.md) | Nine active domain tables, future version table, object keys and write closure |
| [Execution/data flow](components/pipeline-execution-and-data-flow.md) | Exact stage locations, reads/writes and handoffs |
| [Orchestration](components/job-orchestration.md) | Initial processing and follow-up export task, job state, repair cron, Local/Modal executors and failure recovery |
| [Processing](components/cloud-processing.md) | Streaming extraction, required 21-point hand inference, masks, model rights and resources |
| [Review/delivery](components/review-and-delivery.md) | Staff approval/customer dataset viewing, plus future whole-dataset versions and portable package |
| [Render deployment](components/render-deployment.md) | Web/database/workflows/cron placement, root monorepo builds and credentials |
| [Operations/costs](components/operations-and-costs.md) | CPU-first budget, monitoring, retention and recovery |
| [Current design audit](design-audit.md) | MVP decisions, remaining gates and documentation verification |

## Research and measurement references

These documents retain earlier investigations; they are not extra MVP services or implementation requirements.

| Reference | Purpose |
| --- | --- |
| [Curator integration](components/curator-integration-reference.md) | Pinned Curator/Ray/Lance implementation and advanced recovery research; deferred |
| [Lance introduction](components/lance-datasets.md) | Future table/search/versioning option; not required for ordinary pose files/manifests |
| [Hosting evidence](components/hosting-evaluation.md) | Render decision plus earlier provider/SDK investigation; current workflow/local contracts supersede old task boundaries |
| [Video cost research](components/video-cost-model.md) | Capture byte assumptions and previous full-stack volume scenarios |
| [Platform comparison](components/platform-cost-comparison.md) | Earlier matched Render/Supabase/AWS and R2/S3 comparisons |
| [Physical capture](pixel-v3-physical-validation.md) / [geometry](geometry-v3-capture-regression.md) | Acquisition evidence and remaining accuracy limits |
| [Training qualification](training-qualification-requirements.md) | Limits on metric/action/training claims |
| [WiLoR benchmark](wilor-full-hand-benchmark.md) | Research model comparison, not commercial deployment clearance |

Existing Flutter/native recorder source is imported into the monorepo, with opt-in Android H.264 integration and local CPU/Rerun validation. The new application stack and cloud pipeline remain to be implemented. [Import checks](validation/mobile-source-import.json) are separate from capture simulation and physical qualification. No design review upgrades existing pose-accuracy claims.
