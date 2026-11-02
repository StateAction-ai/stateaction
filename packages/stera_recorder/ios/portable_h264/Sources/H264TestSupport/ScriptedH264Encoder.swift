import Foundation
@testable import StateActionH264

/// Locations of the shared SA-50 contract files.
public enum ContractFixtures {
    public static var repoRoot: URL {
        if let env = ProcessInfo.processInfo.environment["STATEACTION_REPO_ROOT"] { return URL(fileURLWithPath: env) }
        // .../packages/stera_recorder/ios/portable_h264/Sources/H264TestSupport/<this file>
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<7 { url.deleteLastPathComponent() }
        return url
    }

    public static var captureDir: URL { repoRoot.appendingPathComponent("packages/contracts/capture") }

    /// Contract assets: the published v1.1 directory unless
    /// `STATEACTION_CAPTURE_CONTRACT_DIR` points at a (clearly labelled)
    /// proposed-revision overlay.
    static func assets() throws -> CaptureContractAssets {
        let env = ProcessInfo.processInfo.environment["STATEACTION_CAPTURE_CONTRACT_DIR"]
        return try CaptureContractAssets.load(directory: env.map { URL(fileURLWithPath: $0) } ?? captureDir)
    }

    public static func baselineNals() throws -> [Data] {
        try H264Bitstream.splitAnnexB(Data(contentsOf: captureDir.appendingPathComponent("golden/source/baseline-5.h264")))
    }

    public static func bFrameNals() throws -> [Data] {
        try H264Bitstream.splitAnnexB(Data(contentsOf: captureDir.appendingPathComponent("golden/source/bframes-6.h264")))
    }
}

/// Deterministic stand-in for the VideoToolbox adapter. It emits real H.264 NALs
/// from the public SA-50 source stream (SPS, PPS, SEI+IDR, P x4) as
/// length-prefixed samples, and can delay, reorder, drop, fail or corrupt
/// outputs to exercise the session's identity and lifecycle rules.
final class ScriptedH264Encoder: H264FrameEncoding {
    typealias Frame = Int

    enum Fault: Equatable {
        case drop
        case fail(Int32)
        case noRefcon
        case wrongPts
        case configOnly
        case noParameterSets
        case nonIdrInsteadOfIdr
        case syncMismatch
        case truncatedLength
    }

    struct Pending { let id: Int64; let pts: Int64; let picture: Int }

    var hardware: Bool? = true
    var reportedProfile: H264ProfileName?
    var reorderingAllowed = false
    var reportedRaster: (Int, Int)?
    var startError: H264EncoderStartError?
    var nalLengthSize = 4
    var deferOutputs = false
    var hangOnComplete = false
    var encodeError: Error?
    var faults: [Int64: Fault] = [:]
    var gopLength = 5
    /// Replaces the SPS level_idc byte (simulates a different encoder configuration).
    var spsLevelOverride: UInt8?

    private(set) var queued: [Pending] = []
    private(set) var started = false
    private(set) var invalidated = false
    private(set) var encodeCalls = 0
    private(set) var forcedKeyFrames: [Int64] = []
    private var output: ((H264EncoderOutput) -> Void)?
    private var gopPosition = 0
    private var request: H264EncoderRequest?
    private let sps: Data
    private let pps: Data
    private let idrPicture: [Data]
    private let pPictures: [Data]

    init() throws {
        let nals = try ContractFixtures.baselineNals()
        sps = nals[0]; pps = nals[1]
        idrPicture = [nals[2], nals[3]]
        pPictures = Array(nals[4...7])
    }

    var parameterSets: H264ParameterSets {
        var s = sps
        if let level = spsLevelOverride { s[s.startIndex + 3] = level }
        return H264ParameterSets(sps: [s], pps: [pps], nalLengthSize: nalLengthSize)
    }

    func start(request: H264EncoderRequest, output: @escaping (H264EncoderOutput) -> Void) throws -> H264EncoderReport {
        if let e = startError { throw e }
        self.request = request
        self.output = output
        started = true
        let raster = reportedRaster ?? (request.width, request.height)
        return H264EncoderReport(
            name: "scripted.h264", hardware: hardware, profile: reportedProfile ?? request.profile,
            width: raster.0, height: raster.1, fps: request.fps, bitrate: request.bitrate,
            idrIntervalSeconds: request.idrIntervalSeconds, frameReorderingAllowed: reorderingAllowed,
            evidence: [("encoder_id", .string("scripted")), ("source", .string("golden/source/baseline-5.h264"))])
    }

    func encode(_ frame: Int, sourceFrameId: Int64, ptsUs: Int64, forceKeyFrame: Bool) throws {
        encodeCalls += 1
        if let e = encodeError { throw e }
        if forceKeyFrame { forcedKeyFrames.append(sourceFrameId); gopPosition = 0 }
        let picture = gopPosition
        gopPosition = (gopPosition + 1) % gopLength
        let p = Pending(id: sourceFrameId, pts: ptsUs, picture: picture)
        if deferOutputs { queued.append(p) } else { deliver(p) }
    }

    /// Releases deferred outputs in the given order of queue indices (default FIFO).
    func release(order: [Int]? = nil) {
        let items = queued
        queued.removeAll()
        for i in order ?? Array(items.indices) { deliver(items[i]) }
    }

    func completeFrames(timeoutSeconds: Double) -> Bool {
        if hangOnComplete { return false }
        release()
        return true
    }

    func invalidate() { invalidated = true; queued.removeAll() }

    /// Emits an output after invalidation (must be ignored by the session).
    func deliverLate(id: Int64, pts: Int64) { deliver(Pending(id: id, pts: pts, picture: 1)) }

    private func lengthPrefixed(_ nals: [Data]) -> Data {
        var out = Data()
        for nal in nals {
            var size = nal.count
            var prefix = [UInt8](repeating: 0, count: nalLengthSize)
            for k in stride(from: nalLengthSize - 1, through: 0, by: -1) { prefix[k] = UInt8(size & 0xFF); size >>= 8 }
            out.append(contentsOf: prefix)
            out.append(nal)
        }
        return out
    }

    private func deliver(_ p: Pending) {
        guard let output else { return }
        let fault = faults[p.id]
        let isIdr = p.picture == 0 && fault != .nonIdrInsteadOfIdr
        var nals = isIdr ? idrPicture : [pPictures[(max(p.picture, 1) - 1) % pPictures.count]]
        var sets: H264ParameterSets? = parameterSets
        var sync: Bool? = isIdr
        var pts: Int64? = p.pts
        var id: Int64? = p.id
        switch fault {
        case .drop?:
            output(H264EncoderOutput(sourceFrameId: id, ptsUs: pts, kind: .dropped(reason: "encoder_dropped"))); return
        case .fail(let status)?:
            output(H264EncoderOutput(sourceFrameId: id, ptsUs: pts, kind: .failed(status: status))); return
        case .noRefcon?: id = nil
        case .wrongPts?: pts = p.pts + 1
        case .configOnly?: nals = [parameterSets.sps[0], parameterSets.pps[0]]; sync = nil
        case .noParameterSets?: sets = nil
        case .syncMismatch?: sync = !isIdr
        case .truncatedLength?:
            var data = lengthPrefixed(nals); data.removeLast(3)
            output(H264EncoderOutput(sourceFrameId: id, ptsUs: pts, kind: .sample(data: data, encoderMarkedSync: sync, parameterSets: sets))); return
        case .nonIdrInsteadOfIdr?, nil: break
        }
        output(H264EncoderOutput(sourceFrameId: id, ptsUs: pts, kind: .sample(data: lengthPrefixed(nals), encoderMarkedSync: sync, parameterSets: sets)))
    }
}

/// Builds sessions/controllers with deterministic clocks for tests and the simulator.
struct CaptureHarness {
    static let frameClock = "apple.arkit_frame_timestamp"
    static let anchorClock = "apple.process_info_system_uptime"
    static let epochAnchorNs: Int64 = 1_800_000_000_000_000_000
    static let nativeAnchorNs: Int64 = 1_000_000_000

    static func configuration(recordingId: String = "00000000-0000-4000-8000-000000000052",
                              maxPending: Int = 4,
                              request: H264EncoderRequest = defaultRequest) -> H264CaptureConfiguration {
        H264CaptureConfiguration(
            recordingId: recordingId, request: request, maxPendingFrames: maxPending,
            frameClockId: frameClock,
            anchor: FixedHostAnchor(nativeClockId: anchorClock, nativeAnchorNs: nativeAnchorNs,
                                    epochAnchorNs: epochAnchorNs, uncertaintyNs: 2_000,
                                    revision: "ios-fixed-anchor-1", status: "unverified"),
            calibrationModel: "arkit_camera_intrinsics")
    }

    static let defaultRequest = H264EncoderRequest(profile: .baseline, width: 64, height: 48, fps: 30,
                                                   bitrate: 200_000, idrIntervalSeconds: 1, requireHardware: true)

    static func session(_ config: H264CaptureConfiguration, sink: CaptureByteSink) throws -> H264CaptureSession {
        try H264CaptureSession(configuration: config, assets: ContractFixtures.assets(), sink: sink,
                               nowEpochNs: { epochAnchorNs + 10_000_000_000 }, currentUptimeNs: { 2_000_000_000 })
    }

    /// Native timestamp of frame `index` at 30 fps (raw float64 seconds like ARKit).
    static func native(_ index: Int, offsetSeconds: Double = 1.001) -> NativeFrameTimestamp {
        NativeFrameTimestamp(clockId: frameClock, rawSeconds: offsetSeconds + Double(index) / 30.0)!
    }

    static func nativeTimestamps(_ n: NativeFrameTimestamp) -> [(String, Int64)] {
        H264NativeTimestampKeys.arkitFrame(n)
    }
}
