# SA-142 selective stage reruns

## Execution and lineage

Staff choose a terminal parent from the same recording, one stage, and either “Re-run this stage” or “Re-run from here.” Each confirmation creates a new job. Its immutable plan records the direct parent, actor, reason, selected stage, scope, execution set, module references, resolved parameters, expected source and reuse identities, rate revision, and confirmed budget. Use `jobs.derived_from_job_id` with a same-recording foreign key. Keep `previous_job_id` for recovery retries. A retry of a failed derived job must preserve its exact partial plan and pass reuse and fresh spend checks, or use the stage-rerun action to confirm a new attempt. The existing full retry route must never turn a partial job into an implicit full run.

Use the parallel recipe graph for new derived jobs. `segment → caption` is the data edge. `hand_pose` is independent and the seal waits for all stage dispositions. “From here” follows enabled descendants. “This stage” is unavailable when an enabled descendant would need recomputation, even if the old output might happen to match. Thus segment-only is unavailable with caption enabled, segment-from-here runs both, and hand-pose-only runs hand pose. Caption-only requires successful reusable segments with at least one accepted segment. The plan lists disabled stages and inherited non-success states separately. An inherited failure remains a failure with its source evidence. Missing required successful outputs block the plan. If hand pose is required to build a result and there is neither a usable successful parent result nor a selected hand-pose run, explain that the requested scope is unavailable.

Store one immutable `job_stage_reuse` row per inherited stage disposition, with its immediate source, original execution (resolved through the parent chain), original receipt and digest where present, fingerprint and child output mapping. Only validated successful evidence is labelled “Reused.” Preserve failed or skipped dispositions with their original status and reason. Successful reuse never creates a stage claim, call ID, execution evidence or `job_stage_runs` row for the child stage. Enforce disjointness between inherited and executed stages under the job row lock. A confirmed plan can be shown as pending preparation until verification completes. The SQL and controller projections should read the same effective graph and dispositions. The existing one-claim-per-stage and unknown-submission rules still apply to actual executions.

The journal defines three stages. The ticket’s example mentions `cpu_unit`, which has no journal row in this baseline. The UI shows the steps and receipts actually recorded, including the CPU hand-pose execution when selected.

## Reuse identity and artifact ownership

Use SHA-256 over versioned canonical JSON. The fingerprint includes stage, module and version, resolved parameter digest, pinned producer identity (model, revision, weights, quantization, prompt and decoding where applicable), source manifest and verified input artifact identities by role, and input-affecting runtime/format revisions. Include a GPU setting if it changes the declared computation. Keep observed GPU provenance with the original receipt. Treat GPU execution as potentially nondeterministic. An equal fingerprint identifies the same declared inputs and configuration. It does not predict equivalent output across executions. An explicit rerun always executes its selected stages even when a fingerprint matches.

For an existing parent without a stored fingerprint, reconstruct it from its immutable admitted task and recipe, stage receipt, and verified output provenance. Check that the evidence agrees, including output role, slot, byte length and digest. Older runs with insufficient evidence are unavailable for reuse. Support a failed terminal parent with independently successful stages and completed files by checking its exact termination and verifying those files and receipts, even if the full result was never accepted. Reject any live or unresolved parent, deleted recording, changed source, lost processing permission, or missing required source or reusable object. A valid hosted parent must pass these checks using its retained evidence.

Reserve child-owned slots and immutable storage keys before copying. Use bounded server-side copy for ordinary objects and bounded multipart copy for large objects such as hour-scale `recording.mp4`. Verify source and destination size and SHA-256 with the storage verifier, including on the local stub storage. Bind plan identity to stable file IDs, roles and digests. The plan can check object presence without hashing large objects in the request. After admission, the lease-fenced controller materializes and verifies the retained inputs before issuing any selected stage claim. Keep object I/O outside DB transactions.

Add a controller-only prepare action authorized by the current workflow lease and admission slot. Its SQL reservation function locks the child, verifies the immutable confirmed reuse plan and same-recording source slot, and reserves only the child ID, slot, role, size, digest and storage key recorded in that plan. The file and slot guards allow an output reservation during `submitting` only for an exact matching server-owned preparation reservation. The app role cannot write preparation reservations directly, and worker output routes keep their current running-job and stage capability checks. A second lease-fenced SQL operation records completion of a matching reservation after both hashes pass. Stage claim issuance is refused until every reservation is complete and the effective reuse records exist. The claim guard also rejects stages outside the immutable execution set even if a controller ignores the API projection.

Resume from the same reserved slots and verify existing copies. Persist the multipart upload ID and exact part receipts, or discard that incomplete upload and restart within the copy allowance. Use lease-fenced object generations where a stale worker could otherwise overwrite bytes already accepted. Recheck the lease and active job after each bounded storage operation and before publishing a verified copy. Abort abandoned multipart uploads and reclaim their uncommitted objects through scoped cleanup. Missing or mismatched bytes stop the derived run with `reuse_unavailable`, preserve the selected result and leave unused stage calls unissued. Do not fall back to execution. Once verified and copied, the derived job can read its own files independently. Keep parent catalog/receipt lineage with recording history. Keep parent bytes through copy verification and while the parent itself is reviewable under the existing retention and recording deletion policy. A new rerun from a pruned parent is unavailable.

Copied segments, captions and hand-presence JSON retain their original embedded `job_id` and digests. Acceptance and the caption worker and `annotations.ts` should allow the originating job ID only when a server-validated reuse mapping binds that exact child file, role and digest to the original job on the same recording and source. Pass that producer ID in a versioned caption input and derive it server-side. Fresh documents still bind to the child. Caption JSON must name the digest of the child-owned segments bytes it consumed. Never rewrite copied producer documents or receipts. Publish `http.recording-annotations.v3` for derived results. Its cross-field rule binds embedded annotations to per-file producer identities and binds the DAG and review context to the child result. The v1 rule still requires the embedded job ID to match the response job ID.

The child publishes a new result manifest and inventory. Copy the reusable clip, video, hand-presence and necessary diagnostic artifacts. Do not copy the parent’s result manifest or prepared manifest as the child’s authority. For hand-pose execution, preserve worker prepare-and-seal behavior. When hand pose is reused, rebuild the child manifest from accepted parent hand facts with child file IDs and child clip IDs, and record server assembly and original hand provenance in a versioned manifest. Tie closure and submission to the actual child job claim identity, current controller lease, settled effective graph and verified inventory. The existing `job_seal_nonce` and output, closure and candidate guards assume a hand-pose claim. Add a derived-job-only server seal path for the reused-hand case, anchored in an actual claimed selected stage with exact terminal execution evidence. The controller alone can use it. Worker capabilities, original attestations and result acceptance remain independently checked. The original hand call cannot attest a child invocation. Frame-map and hand-observations sidecars also keep the producing job and clip IDs. Record original job and clip IDs against the exact child clip, sidecar roles and digests in the v4 manifest and validated catalog copy map. Update the artifact reader to check those identities for reused clips and to keep the existing child-identity check for freshly executed clips. Catalog and viewer links always address the child clip; source frame IDs and timestamps remain unchanged. If no selected stage can claim or reach a sealable disposition, fail explicitly and keep the prior result. No fake hand worker or synthetic provider evidence.

## Admission, spend and lost acknowledgements

Reuse normal queued admission, the global slot, the one-live-job-per-recording constraint, and existing execution evidence and release. Under the recording lock, switch `recordings.current_job_id` to the child and set `processing` on enqueue. Eligible non-deleted recordings can have an accepted result or an earlier failed processing run as long as the source is still eligible and the live pointer has settled. Review reads remain available from the selected result while a child is processing or after it fails. Use the existing result acceptance transaction to record selection changes. Normal recovery handles termination after a claim. A preparation failure before any claim is a proven pre-submission failure and follows the existing release path.

Use executed stage budgets plus the normal admission margin, with the existing minimum and maximum. Include copy and verification within the margin, bound them independently, and refuse plans that exceed caps. Reused stages add zero execution budget. Estimate duration from comparable stage timings when present, with stage execution bounds and copy bytes shown separately. Display unknown when a defensible estimate is missing.

Use the versioned operator rate card pattern in `packages/server/src/ops/cost.ts` for estimates. Keep module requirements in the module manifest. The spend log records actual spend. Calculate admitted CPU, storage and GPU bounds separately, with decimal arithmetic. Use the provider billing granularity, resource maxima, billable time and any requeue or shutdown allowance. Display the estimates and the job ceiling separately.

Store operator-authorized ceilings as records with approval reference, environment, amount and expiry. Keep one reservation per confirmed job under the selected authorization row. Confirm locks that row, checks its remaining ceiling, and reserves before enqueue commits. Release only unused capacity proved by never-submitted evidence or by exact terminal calls and attributable metering. An unknown or unmetered call keeps the reservation charged at its ceiling until reconciliation. The CPU-only case has a zero GPU ceiling and no GPU allowance.

Bind each selected stage in the confirmed plan to its deployment revision, provider function ID, environment and approved resource envelope. Inspect the actual immutable function identity and its resources before issuing the stage claim. Carry that same identity to the spawn adapter, which must use the verified function handle or a provider-supported immutable lookup. A second lookup by mutable name after the check would allow a different function to run. A missing or mismatched binding is refused before spawn. Apply this check to the hosted CPU binding as well, including the hand-pose-only proof. A GPU binding is unavailable when the provider cannot establish the upper bound or no authorized capacity is available.

Planning reads the catalog. In hosted development read-only mode, both planning and confirmation return HTTP 403 before loading processing settings. Confirm resubmits the original plan inputs, expected digest and cap. Under the recording lock, staff authorization, current eligibility, reuse metadata, stage configuration, rates and cap are rechecked. A mismatch requires a new preview and confirmation. Use the client request UUID as child job ID. Before mutable eligibility checks, an authorized replay matching actor, recording, parent and the full normalized confirmed request returns the existing child, including after it settles or stops being current. Return a conflict on a payload or identity collision. One transaction writes the immutable confirmation, job and live pointer. Queue and controller re-entry resume the same job. An unknown provider acknowledgement never permits a second stage spawn.

## Result selection and marks

Create append-only `recording_result_selections` with recording, per-recording sequence, accepted job, actor, reason and timestamp. Serialize inserts under the recording lock. Seed existing accepted results from the current successful result or, where the current job is already failed, the latest accepted result for that recording. Keep the live pointer independent. Non-derived acceptance keeps the existing latest successful result behavior. For a derived child, auto-select after acceptance only if the selection revision is unchanged from confirmation and the child preserves the usable stage results of the selected run, with no newly failed stage or worse recorded failure counts in comparable annotation outputs. A refused/cancelled/failed child never replaces the selection. A successful child that was not auto-selected remains in history. Staff can explicitly select an accepted job with an expected selection sequence. Preserve existing authorization and deletion checks, including on direct history links. Keep existing dataset membership and publishing rules while switching selection-dependent reads to the selection. A staff history link cannot change customer or dataset access to that job's clips.

Keep marks pinned to the original `(job_id, segments_sha256, segment_id)`. Read inherited marks through the proven reuse chain when the segment bytes are the same, displaying the marking run and allowing a child-local Good or Issue to take precedence. The response gives the origin and display revision separately from the job-local write revision, which starts at zero on the child. Store new marks against the child-owned segment file with the existing revision guard. Keep the current Good/Issue actions. If segmentation runs again, show the old marks on the historical result and report that they belong to it. Do not migrate marks by matching segment IDs, time ranges or coincidentally equal digests.

## Contracts and UI

The original recording-level plan, confirm, history and result-selection contracts are under `/api/v1`. The current console uses `POST /api/v2/recordings/<recordingId>/stage-reruns/plan` and `POST /api/v2/recordings/<recordingId>/stage-reruns` for retry planning and confirmation. Carry `requestId`, the plan inputs, `expectedPlanSha256`, `expectedMaxGpuCostUsd` and a reason on confirmation. Return 201 for a new child and 200 for exact replay. Refusals include `plan_changed`, `recording_busy`, `reuse_unavailable`, `cost_cap_missing` and `request_id_in_use`. Publish new versions of the DAG projection, caption input and result manifest for changed wire shapes. Use a versioned annotation response if it includes a new DAG shape or a distinct result/producer identity. Keep old registry entries unchanged. The DAG reports source job, original receipt and digest for inherited nodes, and current execution evidence for executed nodes. Only the needed controller and worker reads receive reuse metadata. A staff-only route can read the bounded original receipt without treating it as a new receipt.

In Recordings (`/recordings/<recordingId>`), staff can retry eligible failed clips together. On a clip’s Processing page (`/recordings/<recordingId>/clips/<clipId>/processing`), staff can retry individual failed stages or retry from a stage when the recipe has downstream work. Stage retry confirmation shows planned stages, inherited outputs and estimated cost. Clip planning retry uses job control and shows the earlier run's estimated cost when available. The Processing page lists stage attempts and reused outputs and lets staff select a different accepted result. **Open processed clip** opens the selected result at `/clips/<clipId>`.

### Original confirmation sketch

```text
Hand pose · Failed
[Re-run this stage] [Re-run from here]

Re-run hand pose
Runs    Hand pose · hand_pose_cpu_v1@1 · CPU
Reuses  Segment, caption · original receipts ↗
Time    8–12 min (example estimate) · 24 MB to copy
GPU     $0 confirmed cap
[Cancel] [Run hand pose]

Run history
Run 18 · Selected · Derived from run 17
Run 17 · Failed hand pose · View run
```

For an unavailable segment-only rerun, describe why Caption must run with it and leave “Re-run from here” available. On narrow screens, stack the actions and confirmation details in their reading order.

## Imported results

Cached imports expose the original model metadata and import seal in the run
history under the Imported label. The current import path creates a review-only
recording. It has no dispatchable registration or active processing permission,
so rerun planning refuses it. A processing job must use a normally admitted
recording and prove its own stage receipts.

## Deployment and spend

Apply migrations 015 and 016 in order and deploy matching web and workflow
releases before enabling confirmations. The active dispatcher policy applies
to the preview and confirmation, including the exact admitted source and the
direct, zero-GPU hand-pose scope in public-video canary mode. This avoids
creating a queued job or reserving spend for a scope the dispatcher excludes.

Deploy each module under a name derived from the exact Git revision, module
reference and canonical parameters digest. Reserve that name in a durable
operator record before deploying. Refuse a name already present in the
operator record or provider history, including stopped deployments. Use a
new name for a new deployment. Modal version pinning requires a different
plan. [Modal Function lookups](https://modal.com/docs/guide/trigger-deployed-functions#version-pinned-lookups)

Set `STATEACTION_RERUN_BINDINGS` from the inspected deployment records. Each
binding records the app and environment, exact function ID, definition identity,
image and entrypoint digest, revision and parameters digest, CPU, memory, GPU
and container bounds, and rates in microdollars per billed second. The
digest includes normalized placement. GPU bindings use the default placement,
and CPU bindings require nonpreemptibility with no region or instance pin at
the recorded list rate. The controller checks CPU and memory requests
and limits, including Modal’s disk-induced memory request. It rejects a
binding priced below the resulting rate. [Resource billing](https://modal.com/docs/guide/resources#billing)

If the provider omits its definition ID, the identity
is explicitly marked `definition-sha256-<digest>` and comes from the same full
normalized definition that is re-read before spawn. The provider app and
function IDs remain mandatory. The digest binds attached secret IDs and the exact
volume ID, name, filesystem version, environment and mount path. FLORA
mounts must be read-only. The digest includes the SDK’s background-commit
flag, which the SDK sets even for read-only mounts. [Modal Volume mounts](https://modal.com/docs/guide/volumes#read-only-mounts)

An external attachment the controller cannot pin is refused in the
fallback. For FLORA, the controller also reads and hashes the released
checkpoint manifest on the exact mounted volume before each bound spawn.
The worker and controller use the same published checkpoint pins, which
match both manifests verified during SA-85’s private backup. Use the
same verified bindings in the workflow that executes the stages. When set for
a native recipe, each enabled stage also requires a verified binding. The
controller reads the provider definition before issuing a claim and again
before each spawn. It checks the effective scheduling limits and submits only
through the exact verified function ID. An empty protobuf override message
can have own properties whose values are undefined. The controller treats
those properties as unset and refuses defined overrides, including an
explicit zero. The digest covers the complete
definition decoded by the pinned SDK, with explicit refusals for alternate
execution paths and resource, placement, attachment or scheduling settings
outside the envelope. Input-plane addresses are transport metadata. A
changed definition or denied read blocks the spawn.

The stored v2 stage receipt adds the verified provider identity and digest
alongside the original v1 worker receipt digest. The original worker fields
are preserved and rechecked. Reuse keeps the exact stored receipt and its
digest. Migration 016 independently checks stage state and receipt digests
against the parent catalog and restricts copied output slots to successful
stages. Content digests are checked against storage. Copy progress is
lease-fenced. A late object write can finish at the same reserved key with
identical source bytes, and the new owner still verifies the destination
before publishing it.

For bound GPU execution the controller enforces one container and a stage
wall-clock budget derived from the approved billing envelope. The budget
reserves time for cancellation and provider shutdown. The watchdog reads the
exact call at 15–30 second intervals, requests container termination at the
deadline or on a restart signal, and cancels on loss of watchdog access.
A failed controller write or lease loss also requests termination of the
known call. An unconfirmed cancellation holds the slot for reconciliation
and reports the exact call identity. If the journal and catalog disagree,
the controller reports both IDs. An acknowledgement for one ID cannot exempt
the other from cancellation. The hosted
operator records workspace gross usage before and after each job and aborts
the window on an allowance breach. Modal does not offer a hard total cap for
an individual Function call. It can reschedule a GPU container after a crash
even when application retries are off. The controller wall budget, restart
watchdog and operator read-back govern the approved run. An unconfirmed
GPU cancellation can leave an extra Captioner attempt billable. At the
full stage rate that adds up to roughly USD 1.56, which puts the estimated
workspace gross at about USD 22.07 for the authorized full proof. The
per-job ceiling stays USD 3.00. The operator refuses dispatch if the
workspace baseline plus planned use would exceed USD 22 and aborts on a
metered breach.

The coordinator overrode reviewer B’s provider-budget requirement for the
attended qualification window. The USD 24 gross Modal Workspace budget
was unconfirmed. The estimated full-run total with one extra attempt was
USD 22.07, within the user’s USD 25 workspace authorization. Preflight
records any budget returned by the provider. During the full workflow the
operator polls workspace gross usage every 30 seconds. A reading above
USD 22.50 gross or more than USD 4.50 from the window baseline triggers
exact-call cancellation with container termination, stops both temporary
GPU apps and records a typed job failure. If the read fails, the operator
takes the same shutdown path. A submitted job retains its slot until
termination evidence is available.

One 30-second interval at the full GPU-stage rate represents about
USD 0.033 of new usage. Billing data can arrive minutes later. The operator
check detects reported spend and the stage watchdog remains the timely
execution limit. The Workspace owner can set a USD 24 gross budget at any
time for a provider-enforced outer bound. [Modal preemption](https://modal.com/docs/guide/preemption) · [Modal retries](https://modal.com/docs/guide/retries) · [Modal billing](https://modal.com/docs/guide/billing) · [Modal budgets](https://modal.com/docs/guide/budgets)

The claim transaction locks the live spend authorization, compares current
aggregate reservations with its current caps, and clamps the claim and job
start deadline to expiry. Terminal jobs with no submission intent release
their reservation automatically. After a controller submitted work, the
owner can append a reconciliation with actual, attributable CPU and GPU
charges rounded up in cents and a provider metering reference. The catalog
requires terminal evidence for the job and every exact claimed call. Until
then, the whole reservation counts against the authorization.

## Hosted qualification procedure

The first accepted full run produced ten clips from the public 299-second
IndEgo recording in the hosted stack. Each of its three stages recorded its
verified provider binding. The subsequent hand-pose proof uses a new sealed
fixture on the same recipe and a tighter inspected execution envelope.

Before dispatching the parent, verify that the child helper receives
the canary settings and CPU-only binding. The dry run builds the exact
child workflow payload. Its read-only catalog query checks the admitted
source digest, the consent bound to the recording and the collector
role. It also confirms that no child or spend reservation exists. The
normal planner and confirmation lock the consent row after the parent
succeeds. Keep that consent active through both jobs. At close, retire
the collector, revoke the consent and compute grant, and verify the
restored releases, provider apps and admission slot.

## Primary references

- Dagster links selective re-execution to the original run, distinguishes selected ops from their descendants, and uses stored outputs through I/O managers. [Dagster re-execution guide](https://op-graph-docs.dagster.dagster-docs.io/guides/dagster/re-execution) · [Dagster execution API](https://dagster.io/docs/api/dagster/execution#dagster.ReexecutionOptions)
- SageMaker selective execution can point at a specific successful or failed execution for omitted dependencies. It does not run unselected downstream steps. [SageMaker selective execution guide](https://docs.aws.amazon.com/sagemaker/latest/dg/pipelines-selective-ex.html)
- Metaflow resume reuses successful results from an origin run under a new run number. It retains original parameters and can reuse outputs after step code changes. That behavior supports explicit origin lineage. StateAction adds compatibility checks. [Metaflow debugging and resume](https://docs.metaflow.org/metaflow/debugging#how-to-use-the-resume-command)
- Argo resubmission can reuse a prior workflow’s successful steps and outputs. Template memoization separately looks up outputs by key in a ConfigMap. StateAction adopts explicit parent selection with application-level digest validation. [Argo resubmit](https://argo-workflows.readthedocs.io/en/latest/cli/argo_resubmit/) · [Argo step memoization](https://argo-workflows.readthedocs.io/en/latest/memoization/)

## Acceptance evidence

| Criterion                               | Evidence to collect                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reviewed design and versioned contracts | Design review and disposition on SA-142. Contract registry compatibility, validation and negative cases.                                                                                                                                                                                                                                                                                                                                                                    |
| Hand-pose-only GPU spend                | Real local stub flow with existing successful segment/caption outputs and a hosted run with an authorized recording. Link parent and child IDs and stage/dispatch evidence. Record exactly one CPU hand-pose stage, zero GPU claims/spawns and $0 attributable GPU usage from provider evidence.                                                                                                                                                                            |
| UI                                      | Browser runs against real seeded data at 1280 and 390 px. Exercise both actions, disabled reasons, review and confirmation, original receipt, lineage, run history and historical selection.                                                                                                                                                                                                                                                                                |
| Truthful outputs and lineage            | Corruption, missing-object and identity refusals, digest-verified child copies, unchanged parent receipt and documents, valid child closure, failed-stage truth and selection stability. Exercise a pre-fingerprint failed parent with no accepted result, multi-generation reuse and exact receipts, caption-only with a reused hand seal and validated clip sidecars, lease loss partway through copying, and selection/history/marks while processing and after failure. |
| Lost acknowledgement                    | Drop the successful confirm response and replay the same UUID before and after settlement. Assert one child, one budget reservation and no second selected-stage invocation. Race different payloads and concurrent requests. Verify full retry cannot turn a derived job into a full dispatch. Exercise changed CPU/GPU bindings, provider acknowledgement loss and reservation hold through exact reconciliation.                                                         |
| Tests and gate                          | Run new or changed tests 20 consecutive times, record focused/browser/hosted evidence, and obtain the final-head PASS via `ci:land` only after all other criteria are demonstrated.                                                                                                                                                                                                                                                                                         |

Repository baseline is `a67fdcf` (SA-84, parallel recipe). Recheck journal, recovery and seal assumptions against SA-81 (#104) and SA-44 (#105) after either lands. Keep changes to shared recovery code limited to preserving the confirmed plan, stage evidence and existing release rules.
