# Release the Python recipe workflow

Use this procedure for the schema 024 to 025 cutover. The combined
[production deploy command](render-deployment.md#deploy-workflow-and-script)
migrates before it switches services. Use the steps below for this release.

## Before the window

Record one operator, the full commit already on `origin/main`, and the
allowed time and incremental cost. Record the window end, the time reserved
for rollback, the approved CPU, memory and task limits, the fixture's size,
duration and SHA-256, and its owner's consent to upload, process and delete
the qualification copy. Use an ordinary supported capture and the hosted
ingest path. Keep the original source. Announce a maintenance window covering
sign-in, ingest, catalog edits and processing.

After authorization, read back the real service identities and permissions.
The [topology](render-deployment.md#hosted-production-stack-sa-41) names
`stateaction-web`, `stateaction-workflow`, `stateaction-repair`, and
`stateaction-db`. Record web and repair repository, ref, live deployment ID,
start command and suspended state. Record the workflow ID, live version,
commit and task slug. Record the database identity, version and migration
ledger. Seal the old binding map, task slug, dispatch key reference and all
affected environment settings in the operator's credential store. Put only
IDs and digests in the release receipt. Compare the list against the deployed
environment, including one-off jobs, other gatekeepers and owner clients.

Reserve an approved candidate web origin, workflow slug, disposable catalog
and R2 bucket. Reuse approved isolated staging resources if available.
The fixed `stateaction_app` role shares a login across logical databases on
one instance. Reuse that instance only if the operator can allocate isolated
databases within its storage cap and demonstrate database-specific `CONNECT`
denials from that login against both production databases while the fixture
runs. With an independent instance, use a separate app password. Keep the
preserved production objects available to the restore verifier using only
read permission. A scheduled job or one-off job must not inherit candidate
authority accidentally.
If the provider requires an extra paid service, auth redirect, quota change
or privilege to do this, confirm that the approved manifest covers it before
making the change. Verify that only the named staff operator and fixture
collector can access the candidate catalog. Test the actual OAuth redirect,
workflow callback and R2 presign path.

Pause any other releases. Confirm auto-deploy is off on web, workflow and
repair, including the candidate. Keep the predecessor workflow version and
its config available and inactive for rollback. Build the candidate web and
stage the Python workflow at the exact release ref and separate slug. Use
`stateaction_controller.workflow` from `workers/controller`. When repair
builds the branch tip, pin both the release and predecessor to refs whose
tips will remain fixed in the window. Record the old branch. Render resumes
repair before it can deploy. Revoke its credential and detach it from the
service before resuming it. Verify an invocation cannot write. Confirm the
new live SHA, then suspend again until the bounded reconcile passes. Use the
same procedure and predecessor ref to recover, even if it was originally
suspended. Stop before migration if any revision cannot be staged or
restored safely.

Keep the generic deploy action and Blueprint reconfiguration frozen after
promotion until their database selection matches the new production catalog.
The current config points at the parked database and could reattach or migrate
it. If the promoted catalog keeps a different name or instance, update the
deployment configuration and verify its target before lifting that freeze.

## Quiesce and checkpoint

1. Announce the pause in intake, sign-in and editing. Suspend repair, revoke
   its credential and disable Render start authority, including direct
   workflow starts. Leave the existing workflow and worker callbacks live
   only long enough to drain. The catalog fence begins after drain. Record the exact workflow run
   and Modal call IDs and confirm terminal evidence, an empty admission slot
   and no uncertain jobs or claims. Check pending multipart uploads and already
   issued write URLs. Drain or expire them before taking a checkpoint. Do not
   shorten a signed grant by assumption or treat a quiet queue as proof.
2. Suspend production web and stop owner automations. Add only the attended
   operator's temporary `/32` to the database allow list if access requires
   it. Close production database writer access.
   On the exact database revoke `CONNECT` from `PUBLIC` and every ordinary writer
   role, checking inherited and explicit privileges. Disconnect existing
   writer sessions by exact database and session IDs if they survive service
   suspension. First verify the operator has permission to signal them. The
   local rehearsal found that the migration owner alone could not terminate
   an app session. Stop if sessions remain and no authorized operator can
   end them. Check for prepared
   transactions on that database and resolve any before checkpointing. A failed connection
   probe with the application's role and a zero-session read-back prove both
   sides of the fence. Also verify that legacy repair and task credentials
   cannot write and ordinary web routes are inaccessible. Record the original
   database ACL so it can be restored. Retain only the attended owner
   connection. If the managed operator cannot close or verify a write path,
   stop. Remove the temporary `/32` immediately after database operations
   and check the provider read-back on every exit path.
3. Inventory existing queued legacy jobs and recordings pinned to a legacy
   recipe. Resolve them through the supported path with operator approval or
   stop before switching authority. Migration 025 checks unsettled work. Keep
   the catalog fence in place even when those checks pass.
4. After verifying the app fence, write one approved synthetic `user` row
   through the attended owner with no access or sessions. Freeze owner
   writes and take the v024 checkpoint. Capture time, digest, source
   database identity and row fingerprints for IDs, source and output hashes,
   selections and the sentinel. Use `pg_dump --format=custom --no-owner` with
   a private, bounded file and an authenticated owner connection. Restore
   with `pg_restore --no-owner --single-transaction --exit-on-error` into a
   new isolated database. Confirm all roles named by the dump exist on the
   target with the expected restrictions, including `stateaction_app` and
   `stateaction_dev_reader` if present. Revoke `CONNECT` from `PUBLIC` and
   every ordinary role before loading the dump. Probe the restricted login
   before and after restore. Use the [restore runbook](database-recovery.md)
   for object verification and reconciliation of sessions, grants and
   external state. Keep the restore at 024 throughout that proof. The release
   migration below is the only upgrade in this procedure. Record
   actual restore time and the result of comparing the ledger and schema.
   Keep the original database parked and read back its fingerprint before
   rollback. A second sentinel on an independent fixture catalog must survive
   restoring 024 and must not appear in the production restore.
5. Keep the entire production fence closed. Revoke `CONNECT` from ordinary
   roles on the restored copy before applying 025. The normal `hosted:migrate`
   command re-grants app-role `CONNECT` as part of password setup. Use the same
   migration library with the pre-existing restricted role and no password
   setup. With the production copy's owner URL in the secret environment and
   its unique database name in `STATEACTION_RELEASE_DATABASE`, run this from
   the built, pinned release checkout.

   ```sh
   env -u APP_DB_PASSWORD node --input-type=module -e '
     import { migrateDatabase } from "./packages/server/dist/migrations.js";
     try {
       const ownerUrl = process.env.MIGRATION_DATABASE_URL;
       const database = process.env.STATEACTION_RELEASE_DATABASE;
       if (!database || decodeURIComponent(new URL(ownerUrl).pathname) !== `/${database}`) {
         throw new Error("Wrong restore target");
       }
       const report = await migrateDatabase({ ownerUrl });
       if (!report.appRoleGranted || report.applied.join() !== "25") {
         throw new Error("Unexpected restore schema or grants");
       }
       console.log("Applied migration 025 to the checked restore target");
     } catch {
       console.error("Fenced migration failed verification");
       process.exitCode = 1;
     }'
   ```

   Check `CONNECT` grants and sessions after migration, and attempt a fresh
   restricted app login. Require denial on both production databases while
   the fence is closed. Read back migration 025 and its checksum, grants,
   schema and the same catalog identities. Keep the original database parked.

## Qualify the CPU candidate

Build three immutable Modal apps from `workers/processing/modal_app.py`,
one for each of `clip_filter_passthrough@1`, `recording_mp4_remux@1` and
`hand_pose_cpu@1`. Each exports `process_recording`. Use the module,
canonical parameter digest and exact source commit to derive the app name
with the contract's `immutableModalAppName`. Export the pinned processing
dependencies with
`uv export --project workers/processing --locked --no-dev --no-emit-project --no-emit-package stateaction-contracts -o <private-file>`.
Pass `STATEACTION_LOCKED_REQUIREMENTS`, `STATEACTION_CODE_REVISION`,
`STATEACTION_IMAGE_SPEC_SHA256`, `STATEACTION_MODAL_APP_NAME`,
`STATEACTION_GRAPH_MODULE` and `STATEACTION_GRAPH_PARAMS_SHA256` to the
deployment process. Set `STATEACTION_MODAL_HAND_POSE_TIMEOUT_S=600` and
`STATEACTION_MODAL_HAND_POSE_STARTUP_TIMEOUT_S=90` as approved in the
manifest. The wrapper limit is 300 seconds. From the pinned checkout use
`uv run --project workers/controller --locked modal deploy --env <approved-env> workers/processing/modal_app.py`
once per module while all dispatch is closed. Do not replace any of the
predecessor's apps.

Use the [Python verifier](../../packages/modal-verifier/README.md) to
inspect each exact target with `inspect.aio` and its `Bounds`, then call
`verify_binding.aio` with the returned pinned identity. Record app,
function, definition, image, revision, parameters and resource bounds. Keep
only those three CPU entries in the web's `STATEACTION_GRAPH_BINDINGS` and
match them in the workflow's `MODAL_STAGE_FUNCTIONS` using the
[controller configuration](../../workers/controller/src/stateaction_controller/config.py).
Set the Python workflow's `APP_ENV=production`, `EXECUTION_BACKEND=modal`,
`JOBS_STATE_DIR=/tmp/stateaction-jobs`, `CONTROLLER_CAPABILITY_TOKEN`,
`MODAL_ENVIRONMENT`, `MODAL_APP_NAME`, `MODAL_FUNCTION_NAME` and
`STATEACTION_API_URL`. Bind the
stage targets as `module@1=app/process_recording` and use only the approved
workflow-scoped Modal credential on this service.
Read back both configurations and confirm that a graph needing a GPU
binding is refused before dispatch. Freeze all Modal deployments and
autoscaler changes for as long as jobs may dispatch. This depends on
operators honoring the freeze.

Bootstrap only the disposable catalog with schema 025 and restricted app
grants. On a shared instance use the owner migration library without password
setup, as in step 5, and grant `CONNECT` only on the disposable database.
Enable `STATEACTION_CAPTURE_RECIPE_SELECTION=manual` before any upload.
Set up the approved staff and collector identities and record the source
collection and processing consent with the
[pilot access commands](pilot-operations.md#12-capture-and-processing-permission-evidence-collector).
Use the owner CLI `issue-service-capability` against this catalog. Issue
separate tokens for workflow (`jobs:status,jobs:reconcile`) and attended
repair (`jobs:repair`) with an expiry within the window. Set the candidate
web's dedicated dispatch key and `PROCESS_RECORDING_TASK_SLUG` to the staged
slug. Leave its scheduled repair off. Invoke `stateaction_controller.repair`
once against the candidate with `APP_ENV=production`, `STATEACTION_API_URL`
and `REPAIR_CAPABILITY_FILE` for the plan, once for its child and once for
the approved retry. Use the authenticated Android collector upload from the
approved candidate-origin build with `PROD_BACKEND_ORIGIN` set explicitly.
Verify OAuth, consent, upload and the personal Android profile before use.
Production catalog, admission, dispatch and repair stay fenced.
Select
`cpu_hand_canary@1` and record the admitted recipe and source hashes,
job and workflow run IDs, and the exact function and call IDs. Read back
one plan and one child before retry, with terminal evidence and the
`original_video`, `source_span` and `track_hands` receipts. Hash the
selected output bytes and compare them with the accepted catalog digest.
Verify both staff Processing pages and the selected clip player. Exercise
a large synthetic output against the approved ingress size and time
limits if the fixture's own artifacts are smaller than the agreed test.

Before retry, the owner inserts one `rerun_spend_authorizations` row with a
fresh UUID `id`, the fixture recording ID and the bound Modal environment. Set `approval`
to the recorded approval reference, `max_gpu_cents=0`, `max_compute_cents`
to the verified leaf cap (27 under the manifest limits), and `expires_at`
within the window. Choose the successful `track_hands` leaf on the clip Processing page,
select **Rerun this step** and confirm **Start retry**. Compare the
preview's retained source and upstream data with the retry's bindings,
parent job, receipts and exact new call. Verify a single leaf call, the
expected reuse and the final selected digest. Read back the bounded repair
entry point with its fixture-only capability and dispatch closed once the
fixture has settled. Record time, actual resource use, cost and cleanup.
Retain sanitized evidence and remove only the identified fixture resources
after callbacks and uploads have terminated. Stop the candidate web and
close its database connections before reopening any production login.
Keep the verified CPU apps
and promoted workflow version if they become production dependencies.

## Switch and verify

Keep both production database app logins denied while installing and
starting the verified web release, pointing it to the migrated restore copy,
and setting its authority to the staged Python workflow slug. The running
web can report `/api/v1/live` with its database writer fenced. Read back its
provider version and probe a catalog route for denial. Leave the Render
dispatch key absent and repair inactive during this check. Before reopening anything,
read back the actual web revision, schema and ledger, effective workflow
version and slug, binding digest, dispatch key state and repair revision.
Probe that no ordinary request, direct start or cron invocation can create a
job during the switch. Use the qualified isolated candidate for the
authenticated browser proof. Reconcile captured sessions and grants and revoke
the restored capabilities before reissuing workflow and repair credentials
from the migrated database. Point the promoted workflow at the production
origin and read back the effective version and configuration while no tasks
can dispatch.

Once the candidate and production read-backs agree, reopen catalog access
and admissions in the manifest's order. Enable only the verified CPU
bindings and use manual CPU recipe selection for any authorized intake.
Keep the old repair revision suspended until the new revision and
its API-only capability have passed their bounded reconcile check. Resume
the new repair schedule only as approved. Record when the first ordinary
write or job was accepted. Keep the old checkpoint and original service
settings through the agreed retention interval.

## Restore or stop

Before reopening ordinary writes, a wrong revision, unexpected writer, lost
acknowledgement, unknown call, cost or time limit, digest mismatch or failed
staff retry holds the fence. Drain exact runs on the disposable candidate.
Restore the prior web deployment and environment, prior workflow version and
slug, prior binding and dispatch configuration and the prior repair revision,
schedule and suspension state. Reconnect to the parked v024 checkpoint
only if its fingerprint still matches the verified restore. Otherwise use the
verified isolated v024 restore. Verify the complete record, including
unrelated sentinels, schema, ID and selection hashes, restricted grants, and
object reads. Keep all writers closed until the old tuple is correct. Restore
the recorded database host, port, name and allow list, app processing and
recipe selection settings, web and workflow deploy flags, workflow API origin
and Modal targets, and repair branch and environment. Reissue expired or
revoked service capabilities with the old scopes. Restore the appropriate
database ACL, then the recorded pre-window admission and repair state.
If recovery cannot be proved, leave the fence in place and report the exact
unresolved resource. Never restore over the live database.

After the first ordinary write or admission on v025, preserve its evidence
and use a forward fix under a fresh fence. Restoring the checkpoint after
that point would discard writes.

## Local evidence

Run the fenced case in
[restore-drill.test.ts](../../packages/server/test-integration/restore-drill.test.ts)
through the catalog integration runner with bounded loopback fixtures. Compare
its v024 checkpoint, migrated v025 candidate, restored v024 schema and rows,
failed writer probes and independent sentinels. The [CPU integration](../../workers/controller/integration/graph-local-world.mjs)
uses the real Next web app, Postgres, object storage, the local Render runner,
the Python workflow, and the staff browser. Use the serial gate with
`pnpm ci:local --full --serial-stages` on the final PR head. The local
rehearsal uses local process and storage identities. Record the actual
production provider read-backs during the hosted window.

## Hosted release evidence (2026-11-27)

On 2026-11-27 the user approved a simplified zero-external-user cutover on
production (`SA-159`): take a pre-migration local `pg_dump` backup, keep GPU
dispatch disabled, stay within a USD 3 incremental spend cap, deploy the pinned
`main` release (`ad9ad4a1ef606e974d523913703d05cf6e8acf55`), verify public
rendering and `/api/v1/health`, and prove one hosted CPU fixture run plus one
leaf retry end-to-end before cleaning up fixture copies.

- **Pre-migration backup and schema 025 (`stateaction-db`, `dpg-dc2bek3rjlhs73ae5qg0-a`):**
  - Local custom-format `pg_dump` captured outside Git at
    `~/.cache/stateaction-sa159-backup/v024-pre-cutover.dump` (884,422 bytes,
    mode `0600`; remove after the agreed retention interval per
    [database-recovery.md](database-recovery.md)).
  - Migration `025` applied cleanly (`applied [25]`, `already applied [1..24]`,
    app role grants verified).
  - Temporary operator `/32` removed from `ipAllowList` and verified empty
    after both backup and migration.
- **Immutable CPU-only Modal apps (`--env main`, commit
  `ad9ad4a1ef606e974d523913703d05cf6e8acf55`, GPU disabled, `maxContainers=1`,
  `maxCpuMilli=4000`, `maxMemoryMib=26215`, `maxBilledSeconds=810`,
  `microUsdPerCpuSecond=328`, `microUsdPerGpuSecond=0`):**
  - Image spec SHA-256:
    `20db0e639468091c820821bd4c1137c4738ce710a3db006cb0b16f06a9be1a65`; canonical
    params SHA-256:
    `44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a`.
  - `clip_filter_passthrough@1`:
    `stateaction-clip-filter-passthrough-5ebfaaf9d32fd98f0f4d11e5`
    (`fu-2S7rYbnS1xbJGjBexK7cQy`, `im-73GZtBRx6zE0YJgQm18mwB`,
    `definitionSha256=5d044833a1dd9a733bf90907c46cc084caccde7e3e1cd2820b5df04f5bee43df`).
  - `recording_mp4_remux@1`:
    `stateaction-recording-mp4-remux-1c6bfdaf9da6d5c60bfb8e2a`
    (`fu-fhIs0PMJvT29i8Jd4FMsES`, `im-B5PakMEhNokOw3yOwu7I3I`,
    `definitionSha256=ca98c9d0094389961404bc651733399ae54ce39acba61b3949eb18b6b086b62d`).
  - `hand_pose_cpu@1`:
    `stateaction-hand-pose-cpu-0f83e4e30cf0ef367e824b51`
    (`fu-ocTWZxzASQEiGHpDp0PyBk`, `im-dBy4kKg1sdyAvFGpSNcuDi`,
    `definitionSha256=d812ac3e9e034f2b1eb68a4369fb483ca6a9b71a8d687a920033d09e3cd621c6`,
    `modelSha256=fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1`).
  - All three bindings passed `stateaction-modal-verifier` (`inspect.aio` +
    `verify_binding.aio`) before configuring `STATEACTION_GRAPH_BINDINGS` on
    `stateaction-web` and `MODAL_STAGE_FUNCTIONS` on `stateaction-workflow`.
- **Render production stack cutover and live checks:**
  - `stateaction-web` (`srv-dc2bfl6c6qcc73df90e0`): live deploy
    `dep-dc52m1dg1s2s738c06b0` at `ad9ad4a1ef606e974d523913703d05cf6e8acf55`
    with verified CPU-only `STATEACTION_GRAPH_BINDINGS`,
    `STATEACTION_CAPTURE_RECIPE_SELECTION=manual`, and
    `PROCESS_RECORDING_TASK_SLUG=stateaction-workflow/process-recording`.
  - `stateaction-workflow` (`wfl-dc2bermc6qcc73df6890`): switched from Node to
    Python (`stateaction_controller.workflow`, Python `3.12.13`), released with
    the cross-event-loop `before_submit` fix in `modal_executor.py`
    (`wfv-dc52fgm1egvs73ab1kbg`, task `tsk-dc52g743qr4g00akat00`; re-released at
    the final merged `main` commit immediately after this release lands).
  - `stateaction-repair` (`crn-dc2bflrrjlhs73ae9jt0`): switched from Node to
    Python (`dep-dc52569aekrs73d2jrmg` at `ad9ad4a1ef606e974d523913703d05cf6e8acf55`),
    kept suspended.
  - Live checks passed: `GET https://stateaction.ai/api/v1/live` (`200 ok`),
    `GET https://stateaction.ai/api/v1/health`
    (`200 {"status":"ok","checks":{"database":true,"storage":true,"jobs":true}}`),
    and anonymous `GET https://stateaction.ai/` (`200`, IndEgo public clip
    review, caption panel, hand pose, customizable pipeline, Sign in, and no
    FLORA references).
- **Hosted CPU fixture end-to-end run and leaf retry:**
  - Fixture recording `12461708-bc67-4039-9584-faa482c27d5a` (indexed MCAP,
    87,209 bytes, `sha256=b786d6a54c368138417f7ecbe5b343ca085bedd9c7575cd138306a42cd4e77e4`,
    `sourceManifestSha256=535fb21f6be4a7c91e2fc80a9dfdcbe5e387051d4a4c54937d29cb8f0fd7fde9`),
    recipe `cpu_hand_canary@1`.
  - `clip_plan` job `16450656-2b46-410a-9c17-582bb7cd675d`
    (`trn-0b54gdc52n1dca4tg00b0kpo0`): `succeeded` and `accepted`
    (`inventory_sha256=1187b7130e74ecbe40294b988591ef52211936047b5f17ab93b10e1a7398b6a2`);
    `original_video` (`fc-01M8FVM394SMZD4QGRB5QDG2HJ`, `review_video@1`,
    2,191 bytes) and `source_span` (`fc-01M8FVMA1MYKZ518YGC923R1BJ`,
    `clip_plan@1`, 727 bytes).
  - `clip_pipeline` job `98297263-cf2d-4454-9f82-53e2795dc80b`
    (`trn-0b54gdc52n6tson7000fp89s0`): `succeeded` and `accepted`
    (`inventory_sha256=d6caca7df06e0c20c29f6e6451fd87ec0277081e755199779f3eb7a999a9debf`);
    `track_hands` (`fc-01M8FVMRPSWDB9VZZGB2MDM12D`, all 7 `hand_pose@2`
    outputs verified and accepted).
  - `leaf_retry` job `0258c95d-5576-4b85-8279-3307cf96a980`
    (`derived_from_job_id=98297263-cf2d-4454-9f82-53e2795dc80b`,
    `trn-0b54gdc52ndlson7000fp89sg`, `maxComputeCostUsd="0.27"`,
    `maxGpuCostUsd="0.00"`): `succeeded` and `accepted`
    (`inventory_sha256=418100a419cb9344b1727f6f394769a41976dcebae8097c9a230eae77ff0c469`);
    distinct `track_hands` Modal call `fc-01M8FVNK5WZTQSREM4RJ4HKJH0`, and clip
    `selected_job_id` updated to `0258c95d-5576-4b85-8279-3307cf96a980`.
  - **Bug uncovered and fixed during hosted E2E:** In
    `workers/controller/src/stateaction_controller/modal_executor.py`,
    `synchronize_api(_spawn_once)` ran `before_submit()` on Modal's
    Synchronicity background event loop instead of the caller's asyncio loop,
    raising `RuntimeError: <asyncio.locks.Event> is bound to a different event
loop` against `httpx.AsyncClient`. Splitting input preparation and
    submission (`prepare_spawn_input` -> caller-loop `await before_submit()` ->
    `submit_spawn_input`) fixed the failure; regression covered in
    `workers/controller/tests/test_modal_executor.py`.
  - **Cleanup verified:** Deleted all 22 fixture R2 objects from
    `stateaction-prod`, soft-deleted fixture recording
    `12461708-bc67-4039-9584-faa482c27d5a`, revoked temporary capability/ingest
    permissions, expired the temporary rerun spend authorization, and confirmed
    `stateaction-db` `ipAllowList` is empty.
