# SA-60 follow-up: use the imported recorder as the capture base

The first physical standalone run **failed before RGB acquisition**. Its closed failed MCAP is not video/hardware-encoder qualification. The separate startup stack was unnecessary; the implementation should extend `packages/stera_recorder`, preserving the working Flutter/ARCore camera lifecycle and our existing fixes. This directory now serves as a protocol/codec experiment and emulator regression harness, not the product app starting point.

Implemented follow-up, 2026-11-01: the [existing-recorder integration](../../../docs/components/android-h264-implementation.md) now follows this approach behind explicit build flags. Its actual-controller emulator/CPU/Rerun checks are distinct from the earlier standalone probe and pending phone qualification.

## What failed and what local testing established

The first harness treated a positive ARCore `Frame.timestamp` as proof that `Frame.androidCameraTimestamp` was also immediately positive. That extra requirement caused `Camera native time missing/regressed` before the first acquisition. The failed file has 0 acquired/submitted RGB, 73 accelerometer/72 gyro messages and a failed capture outcome; exact missing-clock value was not retained, so zero versus another nonpositive value is not proven from its metadata. Startup absence and a true positive-clock regression must be separate states.

The existing `encoding/CpuImageEncoder.kt` and `geometry/CaptureGeometry.kt` already do the better thing: acquire the CPU image associated with the current Frame, retain original Image/Frame/Android timestamps independently, validate the matching image raster/intrinsics, and make no cross-clock equality claim.

The emulator-only native test exercised actual ARCore image acquisition and this spike's `CaptureGl` OES/EGL → encoder Surface path. Thirty CPU images and thirty complete AVC frames reached EOS and independently decoded. It did **not** call the imported Stera classes, exercise its UI or qualify the complete recording controller. The emulator uses software AVC at 640×480; this is not the phone's hardware Main4.0/1080p profile.

Crucially, actual emulator values show `Image.timestamp` can differ from both the Android camera timestamp and `ImageMetadata.SENSOR_TIMESTAMP`, even for a Frame-associated CPU image. For example: Image `596904370702`, ARCore Frame `596976904406`, Android camera and SENSOR_TIMESTAMP `596496703000`. The shared frame association does not make their clock values equal.

## Minimal implementation after the monorepo import

1. Keep Stera's existing session manager, permission/lifecycle handling, preview and acquired-image geometry. Do not copy this harness's Activity/session startup into the app.
2. Extract the existing CPU acquisition/geometry boundary into an owned frame lease/snapshot with the native timestamps, source frame ID, immutable raster/intrinsics and tracking state. Release the Image promptly and never retain a live ARCore Frame across asynchronous work.
3. Put the existing JPEG encoder and a new hardware H.264 adapter behind a small `RgbEncoder` interface. For an initial reuse-first adapter, probe hardware YUV input support and copy acquired YUV planes into the codec's actual input-image strides. This replaces JPEG compression without a JPEG intermediate; measure the CPU copies. Preserve the JPEG implementation as a legacy/reference profile. Reusing the existing GL context for a Surface adapter is a later measured optimization, not permission to introduce a second AR session.
4. Preserve the imported pose/depth/point-cloud/geometry paths; add independent raw IMU and reliable outcome accounting at their existing boundaries. This narrow spike's omitted optional streams must not become silent product omissions.
5. Reuse only reviewed portable pieces from this spike: complete-AU/Annex-B handling, source-ID↔PTS matching, explicit generic MCAP schemas and bounds, finite EOS/close handling and the timestamp-availability regression tests. Production bindings/schemas and crash journal still need their implementation tickets.

## Clock source decision

`Frame.timestamp` has a specifically undefined timebase. `Image.timestamp` is source-specific. Neither becomes elapsed-realtime simply because the selected camera advertises REALTIME.

For a positive required RGB capture clock, prefer **`frame.imageMetadata[SENSOR_TIMESTAMP]`** associated with that same Frame when the selected Camera2 camera reports `SENSOR_INFO_TIMESTAMP_SOURCE_REALTIME`; retain its original value and the separate CPU/Frame/accessor timestamps. Camera2 documents SENSOR_TIMESTAMP as the exposure-start clock and REALTIME as elapsed-realtime. A positive `Frame.androidCameraTimestamp` is another explicitly named camera-clock source; when both exist, disagreement is a visible integrity error rather than a nearest-time match. Preserve the chosen source/mapping revision and fixed epoch anchor. This is clock-domain provenance, not independently measured sensor synchronization accuracy.

An associated CPU image can therefore supply the actual pixels and its own original timestamp, while same-Frame sensor metadata supplies the documented camera capture clock. **Do not reinterpret the CPU timestamp itself as SENSOR_TIMESTAMP without evidence.** Metadata/accessor absence gets explicit availability evidence and a bounded startup wait. Persistent absence is an unsupported mapped-clock profile or a separate explicit native-clock recording mode; it is not fixed by substituting callback time. A SharedCamera profile would need the documented CaptureResult callback association, not `Frame.imageMetadata`.

The contained `CameraTimestampGate` now handles optional accessor absence, a positive same-Frame SENSOR_TIMESTAMP, duplicate/regressed values, disagreement and finite unavailable-clock timeout. JVM replay and the emulator exercise this policy. It is not a new phone build to ask the user to retry: first wire it into the imported acquisition boundary and exercise the actual changed Stera recording path in simulation. Only then request intentional physical testing for the remaining hardware-specific proof.

Sources: [ARCore Frame](https://developers.google.com/ar/reference/java/com/google/ar/core/Frame), [Android Image timestamps](<https://developer.android.com/reference/android/media/Image#getTimestamp()>), [Camera2 SENSOR_TIMESTAMP and REALTIME](https://developer.android.com/reference/android/hardware/camera2/CaptureResult#SENSOR_TIMESTAMP). Machine-readable results and exact tested-build hashes are in `result.json` / `emulator-result.json`; the safe physical-failure receipt is `physical-failure.json`.
