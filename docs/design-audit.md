# Design audit and handoff status

Date: 2026-10-23. Scope: the complete architecture/component set. Reviewers: backend/identity, processing/platform, upload/delivery and coordinating architecture reviewer. Findings below are resolved in the design; implementation remains unverified.

October 26 decision: the [selected Render deployment](components/render-deployment.md) uses Next.js/Node, Better Auth, Render Postgres and Render Workflows, with R2 media/Modal processing. The Node/Lightsail/Supabase/Inngest recommendation and word counts below are the historical October 23 audit snapshot. Current component contracts supersede its provider assumptions; no deployment has occurred.

## Changes made

| Finding | Design correction |
| --- | --- |
| Two API/runtime/auth paths left engineers to decide basic architecture | One recommended Node24/TypeScript/Fastify target on AWS; Supabase Postgres and one Better Auth authority. Edge/Deno deferred. |
| Repeated audit history and rules obscured implementation contracts | Short main design and owner map; each component owns its contract; shared schemas/encoding isolated in contracts.md. Prior detail remains in git history. |
| One recording workflow could exhaust step/state limits across many batches | Independent ingest, bounded-batch, review-assembly and release workflows; aggregate cost/execution admission. |
| Nullable batch identity could bypass SQL job uniqueness | Non-null partition keys and separate partial unique constraints for batch/run jobs; recording-versus-release run target explicit. |
| Worker result, validation and application acceptance were insufficiently separated | Worker candidate → read-only trusted cloud validator → short API acceptance/publication transaction. No worker self-approval. |
| Validated/published data could remain writable through outstanding capabilities | Producer termination, grant retirement and reconciled pending writes before validation; bind that barrier into final acceptance and publication. |
| Completed jobs could retain CPU slots needed by their own validators | Release terminated compute capacity while retaining separate dataset/destination ownership through validation and acceptance. |
| Retry isolation could be mistaken for copying every dataset | Stable per-batch Lance/media/checkpoint root; serialized writer; old execution terminal plus write grants retired before takeover. |
| Rights evidence and train/validation leakage policy were underspecified | Frozen rights-policy scope/evidence, revocation/redaction gates, correlated split groups and overlap checks. |
| Cross-language integers, routes and manifests could drift | Shared named schema versions, decimal-string large integers, explicit route/auth boundaries and immutable typed references. |
| Long-recording costs omitted some resource/transfer effects | Measured scratch/byte/fragment limits; actual-vs-requested CPU/RAM, disk-related memory and Modal egress included. |

## Remaining launch gates

| Gate | Owner / required proof |
| --- | --- |
| Identity/mobile | Enabled provider credentials, trusted redirects/audiences, real-device session lifecycle and preserved owner journal |
| Storage | R2/S3 multipart, checksum/session-token behavior and pinned Lance conditional commit/recovery with scoped grants; choose S3 if R2 fails |
| Processing | Representative two-hour bounded memory/scratch/read-byte test; frozen batch limits and loss/recovery qualification on exact images |
| Models | Pinned image/weights/context/GPU fit, declared quality and commercial terms. WiLoR/MANO/FLORA are not automatically cleared. |
| Product/data policy | Project rights evidence, allowed uses, region/retention/redaction, delivery profile and split grouping approved by responsible owners |
| Delivery/operations | Complete loader/download canary, authorization/cancellation faults, restore/revocation exercise and measured budget |

These gates do not block contract/API/UI development. They block activation of the affected production capability. There is no claim that the two-hour pipeline, R2/Lance deployment or optional GPU recipes have already passed.

## Validation of this handoff

The complete set is approximately **16,800 words versus 43,000 before** (61% shorter), including the new shared-contract and audit documents. The main design is under 900 words. Component ownership keeps implementation detail available without repeating the entire architecture.

Checked all 15 documents: 109 local links/anchors, fenced blocks, route/schema/state consistency and clean diff whitespace. Rendered and visually inspected the simplified processing diagram. Cross-review resolved the write-after-validation/publication window, nullable-key dedup, workflow fan-out limits, validator capacity deadlock and naming/state drift.

These are static design/document checks. Implementation tests and paid provider benchmarks remain separate work. The [milestones](implementation-plan.md) define the evidence each engineering owner must produce.
