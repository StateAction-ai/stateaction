import Foundation

// Portable (Foundation-only) H.264 bitstream rules for the iOS `h264_mcap_v1`
// producer. Nothing in this file touches VideoToolbox, AVFoundation or ARKit so
// that the exact same source compiles and is tested on Linux Swift
// (`packages/stera_recorder/ios/portable_h264`). It mirrors the SA-50 writer
// contract (`packages/contracts/capture/README.md`, encoder buffer sequences)
// and the Android `AnnexB` rules.

/// Contract reject codes shared with the SA-50 readers plus producer-side codes.
/// Raw values are the `reason`/error labels written into evidence.
enum H264CaptureError: Error, Equatable, CustomStringConvertible {
    case incompleteAccessUnit
    case partialPtsMismatch
    case missingParameterSets
    case multipleAccessUnits
    case ptsInvalid
    case configOnly
    case bFrame
    case invalidBitstream(String)
    case accessUnitTooLarge(Int)
    case unsupportedNalLengthSize(Int)

    /// Stable code. The first five equal the SA-50 encoder-buffer contract codes.
    var code: String {
        switch self {
        case .incompleteAccessUnit: return "E_INCOMPLETE_AU"
        case .partialPtsMismatch: return "E_PARTIAL_PTS_MISMATCH"
        case .missingParameterSets: return "E_MISSING_PARAMETER_SETS"
        case .multipleAccessUnits: return "E_MULTIPLE_ACCESS_UNITS"
        case .ptsInvalid: return "E_PTS_INVALID"
        case .configOnly: return "E_CONFIG_ONLY"
        case .bFrame: return "E_B_FRAME"
        case .invalidBitstream: return "E_INVALID_BITSTREAM"
        case .accessUnitTooLarge: return "E_AU_TOO_LARGE"
        case .unsupportedNalLengthSize: return "E_NAL_LENGTH_SIZE"
        }
    }

    /// Label-safe (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`) drop reason for FrameEvent.
    var dropReason: String {
        switch self {
        case .incompleteAccessUnit: return "incomplete_access_unit"
        case .partialPtsMismatch: return "partial_pts_mismatch"
        case .missingParameterSets: return "missing_parameter_sets"
        case .multipleAccessUnits: return "multiple_access_units"
        case .ptsInvalid: return "pts_invalid"
        case .configOnly: return "config_only_output"
        case .bFrame: return "b_frame_output"
        case .invalidBitstream: return "invalid_bitstream"
        case .accessUnitTooLarge: return "access_unit_too_large"
        case .unsupportedNalLengthSize: return "unsupported_nal_length_size"
        }
    }

    var description: String {
        switch self {
        case .invalidBitstream(let why): return "\(code): \(why)"
        case .accessUnitTooLarge(let n): return "\(code): \(n) bytes"
        case .unsupportedNalLengthSize(let n): return "\(code): \(n)"
        default: return code
        }
    }
}

enum H264NalType {
    static let nonIdrSlice: UInt8 = 1
    static let idrSlice: UInt8 = 5
    static let sei: UInt8 = 6
    static let sps: UInt8 = 7
    static let pps: UInt8 = 8
    static let accessUnitDelimiter: UInt8 = 9
}

enum H264Bitstream {
    static let startCode: [UInt8] = [0, 0, 0, 1]
    /// Same bound as the Android producer and the SA-50 Profile `access_unit_bytes`.
    static let maxAccessUnitBytes = 16 * 1024 * 1024 - 4096
    static let maxNalsPerAccessUnit = 4096

    @inline(__always)
    static func nalType(_ nal: Data) -> UInt8 {
        nal[nal.startIndex] & 0x1F
    }

    /// Splits length-prefixed (AVCC/ISO 14496-15) sample data into NAL payloads.
    /// `nalLengthSize` must come from the format description
    /// (`CMVideoFormatDescriptionGetH264ParameterSetAtIndex` `nalUnitHeaderLengthOut`),
    /// never be assumed to be 4.
    static func splitLengthPrefixed(_ data: Data, nalLengthSize: Int) throws -> [Data] {
        guard nalLengthSize == 1 || nalLengthSize == 2 || nalLengthSize == 4 else {
            throw H264CaptureError.unsupportedNalLengthSize(nalLengthSize)
        }
        var result: [Data] = []
        var index = data.startIndex
        while index < data.endIndex {
            guard data.endIndex - index >= nalLengthSize else {
                throw H264CaptureError.invalidBitstream("truncated NAL length prefix")
            }
            var size = 0
            for k in 0..<nalLengthSize { size = (size << 8) | Int(data[index + k]) }
            index += nalLengthSize
            guard size > 0, size <= data.endIndex - index else {
                throw H264CaptureError.invalidBitstream("NAL length \(size) overruns sample")
            }
            result.append(data.subdata(in: index..<(index + size)))
            index += size
            guard result.count <= maxNalsPerAccessUnit else {
                throw H264CaptureError.invalidBitstream("NAL count bound exhausted")
            }
        }
        return result
    }

    /// Parses an Annex B byte stream into NAL payloads (no start codes). Leading
    /// bytes before the first start code are rejected.
    static func splitAnnexB(_ data: Data) throws -> [Data] {
        let bytes = [UInt8](data)
        var starts: [(Int, Int)] = []
        var i = 0
        while i + 2 < bytes.count {
            var n = 0
            if bytes[i] == 0 && bytes[i + 1] == 0 {
                if bytes[i + 2] == 1 { n = 3 }
                else if i + 3 < bytes.count && bytes[i + 2] == 0 && bytes[i + 3] == 1 { n = 4 }
            }
            if n != 0 { starts.append((i, n)); i += n } else { i += 1 }
        }
        guard let first = starts.first else {
            throw H264CaptureError.invalidBitstream("no Annex B start code")
        }
        guard first.0 == 0 else { throw H264CaptureError.invalidBitstream("junk before Annex B start code") }
        guard starts.count <= maxNalsPerAccessUnit else {
            throw H264CaptureError.invalidBitstream("NAL count bound exhausted")
        }
        var nals: [Data] = []
        nals.reserveCapacity(starts.count)
        for (k, s) in starts.enumerated() {
            let begin = s.0 + s.1
            let end = k + 1 < starts.count ? starts[k + 1].0 : bytes.count
            guard end > begin else { throw H264CaptureError.invalidBitstream("empty NAL") }
            nals.append(Data(bytes[begin..<end]))
        }
        return nals
    }

    static func joinAnnexB(_ nals: [Data]) -> Data {
        var out = Data()
        out.reserveCapacity(nals.reduce(0) { $0 + $1.count + 4 })
        for nal in nals {
            out.append(contentsOf: startCode)
            out.append(nal)
        }
        return out
    }

    /// `(first_mb_in_slice, slice_type)` read from at most 16 unescaped bytes; the
    /// pixel payload is never copied.
    static func sliceHeader(_ nal: Data) throws -> (firstMb: Int, sliceType: Int) {
        var buf = [UInt8](repeating: 0, count: 16)
        var count = 0
        var zeros = 0
        var index = nal.startIndex + 1
        while index < nal.endIndex && count < buf.count {
            let b = nal[index]
            index += 1
            if zeros >= 2 && b == 3 { zeros = 0; continue }
            buf[count] = b
            count += 1
            zeros = b == 0 ? zeros + 1 : 0
        }
        var bit = 0
        func readBit() throws -> Int {
            guard bit < count * 8 else { throw H264CaptureError.invalidBitstream("truncated slice header") }
            let v = Int(buf[bit / 8] >> UInt8(7 - bit % 8)) & 1
            bit += 1
            return v
        }
        func ue() throws -> Int {
            var leading = 0
            while try readBit() == 0 {
                leading += 1
                guard leading < 30 else { throw H264CaptureError.invalidBitstream("Exp-Golomb overflow") }
            }
            var suffix = 0
            for _ in 0..<leading { suffix = (suffix << 1) | (try readBit()) }
            return ((1 << leading) - 1) + suffix
        }
        let firstMb = try ue()
        let sliceType = try ue()
        guard sliceType <= 9 else { throw H264CaptureError.invalidBitstream("invalid slice type \(sliceType)") }
        return (firstMb, sliceType)
    }

    /// Validates one complete Annex B **image** access unit exactly as the SA-50
    /// readers classify it. Returns `true` for IDR.
    @discardableResult
    static func validateAccessUnit(_ annexB: Data) throws -> Bool {
        guard annexB.count <= maxAccessUnitBytes else { throw H264CaptureError.accessUnitTooLarge(annexB.count) }
        let nals = try splitAnnexB(annexB)
        return try validateAccessUnit(nals: nals)
    }

    @discardableResult
    static func validateAccessUnit(nals: [Data]) throws -> Bool {
        if nals.filter({ nalType($0) == H264NalType.accessUnitDelimiter }).count > 1 {
            throw H264CaptureError.multipleAccessUnits
        }
        var slices: [(type: UInt8, header: (firstMb: Int, sliceType: Int))] = []
        for nal in nals {
            let t = nalType(nal)
            if t == H264NalType.nonIdrSlice || t == H264NalType.idrSlice {
                slices.append((t, try sliceHeader(nal)))
            }
        }
        guard !slices.isEmpty else { throw H264CaptureError.configOnly }
        let firstSlices = slices.filter { $0.header.firstMb == 0 }.count
        if firstSlices > 1 { throw H264CaptureError.multipleAccessUnits }
        if firstSlices == 0 { throw H264CaptureError.incompleteAccessUnit }
        if slices.contains(where: { $0.header.sliceType % 5 == 1 }) { throw H264CaptureError.bFrame }
        if Set(slices.map { $0.type }).count != 1 {
            throw H264CaptureError.invalidBitstream("mixed IDR and non-IDR slices")
        }
        let idr = slices[0].type == H264NalType.idrSlice
        if idr {
            let beforeImage = nals.prefix { let t = nalType($0); return t != H264NalType.nonIdrSlice && t != H264NalType.idrSlice }
            let hasSps = beforeImage.contains { nalType($0) == H264NalType.sps }
            let hasPps = beforeImage.contains { nalType($0) == H264NalType.pps }
            guard hasSps && hasPps else { throw H264CaptureError.missingParameterSets }
        }
        return idr
    }
}
