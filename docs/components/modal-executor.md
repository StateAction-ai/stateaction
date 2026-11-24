# Modal CPU executor (SA-42)

Source implementation of the Modal executor over the SAME `hand_pose_cpu_v1` Python core and the SAME shared controller (`apps/jobs`). **Nothing here has been deployed, built, spawned or billed**, and no real-provider canary exists: every statement about Modal's runtime behaviour below is either taken from the official documentation/SDK source (cited) or listed as an open canary item. Local development (`LocalExecutor`) is unchanged; production still rejects it.

## Shape

| Piece                                                                                                                | Where                                              | Credentials                                                                  |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------- |
| Discriminated settings (`local` or `modal`)                                                                          | `apps/jobs/src/config.ts`                          | none                                                                         |
| Controller driver (journal, one spawn, adoption)                                                                     | `apps/jobs/src/modal-controller.ts`, `journal.ts`  | workflow API capability + Modal token (controller service only)              |
| Provider seam `ModalClient {spawn, poll, cancel}`                                                                    | `apps/jobs/src/modal-executor.ts`                  | -                                                                            |
| Adapter over the official `modal` JS SDK (pinned)                                                                    | `apps/jobs/src/modal-sdk.ts`                       | `MODAL_TOKEN_ID/SECRET` from env, only here                                  |
| Thin processing wrapper (only module importing Modal)                                                                | `workers/processing/modal_app.py`                  | none; `restrict_modal_access=True`, `secrets=[]`, scrubbed child environment |
| Shared worker CLI                                                                                                    | `workers/processing/.../run_job.py`                | the one-time bootstrap token, from STDIN only                                |
| Recorded identity projection (`executionBackend`, `executionRef`, immutable `startDeadline` and `executionDeadline`) | `jobs.job-status.v2` (catalog.v12), `getJobStatus` | -                                                                            |

## Selection and the production guard

`controllerSettings()` never infers the backend. `EXECUTION_BACKEND=local` requires `APP_ENV=local` (development and production reject it, as before). `EXECUTION_BACKEND=modal` requires `APP_ENV=development|production`, explicit `MODAL_APP_NAME` / `MODAL_FUNCTION_NAME` (optional `MODAL_ENVIRONMENT`), `JOBS_STATE_DIR`, a non-loopback **https** `STATEACTION_API_URL`, and refuses `WORKER_PIPELINE` (only `hand_pose_cpu_v1` runs on Modal). `LocalExecutor` (`verify-platform`) still requires `APP_ENV=local` and `EXECUTION_BACKEND=local`, so it cannot run on Render. The admitted backend (`jobs.execution_backend`, delivered in `jobs.job-status.v2.executionBackend` and in the submission result) must equal `modal` before anything is submitted or spawned.

## State machine and ordering (one paid spawn per job)

`status -> record_workflow_run -> claim_lease -> record_worker_submission (token, once) -> journal intent (+ token file) -> journal spawning -> ONE spawn -> journal submitted (call ID) -> discard token -> record_execution {modal, fc-...} -> poll -> structured result -> provider_call_terminal evidence`.

- A spawn also needs the controller lease still held and BOTH immutable deadlines (the 10-minute worker start bound and the absolute execution bound) still ahead; otherwise it ends uncertain without a call. The local executor, symmetrically, refuses a job admitted to another backend (`backend_mismatch`) and a foreign Modal journal before any submission or spawn.
- Every provider operation is bounded (`apiTimeoutMs`; the SDK client is created with `maxRetries: 0` so it cannot retry a spawn RPC). The adapter checks the operation bound, controller lease and job deadlines immediately before invoking the SDK spawn. A lookup that finishes too late cannot start a call. If the adapter times out after invoking spawn, the SDK may still complete it. In either case the controller retains the `spawning` journal and never retries the spawn. The SDK client is closed when the controller entry settles.
- `spawning` is written **before** the spawn and carries no call ID. A spawn that rejects (including a lost acknowledgement), a missing or malformed ID, a controller crash at any point before the ID is durable, or a re-entry that finds `spawning` without an ID **never spawns again**: it ends in `mark_submit_unknown` (`submit_unknown`), keeps the slot, records no evidence. There is no spawn retry anywhere.
- A known call is **adopted**: from the controller's own journal, or (different instance, lost task-local disk) from the server's recorded `executionRef` in `jobs.job-status.v2`, together with the server's immutable `startDeadline` and `executionDeadline` (the six-hour execution bound is never substituted for the start bound). The projection is an identity only: absence never authorizes a spawn, and a mismatch between journal and server reference ends in `needs_operator` with no evidence.
- The worker-claim and controller-record race is preserved. `record_execution` is idempotent when the worker claim already set the same ID (`recorded:false`) and a different ID is a conflict (`needs_operator`, no evidence). The server's existing `COALESCE(execution_call_id)` / `recordExecutionRef` rules are unchanged.
- Leases, `record_workflow_run` fences, cancellation (`cancel_requested`), the start deadline and the immutable execution deadline keep their meaning. Output acceptance (SA-28) still decides the terminal business state; slot release still needs that state **and** this evidence.

## What counts as terminal (and what never does)

`provider_call_terminal` is recorded only when `FunctionCall.get()` **returns** the wrapper's structured result `{schemaVersion:1, functionCallId, exitCode}` whose `functionCallId` equals the recorded call (strict keys, small integer exit code). The wrapper returns it only after the shared CLI leader has exited and its whole process group/session is **proven empty** inside the container (bounded `/proc` scan with SIGKILL of strays); a permission error, an unreadable process table, a kill failure or a stray that will not die makes it raise and return nothing, so the controller stays uncertain. A descendant that escapes into a new session cannot be seen by this scan (the same limitation as the local executor). Everything else stays uncertain (`needs_operator`, admission slot retained, no evidence):

- our poll timeout (`TimeoutError`), a remote function timeout (`FunctionTimeoutError`), a cancelled or failed call (`RemoteError`), `InternalFailure`, any other SDK error, a lost connection, a value that is not our structured result, or a result for another call. Exception class and message text are never terminal authority; the adapter tests `TimeoutError` before `FunctionTimeoutError` only to label diagnostics (the SDK's deprecated `instanceof` shim makes a poll timeout also an instance of `FunctionTimeoutError`).
- `FunctionCall.cancel(terminateContainers=True)` is a **request**. After sending it the controller keeps polling for an observed structured result for `CONTROLLER_REAP_GRACE_MS`; without one it returns `needs_operator` (`call_not_provably_terminal_after_cancel`). Lease expiry, our deadline and a heartbeat are never proof.

## Operator recovery after a lost spawn acknowledgement

Recover the existing execution before retrying the job. The operator command
uses the scoped controller capability, an operator's Modal credentials and
`MIGRATION_DATABASE_URL` to check the original claim digest. Use a trusted
operator shell configured for the workflow's API origin and Modal environment.

1. Request cancellation using the existing job controls. Verify the exact job
   is in `cancel_requested`; it still holds admission. Record the original
   Render task run ID. Allow its controller lease to expire.
2. Use the Modal function's [call history](https://modal.com/docs/cli/latest/function#modal-function-calls)
   and the job's recorded intent window to identify the call ID. If more than
   one possible call remains, keep the case open until the provider evidence
   resolves the ambiguity. A missing call, timeout, cancellation response or
   provider error supplies no proof.
3. Run `pnpm --filter @stateaction/jobs recover-modal <job-id> --call <fc-id> --run <render-run-id>`.
   For a recipe job, pass `--stage segment`, `--stage caption` or
   `--stage hand_pose` for the issued stage. The command observes one Modal
   result. If the job never recorded a call ID, the result must also carry
   the wrapper's binding to this API origin, job, stage module and original claim. An older
   deployed wrapper can recover only an already recorded call. A matching
   result lets the command take the existing controller lease, attach the
   exact call, and record terminal proof. It never starts another call or
   sends a provider cancellation request.
4. Reconcile the cancelled request using Pipeline controls or
   `pnpm --filter @stateaction/server job-recovery reconcile <job-id> --expect cancel_requested`.
   Confirm the job is `cancelled` and admission is free before retrying.
   If the evidence response was lost, a recipe with an unsettled stage
   remains in `cancel_requested`. Check status, let the lease expire, and repeat
   the recovery command for the same call to settle the stage. The earlier job and its output prefix are kept.

The binding is a SHA-256 digest of the API origin, job UUID, stage, module and
SHA-256 of the original single-use claim token, joined with line feeds. The
wrapper returns the binding only after the process group has ended. The
command compares it with the binding derived from the immutable claim digest
in Postgres. Neither the claim token nor its digest appears in the provider
result or recovery output. The command reads the
structured result from the authenticated Modal SDK and the application's
recorded state. For an unknown call, use the intended workspace and the
deployed StateAction function's history to locate the candidate ID.

Deploy the controller version that reads the binding before enabling the new
Modal wrappers. When rolling back, return the wrappers to their prior version
before rolling back the controller. Keep dispatch disabled during the switch.

### Provider-confirmed failure before the worker starts

An issued recipe stage with a recorded Modal call can fail before its worker
claims the stage. In that case use the operator command from a trusted shell
with Modal credentials and `MIGRATION_DATABASE_URL`:

```sh
pnpm --filter @stateaction/jobs recover-modal <job-id> --call <fc-id> --run <render-run-id> --stage <stage> --pre-entry
```

The operator tool queries Modal for the exact call's input count, terminal
output and call graph. It requires one matching input, zero unfinished inputs,
no assigned task, no start time and no retry. Only Modal's `INIT_FAILURE`
and `TERMINATED` statuses qualify. A `RemoteError` on its own leaves the
slot held. The ordinary controller continues to require its structured result.

The database confirms the original workflow run, an expired controller lease
and the exact latest stage call with an unconsumed claim. It rejects an
existing result candidate. One transaction records the provider proof, marks
the stage `failed` with `startup_failure` or `terminated_before_start`,
and settles the job. The admission trigger releases the slot only with exact
proof for every issued stage. A previously requested cancellation stays a
cancellation. Repeating the exact operation keeps the original evidence and
does not dispatch anything.

## Wrapper and image

`modal_app.py` defines a finite CPU function: `cpu`/`memory` request=limit, `ephemeral_disk`, `timeout`, `retries=0`, `max_containers=1`, `min_containers=0`, `single_use_containers=True`, `nonpreemptible=True` (a preemption would otherwise restart the same input; it is billed at 3x CPU/RAM), `restrict_modal_access=True`, `secrets=[]`, no GPU. The wrapper's own deadline is below the Modal timeout so a hung CLI is killed and a result still returned. The sizing values (4 CPU, 8 GiB, 50 GiB scratch, 6 h timeout) are **candidate ceilings, not measured requirements**; no run has measured CPU, memory, scratch or duration, and they must be re-derived from a separately authorized canary. Budget note: `nonpreemptible=True` bills CPU and memory at 3x the list price (Modal documentation), so any spend estimate or workspace spend cap must include that premium; the ceilings above times the premium are an upper bound per call, not an expected cost. This source is **not qualified** and must not be called production-ready.

The controller passes one JSON string argument (the scoped bootstrap: API origin, job ID, one-time token, pipeline). The wrapper adds `executionRef = modal.current_function_call_id()` and `executorKind: "modal"` (the controller cannot know the ID before the spawn) and pipes it to `python -m stateaction_processing run-job --execution-ref <id>` on STDIN. The child environment is built from an allowlist (`PATH`, `HOME`, `PYTHONPATH`, model/contract/revision pins); no Modal, database, R2 or Render value reaches it. The CLI still claims **before** importing the pipeline or reading a source, sends `executor {kind: modal, functionCallId}`, rejects a kind/reference mismatch, a non-https or loopback API origin and any pipeline but `hand_pose_cpu_v1` on Modal.

Image pins: locked wheels from `uv export --locked` of `workers/processing/uv.lock` (hashes kept) via `pip_install_from_requirements`; in-repo worker, `stateaction-contracts` and capture-contract directories added with `copy=True`; the hand model fetched at build and verified against the `hand_model.json` SHA-256; `STATEACTION_CODE_REVISION` and `STATEACTION_IMAGE_SPEC_SHA256` (the admitted build-spec digest) baked from the deploy environment. Deploy fails closed without `STATEACTION_LOCKED_REQUIREMENTS`, `STATEACTION_CODE_REVISION` and `STATEACTION_IMAGE_SPEC_SHA256`. Before reading any source, a Modal run compares the baked code revision and build-spec digest with the claim grant, checks the pinned model digest, and hash-verifies the actual model file; any mismatch fails the run (`E_RUNTIME_IDENTITY_MISMATCH` / `E_MODEL_DIGEST_MISMATCH`).

**Provenance.** `PROCESSING_IMAGE_SPEC_SHA256` stays the operator-supplied, admitted build-spec digest delivered to the worker through the claim grant; it is **not** a Modal image ID and the controller/wrapper neither compute nor compare it (the CLI `artifact_cli` fallback hashes `uv.lock` only, which is a different definition). The real Modal image ID is not recorded anywhere yet. Modal accepts `python_version="3.12"` only, so the patch level (3.12.13 in `config/platform-toolchain.json`) is not pinned on Modal.

## Recipe stages (SA-91)

The same driver runs one recipe stage at a time (`driveModal` with a stage):

- It uses the stage journal (`<stateDir>/<jobId>/<stage>/modal-journal.json`) and the stage claim token (`issue_stage_claim`).
- It writes the stage run row (`record_stage_run`) in place of `record_execution`, and adopts the server's stage call.
- It expects a v2 run result with the stage receipt, and cancels on stage wall budget overrun.

Function and bootstrap per stage:

- **Segment and caption:** the function per module comes from `MODAL_STAGE_FUNCTIONS` (`module@version=function`, or `module@version=app/function` when the function lives in another Modal app than `MODAL_APP_NAME`, as the FLORA GPU functions do), and the spawn argument is the stage bootstrap v2.
- **hand_pose:** stays `MODAL_FUNCTION_NAME` with the `run-job` v1 bootstrap plus `stage`, `module`, `recipeSha256` and `priorStages`. The SA-92 wrapper returns v2 with the receipt; a v1 return is still accepted and recorded `failed (receipt_missing)`.

The Modal wrappers for the GPU modules are SA-94. See [Job orchestration](job-orchestration.md#recipe-stage-runner-sa-91-appsjobs).

## Credential placement

Web: no Modal setting. Repair cron: only `STATEACTION_API_URL` and `REPAIR_CAPABILITY_TOKEN`. Workflow controller: `CONTROLLER_CAPABILITY_TOKEN`, `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET` (`sync: false`), plus non-secret `MODAL_APP_NAME`, `MODAL_FUNCTION_NAME`, `JOBS_STATE_DIR`. The processing container: nothing but the call's bootstrap. `infra/test/blueprint.test.mjs`, `apps/jobs/test/modal-config.test.ts` and `workers/processing/tests/test_modal_app.py` assert this.

## Tests (no provider)

`apps/jobs/test/modal-controller.test.ts` (fake Modal + contract-shaped stub API: exactly one spawn, journal-before-spawn, lost acknowledgement, crash before ID, journal and server adoption, claim-before/after-record, mismatched IDs, cancel pending vs terminal, failure vs poll timeout vs function timeout, deadline, backend mismatch), `modal-sdk.test.ts` (adapter against a fake SDK), `modal-config.test.ts`, `workers/processing/tests/test_modal_app.py` and `test_run_job_modal.py`, the `jobs.job-status.v2` conformance fixtures and policy tests. These are local simulations, **not** Modal qualification.

## Not proven (real-provider unknowns, canary required before enabling production)

1. The real call ID format (the contract assumes `fc-` plus alphanumerics up to 80 characters).
2. Whether `cancel(terminateContainers=True)` physically stops the container, how fast, and whether a cancelled call ever yields an observable result (the SDK documents it only as a request; until proven, a cancelled call without a result stays `needs_operator`).
3. Behaviour when a spawn is acknowledged late or lost (no documented idempotency key); preemption/retry semantics with `nonpreemptible=True` and `retries=0`.
4. Cold-start dependencies of the image (mediapipe shared libraries, size, time against the 600 s start deadline).
5. Retention and visibility of the spawn argument (the one-time bootstrap token transits and may be stored inside Modal as a call input until expiry); the token is single-use and expires, but this is not "memory only".
6. Cost receipt and workspace spend cap; Python patch-level reproducibility; the JS SDK is Beta (pinned `modal@0.11.1`, verified against its published source).
7. Egress from Modal to the Render API origin and R2 signed URLs; Render task-local disk persistence across a native retry (a lost journal falls back to the server-recorded call, then to `needs_operator`).
