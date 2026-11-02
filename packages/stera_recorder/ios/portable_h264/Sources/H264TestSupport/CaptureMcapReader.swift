import Foundation
@testable import StateActionH264

/// Minimal reader for the unchunked layout `CaptureMcapWriter` produces, used by
/// tests to inspect messages. Conformance is judged by the SA-50 reference
/// checker (see `tool/check_ios_h264_capture.py`), not by this reader.
struct CaptureMcapMessage {
    let topic: String
    let sequence: UInt32
    let logTime: UInt64
    let data: Data

    var json: [String: Any] { (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:] }
}

enum CaptureMcapReader {
    struct Malformed: Error {}

    static func read(_ data: Data) throws -> [CaptureMcapMessage] {
        let b = [UInt8](data)
        guard b.count >= 16, Array(b.prefix(8)) == CaptureMcapWriter.magic, Array(b.suffix(8)) == CaptureMcapWriter.magic else { throw Malformed() }
        func u16(_ o: Int) -> Int { Int(b[o]) | Int(b[o + 1]) << 8 }
        func u32(_ o: Int) -> Int { (0..<4).reduce(0) { $0 | Int(b[o + $1]) << (8 * $1) } }
        func u64(_ o: Int) -> UInt64 { (0..<8).reduce(UInt64(0)) { $0 | UInt64(b[o + $1]) << (8 * UInt64($1)) } }
        func str(_ o: inout Int) -> String {
            let n = u32(o); o += 4
            defer { o += n }
            return String(decoding: b[o..<(o + n)], as: UTF8.self)
        }
        var topics: [Int: String] = [:]
        var out: [CaptureMcapMessage] = []
        var off = 8
        while off < b.count - 8 {
            let op = b[off]
            let len = Int(u64(off + 1))
            let body = off + 9
            guard body + len <= b.count else { throw Malformed() }
            if op == 0x04 {
                var o = body + 4
                let id = u16(body)
                topics[id] = str(&o)
            } else if op == 0x05 {
                let ch = u16(body)
                out.append(CaptureMcapMessage(topic: topics[ch] ?? "?", sequence: UInt32(u32(body + 2)), logTime: u64(body + 6),
                                              data: Data(b[(body + 22)..<(body + len)])))
            }
            off = body + len
        }
        return out
    }

    /// Decodes the Annex B `data` field (3) of a `foxglove.CompressedVideo` payload.
    static func videoData(_ wire: Data) -> Data? {
        let b = [UInt8](wire)
        var i = 0
        func varint() -> UInt64? {
            var v: UInt64 = 0, s: UInt64 = 0
            while i < b.count { let x = b[i]; i += 1; v |= UInt64(x & 0x7F) << s; if x < 0x80 { return v }; s += 7 }
            return nil
        }
        while i < b.count {
            guard let key = varint() else { return nil }
            if key & 7 == 2 {
                guard let n = varint() else { return nil }
                let start = i; i += Int(n)
                if key >> 3 == 3 { return Data(b[start..<i]) }
            } else if key & 7 == 0 { _ = varint() } else { return nil }
        }
        return nil
    }
}
