# Android producer fixture

These three files were copied byte-for-byte from the Android instrumentation
test's session directory. They contain **synthetic data only**. The test uses
Android's real `YuvImage` JPEG encoder and the production Kotlin
`MCAPDatasetWriter`/`CDRSerializer`, followed by the normal Python MCAP decoder.
It does not acquire a physical camera image or ARCore depth measurement.

`provenance.json` records artifact SHA-256 hashes, the instrumentation APK hash,
and the paths and hashes of the producer sources at export. Those source hashes
describe this fixture's origin; subsequent source edits do not require rewriting
the fixture. The original `metadata.json` is intentionally unchanged.

The generator is
`stera-app/packages/stera_recorder/android/src/androidTest/kotlin/open/fpvlabs/stera/ar_recorder/encoding/CpuImageEncoderInstrumentedTest.kt`,
method `actualAndroidEncoderAndMcapWriterExportCrossClockFixture`.
Its APK is
`stera-app/apps/mobile/build/stera_recorder/outputs/apk/androidTest/debug/stera_recorder-debug-androidTest.apk`.

## What the fixture exercises

- Three native 32 × 16 RGB JPEGs. The four luma quadrants are 25, 85, 150,
  and 220, in top-left, top-right, bottom-left, bottom-right order. Their source
  YUV planes have padded strides and nonzero buffer positions. The Android and
  Python tests check the same asymmetric pixel locations for orientation.
- Three 8 × 4 little-endian depth rasters: `700 + index * 10 + pixel_index`
  millimetres. All three use the same native depth timestamp but different frame
  acquisition events. Nearest-native-timestamp lookup must not reuse one raster.
- Native RGB times start at `1453692090123456` ns; ARCore frame-event times
  start at `1453692090999999` ns. Each advances by `33333333` ns. The constant
  difference is a synthetic challenge to equality assumptions, not a measured
  calibration between clocks. Depth time is `1453692080123456` ns throughout.
- RGB and depth use acquisition-event MCAP log times and native publish/header
  times. Pose and geometry rows use frame-event times. Intrinsics, the recorded
  RGB-to-depth transform, and the optical-to-camera transform survive ROS2 CDR.
- `cross_stream_clock_verified=false` remains false after decoding. This fixture
  verifies an association and serialization contract, not depth age, hand-pose
  accuracy, or physical camera/depth registration accuracy.

Run the regression test from the project root:

```sh
.venv-stera/bin/python -m unittest discover -s tests -p test_android_writer_fixture.py -v
```

## Regeneration

Use the configured Linux Android emulator, explicitly addressed by serial; do
not run instrumentation against a contributor's phone. Build from project root:

```sh
source scripts/env.sh
cd stera-app/apps/mobile/android
./gradlew :stera_recorder:assembleDebugAndroidTest
```

Return to the project root, then install and run the fixture method:

```sh
adb -s emulator-5580 install -r stera-app/apps/mobile/build/stera_recorder/outputs/apk/androidTest/debug/stera_recorder-debug-androidTest.apk
adb -s emulator-5580 shell am instrument -w \
  -e class 'open.fpvlabs.stera.ar_recorder.encoding.CpuImageEncoderInstrumentedTest#actualAndroidEncoderAndMcapWriterExportCrossClockFixture' \
  open.fpvlabs.stera.ar_recorder.test/androidx.test.runner.AndroidJUnitRunner
adb -s emulator-5580 exec-out run-as open.fpvlabs.stera.ar_recorder.test \
  tar -C files -cf - geometry-fixtures > /tmp/stera-geometry-fixtures.tar
```

Extract the archive into a temporary directory. The generator creates a new
`geometry-fixtures/session_<date>_<time>/`; inspect that session and copy its
MCAP, metadata and thumbnail together. If replacing the archived fixture,
update the test's MCAP filename and provenance hashes, preserving generated
metadata. The session name and file hashes may change on regeneration. Review
the decoded synthetic values and rerun the regression test before accepting the
replacement. No Android SDK or emulator is needed to run the Python regression
against the archived bytes.
