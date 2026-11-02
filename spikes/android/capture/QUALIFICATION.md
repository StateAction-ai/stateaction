# SA-60 qualification matrix

Evidence types stay separate: **JVM** (host unit tests), **emulator** (software AVC on the API33 virtual-scene AVD) and **physical** (a user-started recording on the Android phone). Emulator or synthetic results never count as physical proof. Machine-readable emulator receipt: [`docs/validation/sa-60-emulator-qualification.json`](../../../docs/validation/sa-60-emulator-qualification.json).

## Reproduce

```sh
source scripts/env.sh                       # host-specific SDK/JDK; CI uses scripts/platform instead
pnpm exec nx run android-capture-spike:test # 32 Python tests: verifier, synthetic MCAP builder, driver safety
pnpm exec nx run android-capture-spike:android-build   # Gradle: 17 JVM tests, APK, androidTest APK, verify Kotlin MCAP fixture
scripts/start_capture_emulator.sh --ar -no-window      # own terminal, emulator-5582
python3 spikes/android/capture/harness/run_emulator_qualification.py --serial emulator-5582 --user 0
```

The driver accepts only `emulator-NNNN` with `ro.kernel.qemu=1` and a verified current personal full user, installs only the standalone `ai.stateaction.spike.capture` packages with an explicit `--user`, and writes raw captures under ignored `artifacts/android-capture-spike/`. Use `capture_verify.py FILE.mcap --profile hardware-candidate` on a future physical recording; the same checks then also enforce Main/4.0, 1920×1080, the one-second IDR interval in capture time and a provisional frame/IMU rate.

## What the emulator run exercises

Real spike classes: `CameraTimestampGate` → `FramePts` → `CaptureGl` (ARCore OES texture → EGL → encoder Surface) → `HardwareAvc` with the opt-in `EncoderProfile.simulation` (software AVC, SPS/PPS injection, complete access-unit assembly, EOS) → `CaptureSink`/`MCAPWriter`/`VideoWire`/`Cdr`, plus independent `SensorManager` accelerometer/gyro events. The result is verified by `capture_verify.py`, which shares no code with the writer.

**Not exercised:** `CaptureEngine` (it requires the strict hardware profile; production Stera H.264 integration is SA-51), any physical camera, IMU, clock or encoder, depth, thermal behaviour, and interruption/crash recovery.

## Criteria

| Acceptance criterion                                                                                                  | JVM                                                                                    | Emulator                                                                                                                                                                                                                                                                      | Physical                                                                        |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Standalone APK; record source/APK/device/OS/encoder versions                                                          | **pass** – APK and androidTest APK build; hashes in receipt                            | **pass** – API33 x86_64, software `c2.android.avc.encoder`                                                                                                                                                                                                                    | **pending** – build B was installed earlier; no new physical build              |
| Original camera frame IDs/times, Annex B access units in generic MCAP, independent raw accel/gyro, raster/calibration | **pass** – Kotlin writer fixture (`profile=""`, protobuf descriptor, indexes) verified | **pass** – 100 frames/AUs, per-frame native + mapped times, CameraInfo per frame, accel and gyro on separate channels                                                                                                                                                         | **pending** – build B failed before RGB; 73 accel/72 gyro callbacks, zero video |
| Tracking/depth/confidence availability and gaps                                                                       | n/a                                                                                    | **not exercised**                                                                                                                                                                                                                                                             | **pending**                                                                     |
| Profile, no B, IDRs, acquisition→PTS identity, config packets, bounded queues/counts, EOS/close                       | **pass** – B/IDR/config/identity negative tests                                        | **pass** except profile – Constrained Baseline/4.1, no B slices, SPS+PPS at every IDR, PTS derived from acquisition time, written/dropped = acquired, encoder EOS, closed MCAP. Main/4.0 1080p **cannot** pass on this encoder (`hardware-candidate` profile fails by design) | **pending**                                                                     |
| Two consecutive sessions                                                                                              | n/a                                                                                    | **pending** – single session in this harness; earlier archive evidence used the full Stera controller                                                                                                                                                                         | **pending**                                                                     |
| 10–20-minute capture: bytes, cadence, drops, RAM, battery/heat, hand/tool detail                                      | n/a                                                                                    | **not applicable** – emulator timing is not phone timing (about 5.6 fps here)                                                                                                                                                                                                 | **pending**                                                                     |
| Reproducible commands and artifact hashes                                                                             | **pass**                                                                               | **pass** – receipt                                                                                                                                                                                                                                                            | **pending**                                                                     |

## Finding to carry to SA-51 / the physical run

On the emulator, ARCore frames repeatedly report `ImageMetadata.SENSOR_TIMESTAMP` one capture behind `Frame.androidCameraTimestamp` (about 10 of 110 frames). `CameraTimestampGate` correctly rejects them as `camera_metadata_timestamp_disagreement`, and `CaptureEngine` aborts capture on that rejection. The harness skips and counts those frames (receipt `finding_camera_clock_gate`). Whether a stale-metadata frame should abort a take, be dropped, or fall back to the accessor is a production policy decision that needs physical-phone evidence; this spike does not change it.

## Genuinely unavailable here

- Physical Pixel capture on hardware Main/4.0 1080p30 at 12 Mb/s, real camera/IMU clocks, hand/tool detail, thermal and battery behaviour, 10–20-minute and two-hour runs (user-started, personal profile only; root coordinates after simulations).
- The imported Stera `ArRecorderImpl` and Flutter path with H.264 (SA-51). The archive tag's collector evidence is historical and was not re-executed in this PR.
