# Hosted job recovery qualification

SA-44 covers the real Render workflow, Modal worker and private R2 output path.
Run each fault once against a designated fixture and record the resulting
provider and application state.

## Before starting

1. Record the live web deploy ID and revision, default workflow version, cron
   state, dispatch setting, and existing Modal apps. Confirm the shared
   admission slot is free and the queue has no other eligible jobs. Keep the
   repair cron suspended and invoke individual repair passes with its scoped
   capability. A repair pass can admit any eligible recording.
2. Use the dedicated workflow-run key for web-to-Render dispatch. Put Modal
   credentials only on the workflow and use fresh, scoped controller and
   repair capabilities. Verify the deployed revisions implement the same job
   and output contracts. Follow the credential placement and rollback steps
   in [Render deployment](render-deployment.md).
3. Use a synthetic capture or Fraunhofer IPK's approved [299-second IndEgo
   clip](https://huggingface.co/datasets/FraunhoferIPK/IndEgo/blob/main/2_Inspection_Repair/mp4_480/User_15_410_0511_1_480.mp4)
   ([CC BY 4.0 dataset](https://huggingface.co/datasets/FraunhoferIPK/IndEgo)).
   The existing fixture tools produce `h264_mcap_simulation_v1`, which Render
   admission rejects. A supported hosted fixture path must preserve the
   public or simulated origin, original source hash and frame timestamps.
   To pin the fixture UUID used by a scoped hosted canary, pass
   `--recording-id <uuid> --camera-label IndEgo.User_15_410_0511_1_480` to
   `workers/processing/tools/mp4_to_sim_mcap.py` when preparing a new fixture.
   Bind its resulting MCAP digest in the allowlist. Reuse already pinned
   canary files byte for byte. Keep media and raw payloads out of Git.
4. Before deploying a worker or issuing a start, check current gross Modal
   usage and reserve for other authorized runs. Record each job's
   `max_job_cost_usd` in the canary ledger and its `maxJobCostUsd` in the recipe
   if it uses one. Bound exposure independently with the provider timeout,
   configured retries, concurrency, and a finite number of planned calls.
   Include image builds, container restart exposure and storage in the
   estimate. The ticket ceiling is USD 10 within USD 25 overall. Stop before
   a call whose reserved charge would exceed either remaining balance.
5. Scope injection to the exact fixture and keep a provider-side record that
   survives the injected loss. Before any test that may hold the only slot,
   verify how the operator can recover the exact execution reference and submit
   supported termination evidence. If that path is unavailable, keep the case
   blocked. See [job orchestration](job-orchestration.md) and the
   [Modal executor](modal-executor.md).

## Fault matrix

| Case                            | Injection                                                                                                                                                                                                                                                                                                                            | Required observation                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Render start acknowledgement    | Pause the fixture controller before it records the workflow run ID. Drop the first response after Render accepts the start, then issue one repair pass while deduplication is valid. Resume the controller after observing the repeat request.                                                                                       | Capture both outbound starts with the same dispatch key and one Render run ID. That run binds to the job, which gets one submission intent and at most one worker execution.                                                                                                                                                                                                        |
| Controller retry and exhaustion | Interrupt one task attempt after it records the Modal call ID. On a separate fixture, fail each bounded controller attempt after recording the Render run ID and before worker submission intent.                                                                                                                                    | The retried controller adopts the same Modal call ID. The exhausted job has no call or intent and releases the slot only with `pre_submission_rejected` and `controller_exhausted`.                                                                                                                                                                                                 |
| Duplicate physical claim        | Exercise two physical invocations with the same fixture bootstrap, and record the distinct execution IDs.                                                                                                                                                                                                                            | Only one invocation receives a grant or signed URLs. The claim nonce and execution reference remain fixed.                                                                                                                                                                                                                                                                          |
| Seal and delayed callbacks      | After the inventory seals, attempt a new allocation and replay the completion of an already-completed file. Send a delayed result from a cancelled or superseded job. Also exercise the exact current claimant's sealed result within the evidence-first grace period.                                                               | Post-seal writes and stale or cancelled results are refused. A valid late result within the documented grace can still be accepted once. Stored output inventory and accepted clips reflect only the authorized candidate.                                                                                                                                                          |
| Cancellation, timeout and retry | For both cancellation and timeout, queue a second eligible fixture and issue a bounded repair pass before terminal evidence becomes available. Attempt retry while the slot is held. After settlement allow the second fixture to admit and settle, then retry a terminal failed or cancelled fixture and replay that retry request. | Repair reports `slot_busy` for the original slot holder, the second fixture stays queued with no dispatch, and retry is refused. Admission resumes only after terminal business state and exact execution evidence. A successful retry and its replay identify one new job and output prefix. Compare previously accepted immutable clips and their object hashes before and after. |
| Modal spawn acknowledgement     | Pause the fixture worker before it makes its claim, which could otherwise persist the call ID. Drop the response after Modal accepts one spawn and record the ID outside the controller. Exercise re-entry before either the job or controller journal knows the ID.                                                                 | Observe unknown identity on re-entry, one provider call, a held slot and no inferred termination. Release the claim barrier and use the verified operator path to recover the exact call and proof before settlement.                                                                                                                                                               |

Keep a successfully completed fixture as the immutable baseline. Exercise
retry on the separate failed or cancelled fixture, since the control route
refuses retry on an accepted successful job.

For each row record the fixture recording and job IDs, Render version and run
ID, task attempt numbers, Modal app and call IDs, and UTC timestamps. Save
before and after state for the recording pointer, job, slot, execution
evidence, sealed file inventory and accepted clips. Record R2 object identity
and hashes where the row touches storage, with no signed URLs. Include the
HTTP outcomes, provider duration and gross cost or a clearly labelled estimate
with its price basis. Reconcile delayed billing before closing the ticket.

Stop dispatch and compare the hosted settings to the preflight snapshot even
if a case fails. Restore the prior web and workflow configuration and cron
state, stop only the canary apps, verify call termination, and verify that
there are no queued or orphaned canary executions. Preserve the evidence and
any accepted immutable data.

## Preflight result, 2026-11-24 UTC

Render web deploy `dep-dc2cocrrjlhs73caf1jg` served HTTPS with the database,
storage and jobs health checks passing. Dispatch settings were absent and
repair cron was suspended. The default workflow version
`wfv-dc2bspt9fdbs73b5485g` was ready and had no task runs in the returned
history. The workflow environment had no Modal credential entries or
stage-function bindings. Modal listed no deployed or running apps in the
selected environment.

All hosted matrix rows are pending. This preflight started no runs, spent
USD 0, and made no service changes. The live run needs a dedicated Render
workflow-run credential, bounded Modal workers, a supported hosted fixture
admission path, and a way to settle the exact execution after acknowledgement
loss. For that last step, use the
[operator recovery command](modal-executor.md#operator-recovery-after-a-lost-spawn-acknowledgement)
on a deployed version that returns the call binding. Recipe-specific cases
also need hosted recipe selection. The existing
recipe override is local-only.
