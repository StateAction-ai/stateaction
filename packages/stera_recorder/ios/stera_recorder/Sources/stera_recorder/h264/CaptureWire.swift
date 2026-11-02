import Foundation

/// Ordered strict JSON value. Nanoseconds/IDs/counts are carried as canonical
/// decimal strings (`.string`), never JSON numbers, per the SA-50 contract.
indirect enum CaptureJSON: Equatable {
    case null
    case bool(Bool)
    case int(Int64)
    case double(Double)
    case string(String)
    case array([CaptureJSON])
    case object([(String, CaptureJSON)])

    static func == (lhs: CaptureJSON, rhs: CaptureJSON) -> Bool {
        lhs.encoded() == rhs.encoded()
    }

    static func decimal(_ v: Int64) -> CaptureJSON { .string(String(v)) }

    func encoded() -> String {
        var out = ""
        write(into: &out)
        return out
    }

    func data() -> Data { Data(encoded().utf8) }

    private func write(into out: inout String) {
        switch self {
        case .null: out += "null"
        case .bool(let b): out += b ? "true" : "false"
        case .int(let i): out += String(i)
        case .double(let d):
            precondition(d.isFinite, "non-finite JSON number")
            if d == d.rounded(), abs(d) < 1e15 { out += String(Int64(d)) } else { out += "\(d)" }
        case .string(let s): CaptureJSON.writeString(s, into: &out)
        case .array(let items):
            out += "["
            for (i, item) in items.enumerated() {
                if i > 0 { out += "," }
                item.write(into: &out)
            }
            out += "]"
        case .object(let pairs):
            out += "{"
            var seen = Set<String>()
            for (i, (k, v)) in pairs.enumerated() {
                precondition(seen.insert(k).inserted, "duplicate JSON key \(k)")
                if i > 0 { out += "," }
                CaptureJSON.writeString(k, into: &out)
                out += ":"
                v.write(into: &out)
            }
            out += "}"
        }
    }

    private static func writeString(_ s: String, into out: inout String) {
        out += "\""
        for scalar in s.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 {
                    let hex = String(scalar.value, radix: 16)
                    out += "\\u" + String(repeating: "0", count: 4 - hex.count) + hex
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        out += "\""
    }
}

/// Minimal Protobuf wire encoder for the pinned `foxglove.CompressedVideo`
/// descriptor (fields: 1 timestamp, 2 frame_id, 3 data, 4 format).
enum CompressedVideoWire {
    static let frameId = "camera_optical_frame"
    static let format = "h264"

    static func encode(captureTimeNs: Int64, annexB: Data, frameId: String = frameId) -> Data {
        precondition(captureTimeNs > 0)
        var stamp = Data()
        stamp.append(0x08); varint(&stamp, UInt64(captureTimeNs / 1_000_000_000))
        let nanos = UInt64(captureTimeNs % 1_000_000_000)
        if nanos != 0 { stamp.append(0x10); varint(&stamp, nanos) }
        var out = Data()
        out.reserveCapacity(annexB.count + 64)
        field(&out, 1, stamp)
        field(&out, 2, Data(frameId.utf8))
        field(&out, 3, annexB)
        field(&out, 4, Data(format.utf8))
        return out
    }

    private static func varint(_ out: inout Data, _ value: UInt64) {
        var v = value
        while v >= 0x80 { out.append(UInt8(v & 0x7F) | 0x80); v >>= 7 }
        out.append(UInt8(v))
    }

    private static func field(_ out: inout Data, _ number: UInt64, _ bytes: Data) {
        varint(&out, (number << 3) | 2)
        varint(&out, UInt64(bytes.count))
        out.append(bytes)
    }
}

/// Bounded byte sink for the capture file.
protocol CaptureByteSink: AnyObject {
    func write(_ data: Data) throws
    /// Durably persists everything written so far.
    func synchronize() throws
    func close() throws
}

final class MemoryCaptureSink: CaptureByteSink {
    private(set) var bytes = Data()
    private(set) var closed = false
    func write(_ data: Data) throws { bytes.append(data) }
    func synchronize() throws {}
    func close() throws { closed = true }
}

/// File sink with a bounded in-memory buffer; flushes to the OS whenever the
/// buffer exceeds `flushThresholdBytes` so retained memory stays bounded.
final class FileCaptureSink: CaptureByteSink {
    private let handle: FileHandle
    private var buffer = Data()
    private let flushThresholdBytes: Int

    init(url: URL, flushThresholdBytes: Int = 1 << 20) throws {
        guard FileManager.default.createFile(atPath: url.path, contents: nil) else {
            throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: url.path])
        }
        handle = try FileHandle(forWritingTo: url)
        self.flushThresholdBytes = flushThresholdBytes
    }

    func write(_ data: Data) throws {
        buffer.append(data)
        if buffer.count >= flushThresholdBytes { try flush() }
    }

    private func flush() throws {
        guard !buffer.isEmpty else { return }
        try handle.write(contentsOf: buffer)
        buffer.removeAll(keepingCapacity: true)
    }

    func synchronize() throws {
        try flush()
        try handle.synchronize()
    }

    func close() throws {
        try synchronize()
        try handle.close()
    }
}

/// Writes the portable SA-50 MCAP layout: magic, Header (empty profile),
/// Schema/Channel/Message records only, DataEnd with a nonzero CRC-32 of every
/// preceding byte, Footer with no summary, closing magic. Unchunked and
/// uncompressed, so every portable reader can verify it.
final class CaptureMcapWriter {
    static let magic: [UInt8] = [0x89, 0x4D, 0x43, 0x41, 0x50, 0x30, 0x0D, 0x0A]
    private static let opHeader: UInt8 = 0x01
    private static let opFooter: UInt8 = 0x02
    private static let opSchema: UInt8 = 0x03
    private static let opChannel: UInt8 = 0x04
    private static let opMessage: UInt8 = 0x05
    private static let opDataEnd: UInt8 = 0x0F

    enum WriterError: Error, Equatable {
        case finished
        case implausibleLogTime(UInt64)
        case unknownChannel(UInt16)
    }

    private let sink: CaptureByteSink
    private var crc = CRC32()
    private var nextSchemaId: UInt16 = 1
    private var nextChannelId: UInt16 = 0
    private var channelSequences: [UInt16: UInt32] = [:]
    private(set) var isFinished = false
    private(set) var bytesWritten: Int64 = 0
    let logTimePolicy: CaptureLogTimePolicy
    private let currentUptimeNs: () -> UInt64

    init(sink: CaptureByteSink, library: String, logTimePolicy: CaptureLogTimePolicy, currentUptimeNs: @escaping () -> UInt64) throws {
        self.sink = sink
        self.logTimePolicy = logTimePolicy
        self.currentUptimeNs = currentUptimeNs
        try emit(Data(Self.magic))
        var header = Data()
        Self.string(&header, "")  // profile must be empty: the file mixes protobuf/cdr/json
        Self.string(&header, library)
        try record(Self.opHeader, header)
    }

    func addSchema(name: String, encoding: String, data: Data) throws -> UInt16 {
        guard !isFinished else { throw WriterError.finished }
        let id = nextSchemaId
        nextSchemaId += 1
        var body = Data()
        Self.u16(&body, id)
        Self.string(&body, name)
        Self.string(&body, encoding)
        Self.u32(&body, UInt32(data.count))
        body.append(data)
        try record(Self.opSchema, body)
        return id
    }

    func addChannel(schemaId: UInt16, topic: String, messageEncoding: String) throws -> UInt16 {
        guard !isFinished else { throw WriterError.finished }
        let id = nextChannelId
        nextChannelId += 1
        var body = Data()
        Self.u16(&body, id)
        Self.u16(&body, schemaId)
        Self.string(&body, topic)
        Self.string(&body, messageEncoding)
        Self.u32(&body, 0)  // empty metadata map
        try record(Self.opChannel, body)
        channelSequences[id] = 0
        return id
    }

    /// Writes one message with the channel's next sequence (0-based, per channel)
    /// and returns that sequence.
    @discardableResult
    func addMessage(channelId: UInt16, logTime: UInt64, publishTime: UInt64, data: Data) throws -> UInt32 {
        guard !isFinished else { throw WriterError.finished }
        guard let seq = channelSequences[channelId] else { throw WriterError.unknownChannel(channelId) }
        guard logTimePolicy.isPlausible(logTimeNs: logTime, currentUptimeNs: currentUptimeNs()) else {
            throw WriterError.implausibleLogTime(logTime)
        }
        var head = Data()
        head.reserveCapacity(31)
        head.append(Self.opMessage)
        Self.u64(&head, UInt64(22 + data.count))
        Self.u16(&head, channelId)
        Self.u32(&head, seq)
        Self.u64(&head, logTime)
        Self.u64(&head, publishTime)
        try emit(head)
        try emit(data)
        channelSequences[channelId] = seq &+ 1
        return seq
    }

    func peekNextSequence(channelId: UInt16) -> UInt32? { channelSequences[channelId] }

    func synchronize() throws { try sink.synchronize() }

    /// DataEnd(CRC) + Footer(no summary) + magic, then durably closes the sink.
    func finish() throws {
        guard !isFinished else { return }
        isFinished = true
        var dataEnd = Data()
        // Readers treat a zero CRC as unavailable (E_DATA_CRC); the CRC of the
        // non-empty magic+header prefix is the honest value whatever it is.
        Self.u32(&dataEnd, crc.value)
        try record(Self.opDataEnd, dataEnd)
        var footer = Data()
        Self.u64(&footer, 0)
        Self.u64(&footer, 0)
        Self.u32(&footer, 0)
        try record(Self.opFooter, footer)
        try emit(Data(Self.magic))
        try sink.close()
    }

    private func record(_ op: UInt8, _ body: Data) throws {
        var head = Data([op])
        Self.u64(&head, UInt64(body.count))
        try emit(head)
        try emit(body)
    }

    private func emit(_ data: Data) throws {
        crc.update(data)
        try sink.write(data)
        bytesWritten += Int64(data.count)
    }

    private static func u16(_ d: inout Data, _ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
    private static func u32(_ d: inout Data, _ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
    private static func u64(_ d: inout Data, _ v: UInt64) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
    private static func string(_ d: inout Data, _ s: String) {
        let bytes = Data(s.utf8)
        u32(&d, UInt32(bytes.count))
        d.append(bytes)
    }
}

/// CRC-32 (IEEE 802.3, as `zlib.crc32`). Portable: no zlib import required.
struct CRC32 {
    private static let table: [UInt32] = (0..<256).map { n -> UInt32 in
        var c = UInt32(n)
        for _ in 0..<8 { c = (c & 1) != 0 ? 0xEDB8_8320 ^ (c >> 1) : c >> 1 }
        return c
    }
    private var state: UInt32 = 0xFFFF_FFFF

    mutating func update(_ data: Data) {
        var c = state
        data.withUnsafeBytes { raw in
            for b in raw { c = Self.table[Int((c ^ UInt32(b)) & 0xFF)] ^ (c >> 8) }
        }
        state = c
    }

    var value: UInt32 { state ^ 0xFFFF_FFFF }
}
