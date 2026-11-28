# Owner-bound native upload (SA-22 app integration)

Android only, behind two independent gates. iOS stays on its existing path
(deferred SA-52/58/64/65).

## Roles

| Layer                                             | Owns                                                                                                                      |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Dart (`apps/mobile/lib/src/modules/owner_upload`) | Visible Upload/Resume/Start-over, create.v2 registration, seal, per-file allocation, enqueue, status. Control plane only. |
| Native (SA-57, `packages/stera_recorder`)         | Bytes, part URL renewal, receipts, reconcile, completion, backoff, OS job. Runs while Dart is suspended.                  |
| Server                                            | Part plan, epochs, MPU state, verification worker.                                                                        |

No storage credential, mobile bearer token, proxy upload or second session
exists: the same Better Auth cookie session authenticates the app and the
native uploader.

## Gates (default off)

1. `.env` `OWNER_NATIVE_UPLOAD=true` (Dart; fails closed).
2. Native manifest meta-data `ai.stateaction.native_upload.enabled=true`
   (SA-57; `capabilities().gateEnabled`).

The coordinator owns the final flip. With either gate off, no native call is
made, the Home section renders nothing and capture/auth behave as before.

## Upload flow (one visible tap)

1. Ownership: `CaptureOwnerLedger` session record must name the current
   `networkOwnerId`; ownerless data requires the existing explicit recovery.
2. Proof: `GET /api/v1/me` for that owner (active collector) before any effect.
   Every later awaited step re-checks controller epoch, auth epoch, cookie-jar
   generation and network owner.
3. Journal (once): strict `FinalSourceEvidenceReader` re-reads the native
   `finalization_journal.json` (`FINALIZED`), `metadata.json` closure
   (`closed`/`completed`/`fsync`, token and recording id agree, no
   `recovery_required.json`) and builds the `http.recording-create.v2` request.
   Client UUID, owner, backend origin, profile and capture-config hash are
   written to the append-only `SourceJournal` before the first API call.
   - Profile follows the recorder's own metadata: hardware `h264_mcap_v1`, or
     the explicitly enabled emulator profile `h264_mcap_simulation_v1` with
     `camera/encoder/clock` provenance all `unknown`.
   - `startedAt` is the wall-clock start from the native session directory name;
     if unknown the upload is blocked, never guessed.
4. Register -> `SourceSealer.freezeRegistration`.
5. Two-phase seal (the server chooses file ids and `seal` only accepts the
   complete inventory it already reserved):
   1. freeze the genuine closure and hash every original file (SA-18 fd-bound);
   2. reserve each original file with `POST /api/v1/uploads` under a stable
      `clientUploadId`, check the reply (recording, role, size, digest) and bind
      the returned **server** file id durably in the journal (`file_reserved`);
      a lost reply is recovered by repeating the identical request;
   3. build and hash the source manifest listing the files by those server ids
      (it never lists itself), then reserve the manifest the same way;
   4. `GET recording`; only an unsealed recording is sealed, with the complete
      server-id inventory, and the returned inventory is compared exactly.
      Local planning ids (UUIDv5) remain for standalone use without a server; a
      journal frozen that way is never remapped (blocked as `legacy_local_ids`).
6. Per file `GET /api/v1/uploads/{serverFileId}`, response compared exactly with
   the sealed inventory, then
   `enqueue(plan verbatim, confined source + SA-18 identity)`. The manifest is
   enqueued from the app-private journal directory with its own hashed identity.
7. `resume()` from the visible tap.

A repeated tap resubmits nothing: journal state, `GET recording` and native
task state decide each step.

## States shown to the user

Upload / Resume / Sign in / Start over, progress from landed parts, and
honestly separated server states: _Uploaded, the server is verifying it_
(transport complete) versus verified. Auth expiry asks for same-owner sign-in;
part URL expiry is native; an uncertain `completing` is only reconciled;
an expired MPU offers _Start over_, which calls restart only when the server
itself reports `expired`. Nothing restarts, replans or resubmits blindly.

## Session hand-off

`SessionCookieJar` carries a monotonic `revision` (persisted floor, legacy = 0)
and a generation-fenced `adoptSnapshot`. `NativeSessionBinder` binds the jar to
native, adopts a newer native rotation only for the exact cached/verified owner
and origin before a refresh uses the old cookies, never during a pending
sign-in, and queues `unbindOwner` synchronously at logout / sign-in start
(never behind hashing). Journals are never deleted or adopted.

## Capture and legacy coordination

`CaptureOwnerGate` pauses native uploads before the owner intent and Start, and
the pause is lifted when the recorder stops (Resume is then a visible action).
`NativeSourceGuard` keeps the legacy Dart queue from listing, resuming or
deleting a session that has a native source journal, and explicit "Delete
recording" is refused for such a session in **every** upload state: a transport
that reached the server is not SHA verification, and even verified files do not
establish the original owner's plus explicit staff cloud-copy confirmation that
local cleanup requires. The separate [collector cleanup action](collector-recovery.md)
requires a fresh proof and retains the journal and manifest.

## Build switches (debug only)

Two independent Gradle properties (each also readable as
`ORG_GRADLE_PROJECT_<name>`); both default to `false`, only the debug manifest
overlay reads them, and a release build can carry neither.

| Property                                  | Effect                                                                                                                                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `-PstateactionNativeUpload=true`          | `ai.stateaction.native_upload.enabled=true` (the native gate; `OWNER_NATIVE_UPLOAD=true` in `.env` is the second gate).                                                              |
| `-PstateactionNativeUploadCleartext=true` | Also `usesCleartextTraffic=true` and `allow_cleartext_loopback=true`. Refused unless `stateactionNativeUpload=true` **and** `stateactionApplicationId=ai.stateaction.collector.e2e`. |

- Emulator qualification (loopback `http://127.0.0.1:3025`): pass both
  properties with the `.e2e` package, as in the scenario scripts.
- Real-device HTTPS build: pass only `-PstateactionNativeUpload=true`; the merged
  manifest then has `native_upload.enabled=true`,
  `allow_cleartext_loopback=false` and `usesCleartextTraffic=false`.

## Qualification status (2026-11-02)

Emulator only (emulator-5582, API 33, personal user 0, simulated H264
`h264_mcap_simulation_v1`); never physical-device evidence.

Demonstrated, with the strict server/object observer (final three-file SHA,
receipts equal sizes, zero open multipart uploads, object SHA equal to sealed
SHA):

- Real login, Home, 15 s Start/Stop and a visible Upload to completion, on the
  retained x64 debug APK built with both switches.
- The same upload with the app backgrounded for 20 s at 256 KiB/s: native kept
  transferring (proxy `newConnections` 0). HOME only backgrounds the app; it is
  not Dart process death.
- A previously accepted take uploaded and its original bytes and journal stayed
  hash-identical before and after every run.
- Build gates: the ARM64 phone APK (`ai.stateaction.collector.dev`) merges
  `native_upload.enabled=true`, `allow_cleartext_loopback=false`,
  `usesCleartextTraffic=false`; Gradle refuses cleartext for any package other
  than `ai.stateaction.collector.e2e` and without the uploader gate.
- Kill identity guard: the no-signal preflight verifies the live pid, uid and
  exact command line with the same command used to signal.

Built and ready for a hardware-only sample, not yet qualified on hardware:

- The ARM64 phone debug APK `ai.stateaction.collector.dev` (sha256
  `cee3f6860dbe7995ba833b707e4f63886f207b9d5ea9e432e536fc023a0501d5`, built
  from source `60f56ab` / QA `80d8ad2`, debug-signed with the same certificate as
  the earlier SA-69 build), published privately for a first personal-profile
  sample of 15 to 20 s with the existing login and a visible Upload. Physical
  device and R2 qualification are still pending. This ticket did not install or
  launch anything on a physical phone.
- After the manifest and build-switch change, the retained x64 APK (sha256
  `fc104951c7f7dc7de5394eb531b7ede4670773145b2bd51aea8c6d5a2de849e5`) passed
  the full actual-app smoke (strict observer: three files completed, receipts
  equal sizes, object SHA equal sealed SHA, zero open multipart uploads), and
  Gradle refused cleartext both on the `.dev` package and without the uploader
  gate.

Still unqualified (no passing evidence yet):

- Process death (`kill -9`) then relaunch and Resume. Three attempts ended on
  harness defects before any recorded death (SELinux denies `run-as` signals;
  a command-line comparison in the identity guard was wrong; `pidof` exits 1
  when no process exists), all fixed; no recovery claim.
- Network loss and recovery, owner A to B to A on device, capture pause, and
  logout during a transfer.
- Multipart (over 64 MiB) on the app path, API 35 / UIDT behaviour, reboot and
  Doze, real R2, and hosted CI.
