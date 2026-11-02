// swift-tools-version: 5.9
// The swift-tools-version declares the minimum version of Swift required to build this package.

import PackageDescription

let package = Package(
    name: "stera_recorder",
    platforms: [
        .iOS("14.0")
    ],
    products: [
        .library(name: "stera-recorder", targets: ["stera_recorder"])
    ],
    dependencies: [
        .package(name: "FlutterFramework", path: "../FlutterFramework")
    ],
    targets: [
        // The @try/@catch shim MCAPWriter wraps FileHandle writes in. SwiftPM
        // can't mix Objective-C and Swift in one target, so it lives in its own
        // module; under CocoaPods the same file lands in the pod's umbrella
        // header instead. See the `#if SWIFT_PACKAGE` import in MCAPWriter.
        .target(name: "stera_recorder_objc"),
        .target(
            name: "stera_recorder",
            dependencies: [
                .product(name: "FlutterFramework", package: "FlutterFramework"),
                "stera_recorder_objc",
            ],
            // Byte copies of packages/contracts/capture used to embed the exact
            // hash-pinned schemas in h264_mcap_v1 files (SA-52). Identity with the
            // contract directory is verified by ios/portable_h264.
            resources: [.copy("Resources/stateaction")],
            linkerSettings: [
                // MCAP CRCs go through zlib (`import zlib` in DatasetWriterImpl).
                .linkedLibrary("z")
            ]
        ),
    ]
)
