# Workflow jobs and processing execution

Selected MVP design · 2026-10-30 · Planned, not implemented or deployed

**Use Render Workflows locally and in production, with exactly two Node tasks.** The official local task server executes the same task definitions that Render hosts. `EXECUTION_BACKEND=local|modal` selects local Python execution or private Modal Functions. Postgres `jobs` rows retain business state; no separate outbox, general DAG, Lance/Curator or independent validator is needed.

[Contracts](../contracts.md) owns task/result schemas, service routes and state names; [processing](cloud-processing.md) owns model/data details; [uploads](mcap-upload.md) owns source/output multipart transfers; [local development](local-development.md) owns setup and the test ladder.

## Two fixed tasks

| Render task / job kind | Worker sequence | Completion |
| --- | --- | --- |
| `process-recording` / `process_recording` | Stream/hash each sealed source once with a non-seeking MCAP reader; progressively decode bounded frames; run MediaPipe CPU hands; generate bounded RGB/overlay previews, exact frame mappings, 21-point arrays, native evidence and inline QC; upload outputs/result manifest | API selects an immutable result for staff review |
| `export-release` / `export_release` | Read the frozen approved result/label selection; write one complete TAR (maximum 32 GiB total) to scratch, close/hash it, upload through the output API, then submit the release manifest | API marks `ready`; fresh staff publication remains separate |

Hand inference is required. Image landmarks and clearly labeled 3D estimates carry masks/provenance; they are not verified metric trajectories or robot actions. Missing/no-visible-hand frames stay explicit. Use the small qualified CPU model first; a GPU profile is a separate quality/rights/resource decision, never an automatic upgrade.

The processing worker streams raw source once per attempt through a hash wrapper and non-seeking MCAP reader. Inference may run before the final source hash is known; any mismatch rejects the entire candidate. Do not stage the full raw recording on scratch. It streams observations/shards rather than retaining a whole recording's depth arrays. Manual retry starts again in a fresh job prefix. Export reuses accepted derived data and freezes the reviewed versions; it does not rerun inference or stream an unknown-size archive into a presigned upload.

## Task definition and dispatch

Pin `@renderinc/sdk` **1.6.0**, inspected read-only for this design. Register the two module-level `task(...)` definitions in `apps/jobs`; its entrypoint statically imports both. The TypeScript SDK starts its task runtime on Render automatically. Keep provider connections/heavy work out of module import. [Task definition](https://render.com/docs/workflows-defining), [published SDK](https://registry.npmjs.org/@renderinc%2fsdk/1.6.0)

Both use `plan: 'flex'`, `timeoutSeconds: 28800` and `retry: { maxRetries: 2, waitDurationMs: 10000, backoffScaling: 2 }`. An eight-hour controller covers the six-hour processing/one-hour export limits plus startup/finalization allowance. The absolute job deadline is anchored to first admission and never reset by controller retry. There are no planned continuations, dispatch generations or per-stage tasks. Render supports up to 24 hours per task. [Runtime/retries](https://render.com/docs/workflows-defining)

The API creates a unique job with the domain change in one transaction. Serialize global admission so **one processing/export execution** is admitted; other jobs remain queued without idle billed controllers. Commit the fixed dispatch key `job:{jobId}` before the initial bounded, awaited SDK start:

```ts
const started = await render.workflows.startTask(taskRef, [{ jobId }], {
  idempotencyKey: `job:${jobId}`,
  signal: AbortSignal.timeout(2000),
});
```

Save the returned run ID conditionally. An aborted/lost acknowledgement leaves the durable job pending dispatch; it does not undo admission or start processing again. A finite minute cron invokes the scoped reconciliation API to repair undelivered task requests and abandoned control. The API alone holds the Render dispatch credential; cron holds only its reconciliation API token, with no Render, Modal or database credential. Network calls occur outside database transactions; no post-response background launch. The SDK uses the local endpoint in development and Render in production. [SDK reference](https://render.com/docs/workflows-sdk-typescript)

The provider deduplicates a task key for 24 hours and ignores changed repeated input. Keep our own immutable job/input digest and permanent terminal/lifecycle checks. Pin cloud task references to the deployed version; configure local task names separately. Do not depend on identical local-server deduplication or persistent history. [Run-task contract](https://api-docs.render.com/reference/createtask)

## Durable state and controller recovery

One `jobs` row represents one intentional processing attempt. Store kind/target, input/profile/code/model/config references, execution backend, fixed deadlines, dispatch key/task reference/run ID, controller nonce/lease, worker submission intent/execution reference, worker nonce/token hash, candidate manifest and outcome/cancellation/retry linkage. A manual processing retry creates a new row/prefix linked to its predecessor; controller retries retain the same job and worker.

At task entry, use `ctx.metadata.taskRunId` to identify the actual Render run, repairing an acknowledgement lost by the submitter. Claim a 120-second controller lease with a fresh nonce; renew roughly every 30 seconds and check it on control effects. A native retry of the same Render run waits for its old lease to expire before resuming. A different duplicate run exits without effects when a live owner exists. Worker claims/heartbeats depend on their own job/invocation identity, not the controller lease.

The current SDK has metadata and `TaskContext.run()`, but no verified saved-step/suspended-sleep primitive. Poll approximately every 30 seconds with bounded requests; RAM remains billed while waiting. Recovery reloads the job and known execution, not process memory. Native controller retries never authorize a second worker submission. [SDK context](https://render.com/docs/workflows-sdk-typescript)

After controller retries are exhausted, surface `needs_attention` and retain global admission/cost accounting until the execution is known terminal. An operator inspects/cancels the exact call in Modal (or resolves the local child), then records authoritative terminal evidence through the staff reconciliation operation before a manual processing retry. Cron cannot perform this Modal operation because it has no Modal credential. Do not invent a new dispatch key to bypass the provider's failed run or assume a lost local run is proof its child stopped. No automatic GPU/model upgrade or processing restart is allowed.

## Submit, run and accept once

1. **Reserve/submit.** Check ownership, source/selection, model rights, bounds and budget. Persist worker submission intent before one executor submission; save its execution reference. Lost acknowledgement is explicitly unknown, never a reason to submit again.
2. **Claim before heavy work.** Each physical worker invocation creates a fresh nonce and calls the job API with its private bootstrap capability. The API checks current job/backend, lifecycle and a ten-minute start deadline. Modal reports `modal.current_function_call_id()`; local execution reports its local handle. This can repair a missing execution reference. Duplicate/replayed workers exit before model imports, downloads or output allocation.
3. **Execute/report.** Receive authoritative task configuration and scoped input/output access. Heartbeats report progress without extending hard deadlines. Upload files through API-allocated one-shot multipart sessions and propose a small candidate containing manifest file ID/hash, never arbitrary URLs or arrays.
4. **Finalize.** Reconcile executor completion and all referenced completed files. The API checks manifest schema, expected job/input/model/config, required files, bounds and active lifecycle, then conditionally selects the result. Inline QC is trusted producer evidence, not independent pose validation. API hosts do no inference, archive creation or bulk hashing.

Controllers use authenticated control API operations; workers have their separate job-scoped capability. Database/storage issuer authority stays in the API. Modal credentials belong only to the authorized Workflow runtime, never the API cron or media workers. A failed controller without terminal worker evidence remains operator-visible; reconciliation cannot approve it from an untrusted callback alone. [Access](auth-and-access.md)

## Executors, uncertainty and cancellation

`LocalExecutor` and `ModalExecutor` share `submit`, `poll` and `cancel`, worker task/result contracts and the HTTP multipart protocol. Local execution is a Python child process owned by the task; Modal execution is a known private Function call. Local restart limitations are explicit in [local development](local-development.md).

Use the pinned `modal` Node SDK: look up the private Function; `fn.spawn([taskInput, bootstrapToken])`; save `functionCallId`; later reconstruct with `modal.functionCalls.fromId(id)` and `get({ timeoutMs: 0 })`. Bootstrap is separate from durable task manifests. Poll `TimeoutError` means pending; `FunctionTimeoutError` means the worker exceeded its execution timeout. Other errors require classification, not respawn. Persist result candidates promptly because spawned-call results expire after seven days. [Function](https://modal.com/docs/sdk/js/latest/Function), [call/error semantics](https://modal.com/docs/sdk/js/latest/FunctionCall), [errors](https://modal.com/docs/sdk/js/latest/Errors), [call identity](https://modal.com/docs/sdk/py/latest/current_function_call_id), [retention](https://modal.com/docs/guide/job-queue)

Application-level Modal retries are zero, but container crashes can still trigger provider rescheduling. Fresh invocation claims and avoiding heavy global startup are necessary. Unknown submission without a claim/call ID requires deadline expiry and provider inspection; silence or heartbeat loss proves neither termination nor zero cost. [Crash behavior](https://modal.com/docs/guide/retries)

Cancellation blocks new claims, output signing and acceptance immediately. While its controller is available, cancel the known execution best effort and reconcile uploads/costs. After exhausted controller retries, operator-assisted inspection/cancellation and API recording of terminal evidence handle cleanup. A deadline or expired lease never releases uncertain compute admission. Delayed callbacks cannot reopen work or replace newer results.

Output immutability uses transport rather than a writer-grant ledger: unique keys, API-controlled CompleteMultipartUpload, no worker prefix write credential and no reuse of completed keys. Consumed upload IDs prevent stale part URLs overwriting completed objects. Accept only closed files allocated to the job; reconcile uncertain completion and abort unreferenced uploads. Qualify this behavior on R2. Staff review/publication and customer delivery remain separate permissions. [Upload contract](mcap-upload.md)
