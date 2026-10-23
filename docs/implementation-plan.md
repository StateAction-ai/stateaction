# Implementation plan

Status: future work, proposed 2026-10-22. This is a work breakdown, not an executed deployment or authorization to spend. Parent: [Technical design](technical-design.md). Canonical processing contracts: [execution and data flow](components/pipeline-execution-and-data-flow.md).

## Sequence and ownership

| Package | Owner discipline | Dependencies | Deliverables | Acceptance gate |
| --- | --- | --- | --- | --- |
| P0. Hosting and identity decision | Backend/platform | None | Choose one API runtime/host and one auth authority; pin SDKs, define environments and costs | Supabase Edge/Deno versus owned Node/TypeScript is explicit; no parallel auth identities |
| P1. Domain/contracts | Backend + robotics | P0 | Versioned API/manifest/schema contracts, ownership/tenant/grant model, additive migrations and synthetic MCAP fixtures | Cross-tenant access rejected; exact timestamps/bytes survive cross-language serialization |
| P2. Login and offline ownership | Identity + mobile | P1 | Qualified real-device login, enrollment, owner-bound capture journal, session expiry/logout behavior | Expiry/account switch preserves recordings and cannot transfer another user's queued capture |
| P3. Resumable upload and seal | Upload + mobile | P1/P2 | Direct multipart/TUS provider adapter as selected, part receipts, URL refresh, idempotent completion, recording seal | Interrupt/restart/app kill, duplicate completion and missing-sidecar race pass on a representative large file |
| P4. Cloud CPU ingest | Robotics processing | P1/P3 | Streaming hash/MCAP validation, versioned geometry adapter, bounded prepared sources/native frame and sensor shards, preview/mapping and compact QC | Two-hour memory/scratch/read-byte qualification; corrupted sources never reach GPU |
| P5. Durable workflow control | Backend/platform | P1/P4 contracts; can develop with fake workers | Outbox, signed Inngest handler or chosen alternative, private Modal adapter, attempt startup claims, deadlines and budget ledger | Crash/duplicate/uncertain submission tests preserve one accepted result and bounded spend |
| P6. Native Curator preparation | Processing/platform | P4/P5 | Pinned source-built image, CPU cut/transcode, canonical Lance batch, durable native checkpoints and writer ownership | Same-root restart works; confirmed previous termination before takeover; full batch readiness validated |
| P7. Optional enrichment | ML/robotics | P6 | Individually qualified embedding/caption/hand adapters; model/config/license inventory | Memory/context fit, commercial-rights gate, row errors, frame mapping and checkpoint restart measured per adapter |
| P8. Internal review | Backend + frontend + data operations | P2/P4/P5; P6/P7 when requested | Role-aware browser, review queue, time-aware preview/overlays, label revisions and exact approvals | Concurrent edit conflicts, staff scope and immutable approval revision tests pass |
| P9. Export and customer delivery | Backend + processing + frontend | P8 | Cloud export, frozen manifest, complete shards/loader, recipient grants, browser inspection and resumable downloader | Every declared training artifact downloads/checksums; no internal approval UI/rights for customers |
| P10. Operability and pilot | Platform + mobile + data operations | P3–P9 | Environment inventory, secret management, backup/restore, cancellation/reconciliation, app build and cost receipts | Full collector-to-customer canary and restore exercise; operator and budget controls documented |

P4/P5 can be developed concurrently against versioned contracts, but the first real ingest is admitted only after upload/seal correctness. P7 is not a launch dependency for a profile that does not promise those outputs. Both internal review and customer delivery are required for the first deployed product.

## Proposed owned code locations

These directories are implementation targets, not created application modules. Keep source-audit links to the cloned app distinct from production ownership.

| Location | Responsibility |
| --- | --- |
| `backend/` | Owned Node.js/TypeScript API variant, domain services, contracts, DB migrations, workflow/outbox/reconciliation processes |
| `supabase/functions/` | Alternative Supabase-hosted TypeScript/Deno API/workflow/short reconciliation handlers if selected in P0 |
| `console/` | Static internal-review and customer-delivery application |
| `processing/contracts/` | Cross-language manifest, task, frame/time and result schemas |
| `processing/capture/` | Streaming MCAP extraction and validated sensor/geometry adapters |
| `processing/curator/` | Pinned recipe wrapper, source/batch preparation and native recovery integration |
| `processing/hand_pose/` | Replaceable model-specific adapter with rights/quality checks |
| `processing/export/` | Portable dataset packaging, loader and release verification |
| `processing/images/` | Separately pinned CPU/Curator/model container definitions |
| `processing/modal_app.py` | Private finite Modal Function definitions and resource policy |
| `processing/tests/` | Synthetic fixtures, fault scenarios, bounded integration tests and qualification receipts |
| Existing Flutter capture client | Reviewed auth/API/upload compatibility changes coordinated with the active capture-fix work |

Choose one backend hosting path in P0, not two complete implementations. Reuse tested capture semantics and wire compatibility; do not copy unsafe server handlers or treat a working local prototype as a production review.

## Required acceptance matrix

| Boundary | Failure to inject | Required result |
| --- | --- | --- |
| Auth to local capture | Expiry, revoked assignment, account switch | No file/journal loss; upload blocked until correct current authorization |
| Upload to object store | Lost PUT receipt, killed app, expired URL, abort/complete race | Server reconciles exact parts and file identity; no overwritten verified original |
| Seal to workflow | Required sidecar late, transaction rollback, duplicate event | One logical ingest only after sealed required inventory is uploaded |
| Source to ingest | Hash mismatch, corrupt record, unsupported geometry, huge decoded dimensions | Quarantine with reason; no GPU successors |
| Ingest sizing | Representative two-hour MCAP | Bounded peak memory/scratch and measured bytes read/written; no whole-session array accumulation |
| Curator recovery | Worker loss before/after checkpoint, ambiguous commit response | Reuse compatible saved work without recreating the dataset; committed rows not duplicated |
| Writer takeover | Lease expires while old worker may still execute | No root regrant until termination plus capability expiry/revocation is established |
| Modal submission | Response lost after acceptance | `dispatch_unknown`, no blind respawn; late start rejected after claim deadline |
| Enrichment | OOM, wrong model rights, terminal clip errors | Bounded failure; no automatic larger GPU or false all-success claim |
| Review to release | Concurrent edit or deletion/cancellation during packaging | Final transaction rejects stale approval/claim/state; published content remains immutable |
| Customer download | Multiple pages, URL expiry, interrupted shard, revoked grant | Complete resume/hash verification; no internal/raw access or episode approval mutation |
| Recovery/cost | API restart, workflow outage, restored DB, delayed usage data | Durable reconciliation, retained revocations/tombstones and conservative unsettled spend accounting |

Test the domain protocol with a fake Modal adapter and isolated DB before paid integration. Provider compatibility and a bounded permissioned canary are separate later actions. Never send private captures to a third-party worker merely to test configuration without the appropriate data-processing scope.

## Completion evidence

A work package closes with a reviewed source change and relevant evidence: contract tests, migration/restore receipt, signed mobile build receipt, provider protocol checks, exact image/model/config digests, fault-recovery logs, measured peak memory/throughput and gross cost. A green health endpoint or successful model forward pass does not close data integrity, geometry qualification or delivery usability.

The design documentation is the present deliverable. No production resources, backend module, worker image build, collector upload or model processing was created as part of drafting it.
