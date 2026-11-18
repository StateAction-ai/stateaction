# Pilot operations runbook: permissions, retention and support (SA-47)

Status, 2026-11-02: **source runbook, not an operational claim.** It records how the existing operator tools are meant to be used for a small pilot. It does not say that any production environment, hosted service, provider alert, legal basis or physical-device path is configured or qualified. The command lines below were written from the CLI source; the operator dry run (see [Dry-run status](#dry-run-status)) is what turns them into checked commands.

Nothing here adds an admin UI, a self-service sharing route, a schema change or an automatic deletion.

## Roles

Roles are named by function. Assign real people outside this repository; do not record names, emails or contact details here.

| Role              | Does                                                                                                                   | Never does                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **project-owner** | Decides who is admitted, signs off retention defaults, holds the permission evidence, approves any exception           | Delegates the owner database credential to a service                          |
| **operator**      | Runs the commands in this page with the owner credential, records references, performs support actions                 | Invents evidence, deletes originals, restarts uncertain work blindly          |
| **collector**     | Records on their own phone, keeps originals until told otherwise, reports problems with the exact recording reference  | Shares a login, cancels a finished recording, starts capture for someone else |
| **reviewer**      | A staff user. Reviews clips, approves or rejects; confirms copies for cleanup once that path exists                    | Treats "processed" as "approved"                                              |
| customer          | An external recipient. Sees only approved, cleared, granted clips in granted datasets. Has no role in operations steps | Gets access from capture or processing permission                             |

## Rules that apply everywhere

- **Principals are immutable user IDs** (`"user".id`, an opaque text value). Email addresses and display names are not principals and are not durable: never use them in `--owner`, `--recipient`, `--actor` or SQL `WHERE` clauses. Look an ID up once, then copy it exactly.
- **Evidence references are pointers, not content.** `--evidence` takes a reference to a document that lives in the project owner's records (a document ID, signed-form ID or ticket reference). The tools store and print only the reference. Do not paste consent text, contact details or file contents into any argument. This repository contains no real permission evidence, and this page does not say that any exists. If the evidence does not exist, the step does not happen.
- **Owner credential** (`MIGRATION_DATABASE_URL`) is operator-only. Keep it in the operator's shell environment or a private file the operator owns with mode `0600` outside the repository. It never goes into the repository, logs, chat, tickets, shell history, shared service environments, web, workflow, worker or mobile environments, `.env` files those read, or Nx caches. In `APP_ENV=local` the CLIs may reuse a loopback `DATABASE_URL`; they refuse a non-loopback database in that mode. Every command below prints JSON with references and counts only.
- **No external messages.** The pilot steps record decisions and evidence references. They never contact collectors or recipients. Notifications are a human act outside these tools.
- **Revocation is next-request.** Role changes, permission revocation and grant disablement take effect the next time the server re-reads them. A presigned read URL already issued (60 s maximum) and a part URL already issued cannot be recalled.

## 1. Admit and remove people

### 1.1 Roles in `access` (collector, staff, customer)

Roles are rows of `public.access (user_id, role, enabled, granted_by)` written by the operator with the owner credential. The web role can only read it, so nobody can grant themselves a role. The user must already exist (a sign-in or a seed created `"user"`); `user_id` references it.

Do not put a database URL or password in `psql` arguments (they show in the process list and history). Use a protected `PGPASSFILE` or `PGSERVICEFILE` (mode `0600`, outside the repository), or the operator's environment variables (`PGHOST`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`), and bind the opaque IDs and operator reference as `psql` variables instead of editing them into SQL:

```bash
psql -v ON_ERROR_STOP=1 -v uid='<USER_ID>' -v role='<collector|staff|customer>' -v by='<OPERATOR_ROLE_REF>' <<'SQL'
-- enable
INSERT INTO access (user_id, role, enabled, granted_by)
VALUES (:'uid', :'role', true, :'by')
ON CONFLICT (user_id, role)
DO UPDATE SET enabled = true, granted_by = EXCLUDED.granted_by, updated_at = now();
SELECT user_id, role, enabled, granted_by FROM access WHERE user_id = :'uid';
SQL
```

Revoke by disabling, not deleting:

```bash
psql -v ON_ERROR_STOP=1 -v uid='<USER_ID>' -v role='<ROLE>' -v by='<OPERATOR_ROLE_REF>' <<'SQL'
UPDATE access SET enabled = false, granted_by = :'by', updated_at = now()
WHERE user_id = :'uid' AND role = :'role';
SELECT user_id, role, enabled, granted_by FROM access WHERE user_id = :'uid';
SQL
```

`access` keeps one current row per `(user_id, role)`. The upsert overwrites `granted_by` and `updated_at` with the latest actor, and disabling keeps the row, but **neither is an audit trail**. The operator keeps dated external evidence of each action (ticket note with the user ID, role, action, time and operator reference). `granted_by` is a free-text reference, not authenticated. Status then follows [auth-and-access](auth-and-access.md): no rows is `pending`, only disabled rows is `disabled`.

Effects: a disabled collector cannot start capture on the app (the app re-reads `/api/v1/me`; see [mobile ownership](mobile-auth-and-ownership.md)), cannot register or upload, and offline eligibility is cleared only when the app next reaches the server. Local recordings stay on the phone.

### 1.2 Capture and processing permission evidence (collector)

A collector needs **both** an enabled `collector` role **and** an active ingest permission. The role alone does not admit a recording. Record evidence for exactly one collector ID:

```bash
pnpm --filter @stateaction/server ingest-permission record \
  --ref <REVISION_LABEL> --owner <COLLECTOR_USER_ID> --scope <PILOT_SCOPE_LABEL> \
  --evidence <EVIDENCE_REF> --by <OPERATOR_ROLE_REF> [--capture-only]
pnpm --filter @stateaction/server ingest-permission list --owner <COLLECTOR_USER_ID>
pnpm --filter @stateaction/server ingest-permission revoke \
  --ref <REVISION_LABEL> --by <OPERATOR_ROLE_REF> --reason <TEXT>
```

- `--ref` is a revision label matching `^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$`. Use a new label per revision; one active record per owner.
- The record always covers capture. It covers processing unless `--capture-only` is given. Use `--capture-only` when only capture is cleared; processing is then not authorized.
- `revoke` is one-way (`active → revoked`). To change scope, revoke, then record a new `--ref`.
- Revocation is ordered against in-flight registration and admission; each one is entirely before or after it.
- The project-owner supplies `--evidence` and `--scope`. The operator must not choose them.

### 1.3 External-recipient permission and dataset access

Capture or processing permission **never** authorizes external inspection. For a customer, the order is fixed: role → sharing evidence → clearance → grant.

1. `access` row for the customer (section 1.1).
2. Staff reviewer has approved the clips and put them in the dataset (clip review UI).
3. Record recipient-sharing evidence for one dataset and one enabled customer:
   ```bash
   pnpm --filter @stateaction/server dataset-sharing record \
     --ref <REF> --dataset <DATASET_UUID> --recipient <CUSTOMER_USER_ID> \
     --evidence <EVIDENCE_REF> --by <OPERATOR_ROLE_REF>
   ```
4. Clear the clips the project-owner has confirmed may be shown. Clear by exact ID (`--clips ID,ID`), or `--all-members` only when every current member is confirmed. Clearance does not cover clips added later:
   ```bash
   pnpm --filter @stateaction/server dataset-sharing clear --ref <REF> --clips <CLIP_ID>,<CLIP_ID> --by <OPERATOR_ROLE_REF>
   ```
5. Grant the view, naming the enabled staff user who acts:
   ```bash
   pnpm --filter @stateaction/server dataset-sharing grant --ref <REF> --actor <STAFF_USER_ID>
   ```
6. Check: `dataset-sharing list --dataset <DATASET_UUID>`.

Withdraw access:

```bash
pnpm --filter @stateaction/server dataset-sharing revoke  --ref <REF> --by <OPERATOR_ROLE_REF> --reason <TEXT>   # also disables the grant
pnpm --filter @stateaction/server dataset-sharing disable --dataset <DATASET_UUID> --recipient <CUSTOMER_USER_ID> --actor <STAFF_USER_ID>
```

A clip is visible to a customer only when its latest review is `approved`, its job is the recording's current `succeeded` job, and an enabled grant rests on active evidence that cleared that clip ([dataset-access](dataset-access.md)). Rejecting a clip removes it from datasets immediately, and re-approval does not restore membership. Cloud, provider or account setup for a real recipient is outside this page.

## 2. First phone recording (collector, personal profile)

Preconditions the operator checks before the collector starts:

- The collector has an enabled `collector` role and an active ingest permission (1.1, 1.2). The operator confirmed both with `list`.
- Backend: the development origin is `https://tim-work-pc.taila68f99.ts.net:8444` over Tailscale Serve (HTTPS). Local password sign-in is for seeded pilot identities only; the collector receives the password from the project-owner through a channel the owner controls. Keep passwords out of tickets, chat logs, command history and screenshots. A private local credential file owned by the operator with mode `0600` is supported for automated tests; never commit or bundle it. The app's `.env` carries no credential ([mobile auth](mobile-auth-and-ownership.md)).
- Phone: **personal profile only.** The company/work profile is never used for installing, updating, launching or testing. Before any install, update or launch, the operator identifies profiles with `adb -s "$ANDROID_SERIAL" shell cmd user list -v`, confirms the personal full user (on the inspected Pixel it was 0 and Work was 10; recheck every session), and follows the [personal-profile command guide](../../scripts/ANDROID_PERSONAL_DEVICE.md) for the package, APK, permission and component arguments. If targeting is ambiguous, stop and report to the project-owner. Do not install or reinstall the spike package into the work profile.
- Complete the applicable simulation and emulator checks before scheduling a phone rehearsal.
- Charging and network defaults for the collector: the recorder requests a stop when free space is at or below 256 MiB (`CaptureResourceGuard.FINALIZATION_RESERVE_BYTES`) and never deletes anything, so start with **much more free space than that**; the amount is the project-owner's call and is not measured here. Keep the phone **charging** and cool, and upload only on **unmetered Wi-Fi**, never mobile data. These are operating defaults for the pilot, not settings this document claims the app enforces.

The collector then:

1. Opens the app, signs in as themselves, and confirms the app shows an active collector.
2. Presses **Start** intentionally. Nothing starts capture on their behalf; an agent, script or operator never presses Start.
3. Records the planned task, presses **Stop**, and waits for the app to report the recording finalized.
4. Once the recording is finalized, presses **Upload** explicitly for that recording while on unmetered Wi-Fi and charging. The Android native uploader supports this. Physical-device qualification is pending. Upload completing is not verification (section 3).
5. Leaves the recording alone afterwards. They do not cancel, delete, rename or move files, and they do not sign in as someone else on that phone to "fix" anything.
6. Tells the operator the recording reference shown by the app and the time.

The Android recorder's finalization, quarantine and recovery rules are in [android-finalization](android-finalization.md). Physical hardware and the first-phone result are **not qualified** by this document or by its source checks.

## 3. What each state means

These are separate facts. Never infer a later one from an earlier one.

| Stage                          | What it proves                                                                   | What it does not prove                         | Where to check                                                        |
| ------------------------------ | -------------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------- |
| **Recording finalizing**       | The phone is closing the container and sidecar. The recording is not complete.   | Anything uploadable                            | The app's capture state; `FINALIZED` journal phase                    |
| **Finalized (on device)**      | Container closed, sidecar read back. Original is on the phone.                   | Upload readiness, owner, permission            | Phone, [android-finalization](android-finalization.md)                |
| **Uploaded**                   | The server received and completed the bytes by the transport rules.              | The content hash matches. ETags are not hashes | Recording/file record on the server                                   |
| **Actual source-SHA verified** | A separate full-read check matched the declared SHA-256 of the original          | Processing, quality, approval                  | The server's verification record; `source_sha_mismatch` means failure |
| **Processing completed**       | The recording's current job reached `succeeded` with an accepted result          | A human has approved the clips                 | `job-recovery status <jobId>`; pipeline page                          |
| **Human approved**             | A staff reviewer's latest review of that clip is `approved`                      | Customer sharing, cleanup                      | Clip review page                                                      |
| **Explicit cleanup**           | A deliberate, separately authorized action removing one recording from one phone | Anything else                                  | See [Cleanup](#6-local-cleanup)                                       |

Missing evidence is "not yet". If the server record for a stage cannot be read, treat the stage as unconfirmed and escalate; do not assume it is done. The upload and verification path may not be qualified on a given build; check the build's remaining-gates list rather than the absence of an error.

## 4. Retention defaults

These are proposed pilot defaults for the project-owner to approve. No retention job, expiry or purge exists ([pipeline-operations](pipeline-operations.md#retention)). Anything stricter than "keep" is a human action.

- **Originals on the phone** that are pending, failed, quarantined, salvaged, uploaded-but-unverified or unreviewed: keep. Never delete, rewrite, move or repair them to free space.
- **Original sources on the server**: immutable; not aged out.
- **Published or referenced artifacts** (outputs of a current accepted job, dataset members, anything a grant or review points to): never purged by age.
- **Superseded or failed job outputs**: keep until a project-owner decision names the job IDs. No automatic purge.
- **Permission evidence references and the external dated role-action record**: keep; revoke instead of delete. The mutable `granted_by` field holds only the latest reference.
- **No automatic source cleanup** of any kind. A device copy leaves only through section 6.

## 5. Support actions

Every action names the exact references. Without them, do not act. Use the recording reference the app showed, the job ID from the pipeline page, the file/slot name, and the owner's user ID.

| Situation                                                                            | Operator does                                                                                                                                                                                                                                                                                                       | Does not                                                                                       |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Low disk on the phone**                                                            | collector stops, charges, reports the recording reference and free space. Project-owner decides: free space only from material that is already on a verified, approved path or from non-recording phone content the collector chooses. Operator records the decision on the ticket                                  | Delete any pending, failed, quarantined or unverified original; clear app data; uninstall      |
| **Permission missing, revoked or scope mismatch**                                    | `ingest-permission list --owner <USER_ID>`; if none active or `coversProcessing` false, project-owner supplies evidence or declines. Recording stays on the phone                                                                                                                                                   | Record evidence that does not exist; admit as a different owner                                |
| **Owner mismatch** (recording belongs to another account)                            | Identify the capturing account's user ID (`list --owner`). The recording is hidden from other accounts by design. The original owner signs back in on that phone to continue. Ownerless captures need that collector's explicit claim in the app                                                                    | Reassign by SQL, sign in as the other person, edit the ledger, delete                          |
| **Auth expiry or logout**                                                            | Collector signs in again with the same account. Uploads pause and resume for the same verified owner. Check `/api/v1/me` shows active                                                                                                                                                                               | Treat 401 as revoked; recreate the account; reuse another login                                |
| **Upload state uncertain** (unknown completion, stalled)                             | Read the file's transport state on the server for that recording. Retry only through the product's transport reconcile/restart path, which acts only when the provider state is proven. If still uncertain, keep the original and escalate with recording and file references                                       | Re-upload under a new ID before the old transport is proven retired; assume complete by ETag   |
| **Source hash mismatch** (`source_sha_mismatch`)                                     | Treat the phone original as the authority. Keep it. Record the recording and file references; engineering decides a re-upload                                                                                                                                                                                       | Delete either copy; mark verified by hand                                                      |
| **Job uncertain** (`submit_unknown`, `needs_attention`, past deadline, no heartbeat) | `pnpm --filter @stateaction/server job-recovery status <JOB_ID>` and follow its `guidance`. For a local run, verify on the controller host that the exact job's worker process group is gone and let the controller record termination evidence. Use `cancel <JOB_ID> --expect <STATE>` only against the state seen | Restart the controller, respawn, clear the slot, or `retry` before termination evidence exists |
| **Retry after termination**                                                          | Only when `status` shows terminal state, recorded exact termination evidence and a released slot: `job-recovery retry <JOB_ID> --expect <STATE>`. This creates a **new** job ID and new output prefix from the same sealed source. Record old and new IDs                                                           | Retry a job whose termination is unproven; reuse the old output prefix                         |
| **Cost or spend alert**                                                              | `ops-report` over the restricted role with an operator rate card ([pipeline-operations](pipeline-operations.md))                                                                                                                                                                                                    | Treat estimates as invoices                                                                    |

Escalation: the operator hands the recording/job/file/owner references to the project-owner; the project-owner decides on anything beyond the table. Keep a dated note on the SA-47 ticket or the incident ticket with the references and the action taken, never the credentials.

After a catalog restore, follow the [database recovery runbook](database-recovery.md) before resuming pilot operations.

## 6. Local cleanup

**Cleanup is currently disabled** in the Android app. Do not describe deletion as available to collectors, do not remove recordings through `adb`, a file manager or clearing app data, and do not use any cleanup command or flag that is not already in the merged source.

**Current safe path:** keep every original on the phone until cleanup is enabled and validated. If storage is short, follow the low-disk row in section 5 (stop, report, project-owner decides). A recording whose stage is only "uploaded" is still an original to keep.

**Pending cleanup gate:** SA-73 shipped the backend proof. The joined SA-23 flow still needs to pass with staff confirmation that a copy exists, an exact sealed inventory with full hashes, fresh proof from the original owner within 60 seconds, and intentional deletion of that exact recording. Keep originals until the joined flow is qualified.

## 7. Open gates (not done by this runbook)

- **Cloud and billing**: Render and Modal accounts, billing limits, spend or usage alerts, notification routes and recovery contacts are not configured by this change. A hosted pilot needs the project-owner's explicit approval and the hosted gates in [render-deployment](render-deployment.md) and [pipeline-operations](pipeline-operations.md#external-prerequisites-not-done).
- **Provider recovery**: Modal behavior (cold start, preemption, idle billing) is unqualified until an authorized canary.
- **Google sign-in, signed Android build, hosted cookies**: see [auth-and-access](auth-and-access.md#remaining-gates) and [mobile ownership](mobile-auth-and-ownership.md#remaining-gates).
- **Android upload and cleanup**: SA-57 shipped native upload owner fencing. Physical upload qualification and the joined SA-23 recovery and cleanup flow are pending (section 6).
- **Legal basis**: this repository records only references. Whether collection, processing or external inspection is permitted is decided by the project-owner outside it.
- **Physical-phone qualification (SA-48)**: separate ticket; not claimed here.

## Dry-run status

`packages/server/test-integration/pilot-operator-dry-run.test.ts` (uncached, throwaway Postgres, restricted `stateaction_app` role, synthetic users and evidence references only) runs the real `ingest-permission-cli.ts` and `dataset-sharing-cli.ts` as child processes with the owner credential, plus the access SQL from section 1.1, and checks the effect through the application role:

- collector: refused without evidence; admitted after `record`; refused when the role is disabled or after `revoke`; a second `revoke` fails; `--capture-only` records no processing cover;
- customer: a disabled customer cannot be a recipient; evidence alone and evidence plus clearance show nothing; `grant` shows the dataset; `revoke` and `disable` end visibility; a disabled customer role ends it on the next request.

Run locally: `pnpm --filter @stateaction/server integration test-integration/pilot-operator-dry-run.test.ts` with the guarded loopback fixtures described in [Local CI](../local-ci.md). Real Better Auth HTTP is covered separately by `web:auth-e2e`; the `psql` heredoc forms in section 1.1 and the Tailscale, phone and hosted steps are not exercised. Hosted CI results are reported separately.
