# Job orchestration and recovery

Updated: 2026-10-23. Build target: owned Node.js 24/TypeScript/Fastify API and supervised outbox/reconciliation process on a small AWS host. Inngest Cloud controls workflows; private Modal Functions execute work; Supabase PostgreSQL owns domain state. Edge/Deno is deferred. No deployment has occurred.

Use the [canonical stage contracts](pipeline-execution-and-data-flow.md), [shared schemas](../contracts.md), [storage records](storage-and-data-model.md) and [processing implementation](cloud-processing.md). This document owns control flow and recovery; it does not redefine stage payloads.

## Workflow boundaries and limits

Use four versioned workflows, rather than polling every batch inside one recording workflow:

| Workflow | Responsibility |
| --- | --- |
| `ingest-run` | Run/validate ingest; register the bounded batch manifest and enqueue one event per batch through the transactional outbox |
| `process-batch` | Execute that batch's canonical stages and validation; publish a durable batch outcome |
| `assemble-run` | Triggered by batch-outcome events; check all enabled dependencies in Postgres and assemble once ready |
| `export-release` | Export/validate a frozen selection to `ready`; a fresh internal-admin publication is separate |

Each logical workflow/job has a durable DB uniqueness key. Duplicate events return existing state, even after Inngest event deduplication expires. Register batch IDs, membership digests and integer `max_batches_per_run` before fan-out. Reject oversized/unmeasured profiles; never silently truncate batches. A batch outcome transaction emits an outbox event, so a lost notification does not lose the review join. The join does not hold a long polling parent workflow.

Current Inngest Free allows 50,000 executions/month, five concurrent steps and 30-day runs; platform limits include 1,000 steps, 4MiB step output and 32MiB state. Our initial ceiling is 400 durable operations and 24-hour lifetime **per workflow**, with aggregate recording cost budgeted. This does not promise 24-hour continuous polling. Admission waits/polls count: active checks every two minutes, capacity waits backing off to fifteen. Stop visibly blocked before exhaustion; authorized rescheduling reuses accepted work. Activation requires measured fan-out/wait/execution counts. State contains IDs/receipts. [Inngest limits](https://www.inngest.com/docs/durable-execution/limits)

## Durable events and hosting

Commit domain changes and uniquely identified `event_outbox` rows together. The supervised Node relay claims rows briefly, sends deterministic event IDs and marks delivered after acknowledgement. Network calls occur outside DB transactions. A lost acknowledgement retries the same event; DB guards remain authoritative. Inngest owns successor timing, not another queue/DAG daemon.

| Stable event | Producer transaction |
| --- | --- |
| `recording/ingest.requested`, `processing/run.requested` | Seal/upload gate or authorized new run creates initial job |
| `processing/batch.requested` | Accepted ingest registers bounded batch membership/jobs |
| `processing/batch.completed` | Final batch outcome accepted |
| `processing/assemble.requested` | Inngest join handler's CAS confirms all dependencies and creates assembly job |
| `release/export.requested` | Admin freezes approved release selection/export job |
| `processing/cancel.requested` | Authorized cancellation changes lifecycle/claims |

Each listed transaction inserts its outbox event atomically with the domain change.

Serve the pinned `inngest/fastify` adapter on `/api/inngest`, with production signing keys, correct public origin and tested GET/POST/PUT behavior. Keep it outside human-cookie middleware; SDK service-signature validation is mandatory. Do not inherit cloned Hono/Bun middleware. Modal's TypeScript SDK supports Node 22+; pin/test the Node 24 integration. Control requests submit/check jobs and return; they do not wait for GPU completion or hash/copy media. [Inngest adapter](https://www.inngest.com/docs/learn/serving-inngest-functions), [Modal SDK](https://modal.com/docs/sdk/js/latest/intro)

## Run one stage

1. **Admit atomically.** In one DB transaction check lifecycle, source/selection/version, model rights, bounds and budget; lock job/batch/resource rows in fixed order; create attempt/deadlines/bootstrap-token hash and reserve budget, CPU/GPU and writer ownership. No reservation precedes its attempt or survives a failed admission. Busy resources return a bounded durable wait. First ingest requires sealed uploaded inputs and establishes server hashing.
2. **Submit once.** After commit, persist submission intent/counter and permit one `spawn` call per attempt. Save `functionCallId` when returned. Lost acknowledgement becomes `dispatch_unknown`, not an automatic replacement.
3. **Claim before heavy work.** The invocation exchanges its bootstrap capability for an invocation-bound claim. Compare-and-set checks attempt, epoch, batch owner, start deadline and active lifecycle. Only the winner receives storage capabilities/configuration. Losers exit before media/model downloads; startup can still be billed.
4. **Execute and wait.** The workflow sleeps between short checks. Workers heartbeat through scoped service APIs; a missing heartbeat is evidence to investigate, not proof of termination. Native Curator writes/checkpoints/publishes its canonical batch in place, then submits a candidate receipt.
5. **Establish quiescence.** Confirm processing execution terminal, disable renewals, retire **every writer capability** through revocation/expiry with clock-skew margin, and reconcile outstanding writes and object visibility. Persist barrier/grant-generation evidence bound to the candidate hash. Keep exclusive batch ownership. Release the terminated call's compute slot now so its validator cannot deadlock behind completed jobs; preserve conservative cost accounting. Uncertain writes block validation, not merely takeover.
6. **Validate independently.** Dispatch private CPU `validate_stage` with authoritative inputs, barrier evidence and a distinct validation-only capability. It gets read-only object access and submits a small receipt through its dedicated callback. Check scope, native commit/receipt, row status, schemas, hashes/bytes and closure. Initial timeout is 600 seconds with bounded object/row/byte budgets; oversize needs a budgeted sharded profile. The validator cannot grant root access, copy the batch or accept application state.
7. **Accept by short CAS.** Load the trusted validation record. Recheck current attempt/epoch/invocation/batch owner, unchanged barrier/grant generation, candidate hash, input/selection/observed version and active lifecycle. Atomically select the pinned version/artifacts and mark success. A physical commit or worker JSON cannot self-approve.
8. **Settle and hand over.** Retain batch ownership through quiescence, validation and acceptance; only then transfer to a successor. Settle actual costs conservatively. Compute capacity and canonical writer ownership are separate resources.

## Exact service and write boundaries

All routes below are POST. IDs are routing data, not credentials. General human sessions cannot call these service routes.

| Path | Caller and authority |
| --- | --- |
| `/internal/v1/processing/attempts/{attemptId}/claim` | Private worker using its random bootstrap capability; establishes one invocation owner |
| `/internal/v1/processing/attempts/{attemptId}/heartbeat` | Claimed invocation capability; refresh only while active and before deadline |
| `/internal/v1/processing/attempts/{attemptId}/candidate` | Claimed invocation; proposes a bounded manifest reference/hash, never self-approves |
| `/internal/v1/processing/validations/{validationId}/complete` | Separately invoked validator using its distinct validation capability; records evidence only |
| `/internal/v1/processing/jobs/{stageJobId}/accept` | Workflow service principal; loads validation and executes final CAS, without a client-controlled override |

Human controls require current internal project grants; POSTs require `Idempotency-Key` and return `202` for admission/cancellation, not completed compute:

| Route | Request |
| --- | --- |
| `POST /api/v1/internal/recordings/:id/processing-runs` | `profileRevision`, `expectedSourceManifestSha256`, `reason` |
| `GET /api/v1/internal/processing-runs/:id` | Status/attempt/validation references; `200` |
| `POST /api/v1/internal/processing-runs/:id/cancel` | `reason` |
| `POST /api/v1/internal/stage-jobs/:id/retries` | `expectedAttemptNumber`, `reason`; stale expectation returns `409` |

The Node workflow handler allocates/dispatches validation through its private service module; the processing worker cannot mint validation credentials or invoke that module. Tokens are hashed in Postgres, scoped to IDs/actions/expiry and excluded from logs/events/manifests. No worker receives general DB credentials or Modal control-plane keys. The validator may reuse an approved image, but it is a separate read-only invocation and policy role; a worker's self-signed JSON is not validation evidence.

The exporter writes a unique unpublished prefix, then reaches quiescence and independent validation. Acceptance ends at `ready`. Publication requires an internal admin's fresh session at `POST /api/v1/internal/releases/:id/publish`; the API rechecks the unchanged barrier/manifest, approval, rights, recipients and lifecycle. The export workflow cannot publish. See [delivery](review-and-delivery.md).

Quiescence is a provider-specific qualification gate. Credential expiry does not cancel an accepted PUT or multipart upload. Track known write operations/MPUs; reconcile completed objects, pending uploads and visibility using qualified request-duration/clock-skew bounds and cleanup rules. No universal drain or R2 write-fence API is assumed; a client timeout or generic fixed sleep is not proof. The storage-adapter canary must demonstrate bounded writes and reconciliation, or validation/adoption stays blocked. This uses existing adapter/reconciler code, not another service.

## Native recovery and uncertain execution

Keep the same dataset URI/media root and compatible native checkpoint namespace across attempts. New attempt IDs change logs/accounting, not the dataset. Preserve native layouts, immutable inputs/fragments and transaction history; the detailed rules are in [processing](cloud-processing.md). No dataset copy occurs between stages.

| Condition | Required recovery |
| --- | --- |
| `dispatch_unknown`, no call ID | Wait for claim/result and investigate provider state. Expire startup capability at the absolute start deadline. Never infer zero cost or safe replacement from silence. |
| Old worker may run, write grant remains valid or write visibility unresolved | Block validation/acceptance and same-root takeover. DB epoch changes do not stop object writes. |
| Durable checkpoint but no canonical commit | After safe takeover, resume compatible native work; replay only uncheckpointed work. |
| Commit succeeded, callback lost | Validator/reconciler checks canonical receipt/version; accept without repeating inference. |
| Candidate invalid, hash mismatch, incompatible layout or model license | Terminal classified failure; retain raw/recovery evidence. No automatic GPU upgrade or reset. |
| Cancellation/deletion wins CAS | Reject delayed acceptance; preserve physical evidence for reconciliation. Cancel known Modal call best effort and retire grants. |
| Workflow quota/host outage | Keep outbox/domain/native state; pause starts and reconcile active work independently. |

Initially use Modal retries zero, one global admitted GPU and two CPU calls. Use a single generic `resource_slots` gate plus per-attempt `budget_reservations`; do not build a second priority scheduler. Include validator/export CPU and startup uncertainty in reservations. Permit at most one diagnosed operator-authorized retry during qualification. Provider concurrency caps are per Function and do not enforce our cross-model GPU budget.

Run reconciliation approximately every sixty seconds with bounded scans: undelivered events, uncertain submissions, stale ownership/grants, native commits lacking application acceptance and stuck exports. It repairs evidence/state, not DAG successor scheduling. If a prior writer cannot be proven terminal and grants retired, pause that batch or authorize a deliberately separate new run/root.

## Choice, implementation and qualification

Inngest is chosen for TypeScript product events, durable waits and low initial operational work. `pgmq` is a queue, not the workflow engine we would otherwise need to write. Temporal Cloud currently has no base fee; AWS MWAA Serverless bills by task duration, so neither alternative should be rejected using an obsolete always-on-cost argument. [Temporal pricing](https://temporal.io/pricing), [MWAA pricing](https://aws.amazon.com/managed-workflows-for-apache-airflow/pricing/)

Use Inngest Cloud with its Apache-2.0 JS SDK. Its server/CLI has SSPL/future Apache terms; no self-hosted fork is planned. [SDK license](https://github.com/inngest/inngest-js/blob/main/packages/inngest/LICENSE.md), [server license](https://github.com/inngest/inngest/blob/main/LICENSE.md)

Implement `backend/src/workflows/`, scoped processing services, one supervised outbox/reconciler and reviewed DB migrations; Python Functions live in `processing/`. Fault-test duplicate claims, lost spawn acknowledgements, late starts, old grants/in-flight writes, checkpoint/commit loss, forged validator receipts, barrier mutation and cancellation racing CAS, batch/step exhaustion, validator CPU-slot deadlock and complete release download. No cloud qualification or paid call was performed for this design.
