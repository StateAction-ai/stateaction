// swift-tools-version: 5.9
// Linux/macOS test harness for the portable (Foundation-only) iOS H.264 MCAP
// capture core. `Sources/StateActionH264` is a symlink to the production
// directory `../stera_recorder/Sources/stera_recorder/h264`, so the exact
// recorder sources are compiled and tested here. Apple-only adapters in that
// directory are guarded by `#if canImport(VideoToolbox)` and compile to nothing
// on Linux; this package does NOT prove Apple-framework compilation.
import PackageDescription

let package = Package(
    name: "portable_h264",
    targets: [
        .target(name: "StateActionH264", path: "Sources/StateActionH264"),
        // Scripted encoder double + fixture access shared by the tests and the simulator.
        .target(name: "H264TestSupport", dependencies: ["StateActionH264"], path: "Sources/H264TestSupport"),
        .executableTarget(name: "h264-capture-sim", dependencies: ["StateActionH264", "H264TestSupport"], path: "Sources/h264-capture-sim"),
        .testTarget(name: "StateActionH264Tests", dependencies: ["StateActionH264", "H264TestSupport"], path: "Tests/StateActionH264Tests"),
    ]
)
