# Synthetic native Android v3 MCAP

`native_cpu_v3.mcap` contains three synthetic 32×16 grayscale JPEGs, 8×4 depth
rasters, identity camera rotations and acquisition metadata. It was emitted by
the Android JPEG encoder and Kotlin MCAP writer in the Linux instrumentation
test `actualAndroidEncoderAndMcapWriterExportCrossClockFixture`.

SHA-256: `61b06cdda3bbb67adf40fa8b7149166e0a1c4d1131cb949680bc1a825c55002a`.
No physical camera/depth data or contributor footage is included. This frozen
fixture exercises the app's Dart MCAP reader and version-gated viewing defaults.
Source generation is in `packages/stera_recorder/android/src/androidTest/`.
