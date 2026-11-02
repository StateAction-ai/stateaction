import Foundation
import XCTest
@testable import H264TestSupport
@testable import StateActionH264

final class CaptureSessionTests: XCTestCase {
    private func make(_ configure: (ScriptedH264Encoder) -> Void = { _ in },
                      config: H264CaptureConfiguration = CaptureHarness.configuration())
        throws -> (H264CaptureController<ScriptedH264Encoder>, ScriptedH264Encoder, MemoryCaptureSink) {
        let enc = try ScriptedH264Encoder()
        configure(enc)
        let sink = MemoryCaptureSink()
        let controller = try H264CaptureController(encoder: enc, session: CaptureHarness.session(config, sink: sink))
        return (controller, enc, sink)
    }

    @discardableResult
    private func submit(_ c: H264CaptureController<ScriptedH264Encoder>, _ i: Int, raster: (Int, Int) = (64, 48), calibration: String = "rgb_0") throws -> H264CaptureSession.Admission {
        let n = CaptureHarness.native(i)
        return try c.submit(i, rasterWidth: raster.0, rasterHeight: raster.1, native: n,
                            nativeTimestamps: CaptureHarness.nativeTimestamps(n), calibrationId: calibration)
    }

    private func events(_ sink: MemoryCaptureSink, _ topic: String) throws -> [CaptureMcapMessage] {
        try CaptureMcapReader.read(sink.bytes).filter { $0.topic == topic }
    }

    private func close(_ sink: MemoryCaptureSink) throws -> [String: Any] {
        try XCTUnwrap(events(sink, "/stateaction/close").first?.json)
    }

    func testNormalSessionWritesIdrWithConfigEveryGopAndExactIdentity() throws {
        let (c, _, sink) = try make()
        for i in 0..<12 { try submit(c, i) }
        let s = try c.finish(outcome: .completed)
        XCTAssertEqual(s.outcome, "completed")
        XCTAssertEqual([s.acquired, s.submitted, s.written, s.dropped, s.unresolved], [12, 12, 12, 0, 0])
        XCTAssertEqual(s.idrMessages, 3)  // GOP 5: frames 0, 5, 10
        let video = try events(sink, "/camera/rgb/video")
        XCTAssertEqual(video.map(\.sequence), Array(0..<12))
        let frames = try events(sink, "/stateaction/frame_events").map(\.json)
        let written = frames.filter { $0["state"] as? String == "written" }
        for (msg, ev) in zip(video, written) {
            let au = try XCTUnwrap(CaptureMcapReader.videoData(msg.data))
            let idr = try H264Bitstream.validateAccessUnit(au)  // every IDR carries SPS+PPS
            XCTAssertEqual(ev["is_idr"] as? Bool, idr)
            XCTAssertEqual(ev["output_sequence"] as? Int, Int(msg.sequence))
            XCTAssertEqual(ev["mapped_capture_time_ns"] as? String, String(msg.logTime))
        }
        // Original native time and mapping provenance.
        let first = try XCTUnwrap(frames.first)
        XCTAssertEqual(first["native_clock_id"] as? String, CaptureHarness.frameClock)
        XCTAssertEqual(first["native_timestamp_ns"] as? String, String(CaptureHarness.native(0).nanoseconds))
        XCTAssertEqual(first["mapped_capture_time_ns"] as? String,
                       String(CaptureHarness.epochAnchorNs + CaptureHarness.native(0).nanoseconds - CaptureHarness.nativeAnchorNs))
        let clocks = try XCTUnwrap(events(sink, "/stateaction/clocks").first?.json)
        let transport = try XCTUnwrap(clocks["recorder_transport"] as? [String: Any])
        XCTAssertEqual(transport["clock_id"] as? String, CaptureHarness.anchorClock)
        XCTAssertEqual(transport["status"] as? String, "unverified")
    }

    func testDelayedCallbacksJoinByRefconNotCallbackOrder() throws {
        let (c, enc, sink) = try make { $0.deferOutputs = true }
        for i in 0..<3 { try submit(c, i) }
        XCTAssertEqual(c.session.pendingIds, [1, 2, 3])
        enc.release()  // outputs arrive after later acquisitions
        try submit(c, 3)
        enc.release()
        let s = try c.finish(outcome: .completed)
        XCTAssertEqual([s.written, s.dropped, s.unresolved], [4, 0, 0])
        let written = try events(sink, "/stateaction/frame_events").map(\.json).filter { $0["state"] as? String == "written" }
        XCTAssertEqual(written.map { $0["source_frame_id"] as? String }, ["1", "2", "3", "4"])
        XCTAssertEqual(written.map { $0["encoder_pts_us"] as? String }, ["0", "33333", "66666", "100000"])
    }

    func testOutOfOrderOutputIsDroppedExplicitlyNotMisattributed() throws {
        let (c, enc, sink) = try make { $0.deferOutputs = true }
        for i in 0..<3 { try submit(c, i) }
        enc.release(order: [0, 2, 1])
        let s = try c.finish(outcome: .completed)
        XCTAssertEqual(s.written, 2)
        XCTAssertEqual(s.dropReasons, ["output_pts_regressed": 1])
        let written = try events(sink, "/stateaction/frame_events").map(\.json).filter { $0["state"] as? String == "written" }
        XCTAssertEqual(written.map { $0["source_frame_id"] as? String }, ["1", "3"])
    }

    func testIdentityFaultsAreTerminalAndCounted() throws {
        let (c, _, sink) = try make {
            $0.faults = [2: .wrongPts, 3: .noRefcon, 4: .drop, 5: .configOnly, 6: .syncMismatch, 7: .truncatedLength]
        }
        for i in 0..<8 { try submit(c, i) }
        let s = try c.finish(outcome: .completed)
        XCTAssertEqual(s.dropReasons, [
            "pts_identity_mismatch": 1, "encoder_dropped": 1, "config_only_output": 1,
            "invalid_bitstream": 2, "encoder_flush_without_output": 1,
        ])
        XCTAssertEqual(s.orphanOutputs, 1)  // nil refcon: never attributed to frame 3 by order
        XCTAssertEqual([s.acquired, s.written, s.unresolved], [8, 2, 0])
        let closeJson = try close(sink)
        XCTAssertEqual(closeJson["outcome"] as? String, "completed")
        XCTAssertEqual((closeJson["frames"] as? [String: String])?["dropped"], "6")
    }

    func testFirstOutputMustBeIdrAndKeyFrameIsForcedAgain() throws {
        let (c, enc, sink) = try make { $0.faults = [1: .nonIdrInsteadOfIdr] }
        for i in 0..<3 { try submit(c, i) }
        let s = try c.finish(outcome: .completed)
        XCTAssertEqual(s.dropReasons, ["awaiting_idr": 1])
        XCTAssertEqual(enc.forcedKeyFrames, [1, 2])
        let video = try events(sink, "/camera/rgb/video")
        XCTAssertTrue(try H264Bitstream.validateAccessUnit(XCTUnwrap(CaptureMcapReader.videoData(video[0].data))))
    }

    func testMissingParameterSetsNeverEmitsIdrWithoutConfig() throws {
        let (c, _, _) = try make { $0.faults = [1: .noParameterSets] }
        try submit(c, 0)
        let s = try c.finish(outcome: .completed)
        XCTAssertEqual(s.dropReasons, ["missing_parameter_sets": 1])
        XCTAssertEqual(s.videoMessages, 0)
    }

    func testPendingBoundLimitsRetainedBuffers() throws {
        let (c, enc, _) = try make({ $0.deferOutputs = true }, config: CaptureHarness.configuration(maxPending: 3))
        for i in 0..<5 { try submit(c, i) }
        XCTAssertEqual(enc.encodeCalls, 3)  // frames 4/5 never reached the encoder
        XCTAssertEqual(c.session.pendingIds.count, 3)
        enc.release()
        try submit(c, 5)
        let s = try c.finish(outcome: .completed)
        XCTAssertEqual(s.pendingHighWater, 3)
        XCTAssertEqual(s.dropReasons, ["pending_bound_exhausted": 2])
        XCTAssertEqual([s.acquired, s.submitted, s.written], [6, 4, 4])
    }

    func testInterruptionGivesEveryPendingFrameATerminalOutcome() throws {
        let (c, enc, sink) = try make { $0.deferOutputs = true; $0.hangOnComplete = true }
        for i in 0..<3 { try submit(c, i) }
        let s = try c.finish(outcome: .aborted("app_backgrounded"))
        XCTAssertTrue(enc.invalidated)
        XCTAssertEqual(s.outcome, "aborted")
        XCTAssertEqual(s.unresolved, 0)
        XCTAssertEqual(s.dropReasons, ["encoder_flush_timeout": 3])
        enc.deliverLate(id: 1, pts: 0)  // a straggler after invalidation/close is ignored
        XCTAssertEqual(c.session.lateOutputs, 1)
        let closeJson = try close(sink)
        XCTAssertEqual(closeJson["failure_reason"] as? String, "app_backgrounded")
    }

    func testEncoderFailureFailsRecordingAndRefusesFurtherFrames() throws {
        let (c, enc, sink) = try make { $0.faults = [2: .fail(-12903)] }
        for i in 0..<4 { try submit(c, i) }
        XCTAssertEqual(enc.encodeCalls, 2)
        let s = try c.finish(outcome: .completed)
        XCTAssertEqual(s.outcome, "failed")
        XCTAssertEqual(s.failureReason, "encoder_status_-12903")
        XCTAssertEqual(s.dropReasons, ["encoder_error": 1, "encoder_failed": 2])
        XCTAssertEqual(try close(sink)["outcome"] as? String, "failed")
    }

    func testSubmitErrorAndRasterMismatchAreExplicitDrops() throws {
        let (c, enc, _) = try make()
        try submit(c, 0)
        try submit(c, 1, raster: (1920, 1440))
        enc.encodeError = NSError(domain: "vt", code: -12902)
        try submit(c, 2)
        let s = try c.finish(outcome: .completed)
        XCTAssertEqual(s.dropReasons, ["raster_mismatch": 1, "encode_submit_failed": 1])
        XCTAssertEqual(s.written, 1)
    }

    func testEncoderStartRejectionsNeverFallBack() throws {
        let cases: [(ScriptedH264Encoder) -> Void] = [
            { $0.hardware = false },
            { $0.reportedProfile = .high },
            { $0.reorderingAllowed = true },
            { $0.reportedRaster = (1280, 720) },
            { $0.startError = .hardwareUnavailable("none") },
        ]
        let expected: [H264EncoderStartError] = [
            .hardwareUnavailable("encoder reported software encoding"),
            .profileRejected("requested baseline, got high"),
            .propertyRejected("frame reordering could not be disabled"),
            .propertyRejected("raster 1280x720 != requested 64x48"),
            .hardwareUnavailable("none"),
        ]
        for (configure, want) in zip(cases, expected) {
            XCTAssertThrowsError(try make(configure)) { XCTAssertEqual($0 as? H264EncoderStartError, want) }
        }
        // Unknown hardware status (platform cannot report) is recorded as null, not claimed.
        let (c, _, sink) = try make { $0.hardware = nil }
        try c.finish(outcome: .completed)
        let profile = try XCTUnwrap(events(sink, "/stateaction/capture_profile").first?.json)
        XCTAssertTrue((profile["encoder"] as? [String: Any])?["hardware"] is NSNull)
    }

    func testCalibrationChangeIsMarkedAndDeclared() throws {
        let (c, _, sink) = try make()
        try submit(c, 0, calibration: "rgb_0")
        try submit(c, 1, calibration: "rgb_1")
        try c.finish(outcome: .completed)
        let reset = try XCTUnwrap(events(sink, "/stateaction/sensor_events").first?.json)
        XCTAssertEqual(reset["supersedes_calibration_id"] as? String, "rgb_0")
        XCTAssertEqual(reset["association_source_frame_id"] as? String, "2")
        let inv = try XCTUnwrap(events(sink, "/stateaction/inventory").first?.json)
        XCTAssertEqual((inv["calibrations"] as? [[String: Any]])?.compactMap { $0["calibration_id"] as? String }, ["rgb_0", "rgb_1"])
    }

    func testConsecutiveSessionsCarryNoStaleConfiguration() throws {
        let (a, encA, sinkA) = try make()
        for i in 0..<6 { try submit(a, i) }
        try a.finish(outcome: .completed)
        let (b, encB, sinkB) = try make({ $0.spsLevelOverride = 0x1F; $0.nalLengthSize = 2 },
                                       config: CaptureHarness.configuration(recordingId: "00000000-0000-4000-8000-000000000053"))
        for i in 0..<6 { try submit(b, i) }
        try b.finish(outcome: .completed)
        XCTAssertNotEqual(encA.parameterSets.sps, encB.parameterSets.sps)
        for (sink, want, other) in [(sinkA, encA.parameterSets.sps[0], encB.parameterSets.sps[0]),
                                    (sinkB, encB.parameterSets.sps[0], encA.parameterSets.sps[0])] {
            for msg in try events(sink, "/camera/rgb/video") {
                let nals = try H264Bitstream.splitAnnexB(XCTUnwrap(CaptureMcapReader.videoData(msg.data)))
                let sps = nals.filter { H264Bitstream.nalType($0) == H264NalType.sps }
                if !sps.isEmpty { XCTAssertEqual(sps, [want]); XCTAssertFalse(sps.contains(other)) }
            }
            XCTAssertEqual(try events(sink, "/stateaction/frame_events").first?.json["source_frame_id"] as? String, "1")
        }
    }
}

final class IOSIntegrationStaticTests: XCTestCase {
    private var iosSources: URL { ContractFixtures.repoRoot.appendingPathComponent("packages/stera_recorder/ios/stera_recorder/Sources/stera_recorder") }

    private func text(_ relative: String) throws -> String {
        try String(contentsOf: iosSources.appendingPathComponent(relative), encoding: .utf8)
    }

    /// The bundled iOS contract copies must stay byte-identical to the published
    /// contract (the reader hash-pins embedded schemas).
    func testBundledContractCopiesAreByteIdentical() throws {
        let bundled = iosSources.appendingPathComponent("Resources/stateaction/capture")
        let files = try FileManager.default.contentsOfDirectory(atPath: bundled.path).sorted()
        XCTAssertTrue(files.contains("manifest.json"))
        XCTAssertTrue(files.contains("foxglove-compressed-video.desc"))
        for f in files {
            XCTAssertEqual(try Data(contentsOf: bundled.appendingPathComponent(f)),
                           try Data(contentsOf: ContractFixtures.captureDir.appendingPathComponent(f)), f)
        }
        let assets = try CaptureContractAssets.load(directory: bundled)
        XCTAssertEqual(assets.wireContractRevision, "stateaction.capture.v1.1")
        XCTAssertEqual(assets.schemas.count, CaptureContractAssets.schemaFiles.count)
    }

    /// Static checks of the Apple-only adapter that cannot be compiled on Linux.
    func testVideoToolboxAdapterSourceRules() throws {
        let vt = try text("h264/VideoToolboxH264Encoder.swift")
        XCTAssertTrue(vt.hasPrefix("#if canImport(VideoToolbox)"))
        for needle in [
            "kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse",
            "RequireHardwareAcceleratedVideoEncoder", "UsingHardwareAcceleratedVideoEncoder",
            "sourceFrameRefcon: UnsafeMutableRawPointer(bitPattern: Int(sourceFrameId))",
            "CMVideoFormatDescriptionGetH264ParameterSetAtIndex", "nalUnitHeaderLengthOut: &nalLength",
            "kCMSampleAttachmentKey_NotSync", "VTCompressionSessionCompleteFrames", "VTCompressionSessionInvalidate",
            "kVTEncodeInfo_FrameDropped".replacingOccurrences(of: "kVTEncodeInfo_FrameDropped", with: ".frameDropped"),
        ] {
            XCTAssertTrue(vt.contains(needle), needle)
        }
        XCTAssertFalse(vt.contains("AVAssetWriter"), "hardware path must not route through AVAssetWriter/MP4")
        let rec = try text("h264/IOSH264CaptureRecorder.swift")
        XCTAssertTrue(rec.hasPrefix("#if canImport(ARKit) && canImport(VideoToolbox)"))
        XCTAssertTrue(rec.contains("requireHardware: true"))
        XCTAssertTrue(rec.contains("status: \"unverified\""))
        let impl = try text("ArRecorderImpl.swift")
        XCTAssertTrue(impl.contains("H.264 capture rejected"))
        XCTAssertTrue(impl.contains("h264.finish(outcome: .completed)"))
        let orchestrator = try text("coordination/RecordingFrameOrchestrator.swift")
        XCTAssertTrue(orchestrator.contains("if shouldSampleRgb, let h264 = h264Capture"))
    }
}

final class CalibrationTrackerTests: XCTestCase {
    func testJitterWithinToleranceKeepsIdAndChangesAreBounded() {
        var t = H264CalibrationTracker(maxCalibrations: 3)
        let k = H264CalibrationTracker.Intrinsics(fx: 1400, fy: 1400, cx: 960, cy: 720, width: 1920, height: 1440)
        XCTAssertEqual(t.calibrationId(for: k), "rgb_0")
        XCTAssertEqual(t.calibrationId(for: .init(fx: 1400.6, fy: 1399.5, cx: 960.2, cy: 720, width: 1920, height: 1440)), "rgb_0")
        XCTAssertEqual(t.calibrationId(for: .init(fx: 1410, fy: 1410, cx: 960, cy: 720, width: 1920, height: 1440)), "rgb_1")
        XCTAssertEqual(t.calibrationId(for: .init(fx: 1410, fy: 1410, cx: 960, cy: 720, width: 1280, height: 720)), "rgb_2")
        XCTAssertEqual(t.calibrationId(for: k), "rgb_2")  // cap reached: no unbounded calibration list
        XCTAssertTrue(t.capReached)
        XCTAssertNil(t.calibrationId(for: .init(fx: .nan, fy: 1, cx: 1, cy: 1, width: 1, height: 1)))
        var fresh = H264CalibrationTracker()
        XCTAssertEqual(fresh.calibrationId(for: k), "rgb_0")  // per recording
    }
}
