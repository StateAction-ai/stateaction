// stateaction.capture.v1.1 golden MCAP conformance checker (Swift, Foundation only).
// Port of conformance/python/capture_conformance.py. Run: swift run CaptureConformance <capture-dir>
import Foundation

let videoTopic = "/camera/rgb/video"
let frameIdName = "camera_optical_frame"
let custom: [String: String] = [
    "stateaction.capture.Profile.v1": "Profile.schema.json",
    "stateaction.capture.Clocks.v1": "Clocks.schema.json",
    "stateaction.capture.Inventory.v1": "Inventory.schema.json",
    "stateaction.capture.FrameEvent.v1": "FrameEvent.schema.json",
    "stateaction.capture.MotionEvent.v1": "MotionEvent.schema.json",
    "stateaction.capture.SensorEvent.v1": "SensorEvent.schema.json",
    "stateaction.capture.Close.v1": "Close.schema.json",
]
let magic: [UInt8] = [0x89, 0x4d, 0x43, 0x41, 0x50, 0x30, 0x0d, 0x0a]

struct Truncated: Error {}
struct Malformed: Error {}
struct Unsupported: Error {}
struct CrcMismatch: Error {}
struct DefinitionOrder: Error {}
struct DefinitionConflict: Error {}

/// JSON object key compared by its exact Unicode scalar sequence. Swift String equality (and so a
/// [String: J] dictionary) uses canonical equivalence, which would merge distinct JSON names such as
/// U+00E9 and e+U+0301; JSON and every other reader treat them as different keys.
struct JKey: Hashable, ExpressibleByStringLiteral, CustomStringConvertible {
    let s: String
    let scalars: [UInt32]
    init(_ s: String) { self.s = s; scalars = s.unicodeScalars.map { $0.value } }
    init(stringLiteral v: String) { self.init(v) }
    static func == (a: JKey, b: JKey) -> Bool { a.scalars == b.scalars }
    func hash(into h: inout Hasher) { h.combine(scalars) }
    var description: String { s }
}

func jobj(_ d: [String: J]) -> J { .obj(Dictionary(uniqueKeysWithValues: d.map { (JKey($0.key), $0.value) })) }

// MARK: JSON value (keeps bool/int/string distinct)
indirect enum J: Decodable, Equatable {
    case null, bool(Bool), int(Int64), dbl(Double), str(String), arr([J]), obj([JKey: J])
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Int64.self) { self = .int(v) }
        else if let v = try? c.decode(Double.self) { self = .dbl(v) }
        else if let v = try? c.decode(String.self) { self = .str(v) }
        else if let v = try? c.decode([J].self) { self = .arr(v) }
        else { self = jobj(try c.decode([String: J].self)) }
    }
    subscript(_ k: String) -> J? { if case .obj(let o) = self { return o[JKey(k)] }; return nil }
    var s: String? { if case .str(let v) = self { return v }; return nil }
    var i: Int64? { if case .int(let v) = self { return v }; return nil }
    var b: Bool { if case .bool(let v) = self { return v }; return false }
    var has: Bool { self != .null }
}

func quote(_ s: String) -> String {
    var o = "\""
    for u in s.unicodeScalars {
        switch u {
        case "\"": o += "\\\""
        case "\\": o += "\\\\"
        case "\n": o += "\\n"
        case "\r": o += "\\r"
        case "\t": o += "\\t"
        default: if u.value < 0x20 { o += String(format: "\\u%04x", u.value) } else { o.unicodeScalars.append(u) }
        }
    }
    return o + "\""
}

func canonical(_ v: J) -> String {
    switch v {
    case .null: return "null"
    case .bool(let b): return b ? "true" : "false"
    case .int(let i): return String(i)
    case .dbl(let d): return String(d)
    case .str(let s): return quote(s)
    case .arr(let a): return "[" + a.map(canonical).joined(separator: ",") + "]"
    case .obj(let o): return "{" + o.keys.sorted { Array($0.s.utf8).lexicographicallyPrecedes(Array($1.s.utf8)) }.map { quote($0.s) + ":" + canonical(o[$0]!) }.joined(separator: ",") + "}"
    }
}

// MARK: SHA-256
func sha256Hex(_ data: [UInt8]) -> String {
    let k: [UInt32] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be,
        0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa,
        0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85,
        0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
        0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
        0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ]
    var h: [UInt32] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
    func rotr(_ x: UInt32, _ n: UInt32) -> UInt32 { (x >> n) | (x << (32 - n)) }
    var p = data + [0x80]
    while p.count % 64 != 56 { p.append(0) }
    let bits = UInt64(data.count) * 8
    for i in (0..<8).reversed() { p.append(UInt8((bits >> UInt64(8 * i)) & 0xff)) }
    var w = [UInt32](repeating: 0, count: 64)
    for off in stride(from: 0, to: p.count, by: 64) {
        for i in 0..<16 { w[i] = UInt32(p[off + 4 * i]) << 24 | UInt32(p[off + 4 * i + 1]) << 16 | UInt32(p[off + 4 * i + 2]) << 8 | UInt32(p[off + 4 * i + 3]) }
        for i in 16..<64 {
            let s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3)
            let s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10)
            w[i] = w[i - 16] &+ s0 &+ w[i - 7] &+ s1
        }
        var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7]
        for i in 0..<64 {
            let t1 = hh &+ (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) &+ ((e & f) ^ (~e & g)) &+ k[i] &+ w[i]
            let t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) &+ ((a & b) ^ (a & c) ^ (b & c))
            hh = g; g = f; f = e; e = d &+ t1; d = c; c = b; b = a; a = t1 &+ t2
        }
        h[0] = h[0] &+ a; h[1] = h[1] &+ b; h[2] = h[2] &+ c; h[3] = h[3] &+ d
        h[4] = h[4] &+ e; h[5] = h[5] &+ f; h[6] = h[6] &+ g; h[7] = h[7] &+ hh
    }
    return h.map { String(format: "%08x", $0) }.joined()
}

// MARK: MCAP
struct Message { var channel: Int; var sequence: UInt32; var logTime: UInt64; var data: [UInt8] }
struct Schema { var name: String; var encoding: String; var data: [UInt8] }
struct Mcap {
    var profile: String? = nil
    var schemas: [Int: Schema] = [:]
    var channels: [Int: (schemaId: Int, topic: String, encoding: String)] = [:]
    var messages: [Message] = []
}

func le<T: FixedWidthInteger>(_ b: [UInt8], _ off: Int, _ t: T.Type) throws -> T {
    let n = MemoryLayout<T>.size
    guard off + n <= b.count else { throw Truncated() }
    var v: T = 0
    for i in 0..<n { v |= T(truncatingIfNeeded: b[off + i]) << T(8 * i) }
    return v
}

func readStr(_ b: [UInt8], _ off: Int) throws -> (String, Int) {
    let n = Int(try le(b, off, UInt32.self))
    guard off + 4 + n <= b.count else { throw Truncated() }
    // Strict UTF-8, as every reader: invalid bytes are a truncated/undecodable record, never U+FFFD.
    guard let text = String(validating: b[(off + 4)..<(off + 4 + n)], as: UTF8.self) else { throw Truncated() }
    return (text, off + 4 + n)
}

// Supported layout (see capture_conformance.py): Header first; only Schema/Channel/Message records; one
// DataEnd with a nonzero CRC-32 of every preceding byte; a Footer without summary; the closing magic.
// Definitions are checked in file order: a Channel's nonzero schema id and a Message's channel id must already
// be defined (E_DEFINITION_ORDER); a repeated Schema/Channel id must repeat the identical record body and Schema
// id 0 is reserved (E_DEFINITION_CONFLICT).
func readMcap(_ d: [UInt8]) throws -> Mcap { try readMcapRecords(d) }

func readMcapRecords(_ d: [UInt8]) throws -> Mcap {
    guard d.count >= 8, Array(d[0..<8]) == magic else { throw Truncated() }
    var pos = 8
    var out = Mcap()
    var dataEnd = false
    var raw: [UInt8: [Int: [UInt8]]] = [0x03: [:], 0x04: [:]]  // id -> exact record body
    func define(_ op: UInt8, _ id: Int, _ body: [UInt8]) throws {
        if let prior = raw[op]![id], prior != body { throw DefinitionConflict() }
        raw[op]![id] = body
    }
    while true {
        if pos == d.count || pos + 9 > d.count { throw Truncated() }
        let recordStart = pos
        let op = d[pos]
        let rawLen = try le(d, pos + 1, UInt64.self)
        let start = pos + 9
        guard rawLen <= UInt64(d.count - start) else { throw Truncated() }
        let len = Int(rawLen)
        let body = Array(d[start..<(start + len)])
        pos = start + len
        if (op == 0x01) != (recordStart == 8) { throw Unsupported() }
        if dataEnd && op != 0x02 { throw Unsupported() }
        switch op {
        case 0x01: out.profile = try readStr(body, 0).0
        case 0x03:
            let (name, o1) = try readStr(body, 2)
            let (enc, o2) = try readStr(body, o1)
            let n = Int(try le(body, o2, UInt32.self))
            guard o2 + 4 + n <= body.count else { throw Truncated() }
            let sid = Int(try le(body, 0, UInt16.self))
            if sid == 0 { throw DefinitionConflict() }
            try define(0x03, sid, body)
            out.schemas[sid] = Schema(name: name, encoding: enc, data: Array(body[(o2 + 4)..<(o2 + 4 + n)]))
        case 0x04:
            let (topic, o1) = try readStr(body, 4)
            let encoding = try readStr(body, o1).0
            let cid = Int(try le(body, 0, UInt16.self)), schemaId = Int(try le(body, 2, UInt16.self))
            if schemaId != 0 && out.schemas[schemaId] == nil { throw DefinitionOrder() }
            try define(0x04, cid, body)
            out.channels[cid] = (schemaId, topic, encoding)
        case 0x05:
            let m = Message(channel: Int(try le(body, 0, UInt16.self)), sequence: try le(body, 2, UInt32.self), logTime: try le(body, 6, UInt64.self), data: [])
            _ = try le(body, 14, UInt64.self)  // publish_time: a short record is truncated in every reader
            if out.channels[m.channel] == nil { throw DefinitionOrder() }
            out.messages.append(Message(channel: m.channel, sequence: m.sequence, logTime: m.logTime, data: Array(body[22...])))
        case 0x0f:
            let crc = try le(body, 0, UInt32.self)
            dataEnd = true
            if crc == 0 || crc != crc32(d, recordStart) { throw CrcMismatch() }
        case 0x02:
            guard dataEnd else { throw Unsupported() }
            guard try le(body, 0, UInt64.self) == 0, try le(body, 8, UInt64.self) == 0, try le(body, 16, UInt32.self) == 0 else { throw Unsupported() }
            guard pos + 8 == d.count, Array(d[pos...]) == magic else { throw Truncated() }
            return out
        default: throw Unsupported()
        }
    }
}

// MARK: Protobuf CompressedVideo
func varint(_ b: [UInt8], _ pos: inout Int) throws -> UInt64 {
    var shift: UInt64 = 0, v: UInt64 = 0
    while true {
        guard pos < b.count, shift <= 63 else { throw Malformed() }
        let x = b[pos]; pos += 1
        v |= UInt64(x & 0x7f) << shift
        if x & 0x80 == 0 { return v }
        shift += 7
    }
}

/// Strict UTF-8 for message strings (invalid bytes are E_MALFORMED_MESSAGE, never U+FFFD).
func strictUtf8<C: Collection>(_ b: C) throws -> String where C.Element == UInt8 {
    guard let s = String(validating: b, as: UTF8.self) else { throw Malformed() }
    return s
}

struct Video { var sec: UInt64 = 0, nanos: UInt64 = 0; var frameId = "", format = ""; var data: [UInt8] = [] }

func decodeVideo(_ b: [UInt8]) throws -> Video {
    var v = Video(); var pos = 0
    while pos < b.count {
        let key = try varint(b, &pos)
        let field = key >> 3, wire = key & 7
        if wire == 2 {
            let n = Int(try varint(b, &pos))
            guard n >= 0, pos + n <= b.count else { throw Malformed() }
            let chunk = Array(b[pos..<(pos + n)]); pos += n
            if field == 1 {
                var p = 0
                while p < chunk.count {
                    let k = try varint(chunk, &p); let val = try varint(chunk, &p)
                    if k >> 3 == 1 { v.sec = val } else { v.nanos = val }
                }
            } else if field == 2 { v.frameId = try strictUtf8(chunk) }
            else if field == 3 { v.data = chunk }
            else if field == 4 { v.format = try strictUtf8(chunk) }
        } else if wire == 0 { _ = try varint(b, &pos) }
        else { throw Malformed() }
    }
    return v
}

// MARK: Annex B
func nals(_ d: [UInt8]) -> [[UInt8]]? {
    var starts: [(Int, Int)] = []
    var i = 0
    while i + 2 < d.count {
        if d[i] == 0 && d[i + 1] == 0 && d[i + 2] == 1 { starts.append((i, 3)); i += 3 }
        else if d[i] == 0 && d[i + 1] == 0 && i + 3 < d.count && d[i + 2] == 0 && d[i + 3] == 1 { starts.append((i, 4)); i += 4 }
        else { i += 1 }
    }
    guard let first = starts.first, first.0 == 0 else { return nil }
    return starts.enumerated().map { n, s in Array(d[(s.0 + s.1)..<(n + 1 < starts.count ? starts[n + 1].0 : d.count)]) }
}

func sliceHeader(_ nal: [UInt8]) -> (Int, Int)? {
    let raw = Array(nal[1..<min(nal.count, 12)])
    var un: [UInt8] = []; var zeros = 0
    for x in raw {
        if zeros >= 2 && x == 3 { zeros = 0; continue }
        un.append(x); zeros = x == 0 ? zeros + 1 : 0
    }
    let bits = un.flatMap { x in (0..<8).map { (x >> UInt8(7 - $0)) & 1 } }
    var vals: [Int] = []; var p = 0
    for _ in 0..<2 {
        var z = 0
        while p + z < bits.count && bits[p + z] == 0 { z += 1 }
        if p + 2 * z + 1 > bits.count { return nil }
        var v = 0
        for bit in bits[(p + z)..<(p + 2 * z + 1)] { v = v << 1 | Int(bit) }
        vals.append(v - 1); p += 2 * z + 1
    }
    return (vals[0], vals[1])
}

func classifyAu(_ d: [UInt8]) -> ([String], Bool) {
    guard let units = nals(d) else { return (["E_NOT_ANNEXB"], false) }
    let types = units.map { Int($0[0] & 31) }
    let slices = units.filter { [1, 5].contains(Int($0[0] & 31)) }
    if slices.isEmpty { return (["E_CONFIG_ONLY"], false) }
    var errors: [String] = []
    let headers = slices.map(sliceHeader)
    let firsts = headers.filter { $0 != nil && $0!.0 == 0 }.count
    if headers.contains(where: { $0 == nil }) || firsts == 0 { errors.append("E_PARTIAL_ACCESS_UNIT") }
    else if firsts > 1 { errors.append("E_MULTIPLE_ACCESS_UNITS") }
    else if headers.contains(where: { $0!.1 % 5 == 1 }) { errors.append("E_B_FRAME") }
    let idr = types.contains(5)
    if idr {
        let firstImage = types.firstIndex { $0 == 1 || $0 == 5 }!
        let before = types[0..<firstImage]
        if !before.contains(7) || !before.contains(8) { errors.append("E_MISSING_PARAMETER_SETS") }
    }
    return (errors, idr)
}

func decodePose(_ d: [UInt8]) throws -> [JKey: J] {
    guard d.count >= 16, try le(d, 0, UInt32.self) == 0x0000_0100 else { throw Malformed() }
    let n = Int(try le(d, 12, UInt32.self))
    guard 16 + max(n - 1, 0) <= d.count else { throw Malformed() }
    return ["sec": .int(Int64(try le(d, 4, Int32.self))), "nanosec": .int(Int64(try le(d, 8, UInt32.self))),
            "frame_id": .str(try strictUtf8(d[16..<(16 + max(n - 1, 0))]))]
}

// MARK: Checker
let poseSchema = "geometry_msgs/msg/PoseStamped"
let poseSchemaFile = "geometry_msgs-PoseStamped.ros2msg"
// topic -> (schema name, schema encoding, message encoding): the reviewed channel table.
let channelTable: [String: (String, String, String)] = [
    "/stateaction/capture_profile": ("stateaction.capture.Profile.v1", "jsonschema", "json"),
    "/stateaction/clocks": ("stateaction.capture.Clocks.v1", "jsonschema", "json"),
    "/stateaction/inventory": ("stateaction.capture.Inventory.v1", "jsonschema", "json"),
    "/stateaction/frame_events": ("stateaction.capture.FrameEvent.v1", "jsonschema", "json"),
    "/stateaction/imu/accel": ("stateaction.capture.MotionEvent.v1", "jsonschema", "json"),
    "/stateaction/imu/gyro": ("stateaction.capture.MotionEvent.v1", "jsonschema", "json"),
    "/stateaction/sensor_events": ("stateaction.capture.SensorEvent.v1", "jsonschema", "json"),
    "/stateaction/close": ("stateaction.capture.Close.v1", "jsonschema", "json"),
    videoTopic: ("foxglove.CompressedVideo", "protobuf", "protobuf"),
    "/tracking/pose": (poseSchema, "ros2msg", "cdr"),
]
// Exact (scalar-sequence) string identity: Swift String == is canonical equivalence, the other readers compare
// code points.
func exact(_ a: String, _ b: String) -> Bool { a.unicodeScalars.elementsEqual(b.unicodeScalars) }
let exactTable = Dictionary(uniqueKeysWithValues: channelTable.map { (JKey($0.key), $0.value) })
func tableEntry(_ topic: String) -> (String, String, String)? { exactTable[JKey(topic)] }
let identityKeys = ["recording_id", "stream_id", "native_timestamp_ns", "native_clock_id", "mapped_capture_time_ns",
                    "clock_mapping_revision", "calibration_id", "encoder_pts_us", "encoder_time_base", "native_timestamps"]

func isDecimal(_ v: J?) -> Bool {
    guard let s = v?.s, !s.isEmpty, s.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }) else { return false }
    return s == "0" || s.first != "0"
}
func isObj(_ v: J?) -> Bool { if case .obj? = v { return true }; return false }
// Identity comparison uses deep JSON equality (1 == 1.0), exactly like the Python reference.
func same(_ a: J?, _ b: J?) -> Bool { jsonEqual(a, b) }

var captureDir = "../.."
var schemaCache: [String: StrictSchema] = [:]
// The reviewed contract schema (never the file's embedded copy, which is only hash-compared).
func contractSchema(_ name: String) throws -> StrictSchema {
    if let s = schemaCache[name] { return s }
    let s = try StrictSchema(parseStrictJson([UInt8](Data(contentsOf: URL(fileURLWithPath: "\(captureDir)/\(custom[name]!)")))))
    schemaCache[name] = s
    return s
}
let singletonTopics = ["/stateaction/capture_profile", "/stateaction/clocks", "/stateaction/inventory", "/stateaction/close"]

func rejectWith(_ errors: Set<String>) -> J {
    .obj(["outcome": .str("reject"), "errors": .arr(errors.sorted().map { .str($0) }), "facts": .obj([:])])
}

func check(_ data: [UInt8], _ manifest: [String: String]) throws -> J {
    var errors = Set<String>()
    let f: Mcap
    do { f = try readMcap(data) } catch is Truncated {
        return .obj(["outcome": .str("reject"), "errors": .arr([.str("E_TRUNCATED")]), "facts": .obj([:])])
    } catch is Unsupported {
        return .obj(["outcome": .str("reject"), "errors": .arr([.str("E_UNSUPPORTED_LAYOUT")]), "facts": .obj([:])])
    } catch is CrcMismatch {
        return .obj(["outcome": .str("reject"), "errors": .arr([.str("E_DATA_CRC")]), "facts": .obj([:])])
    } catch is DefinitionOrder {
        return .obj(["outcome": .str("reject"), "errors": .arr([.str("E_DEFINITION_ORDER")]), "facts": .obj([:])])
    } catch is DefinitionConflict {
        return .obj(["outcome": .str("reject"), "errors": .arr([.str("E_DEFINITION_CONFLICT")]), "facts": .obj([:])])
    }
    if f.profile != "" { errors.insert("E_PROFILE_NOT_EMPTY") }
    var byTopic: [JKey: [Message]] = [:]
    for m in f.messages { byTopic[JKey(f.channels[m.channel]!.topic), default: []].append(m) }
    let names = Set(f.schemas.values.map { JKey($0.name) })
    var facts: [JKey: J] = ["channel_counts": .obj(byTopic.mapValues { .int(Int64($0.count)) })]
    if names.contains("sensor_msgs/msg/CompressedImage") && !names.contains("foxglove.CompressedVideo") {
        let img = byTopic["/camera/rgb/image/compressed"] ?? []
        facts["legacy_images"] = .int(Int64(img.count))
        facts["legacy_log_times_ns"] = .arr(img.map { .str(String($0.logTime)) })
        return .obj(["outcome": .str("legacy_jpeg"), "errors": .arr([.str("E_LEGACY_JPEG")]), "facts": .obj(facts)])
    }
    // Exact per-channel encodings and reviewed schema identity.
    for ch in f.channels.values {
        if let schema = f.schemas[ch.schemaId], let want = tableEntry(ch.topic),
           exact(schema.name, want.0), exact(schema.encoding, want.1), exact(ch.encoding, want.2) {
            if schema.name == poseSchema && sha256Hex(schema.data) != manifest[poseSchemaFile] { errors.insert("E_CHANNEL_ENCODING") }
        } else { errors.insert("E_CHANNEL_ENCODING") }
    }
    var hashes: [JKey: J] = [:]
    for s in f.schemas.values {
        let digest = sha256Hex(s.data)
        hashes[JKey(s.name)] = .str(digest)
        if s.name == "foxglove.CompressedVideo" {
            if digest != manifest["foxglove-compressed-video.desc"] { errors.insert("E_DESCRIPTOR_HASH") }
        } else if let file = custom[s.name] {
            if digest != manifest[file] { errors.insert("E_SCHEMA_MISMATCH") }
        }
    }
    facts["schema_sha256"] = .obj(hashes)
    // Decode every message once; an undecodable message is a defined reject.
    var jsonDecoded: [String: [J]] = [:]
    var videoDecoded: [Video] = []
    var poseDecoded: [[JKey: J]] = []
    do {
        for (key, msgs) in byTopic {
            let topic = key.s
            guard let want = tableEntry(topic) else { continue }
            if want.2 == "json" {
                jsonDecoded[topic] = try msgs.map { m -> J in
                    do { return try parseStrictJson(m.data) } catch { throw Malformed() }
                }
            } else if want.2 == "protobuf" { videoDecoded = try msgs.map { try decodeVideo($0.data) } }
            else { poseDecoded = try msgs.map { try decodePose($0.data) } }
        }
    } catch is Malformed {
        errors.insert("E_MALFORMED_MESSAGE")
        return rejectWith(errors)
    }
    // Strict schema gate: violations are reported exactly and stop evaluation.
    var violations: [String] = []
    for topic in jsonDecoded.keys.sorted() {
        let validator = try contractSchema(channelTable[topic]!.0)
        for (i, value) in jsonDecoded[topic]!.enumerated() {
            for v in validator.validate(value) { violations.append("\(topic)[\(i)]\(v)") }
        }
    }
    if !violations.isEmpty {
        errors.insert("E_SCHEMA_MALFORMED")
        let sortedViolations = violations.sorted { Array($0.utf8).lexicographicallyPrecedes(Array($1.utf8)) }
        return .obj(["outcome": .str("reject"), "errors": .arr(errors.sorted().map { .str($0) }),
                     "facts": .obj(["schema_violations": .arr(sortedViolations.map { .str($0) })])])
    }
    if singletonTopics.contains(where: { (jsonDecoded[$0] ?? []).count != 1 }) { errors.insert("E_CHANNEL_CARDINALITY") }
    if Set(jsonDecoded.values.flatMap { $0 }.map { $0["recording_id"]?.s ?? "" }).count > 1 { errors.insert("E_RECORDING_ID") }
    func js(_ t: String) -> [J] { jsonDecoded[t] ?? [] }
    let clocks = js("/stateaction/clocks").first?["stream_clocks"] ?? .obj([:])
    var knownCalibrations = Set<String>()
    if case .arr(let cs)? = js("/stateaction/inventory").first?["calibrations"] {
        for c in cs { if let id = c["calibration_id"]?.s { knownCalibrations.insert(id) } }
    }
    let frames = js("/stateaction/frame_events")
    var ptsSeen = Set<String>(), acquired: [String: J] = [:], written: [String: J] = [:], state: [String: String] = [:]
    var submitted = Set<String>(), dropReasons: [String: Int] = [:]
    var counts: [String: Int64] = ["acquired": 0, "submitted": 0, "written": 0, "dropped": 0]
    for e in frames {
        let sid = e["source_frame_id"]!.s!, st = e["state"]!.s!
        // Lifecycle: acquired once, then at most one submit and exactly one terminal outcome;
        // every later event repeats the acquired identity (clock, PTS, calibration, time base).
        if st == "acquired" {
            if acquired[sid] != nil { errors.insert("E_FRAME_IDENTITY") }
        } else if acquired[sid] == nil || ["written", "dropped"].contains(state[sid] ?? "") || (st == "submitted" && submitted.contains(sid)) {
            errors.insert("E_FRAME_IDENTITY")
        } else if identityKeys.contains(where: { !same(e[$0], acquired[sid]![$0]) }) {
            errors.insert("E_FRAME_IDENTITY")
        }
        if (st == "acquired" || st == "written") && clocks[e["stream_id"]!.s!]?.s != e["native_clock_id"]?.s { errors.insert("E_CLOCK_MISMATCH") }
        if st == "acquired" {
            if isDecimal(e["encoder_pts_us"]), let p = e["encoder_pts_us"]?.s { if !ptsSeen.insert(p).inserted { errors.insert("E_DUPLICATE_PTS") } }
            if !knownCalibrations.contains(e["calibration_id"]!.s!) { errors.insert("E_CALIBRATION_UNKNOWN") }
            if acquired[sid] == nil { acquired[sid] = e }
        }
        if st == "submitted" { submitted.insert(sid) }
        if st == "written" && written[sid] == nil { written[sid] = e }
        if st == "dropped" { dropReasons[e["reason"]!.s!, default: 0] += 1 }
        counts[st]! += 1
        if acquired[sid] != nil { state[sid] = st }
    }
    facts["frame_event_counts"] = jobj(counts.mapValues { .int($0) })
    let video = byTopic[JKey(videoTopic)] ?? []
    let writtenSeqs = written.values.map { $0["output_sequence"]!.i! }
    let videoSeqs = video.map { Int64($0.sequence) }
    if Set(writtenSeqs).count != writtenSeqs.count || Set(videoSeqs).count != videoSeqs.count || Set(writtenSeqs) != Set(videoSeqs) {
        errors.insert("E_SEQUENCE")
    }
    var bySeq: [Int64: J] = [:]
    for e in written.values { bySeq[e["output_sequence"]!.i!] = e }
    var vf: [J] = []
    for (i, m) in video.enumerated() {
        let v = videoDecoded[i]
        let (auErrors, idr) = classifyAu(v.data)
        auErrors.forEach { errors.insert($0) }
        if i == 0 && !idr && auErrors.isEmpty { errors.insert("E_FIRST_NOT_IDR") }
        let ts = v.sec * 1_000_000_000 + v.nanos
        let ev = bySeq[Int64(m.sequence)]
        if v.frameId != frameIdName || v.format != "h264" { errors.insert("E_VIDEO_FIELDS") }
        if let ev = ev, String(ts) != ev["mapped_capture_time_ns"]?.s || ev["is_idr"]!.b != idr { errors.insert("E_VIDEO_TIMESTAMP_MISMATCH") }
        vf.append(.obj(["sequence": .int(Int64(m.sequence)), "capture_time_ns": .str(String(ts)), "log_time_ns": .str(String(m.logTime)),
                        "frame_id": .str(v.frameId), "format": .str(v.format), "bytes": .int(Int64(v.data.count)),
                        "idr": .bool(idr), "sha256": .str(sha256Hex(v.data)),
                        "source_frame_id": ev?["source_frame_id"] ?? .null, "encoder_pts_us": ev?["encoder_pts_us"] ?? .null]))
    }
    facts["video"] = .arr(vf)
    var motion: [JKey: J] = [:]
    for topic in ["/stateaction/imu/accel", "/stateaction/imu/gyro"] {
        let evs = js(topic)
        motion[JKey(topic)] = .arr(evs.map { .obj(["event_id": $0["event_id"]!, "native_timestamp_ns": $0["native_timestamp_ns"]!, "mapped_capture_time_ns": $0["mapped_capture_time_ns"] ?? .null]) })
        for e in evs where clocks[String(topic.split(separator: "/").last!)]?.s != e["native_clock_id"]?.s { errors.insert("E_CLOCK_MISMATCH") }
    }
    facts["motion"] = .obj(motion)
    let sensors = js("/stateaction/sensor_events")
    var resetAt: [String: String?] = [:]
    for e in sensors {
        if e["source_kind"]?.s == "arcore_pose" && e["tracking_state"]?.s != "tracking" && (e["pose_valid"]?.b ?? false) { errors.insert("E_TRACKING_LOSS_UNMARKED") }
        if e["source_kind"]?.s == "calibration_reset" { resetAt[e["supersedes_calibration_id"]!.s!] = e["association_source_frame_id"]?.s }
    }
    var cals = Set<String>()
    for e in acquired.values {
        cals.insert(e["calibration_id"]!.s!)
        if let at = resetAt[e["calibration_id"]!.s!], let atId = at, UInt64(e["source_frame_id"]!.s!)! >= UInt64(atId)! { errors.insert("E_CALIBRATION_RESET_UNMARKED") }
    }
    facts["sensor_events"] = .arr(sensors.map { .obj(["event_id": $0["event_id"]!, "source_kind": $0["source_kind"]!, "native_timestamp_ns": $0["native_timestamp_ns"]!, "tracking_state": $0["tracking_state"] ?? .null]) })
    facts["calibrations_used"] = .arr(cals.sorted().map { .str($0) })
    let poseMessages = byTopic["/tracking/pose"] ?? []
    facts["cdr_poses"] = .arr(poseDecoded.enumerated().map { i, p in
        var q = p; q["log_time_ns"] = .str(String(poseMessages[i].logTime)); return .obj(q) })
    if let close = js("/stateaction/close").last {
        let dropped = state.values.filter { $0 == "dropped" }.count
        let unresolved = acquired.count - written.count - dropped
        var expect = counts.mapValues { J.str(String($0)) }
        expect["unresolved"] = .str(String(unresolved))
        let expectMotion: J = .obj(["accel": .str(String(js("/stateaction/imu/accel").count)), "gyro": .str(String(js("/stateaction/imu/gyro").count))])
        let expectDrops: J = .arr(dropReasons.keys.sorted().map { .obj(["reason": .str($0), "count": .str(String(dropReasons[$0]!))]) })
        var closeDrops: [J] = []
        if case .arr(let d)? = close["drops"] {
            closeDrops = d.sorted { Array($0["reason"]!.s!.utf8).lexicographicallyPrecedes(Array($1["reason"]!.s!.utf8)) }
        }
        if !same(close["frames"], jobj(expect)) || close["video_messages"]?.s != String(video.count)
            || !same(close["motion_events"], expectMotion) || close["sensor_events"]?.s != String(sensors.count)
            || !same(.arr(closeDrops), expectDrops) { errors.insert("E_COUNT_MISMATCH") }
        let outcome = close["outcome"]?.s
        if outcome == "completed" && unresolved != 0 { errors.insert("E_OUTCOME_MISMATCH") }
        else if outcome == "failed" && (close["failure_reason"] ?? .null) == .null { errors.insert("E_OUTCOME_MISMATCH") }
        facts["close_outcome"] = close["outcome"] ?? .null
        facts["unresolved_frames"] = .int(Int64(unresolved))
    }
    let list = errors.sorted()
    return .obj(["outcome": .str(list.isEmpty ? "accept" : "reject"), "errors": .arr(list.map { .str($0) }), "facts": .obj(list.isEmpty ? facts : [:])])
}

// MARK: Encoder buffer sequences (MediaCodec flags: CODEC_CONFIG=2, END_OF_STREAM=4, PARTIAL_FRAME=8)
let startCode: [UInt8] = [0, 0, 0, 1]

func encoderBufferData(_ buf: J, _ sources: [String: [[UInt8]]]) -> [UInt8] {
    guard case .arr(let range)? = buf["nals"], let first = range[0].i, let last = range[1].i, let source = buf["source"]?.s else { return [] }
    var data: [UInt8] = []
    for n in sources[source]![Int(first)..<Int(last)] { data += startCode + n }
    if case .arr(let slice)? = buf["bytes"] { data = Array(data[Int(slice[0].i!)..<Int(slice[1].i!)]) }
    return data
}

func assembleEncoderBuffers(_ buffers: [J], _ sources: [String: [[UInt8]]]) -> J {
    var errors = Set<String>()
    var aus: [J] = []
    var config: [UInt8] = []
    var pending: (pts: String, data: [UInt8])? = nil
    var finished = false
    for buf in buffers {
        let flags = buf["flags"]!.i!
        let data = encoderBufferData(buf, sources)
        if flags & 2 != 0 {
            if pending != nil { errors.insert("E_INCOMPLETE_AU"); finished = true; break }
            config = data
            continue
        }
        if flags & 4 != 0 && data.isEmpty {
            if pending != nil { errors.insert("E_INCOMPLETE_AU") }
            finished = true
            break
        }
        guard isDecimal(buf["pts_us"]), let pts = buf["pts_us"]?.s else { errors.insert("E_PTS_INVALID"); finished = true; break }
        if let p = pending, p.pts != pts { errors.insert("E_PARTIAL_PTS_MISMATCH"); finished = true; break }
        var acc = (pending?.data ?? []) + data
        if flags & 8 != 0 { pending = (pts, acc); continue }
        pending = nil
        if let units = nals(acc), units.contains(where: { $0[0] & 31 == 5 }) {
            let types = units.map { Int($0[0] & 31) }
            let before = types[0..<types.firstIndex { $0 == 1 || $0 == 5 }!]
            if (!before.contains(7) || !before.contains(8)) && !config.isEmpty { acc = config + acc }
        }
        let (auErrors, idr) = classifyAu(acc)
        if !auErrors.isEmpty { auErrors.forEach { errors.insert($0) }; finished = true; break }
        aus.append(.obj(["pts_us": .str(pts), "idr": .bool(idr), "bytes": .int(Int64(acc.count)), "sha256": .str(sha256Hex(acc))]))
    }
    if !finished && pending != nil { errors.insert("E_INCOMPLETE_AU") }
    if !errors.isEmpty { return .obj(["outcome": .str("reject"), "errors": .arr(errors.sorted().map { .str($0) }), "aus": .arr([])]) }
    return .obj(["outcome": .str("accept"), "errors": .arr([]), "aus": .arr(aus)])
}

let cap = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "../..").standardizedFileURL.path
captureDir = cap
let manifestRaw = try JSONDecoder().decode(J.self, from: Data(contentsOf: URL(fileURLWithPath: "\(cap)/manifest.json")))
var manifest: [String: String] = [:]
if case .obj(let files)? = manifestRaw["files"] { for (k, v) in files { manifest[k.s] = v.s } }
let declared = try JSONDecoder().decode(J.self, from: Data(contentsOf: URL(fileURLWithPath: "\(cap)/golden/cases.json")))
let names = try FileManager.default.contentsOfDirectory(atPath: "\(cap)/golden").filter { $0.hasSuffix(".mcap") }.map { String($0.dropLast(5)) }.sorted()
var failed = 0
func fail(_ message: String) {
    failed += 1
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
}
if case .obj(let d) = declared, Set(d.keys.map { $0.s }) != Set(names) { fail("golden/*.mcap and cases.json disagree") }
for name in names {
    let data = try [UInt8](Data(contentsOf: URL(fileURLWithPath: "\(cap)/golden/\(name).mcap")))
    let result = try check(data, manifest)
    let actual = canonical(result) + "\n"
    let expected = try String(contentsOfFile: "\(cap)/golden/expected/\(name).json", encoding: .utf8)
    if actual != expected { fail("MISMATCH \(name)\n  actual:   \(actual.prefix(300))\n  expected: \(expected.prefix(300))") }
    // The independently declared outcome and error codes are the oracle for rejections.
    if let want = declared[name] {
        if result["outcome"]?.s != want["expect"]?.s || !same(result["errors"], want["expected_errors"]) {
            fail("DECLARED \(name): got \(canonical(result["errors"] ?? .null)); declared \(canonical(want["expected_errors"] ?? .null))")
        }
        // Declared schema violations (without message index) must match exactly.
        var stripped: [String] = []
        if case .arr(let vs)? = result["facts"]?["schema_violations"] {
            for v in vs {
                let text = v.s!
                if let r = text.range(of: "\\[[0-9]+\\]", options: .regularExpression) { stripped.append(text.replacingCharacters(in: r, with: "")) }
            }
        }
        stripped.sort { Array($0.utf8).lexicographicallyPrecedes(Array($1.utf8)) }
        let declaredViolations = want["expected_violations"] ?? .arr([])
        if !same(.arr(stripped.map { .str($0) }), declaredViolations) { fail("VIOLATIONS \(name): \(stripped)") }
    }
}
// Direct strict-schema interpreter cases and fail-closed schema loading.
let schemaCases = try parseStrictJson([UInt8](Data(contentsOf: URL(fileURLWithPath: "\(cap)/fixtures/schema_cases.json"))))
var schemaCaseCount = 0, unsupportedCount = 0
if case .arr(let cs)? = schemaCases["cases"] {
    for c in cs {
        schemaCaseCount += 1
        let text = c["json"]!.s!
        let raw: [UInt8] = text == "__INVALID_UTF8__" ? [0xff, 0xfe] : Array(text.utf8)
        var got: J
        do {
            got = .arr(try contractSchema("stateaction.capture.\(c["schema"]!.s!).v1").validate(parseStrictJson(raw)).map { .str($0) })
        } catch is MalformedJson { got = .str("malformed") }
        if !same(got, c["expect"]) { fail("SCHEMA CASE \(c["name"]!.s!): \(canonical(got))") }
    }
}
if case .arr(let us)? = schemaCases["unsupported_schemas"] {
    for u in us {
        unsupportedCount += 1
        do { _ = try StrictSchema(u["schema"]!); fail("UNSUPPORTED SCHEMA ACCEPTED \(u["name"]!.s!)") } catch is SchemaUnsupported {}
    }
}
let fixture = try JSONDecoder().decode(J.self, from: Data(contentsOf: URL(fileURLWithPath: "\(cap)/fixtures/encoder_buffers.json")))
var sources: [String: [[UInt8]]] = [:]
if case .obj(let s)? = fixture["sources"] {
    for (k, v) in s { sources[k.s] = nals([UInt8](try Data(contentsOf: URL(fileURLWithPath: "\(cap)/\(v.s!)"))))! }
}
var fixtureCases = 0
if case .obj(let cases)? = fixture["cases"] {
    for (name, c) in cases {
        fixtureCases += 1
        guard case .arr(let buffers)? = c["buffers"] else { continue }
        let got = assembleEncoderBuffers(buffers, sources)
        if !same(got, c["expect"]) { fail("ENCODER BUFFERS \(name): \(canonical(got))") }
    }
}
print("{\"runner\":\"swift\",\"cases\":\(names.count),\"encoder_buffer_cases\":\(fixtureCases),\"schema_cases\":\(schemaCaseCount),\"unsupported_schemas\":\(unsupportedCount),\"failed\":\(failed)}")
exit(failed == 0 ? 0 : 1)
