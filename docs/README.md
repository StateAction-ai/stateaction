# Engineering handoff

Updated: 2026-10-30. **Build the simplified MVP**, beginning with the [technical design](technical-design.md), [implementation milestones](implementation-plan.md) and [shared contracts](contracts.md). The [engineering/PM/design review](mvp-review.md) records scope coverage and remaining launch gates. Automatic hand landmarks, internal staff review and customer inspection/download all ship together.

## Implementation documents

| Document | Owns |
| --- | --- |
| [Monorepo](components/monorepo.md) | Flutter/mobile/native source, Node/Python packages, migration and independent builds |
| [Local development](components/local-development.md) | Full local CPU end-to-end testing, optional local GPU, Render's local workflow tooling and cloud canary |
| [UI design and library](components/ui-design.md) | shadcn/ui web choice, Flutter theme, role/state/component map |
| [Clickable UI mocks](mocks/index.html) | Offline collector/staff/customer prototype and demo states |
| [Backend](components/backend-architecture.md) | Next.js/Node modules and provider boundaries |
| [Auth](components/auth-and-access.md) | Manual allowlist, three roles, native login and capture ownership |
| [Upload](components/mcap-upload.md) | Resumable direct multipart, required-file seal and source integrity |
| [Storage](components/storage-and-data-model.md) | Seven domain tables, object keys and write closure |
| [Execution/data flow](components/pipeline-execution-and-data-flow.md) | Exact stage locations, reads/writes and handoffs |
| [Orchestration](components/job-orchestration.md) | Two Render workflow tasks, job state, repair cron, Local/Modal executors and failure recovery |
| [Processing](components/cloud-processing.md) | Streaming extraction, required 21-point hand inference, masks, model rights and resources |
| [Review/delivery](components/review-and-delivery.md) | Staff approval, fixed portable package and customer Download all |
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

The monorepo migration, application stack and cloud pipeline remain to be implemented. No design review upgrades existing pose-accuracy claims.
