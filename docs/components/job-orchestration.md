# Job orchestration and recovery

Selected Render design · 2026-10-26 · Not deployed

**Render Workflows is the sole outer workflow engine.** TypeScript controllers on Render coordinate private Modal CPU/GPU calls; Render Postgres holds durable application state. Curator retains its native Lance/media/checkpoints in object storage. No Inngest, Redis queue, permanent Ray cluster or custom DAG service is required.

Use the [canonical stages](pipeline-execution-and-data-flow.md), [shared contracts](../contracts.md), [storage records](storage-and-data-model.md) and [processing implementation](cloud-processing.md). This document owns control flow and recovery.

## Four business tasks, one workflow service

Register these task names in one versioned Render Workflow service under `backend/src/workflows/`:

| Task | Boundary and completion |
| --- | --- |
| `ingest-run` | Run/validate ingest; register the bounded batch manifest and enqueue one dispatch per batch; finish without awaiting every batch |
| `process-batch` | Advance one batch through its enabled canonical stages and validation; commit a durable batch outcome |
| `assemble-run` | Recheck all enabled accepted batch dependencies; assemble/validate the review package once |
| `export-release` | Export/validate a frozen approved selection to `ready`; finish before fresh admin publication |

Controllers derive the next stage from `stage_jobs` and accepted parent references. The stage list is ordinary versioned TypeScript code. Independent batch tasks provide fan-out. A batch-completion transaction locks the parent run, records its outcome and checks required dependencies; the final ready outcome creates the unique assembly job/dispatch/outbox. Assembly rechecks those accepted inputs and blocks on invalidation rather than producing a partial package. This avoids coalesced notifications losing the final join. No parent waits across all batches or human review.

One unique logical job per business scope and stage prevents duplicate work. Register batch IDs, membership digests and tested integer `max_batches_per_run` before fan-out. Reject oversized/unmeasured profiles; never truncate. Requested optional stages and explicit skips are part of the profile.

## Delivery: outbox to Render

Commit domain changes, a `workflow_dispatches` record and a uniquely identified `event_outbox` row together. Initial triggers are accepted upload/seal or authorized processing request, accepted ingest's batch registration, the all-batches-ready join and an admin-frozen release selection. Cancellation records lifecycle immediately and wakes the existing business controller through the same outbox.

A single **minute Render Cron job** runs the finite relay/reconciler: `* * * * *` UTC, application deadline 45 seconds, bounded pages of 50 rows and at most four outbound requests at once. Normal kickoff waits for the next scheduled invocation plus provider startup/queue delay; show `queued` in the UI. API requests return after committing the outbox; the public web service needs no Render control-plane key. The cron job exits after its bounded pass. [Cron scheduling](https://render.com/docs/cronjobs)

The relay leases due rows briefly, performs network requests outside transactions and calls `POST https://api.render.com/v1/task-runs` with:

- `task`: pinned `workflow-slug/task-name:version` from the deployed definition.
- `input`: one `workflow-dispatch/v1` argument containing IDs, generation and pipeline revision only.
- `idempotencyKey`: deterministic `dispatch:{dispatch_id}`; save returned Render run ID before acknowledging delivery.

Render deduplicates this key for 24 hours and ignores repeated input. Our stored request digest, scope/generation constraints and lifecycle guards remain authoritative indefinitely. Conflicting payloads fail before sending. Lost acknowledgements retry the same row/key; after its deduplication window, a repeated control task is still harmless because it must claim the current DB dispatch. Do not turn a duplicate control task into another Modal invocation. Respect `429`/`Retry-After`, workspace trigger limits and local admission. [Run-task API](https://api-docs.render.com/reference/createtask), [limits](https://render.com/docs/workflows-limits)

## Controller lifetime and restart

Pin/test `@renderinc/sdk` 1.4.0 for task definitions. Its inspected `TaskContext` exposes `run()`, with no verified saved-step or suspended-sleep primitive. This design uses neither. A restarted task reloads Postgres and native receipts. Render's temporary task inputs/results are observability, not the catalog or recovery authority. [SDK reference](https://render.com/docs/workflows-sdk-typescript), [inspection receipt](../validation/render-research-20261026.json)

| Setting | Initial policy |
| --- | --- |
| Compute/retry | `plan: 'flex'`, `retry: { maxRetries: 1, waitDurationMs: 1000, backoffScaling: 2 }`; controller retry does not create a processing retry |
| Task runtime | `timeoutSeconds: 3600`; stop routine advancement and persist continuation by minute 50 |
| Logical deadline | 24 hours across controller generations; profile/operator bounds may be shorter, never reset automatically |
| Polling | Approximately 30 seconds with jitter while a Modal call/validation is active; short requests with explicit timeouts |
| Controller ownership | 120-second lease, renewed every 30 seconds; generation/epoch CAS on every mutation/dispatch authorization |
| Capacity wait | Return within two minutes; enqueue a due continuation with backoff, at most 15 minutes; hold no idle controller for capacity |
| Global controller bound | At most eight active controllers; maximum two database connections per task |
| Payload/result | Application cap 16KiB each, IDs/status only; provider argument ceiling is 4MB |

These are implementation limits, not throughput measurements. Flex retains billed RAM while polling. Render permits tasks up to 24 hours; our smaller slices permit controlled continuation and bounded deployment/recovery. [Task configuration](https://render.com/docs/workflows-defining), [billing](https://render.com/docs/workflows-limits)

At task entry, claim the current dispatch with a random owner nonce and incremented controller epoch. A stale, completed or already-owned generation returns its current outcome without effects. Each scope has one active generation. Continuation atomically marks the old generation `continued`, invalidates its lease, creates the next generation/outbox and preserves the original logical deadline. Every old controller must fail its subsequent CAS. Stage position comes from accepted job records; no second stage cursor is maintained. **Controller epoch is distinct from processing-attempt/worker epoch.** Taking over or continuing a controller never invalidates an ongoing worker claim, heartbeat or write grant. Only an explicit processing retry creates a new attempt/worker epoch, after safe takeover.

If a controller dies, the cron reconciler observes its expired lease and atomically creates a replacement generation using the same routine. It can resume monitoring the existing Modal call, barrier or validation. Persist submission intent before every external call; a lease expiry alone never authorizes another processing call. A late Render retry exits when its generation is stale. Bound continuation count and total control cost in the profile; exceeding either visibly blocks new work. Deadline expiry stops starts and begins cleanup; outstanding calls/grants still require reconciliation.

The cron job delivers due dispatches and recovers abandoned ownership, unknown provider state, grants and incomplete receipts. It **never chooses successor stages**, performs inference or approves results. Controllers own dependency progression. Run cron and workflows in the same workspace/region as Postgres, using its internal pooled URL and a scoped control role. Current Render Workflows cannot use that private network inside a network-isolated environment; qualify placement before activation. [Workflow connectivity](https://render.com/docs/workflows), [private networking](https://render.com/docs/private-network)

## Run and accept one processing stage

1. **Admit atomically.** Check active lifecycle, controller identity, source/selection/version, model rights, tested bounds and budget. Lock job/batch/resource rows in fixed order; create attempt/deadlines/bootstrap-token hash and reserve budget, CPU/GPU and writer ownership together. Busy capacity follows the bounded continuation policy.
2. **Submit once.** Commit a submission-intent flag/counter for that attempt before the single permitted Modal `spawn`. Save `functionCallId` when returned. Lost acknowledgement becomes `dispatch_unknown`; no controller restart or provider retry may blindly replace it.
3. **Claim before heavy work.** The worker exchanges its bootstrap capability for an invocation-bound claim. CAS checks attempt, epoch, owner, absolute start deadline and active lifecycle. Only the winner receives storage capabilities/configuration. Losers exit before media/model downloads; startup may still cost money.
4. **Observe.** Poll the known call and accept scoped worker heartbeats/candidate receipts. Missing heartbeat is not termination proof. Curator writes/checkpoints/publishes its stable batch root in place. Controller continuation preserves the call/attempt and does not restart the model.
5. **Establish quiescence.** Persist trusted Modal terminal observation, then call the API quiescence endpoint. The API disables renewal, retires **all writer capabilities**, and performs bounded grant/drain/visibility metadata reconciliation; `202` means pending, `200` returns the bound barrier. It never hashes media or traverses dataset closure. Bind barrier/grant-generation evidence to the candidate hash; retain exclusive batch ownership. Release the terminal call's compute slot now so validation cannot deadlock behind completed jobs; keep conservative cost accounting.
6. **Validate independently.** Create a `stage_jobs` helper with `stage=validate_stage` and `validation_for_job_id` pointing to the producer job; its partition key binds producer attempt, candidate hash and barrier generation. Use the existing `job_attempts` ledger: **`validationId` is this helper attempt ID**, not another table. Persist its distinct bootstrap hash, CPU/budget reservation and submission intent before the single Modal call; unknown submission obeys the same no-blind-respawn rule. The private validator claims read-only configuration from the API before reads and submits its separate completion receipt. Check scope, native commit/receipt, row status, schemas, hashes/bytes and closure. Initial timeout: 600 seconds with measured object/row/byte budgets. Oversize requires a budgeted sharded profile. Validation cannot write payloads or accept the producer job.
7. **Accept through the API.** A workflow-service-authenticated API call loads trusted validation and performs one short CAS over controller generation/epoch, job/attempt/invocation/batch owner, unchanged barrier/grant generation, candidate hash, parent/selection/observed version and lifecycle. Atomically select pinned artifacts/version and mark success. Worker JSON or a physical commit cannot self-approve.
8. **Settle and advance.** Transfer batch ownership only after validation/acceptance. Settle actual cost conservatively. Compute capacity, controller ownership and canonical writer ownership are separate resources.

## Service boundaries

Human cookies cannot authenticate service routes. All rows below are POST:

| Path | Caller/authority |
| --- | --- |
| `/internal/v1/processing/attempts/{attemptId}/claim` | Random bootstrap capability; establishes one worker invocation owner |
| `/internal/v1/processing/attempts/{attemptId}/heartbeat` | Claimed invocation capability; renewal only while active and before deadline |
| `/internal/v1/processing/attempts/{attemptId}/candidate` | Claimed invocation; bounded candidate reference/hash only |
| `/internal/v1/processing/attempts/{attemptId}/quiescence` | Workflow credential plus live dispatch/epoch; bounded API-issued retirement/drain/visibility evidence. Separate cleanup-only reconciler credential is permitted as described below. |
| `/internal/v1/processing/validations/{validationId}/claim` | Distinct validation bootstrap; binds one validator invocation and returns API-issued read-only configuration plus completion capability |
| `/internal/v1/processing/validations/{validationId}/complete` | Claimed validator completion capability; records evidence on its helper attempt only |
| `/internal/v1/processing/jobs/{stageJobId}/accept` | Workflow service bearer credential plus `workflowDispatchId`, `controllerEpoch`, `expectedAttemptId`; API verifies current dispatch/scope and trusted validation |

Use separate high-entropy, rotatable `WORKFLOW_API_TOKEN` (controllers: quiescence/acceptance) and `RECONCILE_API_TOKEN` (cron: quiescence/cleanup only), with server-side hashed/configured verifiers. Exclude these routes from human-cookie/CSRF middleware. Prefer the API's private Render address from controllers; worker callbacks use its public HTTPS origin. Provider keys and random bootstrap/worker/validator capabilities never enter outbox payloads, Render task arguments, durable manifests or logs.

Quiescence requests bind `expectedAttemptId` and `expectedGrantGeneration` (decimal string); normal controller requests also carry `workflowDispatchId` and `controllerEpoch`. The API loads trusted provider-terminal evidence from control records, verifies candidate/current ownership and performs only bounded provider metadata operations. Retirement may begin while termination is unresolved, but that cannot establish a validation barrier. The cleanup-only reconciler may retire the exact old attempt's grants after cancellation/deadline/lease loss without a live controller; it cannot mint/renew grants, approve results or bless a newer writer's barrier. Cleanup remains authorized until outstanding calls, grants, writes and cost reservations are settled. Late worker callbacks remain proposals and cannot reopen the run or override cancellation.

Only the Next.js API holds R2/S3 credential-issuer secrets. Controllers create attempt records/bootstrap hashes, submit private Modal calls and monitor them; controllers/cron never mint or receive storage grants. Normal workers obtain write/read configuration through their existing claim/heartbeat API. The validator's claim checks its helper attempt, producer candidate/hash, unchanged barrier/write-grant generation, deadline, lifecycle and one invocation owner. The API resolves approved input/candidate roots, issues read-only grants and a separately hashed completion capability, and returns the bounded validation descriptor. Read grants do not increment the producer's write-grant generation. Repeat claim by the same invocation is safe; another invocation is denied. Completion replay must match the stored receipt digest; changed content returns `409`. The API records the helper's validation evidence without accepting its producer.

Controllers import shared domain services to manage their control ledger and dispatch validation. The workflow secret is not a validator credential. Modal workers receive no DB URL, Render key or Modal control-plane key. The validator may reuse an approved image but runs separately with read-only storage and its own receipt capability. Do not expose an unauthenticated cron/webhook endpoint; Render Cron runs an entrypoint directly.

Human processing controls require current internal project grants and `Idempotency-Key`:

| Route | Request/result |
| --- | --- |
| `POST /api/v1/internal/recordings/:id/processing-runs` | `profileRevision`, `expectedSourceManifestSha256`, `reason`; `202` |
| `GET /api/v1/internal/processing-runs/:id` | Status, queued/blocked reason, attempts and validation references; `200` |
| `POST /api/v1/internal/processing-runs/:id/cancel` | `reason`; `202`, starts cancellation rather than claiming immediate termination |
| `POST /api/v1/internal/stage-jobs/:id/retries` | `expectedAttemptNumber`, `reason`; `202`, stale expectation `409` |

The exporter writes a unique unpublished prefix and uses the same barrier/validator/CAS protocol. Its task ends at `ready`. Only a fresh internal-admin session can publish via `POST /api/v1/internal/releases/:id/publish`, rechecking unchanged manifest/barrier, approval, rights, recipients and lifecycle. See [delivery](review-and-delivery.md).

## Native recovery and cancellation

Reuse the same dataset/media root and compatible native checkpoint namespace across attempts. New attempt IDs change logs/accounting, not the dataset. Preserve native layouts, immutable input media/fragments and transaction history; no compaction, rewrite or vacuum while recovery/pinned consumers depend on them. Caption recovery remains recipe-specific. [Processing rules](cloud-processing.md)

| Evidence | Required response |
| --- | --- |
| Modal submission unknown, no call ID | Wait for claim/result and investigate; expire bootstrap at the absolute start deadline. Silence proves neither zero cost nor safe replacement. |
| Old call may run, any write grant valid, or write visibility unresolved | Block validation, acceptance and same-root takeover. Controller/DB epoch changes do not stop object writes. |
| Checkpoint durable, canonical commit missing | After safe takeover, resume compatible native work; replay uncheckpointed work only. |
| Commit succeeded, callback lost | Independent validation checks canonical version/receipt; accept without repeating inference. |
| Invalid candidate/hash/layout/model rights | Classified failure; retain evidence. No automatic GPU upgrade, reset or new root. |
| Cancellation/deletion wins CAS | Reject late acceptance, cancel known Modal call best effort and retire grants; continue cleanup despite controller/run termination. |
| Render task/host outage | Preserve outbox, attempts, control ledger and native state; recover monitoring through the bounded reconciler. |

Credential expiry does not cancel an already accepted PUT/multipart upload. Track write operations/MPUs and prove provider-specific bounded drain/visibility with clock-skew margins; fixed sleeps and client timeouts are insufficient. Unknown writes block adoption. The adapter canary must establish this barrier before R2/S3 activation.

Start with Modal retries zero, one admitted GPU and two CPU calls globally; include validator/export CPU and startup uncertainty. Use existing `resource_slots` plus `budget_reservations`, not a second priority scheduler. Allow one diagnosed operator-authorized processing retry during qualification. Render controller retries do not consume this authorization or grant another `spawn`.

## Implementation and qualification

Implement `backend/src/workflows/`, shared processing/control services, provider adapters and `backend/src/workers/relay-reconcile.ts`; Modal Functions remain in `processing/`. Use Render's MIT SDK and hosted workflow service. [SDK package/license](https://github.com/render-oss/sdk/blob/main/typescript/package.json)

Build the shared backend package from the repository root. The workflow start command executes `node backend/dist/workflows/index.js`; that entrypoint statically imports all four module-level `task(...)` definitions. The TypeScript SDK starts its task runtime automatically on Render; do not add an HTTP listener or Python-style `app.start()`. Avoid database/provider connections at module import, including during registration. [Registration/startup](https://render.com/docs/workflows-tutorial)

Before activation, fault-test duplicate/late task delivery, Render acknowledgement loss beyond 24 hours, controller death after Modal submission, continuation and lease races, unknown processing/validation spawn, late or duplicate worker/validator claims, old grants/in-flight writes, checkpoint/commit loss, forged validator receipt, barrier mutation, cancellation racing CAS, concurrent final-batch joins, fan-out/deadline exhaustion, validator slot deadlock and full release download. No cloud qualification or paid task was performed for this design.
