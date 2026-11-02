# SA-52 portable iOS H.264 capture core (checkpoint, paused)

`Sources/StateActionH264` is a symlink to the production directory
`../stera_recorder/Sources/stera_recorder/h264`, so the recorder's own sources
are compiled and tested on Linux Swift 6.1.2.

## What exists

- Portable core (Foundation only): AVCC to Annex B with the format-description NAL
  length size, complete-AU assembly with SPS/PPS prepended to every IDR
  (`H264AccessUnitAssembler`), bounded refcon + PTS frame ledger
  (`H264FrameLedger`), explicit epoch-mapped log-time policy and fixed host anchor
  (`CaptureClockPolicy`), unchunked SA-50 MCAP writer with DataEnd CRC
  (`CaptureWire`), session/controller with terminal outcomes and Close counts
  (`H264CaptureSession`), calibration IDs (`H264CalibrationTracker`).
- Apple adapters (`VideoToolboxH264Encoder`, `IOSH264CaptureRecorder`), behind
  `#if canImport(...)` guards. They are **not compiled or run**: no macOS/Xcode was available.
- Opt-in wiring: `rgbProfile: "h264_mcap_v1"` in the recording config, plus
  `ArRecorderImpl`/`RecordingFrameOrchestrator` hooks. The legacy JPEG path is
  unchanged when the profile is not requested. `MCAPWriter` uses the explicit
  `CaptureLogTimePolicy`, with `.nativeUptime` as the default (same behaviour as before).

## Checks

```sh
SWIFT_BIN=~/.local/share/robotics-capture-tools/swift-dl/swift-6.1.2-RELEASE-ubuntu24.04/usr/bin/swift \
  python3 packages/stera_recorder/ios/portable_h264/tool/check_ios_h264_capture.py --require-ffmpeg
python3 packages/stera_recorder/ios/portable_h264/tool/check_ios_h264_static.py
```

The capture check runs the 27-test XCTest suite and 10 simulator scenarios. Each
scenario file is judged by the unmodified SA-50 reference checker:

- Published v1.1 rejects every file only on the known contract gap.
- A test-only PROPOSED overlay accepts every file.
- ffprobe decodes every written frame.

## Contract gap (separate revision, owned outside SA-52)

Published capture v1.1 is Android-only in two places:

- `Clocks.recorder_transport.clock_id` is const `android.elapsed_realtime`.
- `FrameEvent.native_timestamps` allows only `arcore_*` keys.

`MotionEvent.native_clock_id` has the same problem for IMU. The iOS producer proposes:

- the clock id `apple.process_info_system_uptime`, with the stream clock `apple.arkit_frame_timestamp`;
- the native timestamp keys `arkit_frame_timestamp_ns` and `arkit_frame_timestamp_f64_bits`.

It also needs optional Profile/encoder fields for colour and pixel format. Today
these are recorded only in the `capture_h264_evidence.json` sidecar.

## Open gates

1. Contract revision merged, then update the bundled copies and drop the overlay.
2. Xcode build (CocoaPods and SwiftPM) and an iOS simulator run.
3. Physical device: hardware, bitstream and frame-map receipt, interruption, and two
   consecutive signed-device sessions.
4. Dart API exposure of `rgbProfile`.
5. Hosted Swift CI (`swift-test` is local-only).
