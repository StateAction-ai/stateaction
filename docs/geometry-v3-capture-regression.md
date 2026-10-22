# Pixel capture regression and v3 repair

## Physical result

The source-built v2 app failed its physical test. Session
`session_20261022_010013` has zero RGB, depth and pose messages. All 291 RGB
capture attempts threw the same class of validation exception. The remaining
topics are `/capture/frame_geometry`, `/device/imu` and `/device/metrics`.
The original upstream capture did save images; this loss of acquisition is a
regression introduced by our geometry changes.

The first failed attempt preserved these timestamps in nanoseconds:

| Source | Value |
|---|---:|
| CPU `Image.timestamp` | 1467836033014624 |
| `Frame.androidCameraTimestamp` | 1467836019878654 |
| `Frame.timestamp` | 1467836032984466 |

V2 required the first two values to be equal. They are not. Its exception
prevents encoding the image; depth and pose saving depend on successful RGB
capture in this path, so they are skipped too. Pixel image diagnostics show
1920×1080 YUV420888, full image crop, and valid-looking plane dimensions; this
attempt failed before plane packing or JPEG compression.

Raw MCAP SHA-256:
`acc18199f6732392c38a20bef3ea282b5e05f584d25da598193874c32bdee2a9`.
The unmodified capture and full diagnostic extraction remain local in
`captures/session_20261022_010013/`. No household video is included in Git.

## Root cause and test gap

[ARCore's image timestamp documentation](https://developers.google.com/ar/reference/c/group/ar-image#arimage_gettimestamp)
describes source-specific timestamps and warns that different sources may use
different time bases. Acquiring a camera image from a Frame establishes its API
association. Numerical equality between those separate timestamps is not a
valid requirement for saving the image.

Our v2 native fixture assigned equal CPU-image and Android-camera times, so it
encoded successfully while failing to test the behavior observed on this Pixel.
Passing encoder, writer and reader tests was incorrectly treated as sufficient
evidence to request a full hand-motion validation. The original pose defects
and the subsequently introduced capture failure are distinct issues.

The v1 physical recording also contained no RGB/depth/pose. It did not preserve
the failing exception, so this report does not claim its exact failure is proven
to be identical to v2.

## Scoped repair

V3 records all three timestamps unchanged, identifies their sources, and records
`rgb_frame_association=Frame.acquireCameraImage_same_frame`. MCAP log time
identifies the acquiring Frame; image headers and publish times preserve the
native image clock. No cross-clock equality, tolerance or inferred depth age
gates image encoding.

Dimensions, calibration dimensions, crop and plane validation remain in place.
Duplicate/nonmonotonic native RGB times are checked only against the prior RGB
image from the same recording. Per-session writer counters and thumbnail state
are reset. Capture failure rate uses actual encoding attempts, and repeated
render-loop returns of the same ARCore Frame no longer inflate frame counts.

The Python reader retains historical v1/v2 support and accepts v3 through its
explicit association/provenance. The real Pixel timestamp tuple is now exercised
through synthetic MCAP decoding and HDF5 export, in addition to the Android
encoder regression. Synthetic pixels and depth in these tests are not real
sensor measurements.

## Acceptance sequence

1. Pass native encoder/writer tests using the observed Pixel timestamps.
2. Decode and process the generated native v3 MCAP, checking saved RGB, depth,
   pose, calibration and timestamp provenance.
3. Install the identified APK and obtain a short user-started Pixel capture.
4. Pull it, verify the source hash, decode actual RGB/depth/pose, and inspect
   captured pixels and depth. Only this establishes that physical acquisition
   has recovered.
5. Then resume independent registration, depth and hand-annotation accuracy
   measurements. Successful acquisition does not certify those measurements.

Steps 1–2 pass: 26 JVM, 6 native Android and 73 Python tests, plus complete
processing of the native three-frame fixture. The v3 APK is installed on the
Pixel. Step 3 awaits a user-started recording, and steps 4–5 remain pending.
The [build receipt](geometry-v3-build-receipt.json) records the exact revision,
APK hash and completed checks. Installation alone is not proof of recovery.
