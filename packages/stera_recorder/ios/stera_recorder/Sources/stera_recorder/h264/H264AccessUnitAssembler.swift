import Foundation

/// One complete Annex B image access unit ready for `/camera/rgb/video`.
struct H264AccessUnit: Equatable {
    let annexB: Data
    let isIdr: Bool
    let ptsUs: Int64
    /// Monotonic per-session revision of the parameter sets prepended/observed.
    /// 0 means no configuration has been seen.
    let configurationRevision: Int
}

/// Parameter sets as delivered by the encoder's format description.
struct H264ParameterSets: Equatable {
    let sps: [Data]
    let pps: [Data]
    /// Length-prefix size of the NALs in each sample (1, 2 or 4) from the same format description.
    let nalLengthSize: Int

    var annexBNals: [Data] { sps + pps }
}

/// Builds whole access units from encoder output. Configuration is stored and
/// prepended to **every** IDR that does not already carry SPS+PPS, never emitted
/// as an image on its own. State is per instance: a new recording creates a new
/// assembler, so a previous session's configuration can never leak forward.
final class H264AccessUnitAssembler {
    private(set) var parameterSets: H264ParameterSets?
    private(set) var configurationRevision = 0
    private var configNals: [Data] = []

    /// Installs parameter sets read from a format description. Returns `true`
    /// when they changed (new revision).
    @discardableResult
    func configure(_ sets: H264ParameterSets) throws -> Bool {
        guard sets.nalLengthSize == 1 || sets.nalLengthSize == 2 || sets.nalLengthSize == 4 else {
            throw H264CaptureError.unsupportedNalLengthSize(sets.nalLengthSize)
        }
        guard !sets.sps.isEmpty, !sets.pps.isEmpty,
              sets.sps.allSatisfy({ !$0.isEmpty && H264Bitstream.nalType($0) == H264NalType.sps }),
              sets.pps.allSatisfy({ !$0.isEmpty && H264Bitstream.nalType($0) == H264NalType.pps })
        else { throw H264CaptureError.missingParameterSets }
        if sets == parameterSets { return false }
        parameterSets = sets
        configNals = sets.annexBNals
        configurationRevision += 1
        return true
    }

    /// Codec-configuration-only buffer (Annex B). Used by the buffer-sequence
    /// replay; VideoToolbox delivers configuration through `configure(_:)`.
    func storeAnnexBConfiguration(_ nals: [Data]) throws {
        guard nals.contains(where: { H264Bitstream.nalType($0) == H264NalType.sps }),
              nals.contains(where: { H264Bitstream.nalType($0) == H264NalType.pps })
        else { throw H264CaptureError.missingParameterSets }
        if nals != configNals {
            configNals = nals
            configurationRevision += 1
        }
    }

    /// Assembles one VideoToolbox sample: length-prefixed NALs with the
    /// format description's NAL length size. `encoderMarkedSync` is the sample's
    /// `kCMSampleAttachmentKey_NotSync` inverse; it must agree with the bitstream.
    func assembleLengthPrefixed(sample: Data, ptsUs: Int64, encoderMarkedSync: Bool?) throws -> H264AccessUnit {
        guard let sets = parameterSets else { throw H264CaptureError.missingParameterSets }
        let nals = try H264Bitstream.splitLengthPrefixed(sample, nalLengthSize: sets.nalLengthSize)
        let au = try assemble(nals: nals, ptsUs: ptsUs)
        if let sync = encoderMarkedSync, sync != au.isIdr {
            throw H264CaptureError.invalidBitstream("encoder sync attachment (\(sync)) disagrees with slices (idr=\(au.isIdr))")
        }
        return au
    }

    /// Assembles NAL payloads of exactly one encoded picture.
    func assemble(nals: [Data], ptsUs: Int64) throws -> H264AccessUnit {
        guard ptsUs >= 0 else { throw H264CaptureError.ptsInvalid }
        guard !nals.isEmpty else { throw H264CaptureError.incompleteAccessUnit }
        let types = nals.map(H264Bitstream.nalType)
        guard let firstSlice = types.firstIndex(where: { $0 == H264NalType.nonIdrSlice || $0 == H264NalType.idrSlice }) else {
            throw H264CaptureError.configOnly
        }
        var units = nals
        let isIdrCandidate = types.contains(H264NalType.idrSlice)
        if isIdrCandidate {
            let before = types[..<firstSlice]
            if !(before.contains(H264NalType.sps) && before.contains(H264NalType.pps)) {
                guard !configNals.isEmpty else { throw H264CaptureError.missingParameterSets }
                units = configNals + nals
            }
        }
        let bytes = H264Bitstream.joinAnnexB(units)
        guard bytes.count <= H264Bitstream.maxAccessUnitBytes else {
            throw H264CaptureError.accessUnitTooLarge(bytes.count)
        }
        let idr = try H264Bitstream.validateAccessUnit(nals: units)
        return H264AccessUnit(annexB: bytes, isIdr: idr, ptsUs: ptsUs, configurationRevision: configurationRevision)
    }
}

/// Replays MediaCodec-style output buffer sequences (SA-50
/// `fixtures/encoder_buffers.json`) through the same assembler so the Swift
/// producer is tested against the shared contract fixture.
struct H264EncoderBuffer {
    static let keyFrame = 1
    static let codecConfig = 2
    static let endOfStream = 4
    static let partialFrame = 8

    let flags: Int
    let ptsUs: String
    let annexB: Data
}

enum H264BufferSequenceReplay {
    struct Result: Equatable {
        let accessUnits: [H264AccessUnit]
        let errors: [String]
    }

    static func assemble(_ buffers: [H264EncoderBuffer]) -> Result {
        let assembler = H264AccessUnitAssembler()
        var aus: [H264AccessUnit] = []
        var pending: (pts: String, data: Data)?
        func reject(_ e: H264CaptureError) -> Result { Result(accessUnits: [], errors: [e.code]) }
        do {
            for buf in buffers {
                if buf.flags & H264EncoderBuffer.codecConfig != 0 {
                    if pending != nil { return reject(.incompleteAccessUnit) }
                    try assembler.storeAnnexBConfiguration(try H264Bitstream.splitAnnexB(buf.annexB))
                    continue
                }
                if buf.flags & H264EncoderBuffer.endOfStream != 0 && buf.annexB.isEmpty {
                    if pending != nil { return reject(.incompleteAccessUnit) }
                    return Result(accessUnits: aus, errors: [])
                }
                guard let pts = CaptureDecimal.parseNonNegative(buf.ptsUs) else { return reject(.ptsInvalid) }
                if let p = pending, p.pts != buf.ptsUs { return reject(.partialPtsMismatch) }
                let data = (pending?.data ?? Data()) + buf.annexB
                if buf.flags & H264EncoderBuffer.partialFrame != 0 {
                    pending = (buf.ptsUs, data)
                    continue
                }
                pending = nil
                aus.append(try assembler.assemble(nals: try H264Bitstream.splitAnnexB(data), ptsUs: pts))
            }
        } catch let e as H264CaptureError {
            return reject(e)
        } catch {
            return Result(accessUnits: [], errors: ["E_UNEXPECTED"])
        }
        if pending != nil { return reject(.incompleteAccessUnit) }
        return Result(accessUnits: aus, errors: [])
    }
}

/// Canonical int64 decimal strings (SA-50 `int64Decimal`).
enum CaptureDecimal {
    static func parseNonNegative(_ text: String) -> Int64? {
        guard !text.isEmpty, text.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }) else { return nil }
        if text.count > 1 && text.hasPrefix("0") { return nil }
        return Int64(text)
    }
}
