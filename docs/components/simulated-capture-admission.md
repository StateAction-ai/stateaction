# Simulated capture admission (SA-71)

Lets truthful emulator capture (`rgb_profile` `h264_mcap_simulation_v1`, `qualification=simulation_only`, `mapped_timeline_semantics=simulation_transport_only`) exercise the same authenticated upload, admission and processing path in **local/development**, without ever being relabelled as hardware and without any path in hosted environments. It is simulation evidence, not device, encoder or provider qualification.

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

- Flag absent (default, including production): create with the simulation profile is `403 forbidden` before any database access; a stored simulated manifest is `deferred` / `profile_unsupported` (never admitted).
- The flag is a startup configuration **error** (`admissionConfigFromEnv`, so `hosted:preflight` and the Next route both fail; routes answer 503) when `APP_ENV` is anything but `local`/`development` (production, staging, unset, misspelt) **or** a Render-injected variable is present (`RENDER`, `RENDER_SERVICE_ID`, `RENDER_INSTANCE_ID`, `RENDER_EXTERNAL_URL`, `RENDER_GIT_COMMIT`, `IS_PULL_REQUEST`, …), even when the flag value is `false` and even when `APP_ENV` is spoofed to `development`. `render.yaml` never defines the flag (guarded by `infra/test/blueprint.test.mjs`). The Render markers cover Render-hosted deployments; they are defense in depth, not a claim about arbitrary hosts (database/storage isolation in `config.ts` still applies).
- `SUPPORTED_RGB_PROFILES` still lists hardware profiles only; listing the simulation profile there is rejected. The flag alone adds it.
- The hardware path (`h264_mcap_v1`, v1 or v2 bodies) is unchanged.

## Migration 006

`packages/server/migrations/006_simulated_capture.sql` (001–005 unchanged; SA-25 continues at 007): widens `recordings.rgb_profile` to the two profiles and adds `recordings.simulation` (immutable by trigger, `SAC01`) with a CHECK that the simulation profile always has the marker and hardware never does; adds `recording_admissions.simulation` with the same rule for admitted rows. No grant change is needed (table-level INSERT/SELECT already cover the new columns; the web role still cannot update either column). The schema cannot tell whether a server may accept simulated rows; that is the runtime gate above.

## Provenance flow

create marker → `recordings.simulation` → sealed manifest `simulation` (what the phone actually declared at close; it may refine unknown→known and wins in views) → immutable `recording_admissions.simulation` → `jobs.task-input.v2` and `recording.v2`. A manifest whose profile differs from the registered one is rejected `profile_mismatch` (relabel attempts in either direction); a marker that is missing, extra or not `simulation_only`/`production_qualified=false` is `manifest_schema_violation`.

## Not done here (downstream gates)

- The server only checks the marker the client declared. **The worker must verify it against the actual MCAP `Profile` message** (profile, qualification, mapped timeline) at processing admission and fail on disagreement; worker input/outputs (SA-31) must carry `artifacts.simulation-provenance.v1` into every output manifest and the viewer. Not implemented in this ticket.
- **Root follow-up seam for the exporter (SA-31):** at downstream integration the worker/exporter binding must compare the actual MCAP `Profile` (profile, `qualification`, `mapped_timeline_semantics`) with the admitted `task-input.v2` `rgbProfile`/`simulation`, reject any mismatch, and for a simulated input add an explicit simulation-only warning to the result limitations (e.g. the export context's `extra_limitations`) and to the RRD notes, preserving `artifacts.simulation-provenance.v1` verbatim (unknown stays unknown). Earlier offline fixture exports do not prove this production binding, and no SA-31 module is copied into this ticket.
- Uploader wiring to the v2 route (SA-22/uploader22), mobile `published_contracts` regeneration and SA-25 job claims consuming `task-input.v2`.
- No physical-device, hardware-encoder or provider qualification; emulator evidence stays labelled simulation.
