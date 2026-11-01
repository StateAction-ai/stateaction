# Android H.264 implementation

2026-11-01 · Controlled integration in the existing Flutter collector. Hardware qualification and deployment remain open. [Capture format](capture-format.md) is the design contract; [wire schemas](../../packages/contracts/capture/README.md) describe the implemented `stateaction.capture.v1.1` revision.

## What runs where

| Location | Implemented responsibility |
| --- | --- |
| Flutter recorder provider | Pass the same validated codec/profile to initialization and Start. H.264 is an explicit build selection; Android only. No image bytes cross the Flutter channel. |
| Existing Android `ArRecorderImpl` | Reuse ARCore, preview, acquisition, calibration and recording lifecycle. RGB continues when tracking is unavailable. |
| Native H.264 controller/encoder | Copy acquired YUV planes into MediaCodec using actual row/pixel strides; no JPEG intermediate. Retain image/frame/camera timestamps separately, allocate source IDs/PTS, assemble complete Annex B frames and drain EOS. |
| Native MCAP writer | Generic MCAP with Protobuf video, CDR sensor/calibration and strict JSON evidence. Independent raw accelerometer/gyro events; complete Foxglove descriptor and pinned schema/license assets. |
| Local Python CPU adapter | Sequential MCAP decode, CPU MediaPipe hands, IDR-safe MP4 remux, frame maps, masked landmark arrays and bounded RRD. A cloud worker is still future work. |
| Local browser | Actual self-hosted Rerun 0.41.0 WASM/WebCodecs viewer; playback, forward/back seeks and cleanup. Authenticated Next.js embedding remains future work. |

The hardware candidate remains native 1920×1080, requested 30 fps, Main/4.0, no B frames, 12 Mb/s and one-second sync requests using actual PTS. Capability/profile mismatches fail explicitly. The default collector still uses JPEG until the H.264 path qualifies.

The **separate emulator profile** is `h264_mcap_simulation_v1`: native 640×480 software AVC, `qualification=simulation_only`, `production_qualified=false`. Unverified camera clocks use a disclosed simulation transport timeline. This proves software integration, not phone camera/IMU synchronization or production throughput. The reader rejects this profile unless explicitly opted in.

## Build selection

Use the [monorepo setup](monorepo.md) first. From the repository root:

```sh
source scripts/env.sh
cd apps/mobile
flutter build apk --debug --target-platform android-x64 \
  --dart-define=STATEACTION_RGB_CODEC=h264 \
  --dart-define=STATEACTION_H264_SIMULATION=true
```

The simulation flag is restricted to emulators by native checks. A future personal-device candidate uses `STATEACTION_RGB_CODEC=h264` **without** the simulation flag and an ARM build. An unsupported camera/clock/encoder returns an error instead of lowering quality. No physical install or camera start is part of these instructions; use the [personal-device guard](../../scripts/ANDROID_PERSONAL_DEVICE.md) after simulations pass, and physical recording still requires the user's intentional Start.

Existing persisted settings must also meet the selected profile: RGB enabled at requested 30 Hz, and hardware mode requires 1080p with raw IMU enabled at requested 100 Hz. Invalid saved choices fail visibly. The on-phone MCAP player remains JPEG-oriented; H.264 review currently uses the CPU/Rerun path below.

## Reproduce the automated path

The harness accepts only a verified, dedicated single-user emulator. It exercises the actual existing native recorder with a native TextureView replacing only Flutter's texture-registry boundary. It records consecutive takes, pause/resume, cancellation and a successful take after cancellation. It does not exercise Flutter navigation/buttons or hardware depth.

```sh
source scripts/env.sh
scripts/start_capture_emulator.sh --ar -no-window
python3 scripts/test_android_h264_e2e.py --serial emulator-5582
```

The command prints a new ignored capture directory. In the pinned [processing environment](../../spikes/android/processing/README.md#run-locally), run:

```sh
spikes/android/processing/.venv/bin/python scripts/validate_android_h264_e2e.py \
  artifacts/android-h264-e2e/ACTUAL_RUN_DIRECTORY \
  spikes/android/processing/artifacts/NEW_PROCESSING_RUN
spikes/android/processing/.venv/bin/python spikes/android/processing/browser_check.py \
  spikes/android/processing/artifacts/NEW_PROCESSING_RUN/take-0/clip-001 \
  --chrome /usr/bin/google-chrome
```

Use new output directories; inspect both browser screenshots before recording visual approval. Raw MCAP, images, APKs and RRD remain ignored. The safe [validation receipt](../validation/android-h264-e2e.json) records exact source/build hashes, counts, failures fixed and coverage limits.

## Remaining delivery gates

- Physical hardware encoder/profile/clocks, sensor rate/raster and hand/tool detail; two short consecutive sessions, then measured 10–20-minute and two-hour resource tests.
- Capture ownership, capability UI, durable native journal/recovery, immutable inventory/hashing and upload admission. Current legacy lifecycle is not the complete production bridge in the mobile design.
- Production interruption policy: the reused recorder retains Pause for regression coverage; the pilot design requires interruption to end a take. Do not ship this legacy behavior as the final policy.
- Representative hand accuracy, long-source memory/performance, full codec conformance and conditional depth/confidence qualification.
- Swift parity, authenticated mobile/API/background upload integration, Render workflow/cloud CPU canary and shared web review UI.

This integration uses no paid cloud/GPU compute. Simulation success does not complete SA-60/SA-61 or authorize a production rollout.
