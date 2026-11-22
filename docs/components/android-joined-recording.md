# Authenticated Android recording: joined emulator qualification (SA-69)

This qualifies the **joined** path on the accelerated emulator: the actual Flutter sign-in screen, the BetterAuth `/me`
verified owner, the original Home **Start Recording** button, the real `ArRecorderImpl`/ARCore/MediaCodec H.264
simulation recorder, the original **Stop & Save** button and the retained owner-bound source. It is simulation evidence only:
the guest H.264 encoder is software, the camera is the emulator's virtual scene, and nothing here qualifies a physical
phone, hardware encoder, sensors or thermal behavior. No upload is exercised or claimed.

## App configuration (public values only)

`apps/mobile/.env` is git-ignored and bundled into the APK, so it holds only non-secret configuration:

```
NO_AUTH_MODE=false
ENVIRONMENT=dev
LOCAL_PASSWORD_AUTH=true
DEV_BACKEND_ORIGIN=https://tim-work-pc.taila68f99.ts.net:8444
PROD_BACKEND_ORIGIN=
```

Passwords, cookies and server secrets never enter `.env`, the APK, test source, process arguments, screenshots or logs.

## Build the separate dev package

`-PstateactionApplicationId` is the supported Gradle mechanism (see `apps/mobile/android/app/build.gradle.kts`); the label
becomes `StateAction Dev`. The original `open.fpvlabs.stera` package is untouched.

```sh
source scripts/env.sh
cd apps/mobile
agent-resource run --lane android-build -- \
  flutter build apk --debug --target-platform android-x64 --no-pub \
  --dart-define=STATEACTION_RGB_CODEC=h264 --dart-define=STATEACTION_H264_SIMULATION=true \
  --android-project-arg=stateactionApplicationId=ai.stateaction.collector.dev
```

The shared installed workstation guard pins JDK21 and bounds Gradle to 2 GiB,
two workers and in-process Kotlin. It enforces a 12 GiB aggregate budget, no
swap, one emulator and the `ci`, `android-build` and `emulator` lanes
(see the workstation guard doc). Generated probes use the same guard.
An ARM64 hardware-profile build (`STATEACTION_H264_SIMULATION=false`) remains
separate from this simulation evidence.

## Run the joined test

```sh
source scripts/env.sh
agent-resource run -- bash scripts/start_capture_emulator.sh --ar --verify-only
agent-resource run --lane emulator -- \
  python3 scripts/test_android_joined_app_e2e.py --login-fixture /path/to/private/0600.json --seconds 20
```

The fixture is a mode-0600 JSON file `{email, password, origin}` that stays outside the repository. It is read into the
driver's memory and typed into the real sign-in form through an `adb shell` stdin pipe after each text field is verified
focused and empty; the harness records only entered lengths and refuses to screenshot a screen showing a text field.
`--second-login-fixture` (optional) additionally proves a different account cannot see the first owner's source.
Use `--fresh` only for a disposable emulator install. By default the driver keeps existing app data and signs out of
any existing session before exercising the sign-in screen.

The driver verifies the APK package and reads its bundled public configuration before checking the accelerated
emulator and installing under user 0. It exercises sign-in and Home Start/Stop, then validates the pulled MCAP with
the official reader, CRC and index checks, the SA-50 strict checker and ffprobe (`scripts/validate_h264_capture.py`).
It checks that the owner ledger binds the intent, session directory and owner with `capture_start` provenance and
that the queue row stays `notStarted` without upload sessions or parts. It compares the source bytes and ledger
after a process restart, logout and re-login. Evidence goes to an ignored `artifacts/sa69-joined/<run>/`.

## Integration defects fixed by this ticket

- **Home Start never opened the recorder.** The card switched to the capture tab before calling the record flow; that
  disposed the card and the flow stopped at its `context.mounted` check. It now records first, then selects the tab.
- **Start waited on the legacy uploaded-videos feed.** `recordVideosForUpload` fetched `/assets` (an API this backend does
  not provide) before the recorder; capture no longer depends on that request.
- Tooling: Flutter's default JDK 25 breaks the Gradle build (see above).

## Not covered

Physical camera, hardware encoder and sensor behavior; richer calibration/depth contracts (SA-54/55/68 — unknown metadata is declared by the recorder); real source hashing and multipart upload (SA-18/20/22).

## Joined finalization and account isolation receipt

On 2026-11-02 the branch was rebased onto actual main `0c162e5` (SA-56).
The guarded real sign-in/Start/Stop run passed with 515 decoded frames, 36 IDRs,
a completed Close with zero drops/unresolved frames, official MCAP/CRC/index
and strict validation. Restart, logout, second active collector sign-in and
return to the original collector preserved the exact source and owner ledger;
the second collector could not see the source. No upload sessions or parts
were created. The MCAP SHA-256 was
`78c8e060eda2855fa369d7ab5a26dccd76622551c82ae9a68fc2158afe17b691`.

The ignored receipt is `artifacts/sa69-joined/final56-account-b/receipt.json`.
The single API33 x86_64 emulator had actual KVM and NVIDIA RTX3090 renderer
evidence and ran inside the shared cgroup budget. The guest encoder remains
software. The ARM64 H.264 build receipt at `artifacts/android-test-builds/arm64-build-receipt.json` records
an APK built from `7a882eb` with simulation disabled. It records no phone installation. The later development R2
receipt covers a `stera_jpeg_mcap_v1` source, so it provides no hardware H.264 evidence for this build.

The hosted checks for the original head were blocked by account billing. The
current local CI merge gate requires a new receipt for the rebased tree.

On 2026-11-17, the rebased app on main `0959abe` passed the joined run against the
Tailscale development backend. The new source decoded 742 frames with 50 IDRs and
a completed Close with zero drops or unresolved frames. The new queue row stayed
`notStarted` with no upload sessions or parts. The source and owner ledger were
unchanged across restart, logout and sign-in with the same collector. The
second-account check is covered by the earlier run above.

The new receipt and independent validator output are under
`artifacts/sa69-rebase/joined-try1/`.
