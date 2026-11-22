# Workflow jobs: durable admission and worker claims

SA-25 · Implemented in `packages/server/src/jobs`, migration `007_job_admission_claims.sql` and `apps/web/app/internal/v1/jobs`. The Render Workflow controller, executors, Modal/local worker runtime and output acceptance are later tickets (SA-26, SA-27, SA-28); nothing here submits to Render, Modal or a worker and nothing fakes a result.

[Contracts](../contracts.md) owns the task, claim, heartbeat and status schemas (frozen catalog.v5); [catalog](catalog.md) owns the tables; [multipart transport](multipart-transport.md) owns worker output uploads. The same server code runs locally, in development and on Render: only the environment differs.

## What a job is

One `jobs` row is one intentional processing attempt (`process_recording`; export is gated and will reuse the same slot). Admission creates a job only after SA-19 validated the sealed recording. The initial processing payload is decode → CPU hand pose → format conversion → Rerun preview; there is no geometry, iOS or paid resource here.

## Database invariants (migration 007)

| Object                     | Purpose                                                                                                                                                                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `dispatch_admission`       | Singleton row (`slot = 1`). Admission is a conditional `UPDATE … WHERE job_id IS NULL`, so across any number of connections at most **one** execution is admitted. Every job kind uses this slot.                                                                                                            |
| `job_inputs`               | Permanent, secret-free input identity written in the admission transaction: sealed source manifest digest, profile, backend, code revision, image spec, model and config digests, output limits, canonical task input and its digest. Immutable.                                                             |
| `job_execution_evidence`   | Append-only authoritative evidence: `local_child_reaped`, `provider_call_terminal` (both must name the exact recorded execution ID and match the backend) or `pre_submission_rejected` (only a job with no submission intent).                                                                               |
| `service_capabilities`     | Hashed, expiring workflow-controller and repair-cron credentials with scopes `jobs:status`, `jobs:reconcile`, `jobs:repair`. Operator-issued only.                                                                                                                                                           |
| `jobs` columns             | `admitted_at`, `dispatch_key = job:{id}`, `execution_backend`, write-once absolute `execution_deadline`, `start_deadline`, submission intent and owner, bootstrap hash, `claimed_at`, heartbeat progress, `unknown_at`; plus the existing controller lease, run, nonce, call ID and capability hash.         |
| `jobs_orchestration_guard` | The state machine: `queued → submitting → (submit_unknown) → running → result_pending → succeeded`, with `cancel_requested`, `needs_attention`, `failed`, `cancelled`. Admission identity, deadlines, intent and claim identity are write-once; `running` requires a claim; compute states require the slot. |

**Slot release needs two facts.** `dispatch_try_release` frees the slot only when the job's business state is terminal (`succeeded`/`failed`/`cancelled`) **and** execution evidence exists, whichever arrives last (AFTER triggers on both). A terminal state alone, evidence alone, lease expiry, deadline expiry, a missing heartbeat or an unknown submission never free it; SA-28's atomic acceptance or failure supplies the terminal state, SA-26/SA-27 the evidence. `pre_submission_rejected` fails the job and so completes both.

Lock order extends the catalog's: recording row, then job row. Admission takes the slot row and then candidate jobs with `SKIP LOCKED` (it never waits on a job row), so it cannot deadlock with claims or cancellation.

## Admission and dispatch intent

`admitNextJob` picks the oldest eligible queued job (current recording pointer, active owner permission covering processing, collector role), writes `job_inputs`, takes the slot, then moves the job to `submitting` with the fixed dispatch key `job:{jobId}`, backend and absolute deadline (`admitted_at + 6 h` without a recipe, or the recipe's enabled stage budgets plus 30 min clamped to 1 h..12 h, never reset). A recipe whose enabled budgets exceed 12 h is rejected at admission: that job moves `queued → cancelled` with `error_code = recipe_deadline_exceeded` (no inputs written, no slot taken), the call reports it in `rejectedJobIds`, and the next eligible job is still admitted, so one bad recipe never blocks the queue. A task input failing its contract validation is rejected the same way (`task_input_invalid`). All of this commits before any external effect. Queued jobs hold no controller or compute. `listPendingDispatches` returns admitted jobs whose Render task start was never acknowledged; SA-26 retries `startTask` with the same key and saves the run with `recordWorkflowRun`.

The default task input is `processRecordingTaskInputV2` (jobs.task-input.v2, from the immutable admission evidence of that job; simulated captures keep their explicit marker). There is no v1 fallback that could strip simulation provenance; the builder is injectable for tests only. Settings (all required, none defaulted): `PROCESSING_EXECUTION_BACKEND` (`local` or `modal`), `PROCESSING_CODE_REVISION`, `PROCESSING_IMAGE_SPEC_SHA256`, `PROCESSING_MODEL_SHA256` (the accepted CPU model, MediaPipe Hand Landmarker full float16 task bundle v1: `fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1`) and `PROCESSING_CONFIG_SHA256`. `render.yaml` prompts for the four operator inputs and pins the model digest; `.env.example` documents them without placeholder values; `hosted:preflight` refuses to start without them outside local development and `/api/v1/health` reports `checks.jobs` (degraded outside local when missing). The job routes configure lazily, so a missing setting makes only these routes return `provider_unavailable`. See [Render deployment](render-deployment.md) for the secrets map; the controller deployment and the controller/cron credentials are SA-26's.

## Controller control (no physical authority)

`claimControllerLease` takes a 120 s lease with a fresh owner nonce per task entry; only one live owner exists, a native retry of the same run waits for expiry, and a different Render run exits without effects. `recordWorkerSubmissionIntent` persists intent, the start deadline (10 min) and the hash of a one-time **bootstrap capability** before the single submission and returns the token once; a second call returns `already_recorded` and never another token. `markSubmissionUnknown` keeps intent, deadlines and the slot for SA-27 repair and never resubmits. `recordExecutionRef` saves the executor reference once. A lease is never worker authority.

## Worker claim

`POST /internal/v1/jobs/{jobId}/claim` (bootstrap bearer, `jobs.worker-claim.v1`) calls `claimWorker`. One transaction locks recording then job and rechecks live state: awaiting claim inside the start deadline, unexpired absolute deadline, slot held, current recording pointer, owner role, processing permission, backend, and the exact execution ID if the controller already recorded one. The nonce, execution ID and running-capability hash are written once. A duplicate, replayed or mismatched physical worker fails with no database inputs read and **no signed URL**; only the winner receives `jobs.claim-grant.v1` with offline-signed source read URLs. The bootstrap token stops resolving the moment the claim wins. A lost claim response therefore cannot be replayed; the worker exits and the job stays visible for repair.

## Current-claim recheck

`assertJobCurrent` / `JOB_CURRENT_SQL` is evaluated live on every worker read and output mutation, including SA-20's output create, sign, receipts and plan routes: job `running`, claimed, holding the slot, before its immutable absolute deadline, recording still pointing at this job and `processing`, owner still a collector with active permission, and the invocation nonce where supplied. Cancellation, a replaced recording pointer, revoked permission or an expired deadline stop everything immediately, while the slot stays occupied until evidence. Heartbeats record progress and never extend a deadline.

## Authentication

Machine credentials only: Better Auth cookies and custom user tokens are never consulted on these routes. Controller and cron credentials are minted by an operator with the owner database credential (`issue-service-capability` CLI, token written once to a new `0600` file, only the hash stored); nothing seeds them from a request or environment. Credentials are limited to 24 hours by the service-credential issuer.

| Route                                              | Principal / scope                                                    |
| -------------------------------------------------- | -------------------------------------------------------------------- |
| `POST /internal/v1/jobs/reconcile`                 | cron or workflow, `jobs:repair`: admit next, list pending dispatches |
| `GET /internal/v1/jobs/{id}`                       | workflow/cron, `jobs:status` (`jobs.job-status.v1`)                  |
| `POST /internal/v1/jobs/{id}/controller`           | workflow, `jobs:reconcile`: strict action object                     |
| `POST /internal/v1/jobs/{id}/claim`                | worker bootstrap, `job:claim`                                        |
| `POST /internal/v1/jobs/{id}/heartbeat`            | running capability, `job:heartbeat`                                  |
| `POST /internal/v1/jobs/{id}/inputs/{fileId}/read` | running capability, `job:input`                                      |

Request and response bodies are frozen in additive `catalog.v7` (TS, Python and Dart conformance fixtures): `jobs.controller-action.v1` (one strict action: `record_workflow_run`, `claim_lease`, `renew_lease`, `record_worker_submission`, `record_execution`, `mark_submit_unknown`, `record_execution_evidence`) and `jobs.controller-result.v1`, `jobs.reconcile-result.v1`, `jobs.heartbeat-ack.v1` and `http.input-read.v1`. Worker bodies reuse the frozen v1 `worker-claim`, `claim-grant` and `heartbeat` contracts. Every response is validated against its contract before it is sent.

## Tests

`packages/server/test-integration/jobs.test.ts` runs against restricted-role Postgres across connections: concurrent admission, slot release only with both facts, evidence/ref mismatches, lease and unknown-submission non-release, duplicate claim races, signed-URL counts, backend/ID mismatch, expired start deadline, heartbeat and read rechecks, revoked permission, replaced pointer, cancellation, expired absolute deadline and credential stores. `apps/web/test-e2e/jobs.e2e.test.mjs` exercises the production Next build over HTTP: owner/staff/customer/anonymous denial on every machine route, scope separation, admission through the slot, the controller flow, the racing physical claim and fixture-byte reads through the server-selected URLs, and permission revocation.

These prove the server protocol. They are not Render, Modal, R2, hosted or physical-device qualification.

## SA-26 controller and LocalExecutor (`apps/jobs`)

The single production task definition is `process-recording` (`apps/jobs/src/process-recording.ts`, input `{jobId}`, `plan: 'flex'`, 8 h timeout, 2 bounded retries). The official Render local runner and Render load the same module. The shared `runController` (`controller.ts`) uses only SA-25's machine API with a protected workflow credential (`CONTROLLER_CAPABILITY_FILE`, owner-only, or the Render secret `CONTROLLER_CAPABILITY_TOKEN`); it has no SQL and no storage access. The Render task start belongs to the API's repair pass (SA-27, below), not the controller or the cron.

Order: status → record the workflow run → claim and renew the lease → record submission and save its one-time token → record the exact execution reference → persist the spawn reservation → launch the worker → persist the acknowledged process identity → send the bootstrap on stdin → supervise. The journal (`JOBS_STATE_DIR`, 0700/0600) uses fsync and atomic rename. The bootstrap contains the API URL, job ID, one-time token, execution reference and pipeline name. It travels only through the worker’s stdin. The worker obtains signed reads after claiming.

Recovery requires authoritative server state and the same execution reference. A lost submission acknowledgement without a saved token, an unfinished spawn, an unreadable journal, a different boot, or a changed process identity requires operator recovery. The controller stops when it loses the lease. It only signals the verified worker through a Linux pidfd once the server’s fixed execution deadline expires. Lease loss and elapsed deadlines do not release capacity. Releasing the slot also requires SA-28’s terminal business state.

The local runner uses `local_fixture_noop` with `APP_ENV=local` to exercise claims, heartbeats and restart recovery. The fixture emits no output. Before receiving its bootstrap, the worker installs a Linux seccomp filter through `libseccomp.so.2` that blocks process and thread creation and program execution. The controller persists the acknowledgement together with the worker’s identity before allowing a claim. It records `local_child_reaped` only when it can prove that acknowledged process exited, including after restart. Missing kernel support or an unproven identity leaves the execution for operator recovery.

The hand-pose worker adapter and output protocol are described in [output acceptance](output-acceptance.md).

On Linux x86-64, the guarded local runner can start `hand_pose_cpu_v1` with a loopback API. Its worker acknowledges a seccomp filter before bootstrap. The filter permits native threads in the worker's process and blocks new processes and program execution. After restart, the controller uses the recorded boot, PID namespace and process identity to check a process-wide pidfd. It records terminal evidence when every thread has exited or the verified namespace reports that the process no longer exists. Signalling still requires a current lease and a pidfd corroborated by the execution reference. Journals without containment proof require operator recovery. Journals stay on one controller machine. Keep `JOBS_STATE_DIR` and its parent directories protected from replacement by other users. Credential files must be regular, non-symlink files owned by the controller user and mode 0600. The API URL must be a bare HTTPS origin or HTTP on loopback. The worker refuses redirects.

The [Modal executor](modal-executor.md) is selected explicitly. A different controller instance can adopt a known call through the recorded `executionRef` in `jobs.job-status.v2` (catalog v12).

## SA-27 repair, cancellation and operator recovery

**Repair entrypoint.** `apps/jobs/src/repair-cli.ts` (`pnpm --filter @stateaction/jobs repair`, Render cron `stateaction-repair`, `* * * * *` UTC, Render runs one instance at a time) makes ONE `POST /internal/v1/jobs/reconcile` call with a `jobs:repair` capability (`REPAIR_CAPABILITY_FILE`/`TOKEN`) and exits non-zero on failure. It has no database, storage, Render or Modal credential, no retry (the next minute repeats the idempotent pass), a 55 s call limit, a response bounded by the published contract size and `redirect: "error"` so the bearer never leaves its origin. It prints counts only.

**What the API does** (`packages/server/src/jobs/recovery.ts`, `dispatch.ts`; `runRepair` behind the existing reconcile route and contract, so catalog v9 is unchanged). One pass holds a Postgres advisory lock (a concurrent or duplicate pass only admits/lists and starts nothing), and in order: (1) finishes verified results (SA-28); (2) `finalizeCancellations`; (3) `failUndispatched`; (4) `flagUncertain`; (5) admits the next job; (6) starts the Render task for at most `batchLimit` (5) pending dispatches with key `job:{id}`, per-start 10 s abort, no retry inside the pass. **Exact bounds:** the 40 s budget is a SOFT limit on beginning new Render starts, counted from the start of the request (so slow SA-28 result repair in step 1 consumes it); it is not a whole-pass cap. Hard bounds are per operation: each Render start 10 s, each SQL step bounded by batch size, SA-28 acceptance by its own manifest/slice/object limits (up to about 120 s). The advisory lock covers steps 2-6 only, not step 1. The cron aborts its call at 55 s and the API may keep running after that, so a failed cron run does not mean nothing happened: every step is idempotent (fixed `job:{id}` key, database fences, admission through the single slot) and the next minute repeats the pass; an unacknowledged start stays in `pendingDispatches`. The recovery mutation transactions (cancel finalization, never-submitted failure, uncertain flagging, retry, operator cancel) set transaction-local `lock_timeout` 5 s and `statement_timeout` 15 s; a timeout or deadlock becomes a retryable `provider_unavailable` (`busy`) and the advisory lock is always released, so a blocked row cannot hold a repair request indefinitely. Read-only candidate selects and the pool checkout are not separately bounded (they rely on the pool's own settings), so not every backend step is claimed hard-bounded. Cancellation is never forced and repair never cancels unknown executions. The API alone holds `RENDER_API_KEY` and `PROCESS_RECORDING_TASK_SLUG` (hosted slug `<workflow>/process-recording`; local runner: `APP_ENV=local` plus `RENDER_USE_LOCAL_DEV`/`RENDER_LOCAL_DEV_URL`). Without them dispatch is reported unavailable, nothing starts, and the job stays pending. The API does not write the run ref; the controller records its own run, so an unacknowledged start simply stays in `pendingDispatches` and the next pass repeats the same key. Render scopes a key to one workflow version for 24 h, so after a deploy or 24 h a repeat start CAN create a second run; that is never the fence: the first controller to take the lease fixes the run, a different run is refused with no effects, submission intent is written once and a worker can win its claim once.

| Situation                                                                                                                            | Repair action                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admitted, no worker submission intent after `dispatchWindowSeconds` (1800 s) and no live lease (lost start, or controller exhausted) | proven never submitted (intent needs a live lease holder in `submitting`): `pre_submission_rejected` evidence + `failed` (`dispatch_lost` / `controller_exhausted`); frees capacity |
| `submitting` with recorded intent and a lease expired by 60 s                                                                        | `submit_unknown` (never failed, resubmitted or released)                                                                                                                            |
| `submit_unknown`/`running` past the immutable deadline, lease lapsed, no evidence                                                    | `needs_attention` (held)                                                                                                                                                            |
| `cancel_requested` with exact termination evidence                                                                                   | `cancelled` (terminal state + evidence frees the slot)                                                                                                                              |
| `cancel_requested`, nothing ever submitted (no intent/ID/nonce)                                                                      | database-verified `pre_submission_rejected` evidence, then `cancelled`                                                                                                              |
| `cancel_requested`, no evidence                                                                                                      | unchanged: not stopped, capacity held                                                                                                                                               |

**Operator actions.** `POST /api/v1/jobs/{jobId}/control` (staff only; additive catalog v11 `http.job-control-command.v1` / `http.job-control-result.v1`; `packages/server/src/jobs/control.ts`) is the real authenticated mutation behind the Pipeline detail controls (`components/pipeline/job-controls.tsx`). It uses the same Better Auth staff guard as the dataset routes (live enabled role, origin, Fetch-Metadata and client-header checks, bearer refused, 4 KiB body bound, restricted pool, no owner, Render or storage credential). The body names `action` (`cancel`, `retry`, `reconcile`), the exact `jobId` and the `expectedState` the operator saw; the job must still be the recording's current job (`stale_current_job`, `stale_state` refuse with no mutation). Cancel only requests (`cancel_requested` is not stopped). Retry needs a terminal job, recorded termination evidence and a released slot (`termination_unproven`, `not_terminal`), inserts a NEW job (new ID, hence new `jobs/{id}/outputs/` prefix) from the same immutable sealed source and moves the recording pointer; `requestId` IS the new job's ID, so repeating after a lost response returns the same job (`replayed`). Exact binding: a replay needs the same request ID, the same prior job AND the same `expectedState` (a finished job's state is immutable, so a true replay always matches); a changed `expectedState` is `stale_state`, a different request ID against an already-retried prior job is `already_retried`, and a request ID that identifies any other job is `request_id_in_use`; none of these creates a job (no migration needed). Reconcile re-evaluates one job with the same guarded non-dispatching steps and never starts or resubmits anything. A `failed` job with `source_sha_mismatch` refuses retry (`source_reupload_required`); the page shows guidance asking for corrected source as a new upload, originals and ownership untouched. `jobControlCapabilities(pool, wired)` advertises a control only for kinds wired to this route, re-read from live rows on every page view. The owner CLI (`pnpm --filter @stateaction/server job-recovery status|cancel|retry <jobId> --expect <state>`) calls the same functions for host-side operation; neither path records evidence, clears the slot or edits job rows.

**Unknown local spawn / escaped child** stays fail-closed: the controller never respawns or records evidence it cannot prove; the instruction is to let the controller recover from its local journal on the controller host or inspect the host, never to clear the slot by hand.

Not implemented (honest limits): no persisted re-upload request (guidance only), no export or iOS (the Modal executor is source-complete but not qualified, see [Modal executor](modal-executor.md)). Tests: `packages/server/test-integration/recovery.test.ts` (real restricted Postgres), `apps/web/test-e2e/job-control.e2e.test.mjs` (production Next, real sessions), `apps/web/test-e2e/job-control-browser.mjs` (real browser click path, run inside one guarded job), the SA-27 case in `apps/jobs/test-integration/controller.e2e.test.mjs` (repair pass -> API starts the official local runner task), `test/recovery-unit.test.ts`, `apps/jobs/test/repair.test.ts`, `infra/test/blueprint.test.mjs`, contract conformance for catalog v11.

## Recipe stage runs and stage claims (SA-88, migration 011)

A job admitted with `jobs.task-input.v3` stores its inline `jobs.recipe.v1` on `jobs.recipe` / `recipe_sha256` (written once at admission; the database checks it equals the persisted task input). A job without a recipe keeps the single-claim path above unchanged (`hand_pose_cpu_v1`, task input v1/v2).

- **Stage claims** (`job_stage_claims`, one per `(job, stage)`): controller action `issue_stage_claim` (lease-fenced, `controller-action.v2`) returns that stage's one-time bootstrap token (the `controller-result.v1` `recorded` shape; `taskInput` is the v2 projection of the admitted v3 input, the worker reads the full v3 through `GET .../task-input`). A repeat returns `already_recorded`. Stages are issued and run in recipe order: a stage starts only after every earlier enabled stage has a terminal run, so at most one stage call can be live. The first issued stage also writes the job-level submission intent; the first claimed stage moves the job to `running` with its nonce, call ID and capability hash. Each stage has its own nonce, capability (`job:heartbeat|input|output`; only `hand_pose` also gets `job:result`) and heartbeat (`heartbeat.v2`, phase mirrored onto the job). A stage capability ends when its run is recorded terminal. A replayed bootstrap token resolves to nothing; a second claim of the stage is refused.
- **Stage runs** (`job_stage_runs`): controller action `record_stage_run`. States follow common.v2 `stageRunState` (`pending` = intent, `submitting` = spawning, `running` = submitted with a call ID, then `succeeded|failed|cancelled`, or `not_run` from nothing/pending). Forward-only; call ID, receipt (`jobs.stage-receipt.v1`, at most 64 KiB, sa-cjson-v1 digest) and the `submit_unknown` reason are write-once; terminal rows are immutable. A succeeded run needs a receipt whose outputs are completed files of the job; observed GPU, counts and worker times come from the receipt. `cost_estimate_usd` stays null until a GPU rate exists. After the job ended, the recorded lease owner may still settle an open stage (terminal states only).
- **Stage evidence** (`job_stage_evidence`, one per `(job, stage)`): `record_execution_evidence` on a recipe job names the exact call of one stage and records its terminal proof. Once a stage claim is issued (the spawn intent), that stage is never `not_run` and goes `succeeded|failed|cancelled` only after proof for its known call, so a timed-out or lost GPU call cannot keep running while the next stage starts. The same proof is also the job's terminal evidence only when it names the latest issued stage and no later stage can still run (the sealing `hand_pose`, or a job in `result_pending`/`cancel_requested`/`needs_attention`/terminal). The slot is released only when every issued stage claim has its proof. A claim whose call ID was never learned (spawn result lost, `submitting`/`submit_unknown`, or a spawn rejected after the claim) can be neither failed, `not_run` nor released: like the 007 `submit_unknown` rule, it holds the slot for the operator path (`needs_attention`), which ends it only after recording the exact call (`record_stage_run` with `callId`) and its terminal proof. A different call ID than the recorded one is refused (`conflict`), never masked.
- **Seal**: `hand_pose` closes the inventory and posts `processing-result.v3`; closure, candidate and attestation bind to the hand_pose stage nonce. A recipe job enters `running` only with the nonce and capability of a claimed stage.
- **Reads**: `POST /internal/v1/jobs/{jobId}/outputs/{fileId}/read` signs a read of a completed `segments_json` output of the same current job, only for the claimed, unfinished caption stage. `GET /api/v1/jobs/{jobId}/dag-run` (staff) renders `http.dag-run.v1` from `job_stage_runs` plus the recipe; a stage with no run is `not_run` (`stage_disabled`, or `not_spawned` once the job ended) or `pending` while it can still run.
- The web role reads both tables and writes them only through the SECURITY DEFINER functions `job_stage_issue_claim`, `job_stage_take_claim`, `job_stage_heartbeat`, `job_stage_record_run` and `job_stage_record_evidence`; triggers hold the invariants for every writer. Tests: `packages/server/test-integration/stage-runs.test.ts`.

## Recipe stage runner (SA-91, `apps/jobs`)

The ONE `process-recording` task runs a recipe job's stages as plain sequential code (`apps/jobs/src/recipe.ts`): `segment`, then `caption`, then `hand_pose`. After the lease, the controller reads three routes with the workflow credential (`jobs:status`):

- `GET /internal/v1/jobs/{jobId}/recipe` (`jobs.recipe.v1`). A 404 means no recipe, and the job runs exactly as before (`hand_pose_cpu_v1`, one claim).
- `GET /internal/v1/jobs/{jobId}/dag-run` (`http.dag-run.v1`). A recorded stage's `callId` is the claiming worker's call, else the spawn's, as `job_stage_call`.
- `GET /internal/v1/jobs/{jobId}/prior-stages` (`jobs.prior-stages.v1`, catalog.v16). This returns the segment and caption runs, each with every completed output file of the job that the 011 slot policy attributes to that stage, with its slot: `segments.json`/`captions.json` and `diagnostics/<stage>/...`; everything else belongs to hand_pose. The controller reads it on every entry, so a controller on a fresh host loses nothing.

**Deploy order:** deploy the server (these three routes) before the workflow service. A controller against an older server gets a 404 on `/prior-stages`, and the task throws.

Per stage, in order:

- **Already settled on the server** (a terminal row): taken as is, never run again.
- **Not yet claimed** (no stage journal, no row): recorded before any claim as one of these:
  - `not_run (stage_disabled)` when the stage is disabled.
  - For caption: `not_run (upstream_failed)` when the segment did not succeed, `not_run (no_segments)` when it found zero segments, or `not_run (segments_unavailable)` when the server holds no `segments.json` for a succeeded segment.
  - For segment and caption only: `not_run (budget)` when the remaining execution deadline is shorter than the stage `budgetSeconds` **plus the hand_pose `budgetSeconds`**. This reserves the seal's time. Every later GPU stage is then `not_run (budget)` too.
  - `not_run (module_unknown | module_local_only | module_needs_gpu | module_unbound)` when the module policy refuses it (see below).
  - `failed (bootstrap_too_large)` when the serialized bootstrap with the largest token and ref exceeds the worker's 8 KiB stdin bound. It is never truncated. A `priorStages` entry is about 230 B, so roughly 30 earlier-stage files fit. Beyond that the hand_pose stage, and so the job, ends without a result; SA-94 modules must keep their diagnostic files few.
  - `hand_pose` always runs otherwise, and is bounded by its own budget. It seals the job, which succeeds when it seals (H3); failed GPU nodes are shown as failed.
- **Run**:
  1. `issue_stage_claim` returns that stage's single-use token, saved in the stage directory.
  2. Journal `intent`.
  3. `record_stage_run submitting`.
  4. Journal `spawning`.
  5. ONE spawn.
  6. Journal `submitted` (call ID, write-once).
  7. `record_stage_run running` with the call ID.
  8. Poll or supervise until a terminal result.
  9. `record_execution_evidence` for that exact call.
  10. `record_stage_run` terminal with the stage receipt.

  The server row (step 3) is written before the local `spawning` mark (step 4), so a lost answer re-enters at `intent` (provably unspawned).

- **Workers per stage:**
  - Segment and caption: `python -m stateaction_processing run-stage <ref>` with the stage bootstrap v2 (`stage`, `module`, `recipeSha256`, and for caption `segmentsFileId`/`segmentsSha256` from prior-stages).
  - hand_pose: the SA-92 `run-job --execution-ref <ref>` worker with the v1 bootstrap plus `stage`, `module`, `recipeSha256` and `priorStages`, the prior-stages rows. On Modal this is `MODAL_FUNCTION_NAME`.
  - Locally, both use the thread-group isolation handshake.
- **Re-entry** (a Render retry of the same run, or a controller on another host):
  - The stage journal or, without one, the server row's call is adopted and never respawned.
  - A `spawning` journal without an ID, a claim without a token, or a recorded stage without a known call ends `submit_unknown` (stage row and job); the claim holds the slot for the operator path.
  - A journal call that differs from the server's is `needs_operator`.
  - A local child adopted after a controller restart has no observed exit code. Its thread group is proven gone, and the receipt it logged (valid for exactly this job, stage and module) is its result.
- **Budget**: the stage wall budget starts when the spawn is journaled. On overrun the call is cancelled with `terminateContainers` (Modal requeues a crashed container under the same call ID), or the local child is killed through its verified identity. A proven end is `failed (budget_exceeded)`. A cancel without a provably terminal result is `needs_operator`.
- **Outcome mapping**:
  - A cancel, deadline or budget ending is never a success.
  - Otherwise the receipt decides: `succeeded`, or `failed` with its code.
  - No receipt is `failed (receipt_missing)`.
  - A receipt the server refuses is `failed (receipt_rejected)`, recorded without it.
  - The local receipt is the last receipt-shaped JSON line (`schemaVersion`, `jobId`, `stage`, `status`) in the last 128 KiB of the stage's 0600 child log. Later log lines (the `sa_metrics` probe, stderr) are skipped. More than 128 KiB of output after the receipt reads as `receipt_missing`, which is truthful but lossy.
- A stage that cannot finish (unknown call, operator path, lost lease, unconfirmed evidence) stops the recipe. The task returns `{outcome: "recipe_run", stages, stopped}`.

**Journals** are keyed by (job, stage): `<stateDir>/<jobId>/<stage>/modal-journal.json`, or `.../journal.json` for the local executor. Each stage directory has its own token file, spawn reservation and child log.

**Run results:** a stage's run result is `{schemaVersion: 2, functionCallId, exitCode, receipt}`. The `receipt` must be valid against `jobs.stage-receipt.v1` for exactly that job, stage and module, and exit code 0 must go exactly with success; it may be `null`. v1 is accepted for `hand_pose_cpu_v1` and jobs without a recipe.

**Acceptance (SA-91):**

- A recipe job's succeeded result is `processing-result.v3`. Each segment or caption node must list exactly the files the slot policy attributes to its stage: none from elsewhere, none left out. A stage that lost its receipt still owns its uploads. The hand_pose node may list no earlier-stage file.
- A recipe job's failed result is the diagnostics-only v2 failure report (no clips, no outputs, no node check).

**Module policy** (`stageModuleRefusal`, `apps/jobs/src/config.ts`):

- A `localOnly` module (stub or replay) runs only with `APP_ENV=local` on the local executor, the `local_fixture_noop` pattern.
- The local executor runs CPU modules only.
- The Modal executor runs a module only with a deployed function binding, set in `MODAL_STAGE_FUNCTIONS="module@version=function,..."`. `hand_pose_cpu_v1@1` always uses `MODAL_FUNCTION_NAME`.

**Limits:**

- The workflow credential is not job-scoped, so it reads every job's prior stages, as with its controller actions.
- Real GPU modules and their Modal wrappers are SA-94 (T09).
- A real stub seal end to end is SA-100 (T15).

**Tests:**

- `apps/jobs/test/recipe.test.ts`: fake Modal and a contract-shaped stub API.
- `packages/server/test-integration/stage-runs.test.ts`, SA-91 cases: prior-stages attribution, orphan ownership, exact node attribution, the v2 recipe failure report.
- The SA-91 cases in `apps/jobs/test-integration/controller.e2e.test.mjs`: the official local runner, the real API and real stage children, controller loss during hand_pose, and route authorization.
