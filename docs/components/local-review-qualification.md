# Local staff-to-customer review qualification (SA-40)

Scope: prove review, assignment and customer isolation against **one actual
uploaded native source** that the real hand-pose CPU run (profile `hand-pose-cpu-v1`) processed and
the real acceptance transaction accepted. No new contract, migration or
acceptance helper. The qualifying path never uses `goldenRRD`, `SEED`, the
catalog fixture or a hand-written acceptance row; the SA-39 browser test
(synthetic catalog rows) is not SA-40 proof.

Historical local qualification passed
(backend source `62c6a2dbe487695a9b714f9457258854f41d9738`, migration 009
applied). The run is split across three guarded invocations of the same driver
because the first full run stopped at a wrong assumption of mine (see Run
history). Everything here is simulation (Android emulator source, local
provider/runner, loopback runtime, software WebGL). It is not hardware, R2,
Google/OAuth, hosted or pose-accuracy qualification.

## Separated claims

Simulation (Android emulator, guest software H.264 encoder), source integrity
(declared size/SHA, receipts), hand-detection coverage (an honest zero-hand
result is valid; the 0.5 thresholds stay), pose accuracy (not claimed) and
hardware (not claimed) are reported separately. Chrome WebGL is software
rendered and labeled `software-rendering-not-accelerated`.

## Driver

`apps/web/test-e2e/local-review-qualification.mjs`, run entirely inside one
guard (API, operator CLI and browser daemon):

```sh
SA40_CONFIG=/path/to/protected/sa40.json \
SA40_OUTPUT_DIR=artifacts/sa40/current-run \
  agent-resource run -- node apps/web/test-e2e/local-review-qualification.mjs
```

It talks to an already-running runtime (the synthetic one on loopback 3025); it
starts no stack, creates no database and runs no bootstrap. Phases:

1. **Trace**: read-only owner SQL plus root's completed-run report (see
   "Config and phases"); the accepted clip is discovered through the staff
   `GET /api/v1/clips?recordingId=` grid, never supplied by config. The viewer
   bytes streamed through the read broker are hashed and compared to the
   accepted file record. Zero clips is reported honestly and stops the review
   phases.
2. **Review matrix (API)**: unreviewed clip is invisible to customers; approve
   with no datasets; assign to two datasets; reject and verify every membership
   is gone and dataset revisions bumped once; reapprove (omitted selection) and
   verify no silent restoration; blank label, stale clip revision, stale dataset
   revision, changed job/result and two concurrent writers (exactly one wins,
   the loser is a 409 that changes nothing); idempotent replay.
3. **Access matrix**: anonymous/collector/outsider/customer against the review
   route, the catalog and the clips list (denied), raw source/recorder metadata
   file reads (no route; reads accept only `thumbnail_jpeg`/`viewer_rrd`),
   hidden/unassigned clips (identical 404), customer DTO field whitelist (no
   notes, QC, hashes, keys, job/recording ids).
4. **Revocation**: operator CLI (`dataset-sharing record|clear|grant|revoke|
disable`, owner credential only) then, after each of grant disable, evidence
   revoke, membership removal, latest-review rejection and access disable, fresh
   metadata and fresh `reads` URLs are denied (404). A URL issued before
   revocation is fetched once afterwards and its outcome **recorded** (it may
   succeed until expiry); the TTL is read from the response (`ttlSeconds`,
   hard maximum 60 s). No immediate-revocation claim is made.
5. **Browser**: staff open the clip Processing page at
   `/recordings/{recordingId}/clips/{clipId}/processing`, then follow the processed
   clip link with a return path to the recording-filtered Data browser. The clip's Back to Data browser link restores the recording
   filter and clip. The customer opens the same `/clips/{id}` URL. Both show
   the latest approved label, the Rerun canvas renders, no release/export is
   created or needed, customers get no review editor. Screenshots at 1280 and
   375 px go to `$SA40_OUTPUT_DIR/browser/`.

Evidence JSON (`$SA40_OUTPUT_DIR/evidence-<phase>.json`, ignored when stored under
`artifacts/`) holds the tested revision, IDs, statuses, hashes and TTLs only: no cookies, passwords, signed URLs, raw bytes or payloads.

## Run history (honest)

Evidence JSON files are in ignored `artifacts/sa40/`; screenshots in
`artifacts/sa40/browser/` (staff grid/clip and customer clip at 1280 and 375 px,
inspected: real Rerun renders the real clip, "Software rasterizer" shown).

1. `trace` and `probe` (read-only): 29 and 36 checks passed. Probe found the
   `--state` launch flag is ignored by agent-browser (the state file is now
   loaded with `state load`), and that screenshots were taken before the viewer
   finished loading (now waits).
2. `all`: stopped at "customer dataset list shows only the granted dataset".
   The runtime also holds two pre-existing seeded datasets, so the assertion
   was wrong; it now requires the granted dataset present and the ungranted one
   absent. By then the whole review matrix (blank/stale/wrong-identity/stale
   dataset rollback, approve unassigned, assign to two datasets, concurrent 201/409,
   identical replay 200, changed-body 409, reject removes all, reapprove no
   restore) and `assign D1` + evidence/clear/grant had passed on the real clip.
   The clip cannot be reviewed from revision 0 again (append-only), so recovery
   is explicit: `SA40_PHASE=access` with `SA40_RESUME_EVIDENCE` pointing at that
   run's evidence file resumes after the review matrix from the live state.
3. `access`: customer isolation matrix, five revocations and the measured URL
   lifetime passed; the customer browser then failed to launch because two
   Chromes exceeded the guard's pids limit. The staff browser is now closed
   before the customer one starts.
4. `browser` (same recovery, browser stage only): staff navigated from the
   former Pipeline page to the recording grid and clip. The customer's visit
   to the same clip URL passed.

Not one end-to-end invocation: the review matrix, access/revocation stage and
browser stage were each observed once on the real clip, in that order, with one
extra read-only re-run of the guard. An integrated re-run needs a new accepted
clip (review is append-only).

## Measured results

- Fresh customer metadata and URL issuance were denied (404; 403 for a disabled
  customer account) after dataset access disable, membership removal,
  latest-review rejection, evidence revocation and customer role disable.
- A previously issued presigned viewer URL stayed usable (HTTP 206) after
  revocation and was refused first at **60.3 s** after issue (TTL reported 60 s,
  sampled every 4 s). Revocation is therefore NOT immediate for URLs already
  issued; the bound is the 60 s TTL.
- No source, job, closure, verification, execution-evidence or clip row changed
  (before/after row digest); the one owner mutation outside the operator CLI is
  a temporary `access.enabled=false` for the customer role, restored.
- Residue left by design (never deleted): two `sa40-<date>-N` datasets, review
  rows, and sharing evidence/grants for dataset 1 (customer currently granted).

## Config and phases

`SA40_CONFIG` (0600, outside the repo) holds origin, four logins (opaque auth
ids for staff/customer), `recordingId`, `jobId` and `expected` (native recording
id, three source file IDs and SHA-256 digests, `recorderMetadataPath`,
`actualExecutionEvidencePath` and `codeRevision`). Set `codeRevision` and the
runtime's `PROCESSING_CODE_REVISION` to the full Git SHA of the tested runtime.
The driver requires that revision in both the completed-run report and the
admitted job input. Give each run a fresh private `SA40_OUTPUT_DIR` to preserve
prior receipts. The owner DSN comes only from
`SA40_OWNER_DATABASE_URL` loaded with `node --env-file=` inside the guard.
Phases via `SA40_PHASE`: `trace`, `probe`, `all` (default), `access`, `browser`.

Trace evidence is read from the database, not config: the job and accepted
candidate bound by invocation nonce and manifest SHA, `job_input` backend `local`
and profile `hand-pose-cpu-v1`, a `local_child_reaped` execution evidence row
bound to the job's execution reference with a non-fixture `recorded_by`, the
released admission slot, all verified output rows, and agreement with root's
completed-run report. The native recording UUID is read from the SHA-checked
provider-fetched recorder metadata. `profile_revision` is a release/profile
name and is not conflated with the adapter module name.
