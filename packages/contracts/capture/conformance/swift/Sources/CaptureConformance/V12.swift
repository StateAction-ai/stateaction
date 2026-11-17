// stateaction.capture.v1.2 (SA-68) additions: channel table, strict foxglove.RawImage decoder and the
// calibration / depth / camera-metadata / Close.v2 rules. Port of conformance/python/capture_conformance.py
// (check_v12). Foundation only; no Apple-platform API.
import Foundation

let profileV2 = "stateaction.capture.Profile.v2"
let custom12: [String: String] = [
    profileV2: "Profile.v2.schema.json",
    "stateaction.capture.Close.v2": "Close.v2.schema.json",
    "stateaction.capture.Calibration.v1": "Calibration.schema.json",
    "stateaction.capture.DepthEvent.v1": "DepthEvent.schema.json",
    "stateaction.capture.CameraMetadata.v1": "CameraMetadata.schema.json",
]
let customV12Table: [String: String] = custom.filter { !$0.key.contains("Profile") && !$0.key.contains("Close") }.merging(custom12) { $1 }
let manifestV12Name = "manifest.v1.2.json"
let rawImageSchemaName = "foxglove.RawImage"
let rawImageDescName = "foxglove-raw-image.desc"
let jsonMessageMax = 65536
let rawDataMax = 16_777_216
let rawMessageMax = rawDataMax + 4096
let rawDimMax: UInt64 = 4096
let depthFrameId = "depth_optical_frame"
let tolerance = 1e-9
let depthImageTopics = ["/camera/depth_raw/image", "/camera/depth_raw/confidence", "/camera/depth_dense/image"]

let channelTable12: [String: (String, String, String)] = {
    var t = channelTable
    let json = ("jsonschema", "json")
    t["/stateaction/capture_profile"] = (profileV2, json.0, json.1)
    t["/stateaction/close"] = ("stateaction.capture.Close.v2", json.0, json.1)
    t["/stateaction/calibrations"] = ("stateaction.capture.Calibration.v1", json.0, json.1)
    t["/stateaction/depth_events"] = ("stateaction.capture.DepthEvent.v1", json.0, json.1)
    t["/stateaction/camera_metadata"] = ("stateaction.capture.CameraMetadata.v1", json.0, json.1)
    for topic in depthImageTopics { t[topic] = (rawImageSchemaName, "protobuf", "protobuf") }
    return t
}()
let exactTable12 = Dictionary(uniqueKeysWithValues: channelTable12.map { (JKey($0.key), $0.value) })

/// Revision dispatch: the schema record name of any /stateaction/capture_profile channel.
func usesV12(_ f: Mcap) -> Bool {
    f.channels.values.contains { $0.topic == "/stateaction/capture_profile" && f.schemas[$0.schemaId].map { exact($0.name, profileV2) } == true }
}

// MARK: strict foxglove.RawImage decoder
struct RawImage {
    var captureNs: Int64? = nil  // nil: seconds*1e9+nanos does not fit int64 (never equal to a valid capture time)
    var frameId = "", encoding = ""
    var width: UInt64 = 0, height: UInt64 = 0, step: UInt64 = 0
    var data: [UInt8] = []
}

/// Varint where any value >= 2^63 is malformed (every such value is a defined reject for RawImage).
func rawVarint(_ b: [UInt8], _ pos: inout Int) throws -> UInt64 {
    var shift: UInt64 = 0, v: UInt64 = 0
    while true {
        guard pos < b.count, shift <= 63 else { throw Malformed() }
        let x = b[pos]; pos += 1
        if shift == 63 && (x & 0x7f) != 0 { throw Malformed() }
        v |= UInt64(x & 0x7f) << shift
        if x & 0x80 == 0 { return v }
        shift += 7
    }
}

func rawTimestamp(_ chunk: [UInt8]) throws -> Int64? {
    var sec: UInt64 = 0, nanos: UInt64 = 0
    var seen = Set<UInt64>()
    var p = 0
    while p < chunk.count {
        let key = try rawVarint(chunk, &p)
        let field = key >> 3
        if key & 7 != 0 || (field != 1 && field != 2) || !seen.insert(field).inserted { throw Malformed() }
        let v = try rawVarint(chunk, &p)
        if field == 1 { sec = v } else { nanos = v }
    }
    if nanos >= 1_000_000_000 { throw Malformed() }
    let (prod, overflow) = Int64(sec).multipliedReportingOverflow(by: 1_000_000_000)
    if overflow { return nil }
    let (sum, overflow2) = prod.addingReportingOverflow(Int64(nanos))
    return overflow2 ? nil : sum
}

func decodeRawImage(_ b: [UInt8]) throws -> RawImage {
    guard b.count <= rawMessageMax else { throw Malformed() }
    var out = RawImage()
    var seen = Set<UInt64>()
    var pos = 0
    while pos < b.count {
        let key = try rawVarint(b, &pos)
        let field = key >> 3, wire = key & 7
        let expected: UInt64
        switch field {
        case 1, 4, 6, 7: expected = 2
        case 2, 3, 5: expected = 5
        default: throw Malformed()
        }
        guard wire == expected, seen.insert(field).inserted else { throw Malformed() }
        if wire == 5 {
            guard b.count - pos >= 4 else { throw Malformed() }
            let v = UInt64(b[pos]) | UInt64(b[pos + 1]) << 8 | UInt64(b[pos + 2]) << 16 | UInt64(b[pos + 3]) << 24
            pos += 4
            if field == 2 { out.width = v } else if field == 3 { out.height = v } else { out.step = v }
            continue
        }
        let n = try rawVarint(b, &pos)
        guard n <= UInt64(b.count - pos) else { throw Malformed() }
        let chunk = Array(b[pos..<(pos + Int(n))])
        pos += Int(n)
        switch field {
        case 1: out.captureNs = try rawTimestamp(chunk)
        case 6:
            guard Int(n) <= rawDataMax else { throw Malformed() }
            out.data = chunk
        case 4: out.encoding = try strictUtf8(chunk)
        default: out.frameId = try strictUtf8(chunk)
        }
    }
    guard seen.contains(1), (1...rawDimMax).contains(out.width), (1...rawDimMax).contains(out.height) else { throw Malformed() }
    return out
}

// MARK: v1.2 rules
private func nul(_ j: J?) -> Bool { j == nil || j == .null }
private func jn(_ j: J?) -> Int64 {
    switch j {
    case .int(let v)?: return v
    case .dbl(let d)?: return Int64(d)
    default: return 0
    }
}
private func dec(_ j: J?) -> Int64 { Int64(j?.s ?? "") ?? 0 }
private func nums(_ j: J?) -> [Double] {
    guard case .arr(let a)? = j else { return [] }
    return a.map { numberValue($0) ?? 0 }
}
private func f32(_ x: Double) -> Bool { Double(Float(x)) == x }
private func closeTo(_ a: Double, _ e: Double) -> Bool { abs(a - e) <= tolerance * max(1.0, abs(e)) }
private func matmul3(_ a: [Double], _ b: [Double]) -> [Double] {
    var out: [Double] = []
    for i in 0..<3 { for j in 0..<3 { out.append(a[3 * i] * b[j] + a[3 * i + 1] * b[3 + j] + a[3 * i + 2] * b[6 + j]) } }
    return out
}
private func kForm(_ k: [Double]) -> Bool {
    k.count == 9 && k[0] > 0 && k[4] > 0 && k[1] == 0 && k[3] == 0 && k[6] == 0 && k[7] == 0 && k[8] == 1
}

/// Saved-raster calibration rules (axis-aligned identity/crop/resize only).
func calibrationValuesOk(_ c: J, _ encoder: J?) -> Bool {
    let k = nums(c["K"]), p = nums(c["P"])
    guard let src = c["source"], let t = c["source_to_saved"], let crop = t["crop"] else { return false }
    let sk = nums(src["K"])
    guard kForm(k), kForm(sk) else { return false }
    let wantP = [k[0], k[1], k[2], 0, k[3], k[4], k[5], 0, k[6], k[7], k[8], 0]
    guard p.count == 12, zip(p, wantP).allSatisfy({ $0 == $1 }) else { return false }
    if jn(crop["left"]) + jn(crop["width"]) > jn(src["width"]) || jn(crop["top"]) + jn(crop["height"]) > jn(src["height"])
        || !same(c["saved_width"], t["scaled_width"]) || !same(c["saved_height"], t["scaled_height"]) { return false }
    if src["value_type"]?.s == "float32" && !sk.allSatisfy(f32) { return false }
    let sx = Double(jn(t["scaled_width"])) / Double(jn(crop["width"]))
    let sy = Double(jn(t["scaled_height"])) / Double(jn(crop["height"]))
    let m: [Double] = [sx, 0, (0.5 - Double(jn(crop["left"]))) * sx - 0.5, 0, sy, (0.5 - Double(jn(crop["top"]))) * sy - 0.5, 0, 0, 1]
    let matrix = nums(t["matrix"])
    guard matrix.count == 9, zip(matrix, m).allSatisfy({ closeTo($0, $1) }) else { return false }
    let prod = matmul3(matrix, sk)
    guard zip(k, prod).allSatisfy({ closeTo($0, $1) }) else { return false }
    if let e = encoder {
        if let w = e["width"], !same(w, c["saved_width"]) { return false }
        if let h = e["height"], !same(h, c["saved_height"]) { return false }
    }
    return true
}

/// Native plane layout beside the stored (tight) layout.
func planeOk(_ p: J, _ sample: Int64) -> Bool {
    let nw = jn(p["native_width"]), nh = jn(p["native_height"])
    let crop = nul(p["crop"]) ? nil : p["crop"]
    if let c = crop, jn(c["x"]) + jn(c["width"]) > nw || jn(c["y"]) + jn(c["height"]) > nh { return false }
    let region = crop.map { (jn($0["width"]), jn($0["height"])) } ?? (nw, nh)
    return jn(p["stored_width"]) == region.0 && jn(p["stored_height"]) == region.1
        && jn(p["native_pixel_stride_bytes"]) >= sample
        && jn(p["native_row_stride_bytes"]) >= (nw - 1) * jn(p["native_pixel_stride_bytes"]) + sample
}

private func inventoryEntry(_ inventory: J, _ sensorId: String, _ errors: inout Set<String>) -> J? {
    guard case .arr(let sensors)? = inventory["sensors"] else { return nil }
    let entries = sensors.filter { $0["sensor_id"]?.s == sensorId }
    if entries.count > 1 { errors.insert("E_COUNT_MISMATCH") }
    return entries.count == 1 ? entries[0] : nil
}

private func inventoryCount(_ inventory: J, _ sensorId: String, _ n: Int, _ errors: inout Set<String>) {
    let entry = inventoryEntry(inventory, sensorId, &errors)
    let count = entry?["observed_count"]
    if n > 0 {
        guard let e = entry, e["supported"]?.s == "yes", e["enabled"]?.s == "yes", e["observed"]?.s == "yes", count?.s == String(n) else {
            errors.insert("E_COUNT_MISMATCH"); return
        }
    } else if let e = entry, e["observed"]?.s == "yes" || !(nul(count) || count?.s == "0") {
        errors.insert("E_COUNT_MISMATCH")
    }
}

private struct StreamState {
    var ids = Set<String>()
    var lastEpoch: Int64 = -1
    var lastTs: Int64? = nil
    var pairs = Set<String>()
    var events = 0, confidence = 0
}

func checkV12(_ errors: inout Set<String>, _ facts: inout [JKey: J], _ byTopic: [JKey: [Message]], _ json: [String: [J]],
              _ rawDecoded: [String: [RawImage]], _ acquired: [String: J], _ close: J?, _ unresolved: Int?) {
    func js(_ t: String) -> [J] { json[t] ?? [] }
    func rawMsgs(_ t: String) -> [Message] { byTopic[JKey(t)] ?? [] }
    let profile = js("/stateaction/capture_profile").first
    let clocksMsg = js("/stateaction/clocks").first
    let clocks = clocksMsg?["stream_clocks"]
    let transport: J? = nul(clocksMsg?["recorder_transport"]) ? nil : clocksMsg?["recorder_transport"]
    let inventory = js("/stateaction/inventory").first ?? .obj([:])
    let frameEvents = js("/stateaction/frame_events")
    facts["wire_contract_revision"] = .str("stateaction.capture.v1.2")

    // mesh / point cloud: declaration only
    for sensorId in ["mesh", "point_cloud"] {
        if let e = inventoryEntry(inventory, sensorId, &errors),
           e["observed"]?.s == "yes" || e["enabled"]?.s == "yes" || !(nul(e["observed_count"]) || e["observed_count"]?.s == "0") {
            errors.insert("E_UNSUPPORTED_STREAM")
        }
    }

    // calibrations
    var invCals: [J] = []
    if case .arr(let a)? = inventory["calibrations"] { invCals = a }
    let ids = invCals.map { $0["calibration_id"]?.s ?? "" }
    if Set(ids).count != ids.count { errors.insert("E_CALIBRATION_VALUES") }
    var invById: [String: J] = [:]
    for c in invCals { invById[c["calibration_id"]?.s ?? ""] = c }
    let calMsgs = js("/stateaction/calibrations")
    var calPos: [String: Int] = [:]
    var calFacts: [J] = []
    let frameRaw = rawMsgs("/stateaction/frame_events")
    for (idx, m) in rawMsgs("/stateaction/calibrations").enumerated() {
        let c = calMsgs[idx]
        let cid = c["calibration_id"]?.s ?? ""
        guard let inv = invById[cid] else { errors.insert("E_CALIBRATION_UNKNOWN"); continue }
        if calPos[cid] != nil || inv["state"]?.s != "yes" || inv["stream_id"]?.s != c["stream_id"]?.s { errors.insert("E_CALIBRATION_VALUES") }
        if calPos[cid] == nil { calPos[cid] = m.pos }
        if !calibrationValuesOk(c, profile?["encoder"]) { errors.insert("E_CALIBRATION_VALUES") }
        let firstIdx = frameEvents.firstIndex { $0["calibration_id"]?.s == cid }
        let firsts = frameEvents.filter { $0["calibration_id"]?.s == cid && $0["state"]?.s == "acquired" }
        if firstIdx == nil || firsts.isEmpty || m.pos > frameRaw[firstIdx!].pos
            || c["first_source_frame_id"]?.s != firsts[0]["source_frame_id"]?.s
            || c["first_native_timestamp_ns"]?.s != firsts[0]["native_timestamp_ns"]?.s
            || c["native_clock_id"]?.s != firsts[0]["native_clock_id"]?.s { errors.insert("E_CALIBRATION_ASSOCIATION") }
        calFacts.append(.obj(["calibration_id": .str(cid), "stream_id": c["stream_id"] ?? .null, "saved_width": c["saved_width"] ?? .null,
                              "saved_height": c["saved_height"] ?? .null, "first_source_frame_id": c["first_source_frame_id"] ?? .null]))
    }
    for inv in invCals where inv["state"]?.s == "yes" && calPos[inv["calibration_id"]?.s ?? ""] == nil { errors.insert("E_CALIBRATION_VALUES") }
    facts["calibrations"] = .arr(calFacts)

    // camera metadata
    let meta = js("/stateaction/camera_metadata")
    var seenMeta = Set<String>()
    for e in meta {
        let sid = e["source_frame_id"]?.s ?? ""
        if let frame = acquired[sid] {
            if seenMeta.contains(sid) || (!nul(e["native_timestamp_ns"]) && e["native_timestamp_ns"]?.s != frame["native_timestamp_ns"]?.s) {
                errors.insert("E_CAMERA_METADATA")
            }
        } else { errors.insert("E_CAMERA_METADATA") }
        seenMeta.insert(sid)
    }
    inventoryCount(inventory, "camera_metadata", meta.count, &errors)
    facts["camera_metadata_count"] = .int(Int64(meta.count))

    // depth
    let events = js("/stateaction/depth_events")
    var images: [String: [UInt32: [RawImage]]] = [:]
    for t in depthImageTopics {
        images[t] = [:]
        for (i, m) in rawMsgs(t).enumerated() { images[t]![m.sequence, default: []].append(rawDecoded[t]![i]) }
    }
    var used = Set<String>()
    func take(_ topic: String, _ sequence: Int64) -> RawImage? {
        let got = UInt32(exactly: sequence).flatMap { images[topic]?[$0] } ?? []
        if got.count != 1 || !used.insert("\(topic)#\(sequence)").inserted { errors.insert("E_DEPTH_EVIDENCE"); return nil }
        return got[0]
    }
    // capture == native + (epoch_anchor - native_anchor)  <=>  capture - native == offset (all int64, no wrap)
    let offset: Int64 = transport.map { dec($0["epoch_anchor_ns"]) - dec($0["native_anchor_ns"]) } ?? 0
    var perStream: [String: StreamState] = [:]
    var depthFacts: [J] = []
    for e in events {
        let stream = e["stream_id"]?.s ?? ""
        var st = perStream[stream] ?? StreamState()
        st.events += 1
        if !st.ids.insert(e["event_id"]?.s ?? "").inserted { errors.insert("E_DEPTH_EVIDENCE") }
        let ts = dec(e["native_timestamp_ns"]), epoch = jn(e["clock_epoch"])
        if clocks?[stream]?.s != e["native_clock_id"]?.s { errors.insert("E_CLOCK_MISMATCH") }
        let basis = e["capture_time_basis"]?.s ?? ""
        let captureTime = dec(e["capture_time_ns"])
        if transport == nil || !same(e["clock_mapping_revision"], transport!["revision"]) { errors.insert("E_CLOCK_MISMATCH") }
        else if basis == "transport_mapping" {
            if e["native_clock_id"]?.s != transport!["clock_id"]?.s || !nul(e["receipt_native_timestamp_ns"]) || captureTime - ts != offset { errors.insert("E_CLOCK_MISMATCH") }
        } else if nul(e["receipt_native_timestamp_ns"]) || captureTime - dec(e["receipt_native_timestamp_ns"]) != offset { errors.insert("E_CLOCK_MISMATCH") }
        let rel = e["timestamp_relation"]?.s ?? ""
        let valid: Bool
        if let last = st.lastTs {
            valid = epoch == st.lastEpoch ? ((rel == "advanced" && ts > last) || (rel == "repeated" && ts == last)) : (rel == "clock_reset" && epoch > st.lastEpoch)
        } else { valid = rel == "first" }
        if !valid { errors.insert("E_DEPTH_CADENCE") }
        let prov = e["estimate_provenance"]?.s ?? ""
        if (rel == "repeated" && prov == "new_estimate") || (rel != "repeated" && prov == "api_repeat") { errors.insert("E_DEPTH_CADENCE") }
        st.lastEpoch = epoch; st.lastTs = ts; st.pairs.insert("\(epoch)#\(ts)")
        if !nul(e["acquisition_source_frame_id"]), acquired[e["acquisition_source_frame_id"]?.s ?? ""] == nil { errors.insert("E_DEPTH_ASSOCIATION") }
        if !nul(e["measurement_source_frame_id"]) {
            if let frame = acquired[e["measurement_source_frame_id"]?.s ?? ""] {
                if frame["native_clock_id"]?.s != e["native_clock_id"]?.s || frame["native_timestamp_ns"]?.s != e["native_timestamp_ns"]?.s { errors.insert("E_DEPTH_ASSOCIATION") }
            } else { errors.insert("E_DEPTH_ASSOCIATION") }
        }
        if !nul(e["calibration_id"]) {
            if let inv = invById[e["calibration_id"]?.s ?? ""] { if inv["stream_id"]?.s != stream { errors.insert("E_CALIBRATION_UNKNOWN") } }
            else { errors.insert("E_CALIBRATION_UNKNOWN") }
        }
        // image evidence
        let d = e["depth"]!
        let got = take(d["output_channel"]?.s ?? "", jn(d["output_sequence"]))
        var sha: J = .null
        if !planeOk(d, 2) { errors.insert("E_DEPTH_EVIDENCE") }
        else if let v = got {
            let ok = Int64(v.width) == jn(d["stored_width"]) && Int64(v.height) == jn(d["stored_height"]) && v.encoding == "16UC1"
                && v.frameId == depthFrameId && Int64(v.step) == jn(d["stored_width"]) * 2 && UInt64(v.data.count) == v.step * v.height
                && v.captureNs == Int64(e["capture_time_ns"]?.s ?? "")
            if !ok { errors.insert("E_DEPTH_EVIDENCE") }
            sha = .str(sha256Hex(v.data))
        }
        let conf = e["confidence"]!
        var confSha: J = .null, confBytes: J = .null
        let separate = conf["state"]?.s == "separate_image"
        if separate {
            st.confidence += 1
            let cgot = take(conf["output_channel"]?.s ?? "", jn(conf["output_sequence"]))
            let sameLayout = ["native_width", "native_height", "stored_width", "stored_height", "crop"].allSatisfy { same(conf[$0], d[$0]) }
            let stamp = conf["native_timestamp"]!
            if !planeOk(conf, 1) || !sameLayout { errors.insert("E_DEPTH_EVIDENCE") }
            if stamp["state"]?.s == "reported" && stamp["native_clock_id"]?.s != clocks?["depth_raw_confidence"]?.s { errors.insert("E_CLOCK_MISMATCH") }
            if let v = cgot {
                let ok = Int64(v.width) == jn(conf["stored_width"]) && Int64(v.height) == jn(conf["stored_height"]) && v.encoding == "mono8"
                    && v.frameId == depthFrameId && Int64(v.step) == jn(conf["stored_width"]) && UInt64(v.data.count) == v.step * v.height
                    && v.captureNs == Int64(e["capture_time_ns"]?.s ?? "")
                if !ok { errors.insert("E_DEPTH_EVIDENCE") }
                confSha = .str(sha256Hex(v.data)); confBytes = .int(Int64(v.data.count))
            }
        }
        let stamp: J? = separate ? conf["native_timestamp"] : nil
        depthFacts.append(.obj([
            "stream_id": .str(stream), "event_id": e["event_id"] ?? .null, "native_timestamp_ns": e["native_timestamp_ns"] ?? .null,
            "native_clock_id": e["native_clock_id"] ?? .null, "clock_epoch": e["clock_epoch"] ?? .null, "timestamp_relation": .str(rel),
            "estimate_provenance": .str(prov), "capture_time_basis": .str(basis), "capture_time_ns": e["capture_time_ns"] ?? .null,
            "sequence": d["output_sequence"] ?? .null, "stored_width": d["stored_width"] ?? .null, "stored_height": d["stored_height"] ?? .null,
            "native_width": d["native_width"] ?? .null, "native_height": d["native_height"] ?? .null, "cropped": .bool(!nul(d["crop"])),
            "depth_bytes": .int(jn(d["stored_width"]) * jn(d["stored_height"]) * 2), "depth_sha256": sha,
            "confidence_state": conf["state"] ?? .null, "confidence_bytes": confBytes, "confidence_sha256": confSha,
            "confidence_timestamp_state": stamp?["state"] ?? .null, "confidence_native_timestamp_ns": stamp?["native_timestamp_ns"] ?? .null,
        ]))
        perStream[stream] = st
    }
    for t in depthImageTopics {
        for (sequence, got) in images[t]! where got.count != 1 || !used.contains("\(t)#\(sequence)") { errors.insert("E_DEPTH_EVIDENCE") }
    }
    facts["depth"] = .arr(depthFacts)
    var streamFacts: [JKey: J] = [:]
    for (k, v) in perStream { streamFacts[JKey(k)] = .obj(["events": .int(Int64(v.events)), "distinct_native_timestamps": .int(Int64(v.pairs.count))]) }
    facts["depth_streams"] = .obj(streamFacts)
    for stream in ["depth_raw", "depth_dense"] { inventoryCount(inventory, stream, perStream[stream]?.events ?? 0, &errors) }

    // Close.v2
    guard let close = close else { return }
    for stream in ["depth_raw", "depth_dense"] {
        let st = perStream[stream]
        var entry: [(String, String)] = [("events", String(st?.events ?? 0)), ("distinct_native_timestamps", String(st?.pairs.count ?? 0))]
        if stream == "depth_raw" { entry.append(("confidence_images", String(st?.confidence ?? 0))) }
        let c = close["depth"]?[stream]
        if entry.contains(where: { c?[$0.0]?.s != $0.1 }) { errors.insert("E_COUNT_MISMATCH") }
        let repeated = events.contains { $0["stream_id"]?.s == stream && $0["timestamp_relation"]?.s == "repeated" }
        let policy = c?["retention_policy"]?.s
        if (policy == "native_updates_only" && repeated) || (policy == "all_returned_images" && c?["skipped_repeats"]?.s != "0") { errors.insert("E_DEPTH_CADENCE") }
    }
    if close["calibrations"]?.s != String(calMsgs.count) || close["camera_metadata"]?.s != String(meta.count) { errors.insert("E_COUNT_MISMATCH") }
    let outcome = close["outcome"]?.s, reason = close["stop_reason"]?.s, drain = close["encoder_drain"]?.s
    let early = ["low_storage_reserve", "thermal_critical", "session_interrupted", "camera_lost", "app_terminating"]
    let bad = (outcome == "completed" && (drain != "eos_reached" || !["user_requested", "duration_limit"].contains(reason ?? "")))
        || ((reason == "writer_error" || reason == "encoder_error" || drain == "encoder_failed") && outcome != "failed")
        || (early.contains(reason ?? "") && outcome != "aborted" && outcome != "failed")
        || (drain == "deadline_exceeded" && outcome == "completed")
        || (drain == "not_started" && (close["frames"]?["written"]?.s != "0" || close["video_messages"]?.s != "0"))
        || (outcome == "unknown" && reason != "unknown")
    if bad { errors.insert("E_OUTCOME_MISMATCH") }
    facts["close_stop_reason"] = close["stop_reason"] ?? .null
    facts["encoder_drain"] = close["encoder_drain"] ?? .null
    facts["auto_admissible"] = .bool(outcome == "completed" && unresolved == 0 && drain == "eos_reached")
}
