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

// MARK: JSON value (keeps bool/int/string distinct)
indirect enum J: Decodable, Equatable {
    case null, bool(Bool), int(Int64), dbl(Double), str(String), arr([J]), obj([String: J])
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Int64.self) { self = .int(v) }
        else if let v = try? c.decode(Double.self) { self = .dbl(v) }
        else if let v = try? c.decode(String.self) { self = .str(v) }
        else if let v = try? c.decode([J].self) { self = .arr(v) }
        else { self = .obj(try c.decode([String: J].self)) }
    }
    subscript(_ k: String) -> J? { if case .obj(let o) = self { return o[k] }; return nil }
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
    case .obj(let o): return "{" + o.keys.sorted { Array($0.utf8).lexicographicallyPrecedes(Array($1.utf8)) }.map { quote($0) + ":" + canonical(o[$0]!) }.joined(separator: ",") + "}"
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
    var channels: [Int: (schemaId: Int, topic: String)] = [:]
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
    return (String(decoding: b[(off + 4)..<(off + 4 + n)], as: UTF8.self), off + 4 + n)
}

func readMcap(_ d: [UInt8]) throws -> Mcap {
    guard d.count >= 8, Array(d[0..<8]) == magic else { throw Truncated() }
    var pos = 8
    var out = Mcap()
    while true {
        if pos == d.count || pos + 9 > d.count { throw Truncated() }
        let op = d[pos]
        let len = Int(try le(d, pos + 1, UInt64.self))
        let start = pos + 9
        guard start + len <= d.count else { throw Truncated() }
        let body = Array(d[start..<(start + len)])
        pos = start + len
        switch op {
        case 0x01: out.profile = try readStr(body, 0).0
        case 0x03:
            let (name, o1) = try readStr(body, 2)
            let (enc, o2) = try readStr(body, o1)
            let n = Int(try le(body, o2, UInt32.self))
            out.schemas[Int(try le(body, 0, UInt16.self))] = Schema(name: name, encoding: enc, data: Array(body[(o2 + 4)..<(o2 + 4 + n)]))
        case 0x04:
            out.channels[Int(try le(body, 0, UInt16.self))] = (Int(try le(body, 2, UInt16.self)), try readStr(body, 4).0)
        case 0x05:
            out.messages.append(Message(channel: Int(try le(body, 0, UInt16.self)), sequence: try le(body, 2, UInt32.self), logTime: try le(body, 6, UInt64.self), data: Array(body[22...])))
        case 0x02:
            guard pos + 8 == d.count, Array(d[pos...]) == magic else { throw Truncated() }
            return out
        default: break
        }
    }
}

// MARK: Protobuf CompressedVideo
func varint(_ b: [UInt8], _ pos: inout Int) -> UInt64 {
    var shift: UInt64 = 0, v: UInt64 = 0
    while true {
        let x = b[pos]; pos += 1
        v |= UInt64(x & 0x7f) << shift
        if x & 0x80 == 0 { return v }
        shift += 7
    }
}

struct Video { var sec: UInt64 = 0, nanos: UInt64 = 0; var frameId = "", format = ""; var data: [UInt8] = [] }

func decodeVideo(_ b: [UInt8]) -> Video {
    var v = Video(); var pos = 0
    while pos < b.count {
        let key = varint(b, &pos)
        let field = key >> 3, wire = key & 7
        if wire == 2 {
            let n = Int(varint(b, &pos))
            let chunk = Array(b[pos..<(pos + n)]); pos += n
            if field == 1 {
                var p = 0
                while p < chunk.count {
                    let k = varint(chunk, &p); let val = varint(chunk, &p)
                    if k >> 3 == 1 { v.sec = val } else { v.nanos = val }
                }
            } else if field == 2 { v.frameId = String(decoding: chunk, as: UTF8.self) }
            else if field == 3 { v.data = chunk }
            else if field == 4 { v.format = String(decoding: chunk, as: UTF8.self) }
        } else if wire == 0 { _ = varint(b, &pos) }
        else { fatalError("wire type") }
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
    if headers.contains(where: { $0 == nil }) || headers.filter({ $0!.0 == 0 }).count != 1 { errors.append("E_PARTIAL_ACCESS_UNIT") }
    else if headers.contains(where: { $0!.1 % 5 == 1 }) { errors.append("E_B_FRAME") }
    let idr = types.contains(5)
    if idr {
        let firstImage = types.firstIndex { $0 == 1 || $0 == 5 }!
        let before = types[0..<firstImage]
        if !before.contains(7) || !before.contains(8) { errors.append("E_MISSING_PARAMETER_SETS") }
    }
    return (errors, idr)
}

func decodePose(_ d: [UInt8]) throws -> [String: J] {
    guard try le(d, 0, UInt32.self) == 0x0000_0100 else { fatalError("CDR header") }
    let n = Int(try le(d, 12, UInt32.self))
    return ["sec": .int(Int64(try le(d, 4, Int32.self))), "nanosec": .int(Int64(try le(d, 8, UInt32.self))),
            "frame_id": .str(String(decoding: d[16..<(16 + n - 1)], as: UTF8.self))]
}

// MARK: Checker
func check(_ data: [UInt8], _ manifest: [String: String]) throws -> J {
    var errors = Set<String>()
    let f: Mcap
    do { f = try readMcap(data) } catch is Truncated {
        return .obj(["outcome": .str("reject"), "errors": .arr([.str("E_TRUNCATED")]), "facts": .obj([:])])
    }
    if f.profile != "" { errors.insert("E_PROFILE_NOT_EMPTY") }
    var byTopic: [String: [Message]] = [:]
    for m in f.messages { byTopic[f.channels[m.channel]!.topic, default: []].append(m) }
    let names = Set(f.schemas.values.map { $0.name })
    var facts: [String: J] = ["channel_counts": .obj(byTopic.mapValues { .int(Int64($0.count)) })]
    if names.contains("sensor_msgs/msg/CompressedImage") && !names.contains("foxglove.CompressedVideo") {
        let img = byTopic["/camera/rgb/image/compressed"] ?? []
        facts["legacy_images"] = .int(Int64(img.count))
        facts["legacy_log_times_ns"] = .arr(img.map { .str(String($0.logTime)) })
        return .obj(["outcome": .str("legacy_jpeg"), "errors": .arr([.str("E_LEGACY_JPEG")]), "facts": .obj(facts)])
    }
    var hashes: [String: J] = [:]
    for s in f.schemas.values {
        let digest = sha256Hex(s.data)
        hashes[s.name] = .str(digest)
        if s.name == "foxglove.CompressedVideo" {
            if digest != manifest["foxglove-compressed-video.desc"] || s.encoding != "protobuf" { errors.insert("E_DESCRIPTOR_HASH") }
        } else if let file = custom[s.name] {
            if digest != manifest[file] || s.encoding != "jsonschema" { errors.insert("E_SCHEMA_MISMATCH") }
        }
    }
    facts["schema_sha256"] = .obj(hashes)
    func js(_ t: String) -> [J] {
        (byTopic[t] ?? []).map { try! JSONDecoder().decode(J.self, from: Data($0.data)) }
    }
    let clocks = js("/stateaction/clocks").first?["stream_clocks"] ?? .obj([:])
    let frames = js("/stateaction/frame_events")
    var ptsSeen = Set<String>(), acquired = Set<String>(), written: [String: J] = [:], state: [String: String] = [:]
    var counts: [String: Int64] = ["acquired": 0, "submitted": 0, "written": 0, "dropped": 0]
    for e in frames {
        let sid = e["source_frame_id"]!.s!, st = e["state"]!.s!
        if (st == "acquired" || st == "written") && clocks[e["stream_id"]!.s!]?.s != e["native_clock_id"]?.s { errors.insert("E_CLOCK_MISMATCH") }
        if (st == "acquired" || st == "written") && e["encoder_pts_us"] == nil { errors.insert("E_MISSING_PTS") }
        if st == "acquired" {
            if let p = e["encoder_pts_us"]?.s { if !ptsSeen.insert(p).inserted { errors.insert("E_DUPLICATE_PTS") } }
            acquired.insert(sid)
        }
        if st == "written" { written[sid] = e }
        counts[st]! += 1
        state[sid] = st
    }
    facts["frame_event_counts"] = .obj(counts.mapValues { .int($0) })
    let video = byTopic[videoTopic] ?? []
    var bySeq: [Int64: J] = [:]
    for e in written.values { bySeq[e["output_sequence"]!.i!] = e }
    var vf: [J] = []
    for (i, m) in video.enumerated() {
        let v = decodeVideo(m.data)
        let (auErrors, idr) = classifyAu(v.data)
        auErrors.forEach { errors.insert($0) }
        if i == 0 && !idr && auErrors.isEmpty { errors.insert("E_FIRST_NOT_IDR") }
        let ts = v.sec * 1_000_000_000 + v.nanos
        let ev = bySeq[Int64(m.sequence)]
        if v.frameId != frameIdName || v.format != "h264" { errors.insert("E_VIDEO_FIELDS") }
        if ev == nil { errors.insert("E_MISSING_PTS") }
        else if String(ts) != ev!["mapped_capture_time_ns"]?.s || ev!["is_idr"]!.b != idr { errors.insert("E_VIDEO_TIMESTAMP_MISMATCH") }
        vf.append(.obj(["sequence": .int(Int64(m.sequence)), "capture_time_ns": .str(String(ts)), "log_time_ns": .str(String(m.logTime)),
                        "frame_id": .str(v.frameId), "format": .str(v.format), "bytes": .int(Int64(v.data.count)),
                        "idr": .bool(idr), "sha256": .str(sha256Hex(v.data)),
                        "source_frame_id": ev?["source_frame_id"] ?? .null, "encoder_pts_us": ev?["encoder_pts_us"] ?? .null]))
    }
    facts["video"] = .arr(vf)
    if Int64(video.count) != counts["written"]! { errors.insert("E_MISSING_PTS") }
    var motion: [String: J] = [:]
    for topic in ["/stateaction/imu/accel", "/stateaction/imu/gyro"] {
        let evs = js(topic)
        motion[topic] = .arr(evs.map { .obj(["event_id": $0["event_id"]!, "native_timestamp_ns": $0["native_timestamp_ns"]!, "mapped_capture_time_ns": $0["mapped_capture_time_ns"] ?? .null]) })
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
    for e in frames where e["state"]?.s == "acquired" {
        cals.insert(e["calibration_id"]!.s!)
        if let at = resetAt[e["calibration_id"]!.s!], let atId = at, UInt64(e["source_frame_id"]!.s!)! >= UInt64(atId)! { errors.insert("E_CALIBRATION_RESET_UNMARKED") }
    }
    facts["sensor_events"] = .arr(sensors.map { .obj(["event_id": $0["event_id"]!, "source_kind": $0["source_kind"]!, "native_timestamp_ns": $0["native_timestamp_ns"]!, "tracking_state": $0["tracking_state"] ?? .null]) })
    facts["calibrations_used"] = .arr(cals.sorted().map { .str($0) })
    facts["cdr_poses"] = .arr(try (byTopic["/tracking/pose"] ?? []).map { m in
        var p = try decodePose(m.data); p["log_time_ns"] = .str(String(m.logTime)); return .obj(p) })
    if let close = js("/stateaction/close").last {
        let dropped = state.values.filter { $0 == "dropped" }.count
        var expect = counts.mapValues { String($0) }
        expect["unresolved"] = String(acquired.count - written.count - dropped)
        let cf = close["frames"]!
        if ["acquired", "dropped", "submitted", "unresolved", "written"].contains(where: { cf[$0]?.s != expect[$0] }) || close["video_messages"]?.s != String(video.count) { errors.insert("E_COUNT_MISMATCH") }
        facts["close_outcome"] = close["outcome"]!
    } else { errors.insert("E_COUNT_MISMATCH") }
    let list = errors.sorted()
    return .obj(["outcome": .str(list.isEmpty ? "accept" : "reject"), "errors": .arr(list.map { .str($0) }), "facts": .obj(list.isEmpty ? facts : [:])])
}

let cap = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "../..").standardizedFileURL.path
let manifestRaw = try JSONDecoder().decode(J.self, from: Data(contentsOf: URL(fileURLWithPath: "\(cap)/manifest.json")))
var manifest: [String: String] = [:]
if case .obj(let files)? = manifestRaw["files"] { for (k, v) in files { manifest[k] = v.s } }
let names = try FileManager.default.contentsOfDirectory(atPath: "\(cap)/golden").filter { $0.hasSuffix(".mcap") }.map { String($0.dropLast(5)) }.sorted()
var failed = 0
for name in names {
    let data = try [UInt8](Data(contentsOf: URL(fileURLWithPath: "\(cap)/golden/\(name).mcap")))
    let actual = canonical(try check(data, manifest)) + "\n"
    let expected = try String(contentsOfFile: "\(cap)/golden/expected/\(name).json", encoding: .utf8)
    if actual != expected {
        failed += 1
        FileHandle.standardError.write("MISMATCH \(name)\n  actual:   \(actual.prefix(300))\n  expected: \(expected.prefix(300))\n".data(using: .utf8)!)
    }
}
print("{\"runner\":\"swift\",\"cases\":\(names.count),\"failed\":\(failed)}")
exit(failed == 0 ? 0 : 1)
