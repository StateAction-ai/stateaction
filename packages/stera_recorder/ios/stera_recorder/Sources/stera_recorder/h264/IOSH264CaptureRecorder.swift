#if canImport(ARKit) && canImport(VideoToolbox)
import ARKit
import CoreVideo
import Foundation

/// Opt-in iOS `h264_mcap_v1` RGB capture: ARKit `capturedImage` -> VideoToolbox
/// hardware H.264 -> `capture_h264.mcap` in the session directory, alongside the
/// legacy recorder outputs (which stay unchanged when the profile is not
/// requested).
///
/// STATUS: not compiled or run on Apple platforms by SA-52 (no macOS toolchain);
/// unqualified. The ARKit frame clock is labelled `apple.arkit_frame_timestamp`.
/// The epoch anchor is read from `ProcessInfo.systemUptime` +
/// `CLOCK_REALTIME`; equality of the uptime domain and the ARKit frame domain is
/// NOT asserted, so the mapping status is `unverified`.
final class IOSH264CaptureRecorder {
    static let profileKey = "rgbProfile"
    static let captureFileName = "capture_h264.mcap"
    static let evidenceFileName = "capture_h264_evidence.json"
    static let frameClockId = "apple.arkit_frame_timestamp"
    static let anchorClockId = "apple.process_info_system_uptime"
    static let anchorRevision = "ios-fixed-anchor-1"
    /// ARKit recycles a small pool of captured images; at most this many may be
    /// retained by the encoder at once.
    static let maxPendingFrames = 3

    private let encoder: VideoToolboxH264Encoder
    private let controller: H264CaptureController<VideoToolboxH264Encoder>
    private let stateLock = NSLock()
    private var calibration = H264CalibrationTracker()
    private var finished: H264CaptureSummary?
    let captureURL: URL
    let evidenceURL: URL

    /// Contract assets bundled with the plugin (byte copies of
    /// `packages/contracts/capture`, verified by the portable test suite).
    static func bundledContractAssets() throws -> CaptureContractAssets {
        let candidates = [Bundle(for: IOSH264CaptureRecorder.self), Bundle.main]
        for bundle in candidates {
            for sub in ["stateaction/capture", "stera_recorder_capture_contract.bundle/stateaction/capture"] {
                if let url = bundle.resourceURL?.appendingPathComponent(sub),
                   FileManager.default.fileExists(atPath: url.appendingPathComponent("manifest.json").path) {
                    return try CaptureContractAssets.load(directory: url)
                }
            }
        }
        #if SWIFT_PACKAGE
        if let url = Bundle.module.resourceURL?.appendingPathComponent("stateaction/capture") {
            return try CaptureContractAssets.load(directory: url)
        }
        #endif
        throw CocoaError(.fileReadNoSuchFile)
    }

    /// Back-to-back uptime/epoch reading; the uptime is the midpoint and the
    /// uncertainty the read window.
    static func sampleAnchor() -> FixedHostAnchor {
        let before = ProcessInfo.processInfo.systemUptime
        var ts = timespec()
        clock_gettime(CLOCK_REALTIME, &ts)
        let after = ProcessInfo.processInfo.systemUptime
        let native = Int64(((before + after) / 2 * 1_000_000_000).rounded())
        let epoch = Int64(ts.tv_sec) * 1_000_000_000 + Int64(ts.tv_nsec)
        return FixedHostAnchor(
            nativeClockId: anchorClockId, nativeAnchorNs: native, epochAnchorNs: epoch,
            uncertaintyNs: Int64(((after - before) * 1_000_000_000).rounded(.up)),
            revision: anchorRevision, status: "unverified")
    }

    static func epochNowNs() -> Int64 {
        var ts = timespec()
        clock_gettime(CLOCK_REALTIME, &ts)
        return Int64(ts.tv_sec) * 1_000_000_000 + Int64(ts.tv_nsec)
    }

    /// Starts the encoder and capture file or throws an explicit rejection
    /// (`H264EncoderStartError`); no partial file is left behind on failure.
    init(sessionDirectory: URL, recordingId: String, request: H264EncoderRequest) throws {
        captureURL = sessionDirectory.appendingPathComponent(Self.captureFileName)
        evidenceURL = sessionDirectory.appendingPathComponent(Self.evidenceFileName)
        let assets = try Self.bundledContractAssets()
        let configuration = H264CaptureConfiguration(
            recordingId: recordingId, request: request, maxPendingFrames: Self.maxPendingFrames,
            frameClockId: Self.frameClockId, anchor: Self.sampleAnchor(), calibrationModel: "arkit_camera_intrinsics")
        let sink = try FileCaptureSink(url: captureURL)
        let encoder = VideoToolboxH264Encoder()
        do {
            let session = try H264CaptureSession(
                configuration: configuration, assets: assets, sink: sink, nowEpochNs: Self.epochNowNs,
                currentUptimeNs: { UInt64(ProcessInfo.processInfo.systemUptime * 1_000_000_000) })
            controller = try H264CaptureController(encoder: encoder, session: session)
        } catch {
            try? sink.close()
            try? FileManager.default.removeItem(at: captureURL)
            throw error
        }
        self.encoder = encoder
    }

    /// Submits one ARKit frame. Only the pixel buffer (bounded by
    /// `maxPendingFrames`) and scalar values are kept; the ARFrame is not retained.
    func submit(frame: ARFrame) {
        let pixelBuffer = frame.capturedImage
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        guard let native = NativeFrameTimestamp(clockId: Self.frameClockId, rawSeconds: frame.timestamp) else { return }
        let k = frame.camera.intrinsics
        let calibrationId: String
        stateLock.lock()
        let id = calibration.calibrationId(for: .init(
            fx: Double(k.columns.0.x), fy: Double(k.columns.1.y),
            cx: Double(k.columns.2.x), cy: Double(k.columns.2.y), width: width, height: height))
        let done = finished != nil
        stateLock.unlock()
        guard !done else { return }
        calibrationId = id ?? "rgb_unavailable"
        _ = try? controller.submit(
            pixelBuffer, rasterWidth: width, rasterHeight: height, native: native,
            nativeTimestamps: H264NativeTimestampKeys.arkitFrame(native), calibrationId: calibrationId)
    }

    /// Flushes/invalidates the encoder, writes Close and the evidence sidecar.
    @discardableResult
    func finish(outcome: H264CaptureOutcome) -> H264CaptureSummary? {
        stateLock.lock()
        if let s = finished { stateLock.unlock(); return s }
        stateLock.unlock()
        let summary = try? controller.finish(outcome: outcome)
        stateLock.lock()
        finished = summary
        let capReached = calibration.capReached
        stateLock.unlock()
        var evidence = controller.session.evidenceJSON()
        if case .object(var pairs) = evidence {
            pairs.append(("first_frame", .object(encoder.firstFrameEvidence ?? [])))
            pairs.append(("calibration_cap_reached", .bool(capReached)))
            evidence = .object(pairs)
        }
        try? evidence.data().write(to: evidenceURL, options: .atomic)
        return summary
    }

    /// Builds the explicit request from the recording config; nil when the H.264
    /// profile was not requested (legacy JPEG path stays in use).
    static func request(from config: RecordingConfig, rasterWidth: Int, rasterHeight: Int) -> H264EncoderRequest? {
        guard config.rgbProfile == H264CaptureConfiguration.rgbProfile else { return nil }
        return H264EncoderRequest(
            profile: config.h264EncoderProfile, width: rasterWidth, height: rasterHeight,
            fps: config.rgbHz, bitrate: config.h264Bitrate, idrIntervalSeconds: 1, requireHardware: true)
    }

    static func newRecordingId() -> String { UUID().uuidString.lowercased() }
}
#endif
