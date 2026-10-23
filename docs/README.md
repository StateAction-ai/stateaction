# Project documentation

Start with the [technical design](technical-design.md), then the [annotated processing flow](components/pipeline-execution-and-data-flow.md). Architecture documents are proposed plans; existing capture validation reports remain separate evidence.

| File | Summary | Status | Date |
| --- | --- | --- | --- |
| [Technical design](technical-design.md) | Platform boundaries, requirements, decisions, invariants and component map | Proposed | 2026-10-22 |
| [Execution and data flow](components/pipeline-execution-and-data-flow.md) | Canonical Curator-pattern stages, physical locations, reads/writes and stable-root handoff | Proposed | 2026-10-22 |
| [Backend architecture](components/backend-architecture.md) | Owned Node.js/TypeScript backend variant; independent framework/service rationale | Hosting choice pending | 2026-10-22 |
| [Auth and access](components/auth-and-access.md) | Login/enrollment, owner-bound offline capture, staff/customer scope and session lifecycle | Proposed; provider/runtime decision pending | 2026-10-22 |
| [MCAP upload](components/mcap-upload.md) | Direct resumable transfer, recording seal, exact completion and integrity handoff | Proposed | 2026-10-22 |
| [Storage and data model](components/storage-and-data-model.md) | Postgres app records, Lance batch state, bulk objects, retention and recovery | Proposed | 2026-10-22 |
| [Understanding Lance](components/lance-datasets.md) | Clip-table example, use cases, storage location and boundaries with Postgres/Parquet | Introduction | 2026-10-22 |
| [Orchestration](components/job-orchestration.md) | Inngest/alternatives, outbox, Modal attempts, waits, retries and admission | Proposed | 2026-10-22 |
| [Cloud processing](components/cloud-processing.md) | MCAP clocks/geometry, Curator image/cache and model qualification | Proposed | 2026-10-22 |
| [Review and delivery](components/review-and-delivery.md) | Our team's review/publication and customers' complete dataset downloads | Proposed | 2026-10-22 |
| [Operations and costs](components/operations-and-costs.md) | Hosting variants, costs, budgets, deployment/restore and operational runbooks | Proposed | 2026-10-22 |
| [Implementation plan](implementation-plan.md) | Work packages, dependencies, ownership and acceptance matrix | Future work | 2026-10-22 |

Existing validation entrypoints: [Pixel v3 acquisition](pixel-v3-physical-validation.md), [geometry regression](geometry-v3-capture-regression.md), [training qualification](training-qualification-requirements.md), [WiLoR research comparison](wilor-full-hand-benchmark.md), and [local build/capture guide](../README.md). These record what was actually measured; a design proposal does not upgrade their accuracy claims.
