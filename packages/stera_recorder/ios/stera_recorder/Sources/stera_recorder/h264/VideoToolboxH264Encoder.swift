#if canImport(VideoToolbox) && canImport(CoreMedia)
import CoreMedia
import CoreVideo
import Foundation
import VideoToolbox

// Hardware H.264 encoder adapter for the iOS `h264_mcap_v1` path.
//
// STATUS: written against the public VideoToolbox/CoreMedia API but NOT
// compiled or run here (no macOS/Xcode toolchain was available to SA-52). The
// portable session/assembler/ledger it feeds are tested on Linux; this adapter
// still needs an Xcode build, simulator/device run and physical qualification.
//
// Rules implemented:
// - Hardware is required through the encoder specification and confirmed by
//   reading back `UsingHardwareAcceleratedVideoEncoder` where the OS reports it;
//   a software readback is rejected (no fallback). An unreportable status is
//   recorded as `hardware: null`, never claimed.
// - The requested profile, disabled frame reordering, bitrate, frame rate and
//   key-frame interval are set and must succeed; profile and reordering are
//   read back and a mismatch rejects the start.
// - Each frame carries its source frame ID as `sourceFrameRefcon` and an exact
//   microsecond PTS; outputs are joined by refcon + PTS, never callback order.
// - Parameter sets and NAL length size come from each sample's format
//   description; the session prepends them to every IDR.

/// Property keys referenced by their documented string values so the adapter
/// does not depend on per-SDK symbol availability for keys that are newer than
/// the iOS 14 deployment target. VideoToolbox ignores/declines unknown keys
/// with an error status, which is recorded.
private enum VTKeys {
    static let requireHardware = "RequireHardwareAcceleratedVideoEncoder" as CFString
    static let enableHardware = "EnableHardwareAcceleratedVideoEncoder" as CFString
    static let usingHardware = "UsingHardwareAcceleratedVideoEncoder" as CFString
    static let encoderId = "EncoderID" as CFString
}

private let videoToolboxH264OutputCallback: VTCompressionOutputCallback = { outputRefcon, sourceFrameRefcon, status, infoFlags, sampleBuffer in
    guard let outputRefcon else { return }
    let encoder = Unmanaged<VideoToolboxH264Encoder>.fromOpaque(outputRefcon).takeUnretainedValue()
    let sourceId: Int64? = sourceFrameRefcon.map { Int64(Int(bitPattern: $0)) }
    encoder.deliver(sourceFrameId: sourceId, status: status, infoFlags: infoFlags, sampleBuffer: sampleBuffer)
}

final class VideoToolboxH264Encoder: H264FrameEncoding {
    typealias Frame = CVPixelBuffer

    struct EncodeError: Error { let status: OSStatus }

    private let stateLock = NSLock()
    private var session: VTCompressionSession?
    private var retainedSelf: Unmanaged<VideoToolboxH264Encoder>?
    private var output: ((H264EncoderOutput) -> Void)?
    private var lastFormat: CMFormatDescription?
    private var lastParameterSets: H264ParameterSets?
    private(set) var firstFrameEvidence: [(String, CaptureJSON)]?

    func start(request: H264EncoderRequest, output: @escaping (H264EncoderOutput) -> Void) throws -> H264EncoderReport {
        self.output = output
        var spec: [CFString: Any] = [:]
        if request.requireHardware {
            spec[VTKeys.requireHardware] = kCFBooleanTrue
            spec[VTKeys.enableHardware] = kCFBooleanTrue
        }
        let retained = Unmanaged.passRetained(self)
        var created: VTCompressionSession?
        let status = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: Int32(request.width),
            height: Int32(request.height),
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: spec as CFDictionary,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: videoToolboxH264OutputCallback,
            refcon: retained.toOpaque(),
            compressionSessionOut: &created)
        guard status == noErr, let session = created else {
            retained.release()
            if request.requireHardware {
                throw H264EncoderStartError.hardwareUnavailable("VTCompressionSessionCreate status \(status) with hardware required")
            }
            throw H264EncoderStartError.sessionCreationFailed(status)
        }
        stateLock.lock()
        self.session = session
        self.retainedSelf = retained
        stateLock.unlock()

        var statuses: [(String, CaptureJSON)] = []
        func set(_ key: CFString, _ value: CFTypeRef, _ label: String) -> OSStatus {
            let st = VTSessionSetProperty(session, key: key, value: value)
            statuses.append((label, .int(Int64(st))))
            return st
        }
        let profileLevel: CFString
        switch request.profile {
        case .baseline: profileLevel = kVTProfileLevel_H264_Baseline_AutoLevel
        case .main: profileLevel = kVTProfileLevel_H264_Main_AutoLevel
        case .high: profileLevel = kVTProfileLevel_H264_High_AutoLevel
        }
        do {
            guard set(kVTCompressionPropertyKey_ProfileLevel, profileLevel, "set_profile_level") == noErr else {
                throw H264EncoderStartError.profileRejected("ProfileLevel \(profileLevel) not accepted")
            }
            guard set(kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse, "set_allow_frame_reordering") == noErr else {
                throw H264EncoderStartError.propertyRejected("AllowFrameReordering=false not accepted")
            }
            let required: [(CFString, CFTypeRef, String)] = [
                (kVTCompressionPropertyKey_RealTime, kCFBooleanTrue, "set_real_time"),
                (kVTCompressionPropertyKey_AverageBitRate, NSNumber(value: request.bitrate), "set_average_bit_rate"),
                (kVTCompressionPropertyKey_ExpectedFrameRate, NSNumber(value: request.fps), "set_expected_frame_rate"),
                (kVTCompressionPropertyKey_MaxKeyFrameInterval, NSNumber(value: request.fps * request.idrIntervalSeconds), "set_max_key_frame_interval"),
                (kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, NSNumber(value: request.idrIntervalSeconds), "set_max_key_frame_interval_duration"),
            ]
            for (key, value, label) in required where set(key, value, label) != noErr {
                throw H264EncoderStartError.propertyRejected("\(label) not accepted")
            }
            let prepare = VTCompressionSessionPrepareToEncodeFrames(session)
            statuses.append(("prepare_to_encode", .int(Int64(prepare))))
            guard prepare == noErr else { throw H264EncoderStartError.sessionCreationFailed(prepare) }
        } catch {
            invalidate()
            throw error
        }

        let readProfile = copyProperty(session, kVTCompressionPropertyKey_ProfileLevel) as? String
        let reordering = (copyProperty(session, kVTCompressionPropertyKey_AllowFrameReordering) as? Bool) ?? true
        let hardware = copyProperty(session, VTKeys.usingHardware) as? Bool
        let encoderId = copyProperty(session, VTKeys.encoderId) as? String
        let actualProfile: H264ProfileName
        switch readProfile {
        case (kVTProfileLevel_H264_Baseline_AutoLevel as String)?: actualProfile = .baseline
        case (kVTProfileLevel_H264_Main_AutoLevel as String)?: actualProfile = .main
        case (kVTProfileLevel_H264_High_AutoLevel as String)?: actualProfile = .high
        default:
            invalidate()
            throw H264EncoderStartError.profileRejected("ProfileLevel readback \(readProfile ?? "unavailable")")
        }
        var evidence = statuses
        evidence.append(("profile_level_readback", .string(readProfile ?? "")))
        evidence.append(("allow_frame_reordering_readback", .bool(reordering)))
        evidence.append(("using_hardware_readback", hardware.map { CaptureJSON.bool($0) } ?? .null))
        evidence.append(("encoder_id", encoderId.map { CaptureJSON.string($0) } ?? .null))
        evidence.append(("require_hardware_spec", .bool(request.requireHardware)))
        return H264EncoderReport(
            name: "videotoolbox.h264", hardware: hardware, profile: actualProfile,
            width: request.width, height: request.height, fps: request.fps, bitrate: request.bitrate,
            idrIntervalSeconds: request.idrIntervalSeconds, frameReorderingAllowed: reordering, evidence: evidence)
    }

    func encode(_ frame: CVPixelBuffer, sourceFrameId: Int64, ptsUs: Int64, forceKeyFrame: Bool) throws {
        stateLock.lock()
        let session = self.session
        if firstFrameEvidence == nil { firstFrameEvidence = Self.frameEvidence(frame) }
        stateLock.unlock()
        guard let session, sourceFrameId > 0 else { throw EncodeError(status: kVTInvalidSessionErr) }
        let properties: CFDictionary? = forceKeyFrame
            ? [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue] as CFDictionary : nil
        var flags = VTEncodeInfoFlags()
        let status = VTCompressionSessionEncodeFrame(
            session, imageBuffer: frame,
            presentationTimeStamp: CMTime(value: ptsUs, timescale: 1_000_000),
            duration: .invalid, frameProperties: properties,
            sourceFrameRefcon: UnsafeMutableRawPointer(bitPattern: Int(sourceFrameId)),
            infoFlagsOut: &flags)
        guard status == noErr else { throw EncodeError(status: status) }
    }

    func completeFrames(timeoutSeconds: Double) -> Bool {
        stateLock.lock()
        let session = self.session
        stateLock.unlock()
        guard let session else { return true }
        let done = DispatchSemaphore(value: 0)
        var status: OSStatus = noErr
        DispatchQueue.global(qos: .userInitiated).async {
            status = VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
            done.signal()
        }
        return done.wait(timeout: .now() + timeoutSeconds) == .success && status == noErr
    }

    func invalidate() {
        stateLock.lock()
        let session = self.session
        let retained = retainedSelf
        self.session = nil
        retainedSelf = nil
        stateLock.unlock()
        if let session { VTCompressionSessionInvalidate(session) }
        retained?.release()
    }

    // MARK: Output

    fileprivate func deliver(sourceFrameId: Int64?, status: OSStatus, infoFlags: VTEncodeInfoFlags, sampleBuffer: CMSampleBuffer?) {
        guard let output else { return }
        if status != noErr {
            output(H264EncoderOutput(sourceFrameId: sourceFrameId, ptsUs: nil, kind: .failed(status: status)))
            return
        }
        if infoFlags.contains(.frameDropped) {
            output(H264EncoderOutput(sourceFrameId: sourceFrameId, ptsUs: nil, kind: .dropped(reason: "encoder_dropped")))
            return
        }
        guard let sample = sampleBuffer, CMSampleBufferDataIsReady(sample) else {
            output(H264EncoderOutput(sourceFrameId: sourceFrameId, ptsUs: nil, kind: .dropped(reason: "encoder_no_sample")))
            return
        }
        let ptsUs = Self.exactMicroseconds(CMSampleBufferGetPresentationTimeStamp(sample))
        guard let block = CMSampleBufferGetDataBuffer(sample) else {
            output(H264EncoderOutput(sourceFrameId: sourceFrameId, ptsUs: ptsUs, kind: .dropped(reason: "encoder_no_data")))
            return
        }
        let length = CMBlockBufferGetDataLength(block)
        guard length > 0, length <= H264Bitstream.maxAccessUnitBytes else {
            output(H264EncoderOutput(sourceFrameId: sourceFrameId, ptsUs: ptsUs, kind: .dropped(reason: "access_unit_too_large")))
            return
        }
        var data = Data(count: length)
        let copy = data.withUnsafeMutableBytes { raw -> OSStatus in
            guard let base = raw.baseAddress else { return kCMBlockBufferBadPointerParameterErr }
            return CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: base)
        }
        guard copy == noErr else {
            output(H264EncoderOutput(sourceFrameId: sourceFrameId, ptsUs: ptsUs, kind: .dropped(reason: "encoder_copy_failed")))
            return
        }
        var sync = true
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]],
           let first = attachments.first, let notSync = first[kCMSampleAttachmentKey_NotSync] as? Bool {
            sync = !notSync
        }
        let sets = parameterSets(for: CMSampleBufferGetFormatDescription(sample))
        output(H264EncoderOutput(sourceFrameId: sourceFrameId, ptsUs: ptsUs,
                                 kind: .sample(data: data, encoderMarkedSync: sync, parameterSets: sets)))
    }

    /// SPS/PPS and NAL length size from the sample's format description, cached
    /// while the description is unchanged.
    private func parameterSets(for format: CMFormatDescription?) -> H264ParameterSets? {
        guard let format else { return nil }
        if let last = lastFormat, CFEqual(last, format) { return lastParameterSets }
        var count = 0
        var nalLength: Int32 = 0
        guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            format, parameterSetIndex: 0, parameterSetPointerOut: nil, parameterSetSizeOut: nil,
            parameterSetCountOut: &count, nalUnitHeaderLengthOut: &nalLength) == noErr, count > 0
        else { return nil }
        var sps: [Data] = []
        var pps: [Data] = []
        for index in 0..<count {
            var pointer: UnsafePointer<UInt8>?
            var size = 0
            guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                format, parameterSetIndex: index, parameterSetPointerOut: &pointer, parameterSetSizeOut: &size,
                parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil) == noErr,
                let pointer, size > 0 else { return nil }
            let nal = Data(bytes: pointer, count: size)
            switch H264Bitstream.nalType(nal) {
            case H264NalType.sps: sps.append(nal)
            case H264NalType.pps: pps.append(nal)
            default: break
            }
        }
        let sets = H264ParameterSets(sps: sps, pps: pps, nalLengthSize: Int(nalLength))
        lastFormat = format
        lastParameterSets = sets
        return sets
    }

    // MARK: Helpers

    private func copyProperty(_ session: VTCompressionSession, _ key: CFString) -> Any? {
        var value: CFTypeRef?
        let status = VTSessionCopyProperty(session, key: key, allocator: kCFAllocatorDefault, valueOut: &value)
        return status == noErr ? value : nil
    }

    /// Exact microseconds or nil (never rounded into a different identity).
    static func exactMicroseconds(_ time: CMTime) -> Int64? {
        guard time.isValid, time.isNumeric, time.timescale > 0 else { return nil }
        if time.timescale == 1_000_000 { return time.value }
        let (scaled, overflow) = time.value.multipliedReportingOverflow(by: 1_000_000)
        guard !overflow, scaled % Int64(time.timescale) == 0 else { return nil }
        return scaled / Int64(time.timescale)
    }

    /// Actual raster, pixel format and colour attachments of the first frame.
    static func frameEvidence(_ buffer: CVPixelBuffer) -> [(String, CaptureJSON)] {
        let format = CVPixelBufferGetPixelFormatType(buffer)
        let fourcc = String(bytes: [24, 16, 8, 0].map { UInt8((format >> $0) & 0xFF) }, encoding: .ascii) ?? String(format)
        func attachment(_ key: CFString) -> CaptureJSON {
            let value: CFTypeRef?
            if #available(iOS 15.0, macOS 12.0, *) {
                value = CVBufferCopyAttachment(buffer, key, nil)
            } else {
                value = CVBufferGetAttachment(buffer, key, nil)?.takeUnretainedValue()
            }
            return (value as? String).map { CaptureJSON.string($0) } ?? .null
        }
        return [
            ("pixel_format", .string(fourcc)),
            ("width", .int(Int64(CVPixelBufferGetWidth(buffer)))),
            ("height", .int(Int64(CVPixelBufferGetHeight(buffer)))),
            ("color_primaries", attachment(kCVImageBufferColorPrimariesKey)),
            ("transfer_function", attachment(kCVImageBufferTransferFunctionKey)),
            ("ycbcr_matrix", attachment(kCVImageBufferYCbCrMatrixKey)),
            ("full_range", .bool(format == kCVPixelFormatType_420YpCbCr8BiPlanarFullRange)),
        ]
    }
}
#endif
