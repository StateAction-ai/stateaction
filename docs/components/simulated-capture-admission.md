# Simulated capture admission (SA-71)

Lets truthful emulator capture (`rgb_profile` `h264_mcap_simulation_v1`, `qualification=simulation_only`, `mapped_timeline_semantics=simulation_transport_only`) exercise the same authenticated upload, admission and processing path in **local/development**. Emulator inputs remain unavailable on Render. The separately scoped IndEgo import below uses the simulation profile to preserve public-video provenance.

## Additive contracts (`catalog.v6`)

`catalog.v6.json` is an exact superset of the immutable `catalog.v5.json` (v1–v5 and every published schema file are byte-for-byte unchanged; `schemas.lock.json` only gains entries). It adds seven contracts. A registry version is **not** a route version: every route stays under `/api/v1`.

| Contract                             | Replaces for simulation                       | Notes                                                                                                                                                                 |
| ------------------------------------ | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `artifacts.simulation-provenance.v1` | –                                             | Shared marker (snake_case) embedded as `simulation` in the source manifest; also the reusable seam for downstream output manifests.                                   |
| `http.simulation-provenance.v1`      | –                                             | Same marker, camelCase, for HTTP and job documents.                                                                                                                   |
| `artifacts.recording-source.v2`      | `recording-source.v1` (frozen)                | Adds the simulation profile + marker; also admits ROS slash schema names (`geometry_msgs/msg/PoseStamped`), which v1 cannot carry. Hardware documents may use v2 too. |
| `http.recording-create.v2`           | `recording-create.v1` (frozen, hardware-only) | Body `schema` `stateaction.recording_create.v2`.                                                                                                                      |
| `http.recording.v2`                  | `recording.v1` (frozen)                       | Adds `rgbProfile` and the marker.                                                                                                                                     |
| `http.recording-registration.v2`     | `recording-registration.v1`                   | Wraps `recording.v2`.                                                                                                                                                 |
| `jobs.task-input.v2`                 | `task-input.v1` (frozen)                      | `process_recording` carries `rgbProfile` (+ marker for simulation).                                                                                                   |

The marker is closed and cannot say anything hardware-like: `qualification` is always `simulation_only`, `production_qualified` always `false`, and `camera`, `encoder` and `clock` provenance are each `{status: "known", label}` (a bounded label from actual source evidence) or `{status: "unknown"}`. Unknown is never filled in. A simulation profile **requires** the marker and the hardware profile **forbids** it, in the create body, the source manifest, the recording view and the job input. The capture contracts (`Profile.schema.json`, the camera wire schema, hand-pose thresholds, the raw source) are not touched.

## Exact local API versioning

| Operation                     | Frozen v1 behaviour                                                                                                                               | v2 behaviour                                                                                                                                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/v1/recordings`     | Body without `schema` = `recording-create.v1`: hardware only, answered as `recording-registration.v1`, `Content-Type: application/json`.          | Body with `schema: "stateaction.recording_create.v2"` = `recording-create.v2`. Answered as `recording-registration.v2` with `Content-Type: application/vnd.stateaction.recording.v2+json`. A hardware v2 body is legal and carries no marker. |
| `GET /api/v1/recordings/{id}` | Default (no v2 `Accept`): `recording.v1` for hardware recordings. **A simulated recording is never downgraded: it answers `406 not_acceptable`.** | `Accept: application/vnd.stateaction.recording.v2+json` returns `recording.v2` for any recording.                                                                                                                                             |
| `POST …/seal`                 | Hardware: `recording.v1` (v2 on explicit `Accept`).                                                                                               | Simulated recordings always answer in v2 (the seal request carries no profile).                                                                                                                                                               |
| Sealed source manifest        | `schema: stateaction.recording_source.v1` (hardware, dotted schema names only).                                                                   | `schema: stateaction.recording_source.v2`. Admission selects the contract from this field. Sealers (SA-22) write v2 and validate with `validateBytes("artifacts.recording-source.v2", bytes)` (Python/Dart: same contract id).                |
| Job input                     | `task-input.v1` (`schemaVersion: 1`).                                                                                                             | `task-input.v2` (`schemaVersion: 2`), built by `admission.processRecordingTaskInputV2(pool, jobId)` from that job's immutable admission row.                                                                                                  |

## Runtime gate

Simulated input is accepted only when **both** hold: `APP_ENV` is exactly `local` or `development`, **and** `ALLOW_SIMULATED_CAPTURE_INPUTS` is exactly `true`.

- With neither setting present, create with the simulation profile is `403 forbidden` before database access. A stored simulated manifest is deferred with `profile_unsupported`.
- The flag is a startup configuration **error** (`admissionConfigFromEnv`, so `hosted:preflight` and the Next route both fail; routes answer 503) when `APP_ENV` is anything but `local`/`development` (production, staging, unset, misspelt) **or** a Render-injected variable is present (`RENDER`, `RENDER_SERVICE_ID`, `RENDER_INSTANCE_ID`, `RENDER_EXTERNAL_URL`, `RENDER_GIT_COMMIT`, `IS_PULL_REQUEST`, …), even when the flag value is `false` and even when `APP_ENV` is spoofed to `development`. `render.yaml` never defines the flag (guarded by `infra/test/blueprint.test.mjs`). The Render markers cover Render-hosted deployments; they are defense in depth, not a claim about arbitrary hosts (database/storage isolation in `config.ts` still applies).
- `SUPPORTED_RGB_PROFILES` lists hardware profiles only. The emulator flag adds the simulation profile for local development.
- The hardware path (`h264_mcap_v1`, v1 or v2 bodies) is unchanged.

## Hosted public-video canary (SA-81)

On Render production with the Modal backend, `STATEACTION_PUBLIC_VIDEO_CANARY`
accepts a JSON object with `ownerUserId`, `clientRecordingId` (v4 UUID) and
`sourceSha256` (the approved simulation MCAP digest). Keep the emulator flag
absent. The collector must have active capture and processing permission, and
the registration and sealed manifest must identify
`IndEgo.User_15_410_0511_1_480` with unknown encoder and clock provenance.
The setting accepts only the pinned MCAP digest for the approved 299-second clip.

While the setting is active, admission selects only the configured
recording's first job with the `indego_hosted_canary@1` recipe. The worker
verifies the MCAP digest before model execution. Automatic dispatch is disabled
in this mode. Keep repair cron suspended, start the exact admitted job once
with the operator's Render CLI, and settle its slot before restoring settings.
Run both GPU stages in single-use containers with timeouts of
800 and 1,300 seconds and set `STATEACTION_MODAL_HAND_POSE_TIMEOUT_S=1100`
for the CPU function before deployment. The recipe records USD 3 per job
and a 5,000-second execution deadline. The provider timeouts bound execution
spend. The recipe's dollar field records the cap.

Remove the canary setting, remove temporary Modal wiring and restore the
prior live versions after the run. The resulting imports and outputs retain
the simulation marker. Two-hour processing remains unqualified.

### Hosted trial on 2026-11-24

Render run `trn-0b54gdc2ed47sjq0s73c7hku0` used candidate `23a642b`,
workflow version `wfv-dc2e6ics728c73ab0rvg`, and the 299-second IndEgo
source. The verified import preserved all 2,990 frames on one timeline.

| Stage     | Worker wall time | Cold load | GPU generation | Sampled CPU core-seconds | Result                                    |
| --------- | ---------------: | --------: | -------------: | -----------------------: | ----------------------------------------- |
| TempSeg   |            249 s |  196.10 s |        14.98 s |                   257.43 | 25 windows, 61 segments, 0 failed windows |
| Captioner |            386 s |  201.35 s |        48.04 s |                   440.32 | 61 captions, 0 failed, 0 not captioned    |
| Hand pose |  No worker start |         — |              — |                        — | Container import failed                   |

Modal measured 252.72 seconds of TempSeg execution and 389.35 seconds of
Captioner execution on RTX PRO 6000. List-price compute was USD 0.6991.
Workspace gross metering rose about USD 0.74 during the trial, from USD
15.39026645 to USD 16.13026350. The workspace figure includes usage beyond
the two measured calls.

The CPU runner imported `/root/modal_app.py`, where its checkout-path lookup
raised `IndexError` before the worker started. The fix moves the lookup into
image build code. The exact container path reproduced the error locally and
passed 20 consecutive wrapper test runs after the fix. A separate Modal CPU
startup check on `32390d8` returned the expected invalid-bootstrap result
without claiming a job or running a model
(`fc-01M85M8R56XNE0VHS2Z9APD5C9`).

The recipe job recorded the expected 5,400-second deadline. The Render task
ended with `call_not_provably_terminal_after_cancel`. Modal returned
`RemoteError` for the stopped hand-pose call and no v2 result. SA-44 later
verified that Modal assigned no task or start time, then settled the stage
and job as failed with `terminated_before_start`. The exact recovery replay
was a no-op. The slot was empty, and the earlier stage rows and all nine
file rows matched the preflight read-back. The job did not reach output
acceptance.

Render returned to its prior web and workflow code, dispatch disabled, repair
cron suspended and Postgres private. The test collector's permission was
revoked, its role was disabled, and the Modal apps stopped.

### Serial replay on 2026-11-24

Render run `trn-0b54gdc2f6tdson7000dc8890` used candidate `dd35132` for
the same 299-second clip. TempSeg processed 25 windows and 2,990 frames
in 226 s, with 175.93 s of cold load, 15.73 s of GPU generation, and
247.15 sampled CPU core-s. It returned 62 segments and zero failed windows.
Captioner took 383 s, with 194.66 s of cold load, 48.48 s of GPU generation,
and 454.19 sampled CPU core-s. It produced 62 captions with zero failed
and zero omitted. Both used RTX PRO 6000.

The CPU worker started and returned `model_load_failed`, with 4 s stage wall
time and 1.50 sampled CPU core-s. Its failure manifest was accepted and
the slot released. The staff Pipeline listed the failed job, and the
recording had no accepted Review outputs. Total measured list compute was
USD 0.67104. Workspace gross metering rose USD 0.73003 with USD 0 billed.
The prior configuration was restored.

The MediaPipe native library links to `libEGL.so.1` and
`libGLESv2.so.2`. Masking either dependency in an isolated local mount
namespace reproduced the model-load error. The Modal image installs both
libraries and loads the pinned model at build time, before any hosted job
can claim or read a recording.

SA-84 merged during this replay and introduced the parallel graph.
Migration 013 adds the graph flag, defaults existing jobs to serial, and
requires all stages to settle before a parallel closure. A third 299-second
job was approved to qualify the parallel graph with a USD 3 cap.

### Parallel hosted qualification on 2026-11-24

Render task `trn-0b54gdc2foa43241c73fbbho0` ran the approved 299-second
IndEgo file on processing candidate `674e8d0`, web deployment
`dep-dc2fmre7bikc738htp20`, and workflow `wfv-dc2fj0e8bjmc73fi0490`.
Recording `0ca1abc4-32aa-4265-9486-998b3eed7bcd` and job
`55d2586e-770e-49e1-91dc-daf539c4f6ad` preserved all 2,990 frames.

| Stage     | Worker wall | Modal execution | Sampled CPU core-s | Model cold load | GPU generation | Output                                    |
| --------- | ----------: | --------------: | -----------------: | --------------: | -------------: | ----------------------------------------- |
| TempSeg   |       235 s |        239.39 s |             259.32 |        187.64 s |        15.85 s | 25 windows, 62 segments, 0 failed windows |
| Captioner |       372 s |        375.69 s |             445.38 |        195.85 s |        48.22 s | 62 captions, 0 failed, 0 omitted          |
| Hand pose |       234 s |        235.40 s |             117.23 |               — |              — | 2,990 frames, 10 clips                    |

Both FLORA stages observed RTX PRO 6000. Hand pose ran on CPU, and the
worker did not time its model load separately. The hand-pose and segment
workers overlapped by 176 seconds. The controller closed the 73-file
inventory after all three stages settled and published the candidate.
Acceptance verified 108,805,309 bytes, within the 77-file and
6,442,450,944-byte bounds for the 10-clip closure. The job completed in
710.475 seconds against its 5,000-second deadline and released the slot.
The closure digest was
`90e636ee02d069d0edcb695aaa9201b35505b27f38c53460ef827596882ecf45`.

Render lost an acknowledgement from the jobs API after the result had
been accepted. One native Render retry completed the task without
creating another job or spawning another Modal call. Each of the three
stage functions recorded one call. Measured compute was USD 0.71929 at
list price, against the USD 3 cap. Workspace gross moved from USD
16.76032220 to USD 17.65453147, and Modal reported USD 0 billed. That
workspace increase includes other metered usage.

#### Production migration and rollback

Before migration, PostgreSQL 17.12 was at schema version 12 with two
existing jobs and an empty admission slot. Migration 013 took 334 ms in
one transaction with a 2-second lock timeout and a 20-second statement
timeout. The job count and table file node were unchanged. Both existing
jobs stayed serial, and only the new routine received its required app
role grant. Web health passed before and after, and the temporary
PostgreSQL allowlist was removed. The migration did not require downtime.

The migration preceded the matched parallel web and workflow rollout.
Rollback restores the prior web and workflow code and settings while
retaining the additive schema. A failure before migration commit rolls back
the transaction. The prior web commit `69156c3` and workflow commit `a6328d3` were
restored. Dispatch stayed disabled, the repair cron remained suspended,
the temporary collector was retired, and both Modal apps stopped.

The staff reads found the accepted recording in Pipeline, Review and the
recording clips view after rollback. The signed MP4 and Rerun range reads
returned `206` with the console origin allowed. The final-head SA-141 UI
readers returned the same output. The rebase preserved every processing
source file and the reviewed SA-81 patch.

## Migration 006

`packages/server/migrations/006_simulated_capture.sql` (001–005 unchanged; SA-25 continues at 007): widens `recordings.rgb_profile` to the two profiles and adds `recordings.simulation` (immutable by trigger, `SAC01`) with a CHECK that the simulation profile always has the marker and hardware never does; adds `recording_admissions.simulation` with the same rule for admitted rows. No grant change is needed (table-level INSERT/SELECT already cover the new columns; the web role still cannot update either column). The schema cannot tell whether a server may accept simulated rows; that is the runtime gate above.

## Provenance flow

create marker → `recordings.simulation` → sealed manifest `simulation` (what the phone actually declared at close; it may refine unknown→known and wins in views) → immutable `recording_admissions.simulation` → `jobs.task-input.v2` and `recording.v2`. A manifest whose profile differs from the registered one is rejected `profile_mismatch` (relabel attempts in either direction); a marker that is missing, extra or not `simulation_only`/`production_qualified=false` is `manifest_schema_violation`.

## Not done here (downstream gates)

- The server only checks the marker the client declared. **The worker must verify it against the actual MCAP `Profile` message** (profile, qualification, mapped timeline) at processing admission and fail on disagreement; worker input/outputs (SA-31) must carry `artifacts.simulation-provenance.v1` into every output manifest and the viewer. Not implemented in this ticket.
- **Root follow-up seam for the exporter (SA-31):** at downstream integration the worker/exporter binding must compare the actual MCAP `Profile` (profile, `qualification`, `mapped_timeline_semantics`) with the admitted `task-input.v2` `rgbProfile`/`simulation`, reject any mismatch, and for a simulated input add an explicit simulation-only warning to the result limitations (e.g. the export context's `extra_limitations`) and to the RRD notes, preserving `artifacts.simulation-provenance.v1` verbatim (unknown stays unknown). Earlier offline fixture exports do not prove this production binding, and no SA-31 module is copied into this ticket.
- Uploader wiring to the v2 route (SA-22/uploader22), mobile `published_contracts` regeneration and SA-25 job claims consuming `task-input.v2`.
- No physical-device, hardware-encoder or provider qualification; emulator evidence stays labelled simulation.
