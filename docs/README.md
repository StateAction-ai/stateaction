# Engineering handoff

Start with [technical design](technical-design.md), [implementation milestones](implementation-plan.md) and [audit findings](design-audit.md). Read the component you own; shared definitions live in [wire/manifest contracts](contracts.md).

| Document | Contract owner / purpose |
| --- | --- |
| [Render deployment](components/render-deployment.md) | Selected services, routing, build targets, credentials and rollout |
| [Hosting decision/evidence](components/hosting-evaluation.md) | Render decision and verified provider/SDK limitations |
| [Video cost model](components/video-cost-model.md) | Capture-based planning assumptions, direct transfer paths and 20/100/1,000-hour monthly scenarios |
| [Platform cost comparison](components/platform-cost-comparison.md) | Render/Supabase/AWS with matched video volumes, R2/S3 costs and CloudFront delivery |
| [Backend](components/backend-architecture.md) | Backend: runtime, modules and provider boundaries |
| [Auth](components/auth-and-access.md) | Identity: login, permissions, offline ownership and deletion |
| [Upload](components/mcap-upload.md) | Mobile/backend: resumable transfer, inventory seal and integrity |
| [Storage](components/storage-and-data-model.md) | Backend: entities, enums, namespaces, credentials and retention |
| [Execution/data flow](components/pipeline-execution-and-data-flow.md) | Processing: stages, locations, reads/writes and handoff |
| [Orchestration](components/job-orchestration.md) | Platform: workflow partitioning, claims, validation, retries and budgets |
| [Processing](components/cloud-processing.md) | Robotics/ML: clocks/geometry, images, resources, models and licenses |
| [Review/delivery](components/review-and-delivery.md) | Product/backend: internal approval, release packaging and customer downloads |
| [Operations/costs](components/operations-and-costs.md) | Platform: deployment, spend, monitoring and recovery |
| [Lance introduction](components/lance-datasets.md) | Background: dataset files, use cases and storage |

Updated 2026-10-26. Status: Render/Next.js/Node, Better Auth, Render Postgres and Render Workflows selected; implementation/qualification pending. R2 stores media; Modal runs CPU/GPU processing. The deployment specification supersedes older Node/Lightsail/Supabase/Inngest assumptions. No service has been deployed.

Existing measurement evidence remains separate: [capture](pixel-v3-physical-validation.md), [geometry](geometry-v3-capture-regression.md), [training qualification](training-qualification-requirements.md), [WiLoR benchmark](wilor-full-hand-benchmark.md). Design review does not upgrade these accuracy claims.
