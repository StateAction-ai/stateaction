import Foundation

// Portable H.264 capture session: evidence state machine + controller that
// drives any `H264FrameEncoding` (VideoToolbox on iOS, a scripted fake in the
// Linux tests). One instance per recording; nothing is static, so encoder
// configuration, calibration and ledger state cannot leak between sessions.

enum H264ProfileName: String, CaseIterable {
    case baseline, main, high
}

/// Requested encoder settings. The encoder must honor each value or reject the
/// start explicitly; it never silently switches profile, raster, format or to
/// software encoding.
struct H264EncoderRequest: Equatable {
    let profile: H264ProfileName
    let width: Int
    let height: Int
    let fps: Int
    let bitrate: Int
    let idrIntervalSeconds: Int
    let requireHardware: Bool
}

/// What the encoder actually reports after configuration (read back, not echoed).
struct H264EncoderReport {
    /// `label` (e.g. `videotoolbox.h264`).
    let name: String
    /// `true` hardware confirmed, `false` software (never accepted when hardware
    /// is required), `nil` platform cannot report it.
    let hardware: Bool?
    let profile: H264ProfileName
    let width: Int
    let height: Int
    let fps: Int
    let bitrate: Int
    let idrIntervalSeconds: Int
    let frameReorderingAllowed: Bool
    /// Full platform readback (encoder ID, property statuses, pixel format,
    /// colour attachments). Written to the evidence sidecar; the v1.1 Profile
    /// schema has no slot for it.
    let evidence: [(String, CaptureJSON)]
}

enum H264EncoderStartError: Error, Equatable {
    case hardwareUnavailable(String)
    case profileRejected(String)
    case propertyRejected(String)
    case sessionCreationFailed(Int32)

    var reason: String {
        switch self {
        case .hardwareUnavailable: return "hardware_encoder_unavailable"
        case .profileRejected: return "profile_rejected"
        case .propertyRejected: return "encoder_property_rejected"
        case .sessionCreationFailed: return "encoder_session_failed"
        }
    }
}

enum H264EncoderOutputKind {
    /// Length-prefixed sample data with the parameter sets/NAL length size of
    /// the sample's own format description.
    case sample(data: Data, encoderMarkedSync: Bool?, parameterSets: H264ParameterSets?)
    /// Encoder reported the frame dropped (e.g. `kVTEncodeInfo_FrameDropped`) or delivered no sample.
    case dropped(reason: String)
    /// Encoder callback status error.
    case failed(status: Int32)
}

struct H264EncoderOutput {
    /// Decoded `sourceFrameRefCon`; nil when the encoder returned none.
    let sourceFrameId: Int64?
    /// Output sample PTS in microseconds; nil when unavailable.
    let ptsUs: Int64?
    let kind: H264EncoderOutputKind
}

protocol H264FrameEncoding: AnyObject {
    associatedtype Frame
    func start(request: H264EncoderRequest, output: @escaping (H264EncoderOutput) -> Void) throws -> H264EncoderReport
    /// Hands one frame to the encoder with its source frame ID as refcon.
    func encode(_ frame: Frame, sourceFrameId: Int64, ptsUs: Int64, forceKeyFrame: Bool) throws
    /// Synchronously completes every submitted frame (bounded by `timeoutSeconds`).
    /// Returns false if completion could not be confirmed.
    func completeFrames(timeoutSeconds: Double) -> Bool
    /// Tears the encoder down; no output callback may arrive afterwards.
    func invalidate()
}

/// Exact contract schema/descriptor bytes (hash-pinned by the readers).
struct CaptureContractAssets {
    static let schemaFiles: [(name: String, file: String)] = [
        ("stateaction.capture.Profile.v1", "Profile.schema.json"),
        ("stateaction.capture.Clocks.v1", "Clocks.schema.json"),
        ("stateaction.capture.Inventory.v1", "Inventory.schema.json"),
        ("stateaction.capture.FrameEvent.v1", "FrameEvent.schema.json"),
        ("stateaction.capture.SensorEvent.v1", "SensorEvent.schema.json"),
        ("stateaction.capture.Close.v1", "Close.schema.json"),
    ]
    static let descriptorFile = "foxglove-compressed-video.desc"

    let wireContractRevision: String
    let schemas: [String: Data]
    let compressedVideoDescriptor: Data

    static func load(directory: URL) throws -> CaptureContractAssets {
        var schemas: [String: Data] = [:]
        for (name, file) in schemaFiles {
            schemas[name] = try Data(contentsOf: directory.appendingPathComponent(file))
        }
        let manifest = try JSONSerialization.jsonObject(with: Data(contentsOf: directory.appendingPathComponent("manifest.json"))) as? [String: Any]
        guard let revision = manifest?["wire_contract_revision"] as? String else {
            throw CocoaError(.fileReadCorruptFile)
        }
        return CaptureContractAssets(
            wireContractRevision: revision,
            schemas: schemas,
            compressedVideoDescriptor: try Data(contentsOf: directory.appendingPathComponent(descriptorFile)))
    }
}

struct H264CaptureConfiguration {
    static let rgbProfile = "h264_mcap_v1"
    static let captureSchema = "stateaction.capture.v1"

    let recordingId: String
    let request: H264EncoderRequest
    let maxPendingFrames: Int
    /// Clock domain label of the native frame timestamps (stream `rgb`).
    let frameClockId: String
    let anchor: FixedHostAnchor
    /// Calibration model label written to the Inventory.
    let calibrationModel: String?
}

enum H264CaptureOutcome: Equatable {
    case completed
    case aborted(String)
    case failed(String)
}

struct H264CaptureSummary: Equatable {
    let outcome: String
    let failureReason: String?
    let acquired: Int64
    let submitted: Int64
    let written: Int64
    let dropped: Int64
    let unresolved: Int64
    let videoMessages: Int64
    let idrMessages: Int64
    let dropReasons: [String: Int64]
    let configurationRevisions: Int
    let lateOutputs: Int64
    let orphanOutputs: Int64
    let pendingHighWater: Int
    let bytesWritten: Int64
}

/// Evidence writer for one `h264_mcap_v1` file. Not thread-safe by itself; the
/// controller serialises every call.
final class H264CaptureSession {
    static let videoTopic = "/camera/rgb/video"

    let configuration: H264CaptureConfiguration
    private let writer: CaptureMcapWriter
    private let assets: CaptureContractAssets
    private let ledger: H264FrameLedger
    private let assembler = H264AccessUnitAssembler()
    private var pts = EncoderPtsAllocator()
    private let nowEpochNs: () -> Int64
    private var channels: [String: UInt16] = [:]
    private var nextSourceFrameId: Int64 = 1
    private var nextSensorEventId: Int64 = 0
    private var sensorEvents: Int64 = 0
    private var videoMessages: Int64 = 0
    private var idrMessages: Int64 = 0
    private var calibrationsSeen: [String] = []
    private var currentCalibration: String?
    private(set) var lateOutputs: Int64 = 0
    private(set) var orphanOutputs: Int64 = 0
    private(set) var needsKeyFrame = true
    private(set) var encoderReport: H264EncoderReport?
    private(set) var closed = false
    private(set) var summary: H264CaptureSummary?
    private var lastLogTimeNs: Int64

    init(configuration: H264CaptureConfiguration,
         assets: CaptureContractAssets,
         sink: CaptureByteSink,
         nowEpochNs: @escaping () -> Int64,
         currentUptimeNs: @escaping () -> UInt64) throws {
        self.configuration = configuration
        self.assets = assets
        self.nowEpochNs = nowEpochNs
        self.ledger = H264FrameLedger(maxPending: configuration.maxPendingFrames)
        self.lastLogTimeNs = configuration.anchor.epochAnchorNs
        writer = try CaptureMcapWriter(
            sink: sink, library: "stateaction-ios-h264",
            logTimePolicy: .epochMapped(anchorEpochNs: configuration.anchor.epochAnchorNs),
            currentUptimeNs: currentUptimeNs)
        var schemaIds: [String: UInt16] = [:]
        for (name, _) in CaptureContractAssets.schemaFiles {
            guard let bytes = assets.schemas[name] else { throw CocoaError(.fileReadNoSuchFile) }
            schemaIds[name] = try writer.addSchema(name: name, encoding: "jsonschema", data: bytes)
        }
        let video = try writer.addSchema(name: "foxglove.CompressedVideo", encoding: "protobuf", data: assets.compressedVideoDescriptor)
        let table: [(String, String)] = [
            ("/stateaction/capture_profile", "stateaction.capture.Profile.v1"),
            ("/stateaction/clocks", "stateaction.capture.Clocks.v1"),
            ("/stateaction/inventory", "stateaction.capture.Inventory.v1"),
            ("/stateaction/frame_events", "stateaction.capture.FrameEvent.v1"),
            ("/stateaction/sensor_events", "stateaction.capture.SensorEvent.v1"),
            ("/stateaction/close", "stateaction.capture.Close.v1"),
        ]
        for (topic, schema) in table {
            channels[topic] = try writer.addChannel(schemaId: schemaIds[schema]!, topic: topic, messageEncoding: "json")
        }
        channels[Self.videoTopic] = try writer.addChannel(schemaId: video, topic: Self.videoTopic, messageEncoding: "protobuf")
    }

    // MARK: Start

    func start(encoder report: H264EncoderReport) throws {
        encoderReport = report
        let c = configuration
        let encoder: [(String, CaptureJSON)] = [
            ("codec", .string("h264")),
            ("profile", .string(report.profile.rawValue)),
            ("name", .string(report.name)),
            ("hardware", report.hardware.map { CaptureJSON.bool($0) } ?? .null),
            ("width", .int(Int64(report.width))),
            ("height", .int(Int64(report.height))),
            ("fps", .int(Int64(report.fps))),
            ("bitrate", .int(Int64(report.bitrate))),
            ("b_frames", .int(0)),
            ("idr_interval_seconds", .int(Int64(report.idrIntervalSeconds))),
        ]
        let profile: CaptureJSON = .object([
            ("capture_schema", .string(H264CaptureConfiguration.captureSchema)),
            ("rgb_profile", .string(H264CaptureConfiguration.rgbProfile)),
            ("recording_id", .string(c.recordingId)),
            ("wire_contract_revision", .string(assets.wireContractRevision)),
            ("encoder_time_base", Self.timeBase),
            ("production_qualified", .bool(false)),
            ("qualification", .string("unqualified")),
            ("limits", .object([
                ("pending_frames", .int(Int64(c.maxPendingFrames))),
                ("access_unit_bytes", .int(Int64(H264Bitstream.maxAccessUnitBytes))),
                ("writer_mode", .string("synchronous_bounded_input")),
            ])),
            ("encoder", .object(encoder)),
        ])
        try writeJSON("/stateaction/capture_profile", profile, logTimeNs: c.anchor.epochAnchorNs)
        let a = c.anchor
        let clocks: CaptureJSON = .object([
            ("recording_id", .string(c.recordingId)),
            ("recorder_transport", .object([
                ("clock_id", .string(a.nativeClockId)),
                ("target_clock_id", .string(FixedHostAnchor.targetClockId)),
                ("native_anchor_ns", .decimal(a.nativeAnchorNs)),
                ("epoch_anchor_ns", .decimal(a.epochAnchorNs)),
                ("uncertainty_ns", a.uncertaintyNs.map { CaptureJSON.decimal($0) } ?? .null),
                ("method", .string(FixedHostAnchor.method)),
                ("revision", .string(a.revision)),
                ("status", .string(a.status)),
                ("synchronization_accuracy", .string("unverified")),
            ])),
            ("stream_clocks", .object([("rgb", .string(c.frameClockId))])),
        ])
        try writeJSON("/stateaction/clocks", clocks, logTimeNs: a.epochAnchorNs)
        try writer.synchronize()
    }

    // MARK: Frames

    enum Admission: Equatable {
        case submit(sourceFrameId: Int64, ptsUs: Int64, forceKeyFrame: Bool)
        case dropped(sourceFrameId: Int64?, reason: String)
    }

    /// Records the acquisition of one camera frame and decides whether it may be
    /// handed to the encoder. Writes `acquired` (and `dropped` when refused).
    func acquire(native: NativeFrameTimestamp, nativeTimestamps: [(String, Int64)], calibrationId: String, admissible: Bool, refusalReason: String) throws -> Admission {
        guard !closed else { lateOutputs += 1; return .dropped(sourceFrameId: nil, reason: "after_close") }
        guard native.clockId == configuration.frameClockId else {
            return .dropped(sourceFrameId: nil, reason: "clock_domain_mismatch")
        }
        guard let mapped = configuration.anchor.mapToEpoch(nativeNs: native.nanoseconds),
              writer.logTimePolicy.isPlausible(logTimeNs: UInt64(mapped), currentUptimeNs: 0)
        else { return .dropped(sourceFrameId: nil, reason: "implausible_capture_time") }
        guard let ptsUs = pts.allocate(nativeNs: native.nanoseconds) else {
            return .dropped(sourceFrameId: nil, reason: "nonmonotonic_native_timestamp")
        }
        if let previous = currentCalibration, previous != calibrationId {
            try writeCalibrationReset(previous: previous, next: calibrationId, native: native, mapped: mapped, sourceFrameId: nextSourceFrameId)
        }
        if currentCalibration != calibrationId {
            currentCalibration = calibrationId
            if !calibrationsSeen.contains(calibrationId) { calibrationsSeen.append(calibrationId) }
        }
        let identity = H264FrameIdentity(
            sourceFrameId: nextSourceFrameId, native: native, mappedCaptureTimeNs: mapped,
            clockMappingRevision: configuration.anchor.revision, calibrationId: calibrationId,
            encoderPtsUs: ptsUs, nativeTimestamps: nativeTimestamps)
        nextSourceFrameId += 1
        try writeFrameEvent(identity, state: "acquired")
        if !admissible || !ledger.hasCapacity {
            let reason = admissible ? "pending_bound_exhausted" : refusalReason
            try ledger.acquireAndDrop(identity, reason: reason)
            try writeFrameEvent(identity, state: "dropped", extra: [("reason", .string(reason))])
            return .dropped(sourceFrameId: identity.sourceFrameId, reason: reason)
        }
        try ledger.acquire(identity)
        let force = needsKeyFrame
        return .submit(sourceFrameId: identity.sourceFrameId, ptsUs: ptsUs, forceKeyFrame: force)
    }

    func markSubmitted(_ id: Int64) throws {
        guard !closed, let identity = ledger.identity(of: id) else { return }
        try ledger.markSubmitted(id)
        try writeFrameEvent(identity, state: "submitted")
    }

    func drop(_ id: Int64, reason: String) throws {
        guard !closed, let identity = ledger.resolveDropped(id, reason: reason) else { return }
        try writeFrameEvent(identity, state: "dropped", extra: [("reason", .string(reason))])
    }

    enum OutputResult: Equatable {
        case written(sourceFrameId: Int64, sequence: UInt32, isIdr: Bool)
        case dropped(sourceFrameId: Int64, reason: String)
        case ignored(String)
    }

    /// Joins one encoder output to its acquisition by source frame ID + PTS.
    func handle(_ output: H264EncoderOutput) throws -> OutputResult {
        guard !closed else { lateOutputs += 1; return .ignored("late_after_close") }
        guard let id = output.sourceFrameId, ledger.identity(of: id) != nil else {
            orphanOutputs += 1
            return .ignored("unknown_source_frame")
        }
        switch output.kind {
        case .dropped(let reason):
            try drop(id, reason: reason)
            needsKeyFrame = needsKeyFrame || videoMessages == 0
            return .dropped(sourceFrameId: id, reason: reason)
        case .failed:
            try drop(id, reason: "encoder_error")
            return .dropped(sourceFrameId: id, reason: "encoder_error")
        case let .sample(data, sync, parameterSets):
            guard let ptsUs = output.ptsUs else {
                try drop(id, reason: "missing_output_pts")
                return .dropped(sourceFrameId: id, reason: "missing_output_pts")
            }
            let identity: H264FrameIdentity
            do {
                identity = try ledger.checkOutput(id: id, ptsUs: ptsUs)
            } catch H264FrameLedger.LedgerError.ptsIdentityMismatch {
                try drop(id, reason: "pts_identity_mismatch")
                return .dropped(sourceFrameId: id, reason: "pts_identity_mismatch")
            } catch H264FrameLedger.LedgerError.outputPtsRegressed {
                try drop(id, reason: "output_pts_regressed")
                return .dropped(sourceFrameId: id, reason: "output_pts_regressed")
            }
            let au: H264AccessUnit
            do {
                if let sets = parameterSets { try assembler.configure(sets) }
                au = try assembler.assembleLengthPrefixed(sample: data, ptsUs: ptsUs, encoderMarkedSync: sync)
            } catch let e as H264CaptureError {
                try drop(id, reason: e.dropReason)
                if videoMessages == 0 { needsKeyFrame = true }
                return .dropped(sourceFrameId: id, reason: e.dropReason)
            }
            if videoMessages == 0 && !au.isIdr {
                try drop(id, reason: "awaiting_idr")
                needsKeyFrame = true
                return .dropped(sourceFrameId: id, reason: "awaiting_idr")
            }
            guard let channel = channels[Self.videoTopic] else { throw CaptureMcapWriter.WriterError.unknownChannel(0) }
            let wire = CompressedVideoWire.encode(captureTimeNs: identity.mappedCaptureTimeNs, annexB: au.annexB)
            let t = UInt64(identity.mappedCaptureTimeNs)
            let sequence = try writer.addMessage(channelId: channel, logTime: t, publishTime: t, data: wire)
            videoMessages += 1
            if au.isIdr { idrMessages += 1; needsKeyFrame = false }
            try writeFrameEvent(identity, state: "written", extra: [
                ("output_channel", .string(Self.videoTopic)),
                ("output_sequence", .int(Int64(sequence))),
                ("is_idr", .bool(au.isIdr)),
            ])
            ledger.resolveWritten(id)
            return .written(sourceFrameId: id, sequence: sequence, isIdr: au.isIdr)
        }
    }

    var pendingIds: [Int64] { ledger.unresolvedIds }
    var hasCapacity: Bool { ledger.hasCapacity }
    var configurationRevision: Int { assembler.configurationRevision }

    // MARK: Close

    /// Writes Inventory + Close, DataEnd/Footer, and durably closes the file.
    /// Frames still pending are `unresolved`; callers that have flushed and
    /// invalidated the encoder should drop them first with a terminal reason.
    @discardableResult
    func close(outcome requested: H264CaptureOutcome) throws -> H264CaptureSummary {
        if let s = summary { return s }
        let unresolved = Int64(ledger.pendingCount)
        var outcome: String
        var reason: String?
        switch requested {
        case .completed: outcome = "completed"
        case .aborted(let r): outcome = "aborted"; reason = r
        case .failed(let r): outcome = "failed"; reason = r
        }
        if outcome == "completed" && unresolved > 0 {
            outcome = "aborted"
            reason = "unresolved_frames_at_close"
        }
        let c = configuration
        let observed = ledger.written > 0
        let inventory: CaptureJSON = .object([
            ("recording_id", .string(c.recordingId)),
            ("sensors", .array([.object([
                ("sensor_id", .string("rgb_camera")),
                ("kind", .string("camera")),
                ("requested", .string("yes")),
                ("supported", .string("yes")),
                ("enabled", .string("yes")),
                ("observed", .string(observed ? "yes" : "no")),
                ("observed_count", .decimal(ledger.acquired)),
                ("native_clock_id", .string(c.frameClockId)),
                ("unavailable_reason", .null),
            ])])),
            ("calibrations", .array(calibrationsSeen.map { id in
                .object([
                    ("calibration_id", .string(id)),
                    ("stream_id", .string("rgb")),
                    ("state", .string("yes")),
                    ("model", c.calibrationModel.map { CaptureJSON.string($0) } ?? .null),
                ])
            })),
        ])
        let closeTime = max(lastLogTimeNs, min(nowEpochNs(), lastLogTimeNs + CaptureLogTimePolicy.defaultMaxForwardNs / 2))
        try writeJSON("/stateaction/inventory", inventory, logTimeNs: closeTime)
        let drops = ledger.dropReasons.sorted { $0.key < $1.key }.prefix(32).map { r, n in
            CaptureJSON.object([("reason", .string(r)), ("count", .decimal(n))])
        }
        let close: CaptureJSON = .object([
            ("recording_id", .string(c.recordingId)),
            ("outcome", .string(outcome)),
            ("failure_reason", reason.map { CaptureJSON.string(String($0.prefix(256))) } ?? .null),
            ("frames", .object([
                ("acquired", .decimal(ledger.acquired)),
                ("submitted", .decimal(ledger.submitted)),
                ("written", .decimal(ledger.written)),
                ("dropped", .decimal(ledger.dropped)),
                ("unresolved", .decimal(unresolved)),
            ])),
            ("video_messages", .decimal(videoMessages)),
            ("drops", .array(Array(drops))),
            ("motion_events", .object([("accel", .decimal(0)), ("gyro", .decimal(0))])),
            ("sensor_events", .decimal(sensorEvents)),
        ])
        try writeJSON("/stateaction/close", close, logTimeNs: closeTime)
        closed = true
        try writer.finish()
        let s = H264CaptureSummary(
            outcome: outcome, failureReason: reason, acquired: ledger.acquired, submitted: ledger.submitted,
            written: ledger.written, dropped: ledger.dropped, unresolved: unresolved,
            videoMessages: videoMessages, idrMessages: idrMessages, dropReasons: ledger.dropReasons,
            configurationRevisions: assembler.configurationRevision, lateOutputs: lateOutputs,
            orphanOutputs: orphanOutputs, pendingHighWater: ledger.highWater, bytesWritten: writer.bytesWritten)
        summary = s
        return s
    }

    /// Sidecar evidence: actual encoder readback plus lifecycle diagnostics that
    /// the v1.1 schemas have no fields for.
    func evidenceJSON() -> CaptureJSON {
        var pairs: [(String, CaptureJSON)] = [
            ("recording_id", .string(configuration.recordingId)),
            ("rgb_profile", .string(H264CaptureConfiguration.rgbProfile)),
            ("qualification", .string("unqualified")),
            ("frame_clock_id", .string(configuration.frameClockId)),
            ("native_timestamp_rounding", .string(NativeFrameTimestamp.roundingRule)),
            ("requested", .object([
                ("profile", .string(configuration.request.profile.rawValue)),
                ("width", .int(Int64(configuration.request.width))),
                ("height", .int(Int64(configuration.request.height))),
                ("fps", .int(Int64(configuration.request.fps))),
                ("bitrate", .int(Int64(configuration.request.bitrate))),
                ("idr_interval_seconds", .int(Int64(configuration.request.idrIntervalSeconds))),
                ("require_hardware", .bool(configuration.request.requireHardware)),
            ])),
        ]
        if let r = encoderReport {
            pairs.append(("encoder", .object([
                ("name", .string(r.name)),
                ("hardware", r.hardware.map { CaptureJSON.bool($0) } ?? .null),
                ("profile", .string(r.profile.rawValue)),
                ("width", .int(Int64(r.width))), ("height", .int(Int64(r.height))),
                ("fps", .int(Int64(r.fps))), ("bitrate", .int(Int64(r.bitrate))),
                ("idr_interval_seconds", .int(Int64(r.idrIntervalSeconds))),
                ("frame_reordering_allowed", .bool(r.frameReorderingAllowed)),
                ("platform", .object(r.evidence)),
            ])))
        }
        if let s = summary {
            pairs.append(("summary", .object([
                ("outcome", .string(s.outcome)),
                ("configuration_revisions", .int(Int64(s.configurationRevisions))),
                ("idr_messages", .decimal(s.idrMessages)),
                ("late_outputs", .decimal(s.lateOutputs)),
                ("orphan_outputs", .decimal(s.orphanOutputs)),
                ("pending_high_water", .int(Int64(s.pendingHighWater))),
                ("bytes_written", .decimal(s.bytesWritten)),
            ])))
        }
        return .object(pairs)
    }

    // MARK: Writing helpers

    private static let timeBase: CaptureJSON = .object([("numerator", .int(1)), ("denominator", .int(1_000_000))])

    private func writeJSON(_ topic: String, _ value: CaptureJSON, logTimeNs: Int64) throws {
        guard let channel = channels[topic] else { throw CaptureMcapWriter.WriterError.unknownChannel(0) }
        let t = UInt64(logTimeNs)
        try writer.addMessage(channelId: channel, logTime: t, publishTime: t, data: value.data())
        lastLogTimeNs = max(lastLogTimeNs, logTimeNs)
    }

    private func writeFrameEvent(_ id: H264FrameIdentity, state: String, extra: [(String, CaptureJSON)] = []) throws {
        var pairs: [(String, CaptureJSON)] = [
            ("recording_id", .string(configuration.recordingId)),
            ("stream_id", .string("rgb")),
            ("source_frame_id", .decimal(id.sourceFrameId)),
            ("state", .string(state)),
            ("native_clock_id", .string(id.native.clockId)),
            ("clock_mapping_revision", .string(id.clockMappingRevision)),
            ("calibration_id", .string(id.calibrationId)),
            ("native_timestamp_ns", .decimal(id.native.nanoseconds)),
            ("mapped_capture_time_ns", .decimal(id.mappedCaptureTimeNs)),
            ("encoder_pts_us", .decimal(id.encoderPtsUs)),
            ("encoder_time_base", Self.timeBase),
            ("native_timestamps", .object(id.nativeTimestamps.map { ($0.0, CaptureJSON.decimal($0.1)) })),
        ]
        pairs.append(contentsOf: extra)
        try writeJSON("/stateaction/frame_events", .object(pairs), logTimeNs: id.mappedCaptureTimeNs)
    }

    private func writeCalibrationReset(previous: String, next: String, native: NativeFrameTimestamp, mapped: Int64, sourceFrameId: Int64) throws {
        guard let channel = channels["/stateaction/sensor_events"], let seq = writer.peekNextSequence(channelId: channel) else { return }
        let event: CaptureJSON = .object([
            ("recording_id", .string(configuration.recordingId)),
            ("stream_id", .string("rgb")),
            ("event_id", .decimal(nextSensorEventId)),
            ("native_timestamp_ns", .decimal(native.nanoseconds)),
            ("native_clock_id", .string(native.clockId)),
            ("mapped_capture_time_ns", .decimal(mapped)),
            ("output_channel", .string("/stateaction/sensor_events")),
            ("output_sequence", .int(Int64(seq))),
            ("source_kind", .string("calibration_reset")),
            ("calibration_id", .string(next)),
            ("association_source_frame_id", .decimal(sourceFrameId)),
            ("supersedes_calibration_id", .string(previous)),
        ])
        try writeJSON("/stateaction/sensor_events", event, logTimeNs: mapped)
        nextSensorEventId += 1
        sensorEvents += 1
    }
}

/// Drives an encoder and a session with bounded in-flight frames. Thread-safe:
/// camera submissions and asynchronous encoder callbacks are serialised by one
/// recursive lock (an encoder may call back synchronously from `encode`).
final class H264CaptureController<Encoder: H264FrameEncoding> {
    private let lock = NSRecursiveLock()
    private let encoder: Encoder
    let session: H264CaptureSession
    private(set) var report: H264EncoderReport?
    private(set) var encoderFailure: String?
    private var invalidated = false

    /// Creates the session file and starts the encoder. If the encoder rejects
    /// the request the error propagates (no silent fallback); the caller must
    /// abort the recording and delete/close the file via `abandon`.
    init(encoder: Encoder, session: H264CaptureSession) throws {
        self.encoder = encoder
        self.session = session
        let report = try encoder.start(request: session.configuration.request) { [weak self] output in
            self?.handle(output)
        }
        let req = session.configuration.request
        if req.requireHardware && report.hardware == false {
            encoder.invalidate()
            throw H264EncoderStartError.hardwareUnavailable("encoder reported software encoding")
        }
        if report.profile != req.profile {
            encoder.invalidate()
            throw H264EncoderStartError.profileRejected("requested \(req.profile.rawValue), got \(report.profile.rawValue)")
        }
        if report.frameReorderingAllowed {
            encoder.invalidate()
            throw H264EncoderStartError.propertyRejected("frame reordering could not be disabled")
        }
        if report.width != req.width || report.height != req.height {
            encoder.invalidate()
            throw H264EncoderStartError.propertyRejected("raster \(report.width)x\(report.height) != requested \(req.width)x\(req.height)")
        }
        self.report = report
        try session.start(encoder: report)
    }

    /// Submits one camera frame. `rasterWidth/Height` are the frame's actual
    /// dimensions; a mismatch with the encoder raster is dropped explicitly
    /// (never rescaled silently).
    @discardableResult
    func submit(_ frame: Encoder.Frame, rasterWidth: Int, rasterHeight: Int, native: NativeFrameTimestamp,
                nativeTimestamps: [(String, Int64)], calibrationId: String) throws -> H264CaptureSession.Admission {
        lock.lock(); defer { lock.unlock() }
        let req = session.configuration.request
        var admissible = true
        var reason = ""
        if invalidated { admissible = false; reason = "encoder_invalidated" }
        else if encoderFailure != nil { admissible = false; reason = "encoder_failed" }
        else if rasterWidth != req.width || rasterHeight != req.height { admissible = false; reason = "raster_mismatch" }
        let admission = try session.acquire(native: native, nativeTimestamps: nativeTimestamps, calibrationId: calibrationId,
                                            admissible: admissible, refusalReason: reason)
        guard case let .submit(id, ptsUs, force) = admission else { return admission }
        try session.markSubmitted(id)
        do {
            try encoder.encode(frame, sourceFrameId: id, ptsUs: ptsUs, forceKeyFrame: force)
        } catch {
            try session.drop(id, reason: "encode_submit_failed")
            return .dropped(sourceFrameId: id, reason: "encode_submit_failed")
        }
        return admission
    }

    func handle(_ output: H264EncoderOutput) {
        lock.lock(); defer { lock.unlock() }
        if case let .failed(status) = output.kind, encoderFailure == nil {
            encoderFailure = "encoder_status_\(status)"
        }
        do { _ = try session.handle(output) } catch {
            encoderFailure = encoderFailure ?? "writer_error"
        }
    }

    /// Completes outstanding frames, invalidates the encoder, gives every frame
    /// still pending a terminal outcome and closes the file.
    @discardableResult
    func finish(outcome: H264CaptureOutcome, flushTimeoutSeconds: Double = 2.0) throws -> H264CaptureSummary {
        let flushed = encoder.completeFrames(timeoutSeconds: flushTimeoutSeconds)
        lock.lock()
        invalidated = true
        lock.unlock()
        encoder.invalidate()
        lock.lock(); defer { lock.unlock() }
        let reason = flushed ? "encoder_flush_without_output" : "encoder_flush_timeout"
        for id in session.pendingIds { try session.drop(id, reason: reason) }
        var final = outcome
        if case .completed = outcome, let failure = encoderFailure { final = .failed(failure) }
        return try session.close(outcome: final)
    }
}
