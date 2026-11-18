# Worker output sealing and atomic result acceptance (SA-28)

Implemented in `packages/server/src/acceptance`, migration `009_output_acceptance.sql`, additive `catalog.v9`, the job routes under `apps/web/app/internal/v1/jobs`, and the worker pipeline `hand_pose_cpu_v1` (`workers/processing`). v1-v8 published documents and migrations 001-008 are untouched. Local protocol tests are not Render, Modal, R2 or physical-device qualification.

## Principle

A worker callback is a **claim**, never a decision. The API selects a result only when it holds, at one instant inside one database transaction, every fact below. Capacity (the single admission slot) is released only by SA-25's two-fact rule, a terminal business state **and** exact physical execution evidence; this ticket supplies the terminal business state, SA-26/27 supply the evidence.

## Pieces

| Piece             | Where                                                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Output transport  | SA-20/21 job routes (`outputs`, `parts/sign`, `parts/receipts`, `complete`, `reconcile`, `cancel`, `restart`), gated by `assertJobAuthority`, now the **open-inventory** predicate (below)  |
| Task input        | `GET /internal/v1/jobs/{id}/task-input` (`job:input`, existing `jobs.task-input.v2`): the admitted recording id, profile revision, capture profile and simulation marker of the claimed job |
| Close inventory   | `POST /internal/v1/jobs/{id}/outputs/close` (`job:output`; `jobs.output-close.v1` → `jobs.output-closure.v1`)                                                                               |
| Result candidate  | `POST /internal/v1/jobs/{id}/result` (`job:result`; frozen `jobs.result-candidate.v1` → `jobs.result-ack.v1`); provisional, selects nothing                                                 |
| Verification      | outside any transaction, resumable: manifest hash + contract + catalog comparison, then each output streamed through SHA-256                                                                |
| Atomic acceptance | one transaction: lock recording then job, recheck every fact live, insert clips, mark files `verified`, job `succeeded`, recording `reviewable`, candidate `accepted`                       |
| Defence in depth  | database triggers: closed-inventory write blocks, candidate pinning, `jobs_acceptance_guard` (no `succeeded` without the facts), `recordings_review_guard`                                  |

## Open inventory and close

`assertJobAuthority` (every output allocate, sign, receipts, complete, cancel, restart) now uses `JOB_OUTPUT_OPEN_SQL`: the full current-claim predicate **plus** no closed inventory **plus** no terminal execution evidence. After either, no byte can be added, restarted or cancelled. The claim, heartbeat and input-read predicate is unchanged.

`close` locks the job row, requires the claiming nonce, and inserts one append-only `job_output_closures` row. The caller supplies no file list and declares `outcome` (`succeeded`/`failed`). The migration trigger enforces: every output file `completed`, exactly one `result_manifest`, caps from the immutable `job_inputs`, every output has a server slot that matches its role (`result-manifest.json` or `clips/NNN/{rgb.mp4,hand-arrays.npz,hand-observations.json,frame-map.json,thumbnail.jpg,viewer.rrd}`), and for a `succeeded` closure exactly six roles per clip with contiguous ordinals. A `failed` closure may contain partial clip files; they are retained and never accepted. `inventory_sha256` is computed by the database over `(slot, file id, role, size, sha256)` sorted by slot. A repeat with the same nonce and outcome returns the stored closure.

Database triggers also refuse any new output file, slot or receipt, and any state/epoch change of an output file, once the closure exists (the only legal change is `completed → verified` at acceptance).

## Candidate

`result` requires the live current claim (state `running`, deadline, pointer, owner role, permission, **nonce**), a closure for the same nonce, outcome and manifest file, and the manifest SHA-256 equal to that file's declared hash. It writes one `job_result_candidates` row (`provisional`) and moves `running → result_pending`, which ends every worker mutation. The exact current claim may still report an already closed inventory after terminal evidence exists, but can never add output. A byte-identical replay is idempotent; a different candidate is `409`; stale, cancelled, expired or revoked claims are `403`.

## Verification (no transaction held)

`advanceResult` runs it. Every bound is finite and configured (`acceptance/config.ts`): at most 600 files, 4 GiB aggregate (`ACCEPTANCE_VERIFY_MAX_BYTES`), 120 s per object (`ACCEPTANCE_VERIFY_OBJECT_TIMEOUT_MS`), 25 s per call slice, a one-hour verification wall, after which the job goes to `needs_attention` (candidate untouched, slot held) rather than being failed. Reads use catalog-generated object keys and the configured bucket only, sequentially, one streaming SHA-256 each, never loading an object into memory, with no redirect handling and a size cut-off at the declared size. Progress is durable per file in `job_output_verifications` (bound to the closed inventory digest), so a request that ends mid-way resumes from `reconcile` without repeating files.

Checks, each with an actionable `reasonCode`: the manifest (≤ the admitted control-document size) hashes to the declared SHA-256 and validates as `artifacts.processing-result.v2`; job, recording, source-manifest digest and provenance (code revision, image spec, MediaPipe model `fbc2a300…cde1`, config digest, profile revision) equal the immutable `job_inputs`; the **attestation** names the exact claim nonce and the ACTUAL capture profile, which must equal the admitted one; simulated captures must carry the identical simulation marker, hardware captures none, unknown camera/encoder/clock staying unknown; a succeeded result states the source was read to EOF and lists the catalog `source_mcap` with identical id, size and SHA-256; the manifest `outputs` equal the closed inventory exactly (id, role, slot, size, SHA-256) and every clip names six files at its own `clips/NNN/` slot; `summary` equals the manifest (check counts, clip count); a success has at least one clip; each stored object hashes to its declared SHA-256 and size.

## Atomic acceptance

```
BEGIN
  lock recording FOR UPDATE, then job FOR UPDATE            -- one lock order everywhere
  require job.state = 'result_pending' and candidate 'verified'
  require EXISTS job_execution_evidence                      -- exact physical terminal evidence
  require job_output_inventory_digest(job) = candidate.inventory_sha256
  require recording.current_job_id = job, not deleted, status 'processing'
  require owner collector role AND ingest_permission_ok(..., processing)   -- current permission
  require candidate.received_at <= execution_deadline        -- the fixed deadline is never extended
  INSERT clips; UPDATE files 'verified' (outputs + source_mcap)
  UPDATE jobs 'succeeded' (+ manifest) | 'failed' (worker-reported failure, manifest kept)
  UPDATE recordings 'reviewable' (success only); UPDATE candidate 'accepted'
COMMIT   -- dispatch_try_release frees the slot: terminal state + evidence now both hold
```

A recheck failure rejects the candidate and fails the job with `inventory_changed`, `recording_replaced`, `permission_revoked` or `deadline_exceeded`; a cancel in progress is left to the cancel path. Concurrent calls serialize on the job row; the loser sees `succeeded` and returns the stored result.

## Arrival orders

- **Result first, evidence later.** Candidate → verified → job stays `result_pending`, slot held. `record_execution_evidence` calls `advanceResult` after its own commit, and `reconcile` repairs any pending job (it runs before admitting the next one), so the same atomic step accepts.
- **Evidence first, result later.** Terminal evidence on a `running` job does **not** fail it. The exact current claim may still post its candidate for an already closed inventory; verification and acceptance then run as above. The finite grace (`ACCEPTANCE_RESULT_GRACE_SECONDS`, default 120 s, never beyond the fixed deadline) runs from the exact evidence timestamp and is never reset by reconcile or replays. A candidate received before the cutoff stays eligible however long verification then takes; one arriving after it is refused (`403`), and `reconcile` fails a still-silent job `worker_exited_without_result`, whose existing evidence completes the release.
- **Duplicates and replays.** Identical close, candidate and advance calls are idempotent; evidence is write-once.

## Fixture boundary

The database guards are unconditional: there is no policy flag, bypass table or test switch, and no closure timing exception. `acceptProcessingResult` (the SA-13 catalog helper) only inserts clips and moves the job; the `succeeded` and `reviewable` triggers then demand the same closure, verified candidate, per-file verification rows and exact terminal evidence as for a real worker. Seeds and legacy suites obtain those facts in the production order through two owner-credential helpers in `src/jobs/fixtures.ts`, never imported by a route or the service: `fixtureCloseOutputs` (intended slots and the closed inventory while the job is still `running`) and `fixtureAcceptResult` (candidate, per-file verification rows and `local_child_reaped` evidence with `recorded_by = 'fixture'`, then the unchanged helper). Both refuse the restricted application role and any job that is not an explicit fixture job (local backend, `fixture-` execution reference), and neither truncates a table or disables a trigger. Synthetic means fixture bytes, no object read; real objects are verified only by the acceptance service. `acceptance.test.ts` runs the real service against real Postgres and S3 and shows the restricted role cannot write the facts a succeeded job needs.

## Worker pipeline `hand_pose_cpu_v1`

Selected by the stdlib-only `run_job` after the claim is won; nothing heavy is imported before. It reads the admitted task input, refuses to run if its exporter configuration digest or model digest differs from the claim's `digests`, then runs the **existing SA-31 exporter** (`export_artifacts`; nominal rate-30 proxy encoder, original PTS, ruleRevision 2, 0.5/0.5 thresholds, no resampling) with a server-backed `OutputSink`: each closed file is allocated, uploaded in parts, receipted and completed through the job routes, the manifest cites the **server** file ids and slots, the worker closes the inventory and posts the provisional candidate. The exporter's narrow SA-28 extension emits `processing-result.v2` with the claim-bound attestation, checks the ACTUAL MCAP `rgb_profile` against the admitted one, and for simulated captures carries the simulation marker into the manifest limitations and each viewer RRD's embedded notes. Any failure uploads a diagnostic v2 manifest and reports a `failed` candidate; an honest zero-hand source is a valid success. `PROCESSING_CONFIG_SHA256` is the exporter's canonical `config_sha256(ExportLimits, StreamLimits)` value (ruleRevision 2), never an arbitrary string.

## Honest limits

- Verification re-reads every output through the API process (bounded above). A job above the budget is rejected `verification_budget_exceeded`.
- The attestation of EOF source verification is the worker's, compared to the sealed catalog digest; the API does not re-read the multi-GB MCAP.
- The current recorder emits capture wire v1.1. SA-29 tracks streaming support for wire v1.2, which shares the admission profile name. Enable a v1.2 recorder only after the worker can verify that wire format.
- A signed source URL lives at most 15 minutes and is requested once per run; a resumable ranged source read is not implemented.
- A worker cannot delete uploaded objects of a failed run; they stay in the closed (failed) inventory for diagnostics.
- Not Render/Modal/R2/phone qualification.
