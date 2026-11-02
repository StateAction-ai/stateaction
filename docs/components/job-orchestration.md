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

`admitNextJob` picks the oldest eligible queued job (current recording pointer, active owner permission covering processing, collector role), writes `job_inputs`, takes the slot, then moves the job to `submitting` with the fixed dispatch key `job:{jobId}`, backend and absolute deadline (`admitted_at + 6 h`, never reset). All of this commits before any external effect. Queued jobs hold no controller or compute. `listPendingDispatches` returns admitted jobs whose Render task start was never acknowledged; SA-26 retries `startTask` with the same key and saves the run with `recordWorkflowRun`.

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

## Remaining design (not implemented here)

The Render Workflows controller, executors, reconciliation and operator evidence recording UI (SA-26/SA-27), output acceptance and terminal business transitions (SA-28), and the export job remain as in the selected MVP design: one Node task `process-recording` (`plan: 'flex'`, 8 h timeout, finite retries), idempotency key `job:{jobId}`, a Python local child or private Modal Function behind `LocalExecutor`/`ModalExecutor`, and no automatic resubmission after an unknown submission.
