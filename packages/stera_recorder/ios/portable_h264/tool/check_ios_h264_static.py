#!/usr/bin/env python3
"""SA-52 toolchain-free static checks for the iOS H.264 capture path.

Runs anywhere Python runs (including hosted CI, which has no Swift/Xcode):
- bundled iOS contract copies are byte-identical to packages/contracts/capture;
- Apple-only adapter files are fully guarded so the portable package compiles
  on Linux, and keep the hardware/no-reordering/refcon/format-description rules;
- portable core files import nothing Apple-specific;
- the production `h264/` directory is what the portable test package compiles.

This is static evidence only. Behaviour is tested by `check_ios_h264_capture.py`
(Linux Swift); Apple compilation and device qualification remain open gates.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PORTABLE = HERE.parent
REPO = PORTABLE.parents[3]
IOS = REPO / "packages/stera_recorder/ios/stera_recorder/Sources/stera_recorder"
H264 = IOS / "h264"
BUNDLED = IOS / "Resources/stateaction/capture"
CAPTURE = REPO / "packages/contracts/capture"
APPLE_ONLY = {
    "VideoToolboxH264Encoder.swift": "#if canImport(VideoToolbox) && canImport(CoreMedia)\n",
    "IOSH264CaptureRecorder.swift": "#if canImport(ARKit) && canImport(VideoToolbox)\n",
}
APPLE_IMPORTS = ("import VideoToolbox", "import CoreMedia", "import CoreVideo", "import ARKit", "import AVFoundation", "import UIKit")
REQUIRED_SNIPPETS = {
    "VideoToolboxH264Encoder.swift": [
        "kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse",
        '"RequireHardwareAcceleratedVideoEncoder"',
        '"UsingHardwareAcceleratedVideoEncoder"',
        "sourceFrameRefcon: UnsafeMutableRawPointer(bitPattern: Int(sourceFrameId))",
        "CMVideoFormatDescriptionGetH264ParameterSetAtIndex",
        "nalUnitHeaderLengthOut: &nalLength",
        "kCMSampleAttachmentKey_NotSync",
        "VTCompressionSessionCompleteFrames",
        "VTCompressionSessionInvalidate",
    ],
    "IOSH264CaptureRecorder.swift": ["requireHardware: true", 'status: "unverified"', "maxPendingFrames = 3"],
}


def main() -> int:
    errors: list[str] = []
    bundled = sorted(p.name for p in BUNDLED.iterdir())
    for required in ("manifest.json", "foxglove-compressed-video.desc", "Clocks.schema.json", "FrameEvent.schema.json"):
        if required not in bundled:
            errors.append(f"bundled contract missing {required}")
    for name in bundled:
        if (BUNDLED / name).read_bytes() != (CAPTURE / name).read_bytes():
            errors.append(f"bundled {name} differs from packages/contracts/capture/{name}")

    link = PORTABLE / "Sources/StateActionH264"
    if not link.is_symlink() or Path(os.path.realpath(link)) != H264.resolve():
        errors.append("portable_h264/Sources/StateActionH264 must symlink the production h264 directory")

    for path in sorted(H264.glob("*.swift")):
        text = path.read_text(encoding="utf-8")
        guard = APPLE_ONLY.get(path.name)
        if guard:
            if not text.startswith(guard) or not text.rstrip().endswith("#endif"):
                errors.append(f"{path.name}: Apple-only file must be wrapped in {guard.strip()} ... #endif")
        elif any(imp in text for imp in APPLE_IMPORTS):
            errors.append(f"{path.name}: portable core must not import Apple frameworks")
        for snippet in REQUIRED_SNIPPETS.get(path.name, []):
            if snippet not in text:
                errors.append(f"{path.name}: missing required rule `{snippet}`")
        if "AVAssetWriter" in text:
            errors.append(f"{path.name}: hardware H.264 path must not use AVAssetWriter/MP4")

    impl = (IOS / "ArRecorderImpl.swift").read_text(encoding="utf-8")
    for snippet in ("H.264 capture rejected", "h264.finish(outcome: .completed)", 'finish(outcome: .aborted("recorder_released"))'):
        if snippet not in impl:
            errors.append(f"ArRecorderImpl.swift: missing `{snippet}`")

    for e in errors:
        print(f"FAIL: {e}", file=sys.stderr)
    if errors:
        return 1
    print(f"OK: {len(bundled)} bundled contract files identical; {len(list(H264.glob('*.swift')))} h264 sources statically checked")
    return 0


if __name__ == "__main__":
    sys.exit(main())
