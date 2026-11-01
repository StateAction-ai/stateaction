# StateAction.ai

Private monorepo: [timothywangdev/stateaction](https://github.com/timothywangdev/stateaction). Track work in [Linear](https://linear.app/hw-personal-projects/project/stateactionai-collection-and-review-mvp-392311683a3e).

Nx coordinates the Node/TypeScript and Python foundation over pnpm and uv. Lefthook validates staged content and blocks direct pushes to `main`; CI and the guarded merger implement one-ticket/one-PR delivery. Start with the [platform setup](scripts/platform/README.md) and [repository workflow](docs/repository-workflow.md). The existing Flutter/native source joins this published baseline through its separate mobile-import ticket.

The diagnostic tools and physical-capture results below retain earlier evidence; they do not qualify the new product auth/upload or cloud processing flow.

## Reproduce this workspace

The workspace and Android changes live in private repositories under
`timothywangdev`. Clone with submodules to get the exact tested app and SDK commits:

```bash
git clone --recurse-submodules https://github.com/timothywangdev/stateaction.git
cd stateaction
```

Authentication is required for the workspace and app repositories. Phone captures,
downloaded videos, APKs, virtual environments, and device credentials stay local.
Only the small synthetic Android test fixture is tracked. Create
`stera-app/apps/mobile/.env` containing `NO_AUTH_MODE=true` before building;
the file is deliberately excluded from Git. The environment and build instructions
below describe the installed local tools; cloning alone does not install them.

## Validation status

**Historical diagnostic status (2026-10-21): v3 physical acquisition works in two Pixel recordings.** The captures contain 245 and 186 matched RGB/depth/tracked-pose events, zero encoder failures, and no message decode errors. The saved-playback orientation fix is installed and tested against the latest recording. See [physical results and remaining hand failures](docs/pixel-v3-physical-validation.md). Hand-pose accuracy, temporal accuracy and training qualification remain unverified.

The user confirmed correct playback orientation. The separate thumbnail fix is
installed, with ten Flutter regression checks passing. Hand investigation now
includes [external calibrated references](docs/hanco-hand-benchmark.md),
[camera-reconstruction experiments](docs/hand-camera-reconstruction.md), and
[temporal tracking and coverage comparisons](docs/hand-tracking-modes.md).
More detections have not established accurate 3D labels. Our runner explicitly
uses MediaPipe; the SDK defaults to WiLoR. The isolated
[WiLoR GPU preflight](docs/wilor-research-preflight.md) now passes full hand
inference through an explicitly sourced, author-linked research-demo MANO asset.
The [full hand comparison and replay](docs/wilor-full-hand-benchmark.md) improves
raw wrist-relative error from 36.26 to 11.57 mm against the small HanCo fitted
reference set. Both Pixel recordings have complete offline WiLoR replays;
metric accuracy, hidden-joint visibility and training qualification remain open.

V1 and v2 both failed acquisition; do not use them for collection. V2 rejected all 291 attempts because of our invalid cross-clock timestamp equality requirement. V3 preserves the separate native clocks and acquiring Frame association. Historical receipts remain evidence of the earlier failures; [the regression record](docs/geometry-v3-capture-regression.md) explains the repair.

The public egocentric RGB test processed all 449 frames but detected hands in only 71; functional processing does not establish annotation accuracy. Earlier recordings and current model estimates have not qualified as metric hand supervision.

After physical acquisition is confirmed, use the
[printed-target protocol](docs/physical-calibration-validation.md) to measure
depth and camera-motion disagreement. Its printable A4 target and auditor are
tested with known synthetic geometry and deliberately corrupted units/axes;
actual Pixel accuracy remains unmeasured.

Verified device: Pixel 9 Pro XL, Android 17 (API 37), `arm64-v8a`, paired and connected over Wi-Fi. Google Play Services for AR is installed. The original pre-geometry-fix APK built successfully on 2026-10-21, its signature passed verification, and its packaged configuration contains only `NO_AUTH_MODE=true`. Build details and SHA-256 are in [docs/build-receipt.json](docs/build-receipt.json). That original build's installation and activity launch on the Pixel passed; the app remained running without matching fatal/Flutter exceptions in the inspected recent app logs. The first recording was copied with matching phone/local hashes and all 21,508 messages decoded without validation errors. Physical tracking accuracy has not been measured.

```text
robotics-data-collection/
├── stera-app/  # upstream mobile application and recorder
├── stera-sdk/  # pinned upstream processing SDK; compatibility helper used locally
├── artifacts/  # built APKs and other build outputs
├── captures/   # recordings copied from the phone
├── docs/       # setup and verification notes
└── scripts/    # reusable local environment and capture inspector
```

The checkout is from [fpv-labs/stera-app](https://github.com/fpv-labs/stera-app), based on `fce8de1a44d3b4a8f0bea9bb5f025ea8e04dcc15` on local branch `local/pixel9pro-debug`. Local Android recorder changes implement the [versioned geometry contract](stera-app/packages/stera_recorder/android/CAPTURE_GEOMETRY.md). An earlier change in `apps/mobile/android/app/build.gradle.kts` reads release-keystore properties as nullable values so a missing `android/key.properties` does not prevent debug configuration. Release builds retain their release signing configuration.

`stera-app/apps/mobile/.env` contains only `NO_AUTH_MODE=true`. This enables local capture and preview without an account, backend, or uploads. The file is ignored by Git but must exist because Flutter bundles it as an asset.

## Environment

```bash
source ~/projects/robotics-data-collection/scripts/env.sh
flutter --version
java -version
adb version
```

Tool locations:

- Flutter: `~/.local/share/robotics-capture-tools/flutter`
- Android SDK: `~/.local/share/robotics-capture-tools/android-sdk`
- Java: `~/.local/share/robotics-capture-tools/jdk21` (Temurin JDK 21.0.12.1+1)

The source pins Flutter 3.44.6, Gradle 8.14, Android Gradle Plugin 8.12.1, and Kotlin 2.2.20. Flutter supplies compile/target SDK 36, minimum SDK 24, and NDK 28.2.13676358. The build also installed SDK platform/build tools 35 and CMake 3.22.1 for dependencies. App Java/Kotlin bytecode targets Java 17. The first build failed because the system Java installation lacked a compiler. The environment script now selects a complete, checksum-verified Temurin JDK 21; both `java` and `javac` were checked. System Java settings are unchanged.

## Build the debug APK

```bash
source ~/projects/robotics-data-collection/scripts/env.sh
cd "$ROBOTICS_CAPTURE_ROOT/stera-app/apps/mobile"
flutter pub get
flutter build apk --debug --target-platform android-arm64,android-x64 --dart-define=NO_AUTH_MODE=true
install -m 644 build/app/outputs/flutter-apk/app-debug.apk \
  "$ROBOTICS_CAPTURE_ROOT/artifacts/stera-local-debug.apk"
```

For this Android no-auth build, Bun and database code generation are unnecessary; generated Dart database code is committed upstream. The official Bun preparation additionally synchronizes Google client IDs (skipped in no-auth mode) and writes iOS configuration.

## Fast Android checks on Linux

With the Android emulator already running, this repeats the JVM tests and six
native codec/MCAP tests, then exports their synthetic fixtures and logs:

```bash
~/projects/robotics-data-collection/scripts/test_android_capture.sh emulator-5580
```

The script refuses physical devices and targets every ADB call explicitly. It
installs only the instrumentation APK; it does not start a production camera
recording. Robolectric covers validation/failure paths; the emulator runs Android's
real JPEG codec. Synthetic tests do not measure ARCore tracking or real depth.
See the [v3 fixture](tests/fixtures/android_geometry_v3/README.md),
[v3 pipeline receipt](docs/validation/synthetic-android-pipeline-v3.json), and
[Linux simulation guide](docs/linux-recording-test-loop.md).

## Public egocentric video test

Run the selected MediaPipe baseline on clean RGB from the reviewed CC BY 4.0
EgoViz-120 sample. This downloads 150 MB once; later runs reuse it. Choose a new
output directory for each experiment:

```bash
.venv-stera/bin/python scripts/test_public_egocentric_video.py \
  --download-default --output captures/public-egocentric/my_validation
python3 scripts/view_capture.py captures/public-egocentric/my_validation/visualization.rrd
```

The [validation report](docs/public-egocentric-video-validation.md) explains the
visible hand misses, exact test coverage and limitations. The
[recorded result](docs/validation/public-egocentric-rgb.json) preserves hashes,
model configuration and export checks. A small same-side export regression ensures
two model predictions cannot overwrite each other merely because their predicted
handedness labels match. Metric 3D, depth and physical camera accuracy remain
separate validation tasks.

## Select the phone and install

Enable debugging and authorize this computer on the phone. For wireless debugging, pair and connect using the temporary details shown by the phone. Pairing codes and network addresses are not stored in this workspace.

```bash
adb devices -l
# Replace the placeholder with the intended phone's first-column identifier.
export ROBOTICS_CAPTURE_DEVICE='device-identifier-from-adb-devices'
adb -s "$ROBOTICS_CAPTURE_DEVICE" get-state
adb -s "$ROBOTICS_CAPTURE_DEVICE" shell cmd user list -v
# Verify the personal full user before proceeding; never select a work profile.
export ANDROID_PERSONAL_USER='verified-personal-user-id'
adb -s "$ROBOTICS_CAPTURE_DEVICE" install --user "$ANDROID_PERSONAL_USER" -r \
  "$ROBOTICS_CAPTURE_ROOT/artifacts/stera-local-debug.apk"
adb -s "$ROBOTICS_CAPTURE_DEVICE" shell am start --user "$ANDROID_PERSONAL_USER" \
  -n open.fpvlabs.stera/.MainActivity
```

Follow [the mandatory profile checks](AGENTS.md) before installation or launch, including checking the exact package installation scope afterward. The selected device must show `device`, rather than `unauthorized` or `offline`. ADB can list the same wireless phone twice, under its address and its mDNS identifier; choose one entry and keep targeting it explicitly. Re-select its identifier if wireless reconnection changes it.

## Record and copy data

The user starts recording on the phone after granting the requested permissions, then stops and waits for the session to finish saving. Raw capture begins only after the user starts it; setup and transfer commands do not start a recording.

After stopping the recording, copy the latest completed session:

```bash
ANDROID_SERIAL="$ROBOTICS_CAPTURE_DEVICE" \
LOCAL_ROOT="$ROBOTICS_CAPTURE_ROOT/captures" \
  bash "$ROBOTICS_CAPTURE_ROOT/stera-app/apps/mobile/scripts/pull_arcore_dataset.sh" --latest
```

Use `--all` instead of `--latest` to copy all saved sessions. `ANDROID_SERIAL` makes the upstream script's ADB calls target the phone explicitly. The script reads `/storage/emulated/0/Android/data/open.fpvlabs.stera/files/ar_sessions/` and checks for a nonempty `session_data_*.mcap`, `metadata.json`, and `thumbnail.jpg`. Each session remains on the phone after copying. Processing with Stera SDK is a separate step.

## Inspect a local capture

The official [fpv-labs/stera-sdk](https://github.com/fpv-labs/stera-sdk) checkout is pinned to `df6a5ec8919053c5cd448db83d4816e1faaaec62`. The inspector loads its ROS2 schema compatibility helper directly and uses lightweight MCAP, NumPy and Pillow dependencies. It does not install the full SDK or run models. FFmpeg and ffprobe must be on PATH; encoding uses CPU libx264.

```bash
cd ~/projects/robotics-data-collection
# The local .venv and these packages are already installed on this machine.
# For a fresh workspace:
uv venv .venv --python 3.12
uv pip install --python .venv/bin/python -r requirements-inspection.txt

# Replace the session name when processing a new capture.
.venv/bin/python scripts/inspect_capture.py captures/session_YYYYMMDD_HHMMSS
```

Outputs are written under that session's `inspection/` folder. Existing JPEG exports cause the script to stop rather than overwrite them. It preserves raw inputs, decodes every MCAP message, validates payloads, exports native integer timestamps and original JPEG bytes, and produces a file hash manifest. These checks establish file integrity and structural validity, not physical sensor accuracy.

## First capture: 2026-10-21

[Session QA report](captures/session_20261021_203504/inspection/QA.md) · [Preview](captures/session_20261021_203504/inspection/preview.mp4) · [Machine-readable QA](captures/session_20261021_203504/inspection/qa.json)

- Approximately 15.6 seconds; 230 RGB JPEGs at 1920×1080, 230 depth images at 160×90, 230 camera poses, and 12,273 IMU messages.
- All 21,508 messages decoded; all JPEGs fully decoded; no recorded payload validation errors. The preview also passed a full FFmpeg decode.
- **All 230 depth frames are pixel-identical.** They contain only one unique depth image, so this session does not establish that depth updates correctly. Treat depth as suspect until the cause is investigated.
- Camera pose recording worked with the user's one-handed phone capture. No hand-joint stream is present; camera tracking and hand tracking are separate capabilities.
- Metadata reports 7,753 total RGB frames, but that field counts AR processing-loop iterations. The actual saved RGB topic has 230 frames.
- IMU messages combine the latest accelerometer and gyroscope values on each callback; they are not 12,273 independent simultaneous measurements. There are only 6,138 unique IMU timestamps. Orientation is unavailable. Shared RGB/depth/pose timestamps do not prove physical synchronization.
- Camera calibration alignment, coordinate transforms, drift, depth accuracy and downstream training utility still require separate experiments.

The preview is **retimed to constant 15 fps** for inspection. Use the raw MCAP and native timestamp exports for analysis. `preview_frame_mapping.csv` maps preview frames back to their original timestamps. `poses.csv`, `imu.csv`, `calibration.json`, and `depth.npz` expose the other streams; `manifest.json` records source and derived hashes. Source files remain on the phone and unmodified locally. This recording includes the user's workspace and stays local.

## Second capture: 2026-10-21 at 21:04

[Session QA report](captures/session_20261021_210417/inspection/QA.md) · [Preview](captures/session_20261021_210417/inspection/preview.mp4) · [Comparison and framing notes](docs/capture-comparison-2026-10-21.md)

All 21,807 messages decoded without structural errors. The approximately 17-second recording contains 252 distinct RGB frames, **252 distinct depth images**, 252 finite camera poses, and 13,404 IMU messages. The frozen-depth behavior from the first take did not recur. This does not establish physical depth accuracy.

**Sparse point-cloud quality failed:** 15,023 of 18,821 point records contain nonfinite values, affecting 250 messages that nevertheless claim `is_dense=True`. Treat the cloud stream as unsuitable for direct geometry processing until diagnosed. RGB, depth and pose results are assessed separately. The largest RGB interval is about 200 ms; the retimed preview conceals this timing gap, so use native timestamps for timing analysis.

The inspector now reports nonfinite point-cloud quality separately from structural decoding failures, allowing valid streams to be exported while retaining explicit warnings and unchanged raw inputs. All new-session exports and hashes were verified, including independent raw-to-export comparisons. No app/SDK changes or uploads were made for this inspection.

## Run Stera Process and Evaluate

Use the geometry-aware runner below for new recordings from the corrected app. It preserves per-frame calibration, native depth timestamps, raw model predictions, and validity masks; it disables inferred body poses. Its report separates capture health from 3D hand consistency. Passing these checks does not establish metric accuracy or visibility of occluded fingers.

```bash
cd ~/projects/robotics-data-collection
# Already installed locally; use these two commands for a fresh setup:
uv venv .venv-stera --python 3.11
uv pip install --python .venv-stera/bin/python -r requirements-stera.txt

# Substitute a new capture path; completed output directories are protected.
.venv-stera/bin/python scripts/process_geometry_capture.py \
  captures/session_YYYYMMDD_HHMMSS/session_data_YYYYMMDD_HHMMSS.mcap

# Open the completed 3D replay on a Linux desktop:
python3 scripts/view_capture.py
```

The earlier baseline run remains available in the [original evaluation report](captures/session_20261021_210417/stera_processed/evaluation.html) and [processing notes](docs/stera-processing-2026-10-21.md). Those outputs are retained for comparison. The old-capture diagnostic replay at `captures/session_20261021_210417/stera_processed_geometry_diagnostic_v3/` processed all 252 frames and passed Rerun loading, but none of its 135 hand estimates qualifies as verified geometry. It uses an explicit orientation hypothesis and is excluded from automatic viewer selection. Open it only by supplying its `episode/visualization.rrd` path to `scripts/view_capture.py`.

Processing uses its own Python 3.11 environment because the SDK requires NumPy below 2. The pinned Rerun 0.22.1 needs a small runtime compatibility adapter in our runner; upstream SDK files remain unchanged. MediaPipe runs locally on CPU. No recording or derived data was uploaded.

All 252 frames were processed. A hand was detected in 135 frames (53.6%); two hands were never detected together. Stera's health score is **97/100**, but it misses the later sparse-cloud failures and does not validate physical depth, pose or hand-joint accuracy. This handheld capture also does not satisfy the skeleton estimator's head-camera assumption. Our report labels the device-uptime clock explicitly and marks calendar timestamps unavailable. The original upstream report, which misinterprets uptime as January 1970, is retained separately.

The viewer launcher selects the newest processed recording and streams it through stdin, avoiding Linux file-watch limits. An optional recording path selects a different replay. `--check` verifies loading without opening a window. It binds only to localhost and chooses an available port.

The original replay contained an inverted skeleton because the SDK inferred world-up's sign from camera orientation. The local runner now pins verified Android ARCore body estimates to positive-Y-up, preserving the warmup and all camera/hand coordinates. A separate corrected run is saved under `stera_processed_y_up/`; the launcher selects the newest completed run. See [skeleton orientation diagnosis](docs/skeleton-orientation-2026-10-21.md) for evidence and remaining camera-calibration limits.

**The subsequent hand-geometry audit failed.** The saved 3D fingers disagree with their 2D detections by approximately 93 px at the median; depth/RGB orientation is inconsistent, and the inferred body has unreachable arms. The up-direction correction does not resolve these problems. Treat these 3D annotations as failed estimates despite the SDK's 97/100 health score. See [the audit and next implementation steps](docs/hand-geometry-audit-2026-10-21.md), including side-by-side visual evidence and reproducible diagnostics.

## Linux file-watch allowance

Rerun's ordinary file loader failed because `inotify_add_watch` returned `ENOSPC`. The current 65,536-watch user limit is largely consumed by two VS Code processes (approximately 63,374 and 1,445 watch references at inspection). Counts are a snapshot and may include shared descriptors. The stdin-based launcher works without changing system settings.

To raise the allowance to 524,288 and persist it, run these commands in your terminal. They require administrator authentication. The configuration is prepared locally but has **not** been installed by this session.

```bash
sudo install -m 644 ~/projects/robotics-data-collection/docs/99-local-file-watches.conf /etc/sysctl.d/99-local-file-watches.conf
sudo sysctl -p /etc/sysctl.d/99-local-file-watches.conf
```

Only `max_user_watches` changes; the separate instance and event-queue limits are untouched. VS Code documents this allowance and recommends excluding large dependency folders from watching where appropriate: [Linux setup guidance](https://github.com/microsoft/vscode-docs/blob/main/docs/setup/linux.md).
