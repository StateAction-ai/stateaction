// Portable strict JSON-Schema subset interpreter (port of conformance/python/strict_schema.py) and a strict
// RFC 8259 parser. Foundation's JSONSerialization/JSONDecoder are not used for evidence: they conflate
// booleans with numbers and do not report duplicate keys.
import Foundation

struct MalformedJson: Error {}
struct SchemaUnsupported: Error { let message: String }

let maxJsonDepth = 32

/// Strict RFC 8259 / RFC 7493 parse (rules in strict_schema.py): a leading UTF-8 BOM, invalid UTF-8, more than
/// maxJsonDepth open arrays/objects, duplicate keys (exact scalar sequences via JKey, never canonical
/// equivalence), unpaired surrogate escapes, NaN/Infinity and numbers overflowing a double are malformed.
func parseStrictJson(_ bytes: [UInt8]) throws -> J {
    if bytes.count >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF { throw MalformedJson() }
    guard let text = String(validating: bytes, as: UTF8.self) else { throw MalformedJson() }
    var p = StrictParser(Array(text.unicodeScalars))
    p.ws()
    let v = try p.value(depth: 0)
    p.ws()
    guard p.i == p.s.count else { throw MalformedJson() }
    return v
}

private struct StrictParser {
    let s: [Unicode.Scalar]
    var i = 0
    init(_ s: [Unicode.Scalar]) { self.s = s }
    mutating func ws() { while i < s.count, [" ", "\t", "\n", "\r"].contains(s[i]) { i += 1 } }
    func peek(_ c: Unicode.Scalar) -> Bool { i < s.count && s[i] == c }
    mutating func value(depth: Int) throws -> J {
        guard i < s.count else { throw MalformedJson() }
        switch s[i] {
        // depth = containers already open; opening one more may not exceed maxJsonDepth.
        case "{": guard depth < maxJsonDepth else { throw MalformedJson() }; return try object(depth: depth)
        case "[": guard depth < maxJsonDepth else { throw MalformedJson() }; return try array(depth: depth)
        case "\"": return .str(try string())
        case "t": return try literal("true", .bool(true))
        case "f": return try literal("false", .bool(false))
        case "n": return try literal("null", .null)
        default: return try number()
        }
    }
    mutating func literal(_ word: String, _ v: J) throws -> J {
        for u in word.unicodeScalars { guard peek(u) else { throw MalformedJson() }; i += 1 }
        return v
    }
    mutating func object(depth: Int) throws -> J {
        i += 1
        var out: [JKey: J] = [:]
        ws()
        if peek("}") { i += 1; return .obj(out) }
        while true {
            ws()
            guard peek("\"") else { throw MalformedJson() }
            let k = JKey(try string())
            ws()
            guard peek(":") else { throw MalformedJson() }
            i += 1
            ws()
            guard out[k] == nil else { throw MalformedJson() }
            out[k] = try value(depth: depth + 1)
            ws()
            if peek(",") { i += 1; continue }
            if peek("}") { i += 1; return .obj(out) }
            throw MalformedJson()
        }
    }
    mutating func array(depth: Int) throws -> J {
        i += 1
        var out: [J] = []
        ws()
        if peek("]") { i += 1; return .arr(out) }
        while true {
            ws()
            out.append(try value(depth: depth + 1))
            ws()
            if peek(",") { i += 1; continue }
            if peek("]") { i += 1; return .arr(out) }
            throw MalformedJson()
        }
    }
    mutating func hex4() throws -> UInt32 {
        guard i + 4 <= s.count, let v = UInt32(String(String.UnicodeScalarView(s[i..<(i + 4)])), radix: 16) else { throw MalformedJson() }
        i += 4
        return v
    }
    mutating func string() throws -> String {
        i += 1
        var out = String.UnicodeScalarView()
        while true {
            guard i < s.count else { throw MalformedJson() }
            let c = s[i]; i += 1
            if c == "\"" { return String(out) }
            if c.value < 0x20 { throw MalformedJson() }
            if c != "\\" { out.append(c); continue }
            guard i < s.count else { throw MalformedJson() }
            let e = s[i]; i += 1
            switch e {
            case "\"": out.append("\"")
            case "\\": out.append("\\")
            case "/": out.append("/")
            case "b": out.append("\u{8}")
            case "f": out.append("\u{c}")
            case "n": out.append("\n")
            case "r": out.append("\r")
            case "t": out.append("\t")
            case "u":
                var v = try hex4()
                // RFC 7493: a surrogate escape must be a high+low pair; anything else is malformed (never U+FFFD).
                if (0xDC00..<0xE000).contains(v) { throw MalformedJson() }
                if (0xD800..<0xDC00).contains(v) {
                    guard i + 6 <= s.count, s[i] == "\\", s[i + 1] == "u" else { throw MalformedJson() }
                    i += 2
                    let lo = try hex4()
                    guard (0xDC00..<0xE000).contains(lo) else { throw MalformedJson() }
                    v = 0x10000 + ((v - 0xD800) << 10) + (lo - 0xDC00)
                }
                guard let scalar = Unicode.Scalar(v) else { throw MalformedJson() }
                out.append(scalar)
            default: throw MalformedJson()
            }
        }
    }
    mutating func number() throws -> J {
        let start = i
        func digit() -> Bool { i < s.count && s[i].value >= 48 && s[i].value <= 57 }
        if peek("-") { i += 1 }
        if peek("0") { i += 1 } else if digit() { while digit() { i += 1 } } else { throw MalformedJson() }
        var integral = true
        if peek(".") {
            integral = false; i += 1
            guard digit() else { throw MalformedJson() }
            while digit() { i += 1 }
        }
        if peek("e") || peek("E") {
            integral = false; i += 1
            if peek("+") || peek("-") { i += 1 }
            guard digit() else { throw MalformedJson() }
            while digit() { i += 1 }
        }
        let tok = String(String.UnicodeScalarView(s[start..<i]))
        if integral, let v = Int64(tok) { return .int(v) }
        guard let d = Double(tok), d.isFinite else { throw MalformedJson() }
        return .dbl(d)
    }
}

// MARK: interpreter
let supportedKeywords: Set<String> = [
    "$schema", "$id", "$defs", "$ref", "title", "description", "type", "const", "enum", "required", "properties",
    "additionalProperties", "propertyNames", "minProperties", "maxProperties", "items", "minItems", "maxItems",
    "pattern", "minLength", "maxLength", "minimum", "maximum", "anyOf", "allOf", "if", "then",
]
let schemaTypes: Set<String> = ["object", "array", "string", "integer", "number", "boolean", "null"]

func numberValue(_ v: J?) -> Double? {
    switch v {
    case .int(let i)?: return Double(i)
    case .dbl(let d)?: return d
    default: return nil
    }
}

func pointerToken(_ key: String) -> String {
    var out = ""
    for b in key.utf8 {
        let safe = (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5A) || (b >= 0x61 && b <= 0x7A) || b == 0x2E || b == 0x5F || b == 0x2D
        out += safe ? String(UnicodeScalar(b)) : String(format: "%%%02X", b)
    }
    return out
}

func isType(_ v: J, _ t: String) -> Bool {
    switch (t, v) {
    case ("null", .null), ("boolean", .bool), ("string", .str), ("array", .arr), ("object", .obj): return true
    case ("number", .int), ("number", .dbl), ("integer", .int): return true
    case ("integer", .dbl(let d)): return d.isFinite && d == d.rounded(.towardZero)
    default: return false
    }
}

func jsonEqual(_ a: J?, _ b: J?) -> Bool {
    switch (a ?? .null, b ?? .null) {
    case (.null, .null): return true
    case (.bool(let x), .bool(let y)): return x == y
    case (.int(let x), .int(let y)): return x == y
    case (.int, .dbl), (.dbl, .int), (.dbl, .dbl): return numberValue(a) == numberValue(b)
    case (.str(let x), .str(let y)): return exact(x, y)
    case (.arr(let x), .arr(let y)): return x.count == y.count && zip(x, y).allSatisfy { jsonEqual($0, $1) }
    case (.obj(let x), .obj(let y)): return x.count == y.count && x.allSatisfy { k, v in y[k] != nil && jsonEqual(v, y[k]) }
    default: return false
    }
}

final class StrictSchema {
    let root: [JKey: J]
    private var patterns: [String: NSRegularExpression] = [:]

    init(_ root: J) throws {
        guard case .obj(let r) = root else { throw SchemaUnsupported(message: "root must be an object") }
        self.root = r
        try check(root, "#")
    }

    private func check(_ schema: J, _ at: String) throws {
        func fail(_ m: String) -> SchemaUnsupported { SchemaUnsupported(message: "\(at): \(m)") }
        guard case .obj(let s) = schema else { throw fail("schema must be an object") }
        for key in s.keys {
            let k = key.s
            guard supportedKeywords.contains(k) else { throw fail("unsupported keyword \(k)") }
            if k == "$defs" && at != "#" { throw fail("$defs only at the root") }
        }
        if case .obj(let defs)? = s["$defs"] { for (n, sub) in defs { try check(sub, "\(at)/$defs/\(n)") } }
        if let r = s["$ref"] {
            guard let ref = r.s, ref.hasPrefix("#/$defs/"), case .obj(let defs)? = root["$defs"], defs[JKey(String(ref.dropFirst(8)))] != nil else {
                throw fail("unresolvable or non-local $ref")
            }
        }
        if let t = s["type"] {
            let ts: [J] = { if case .arr(let a) = t { return a }; return [t] }()
            guard !ts.isEmpty, ts.allSatisfy({ schemaTypes.contains($0.s ?? "") }) else { throw fail("type") }
        }
        if let e = s["enum"] { guard case .arr(let a) = e, !a.isEmpty else { throw fail("enum must be a non-empty array") } }
        if let r = s["required"] { guard case .arr(let a) = r, a.allSatisfy({ $0.s != nil }) else { throw fail("required must be a string array") } }
        if let p = s["pattern"] {
            guard let pat = p.s, pat.hasPrefix("^"), pat.hasSuffix("$"), pat.unicodeScalars.allSatisfy({ $0.isASCII }) else {
                throw fail("pattern must be an anchored ASCII ^...$ expression")
            }
            patterns[pat] = try NSRegularExpression(pattern: pat)
        }
        for k: JKey in ["minProperties", "maxProperties", "minItems", "maxItems", "minLength", "maxLength"] {
            if let v = s[k] { guard case .int(let n) = v, n >= 0 else { throw fail("\(k) must be a non-negative integer") } }
        }
        for k: JKey in ["minimum", "maximum"] { if let v = s[k] { guard numberValue(v) != nil else { throw fail("\(k) must be a number") } } }
        if let props = s["properties"] {
            guard case .obj(let p) = props else { throw fail("properties must be an object") }
            for (n, sub) in p { try check(sub, "\(at)/properties/\(n)") }
        }
        if let ap = s["additionalProperties"], ap != .bool(false) { try check(ap, "\(at)/additionalProperties") }
        for k: JKey in ["propertyNames", "items", "if", "then"] { if let sub = s[k] { try check(sub, "\(at)/\(k)") } }
        if s["then"] != nil && s["if"] == nil { throw fail("then without if") }
        for k: JKey in ["anyOf", "allOf"] {
            if let list = s[k] {
                guard case .arr(let a) = list, !a.isEmpty else { throw fail("\(k) must be a non-empty array") }
                for (i, sub) in a.enumerated() { try check(sub, "\(at)/\(k)/\(i)") }
            }
        }
    }

    func validate(_ instance: J) -> [String] {
        var out = Set<String>()
        v(.obj(root), instance, "", &out)
        return out.sorted { Array($0.utf8).lexicographicallyPrecedes(Array($1.utf8)) }
    }

    private func valid(_ s: J, _ x: J) -> Bool {
        var out = Set<String>()
        v(s, x, "", &out)
        return out.isEmpty
    }

    private func int(_ v: J?) -> Int64 { v?.i ?? 0 }

    private func v(_ schema: J, _ x: J, _ path: String, _ out: inout Set<String>) {
        guard case .obj(let s) = schema else { return }
        func err(_ kw: String) { out.insert("\(path):\(kw)") }
        if let ref = s["$ref"]?.s, case .obj(let defs)? = root["$defs"], let target = defs[JKey(String(ref.dropFirst(8)))] {
            v(target, x, path, &out)
        }
        if let t = s["type"] {
            let ts: [J] = { if case .arr(let a) = t { return a }; return [t] }()
            if !ts.contains(where: { isType(x, $0.s ?? "") }) { err("type") }
        }
        if let c = s["const"], !jsonEqual(x, c) { err("const") }
        if case .arr(let e)? = s["enum"], !e.contains(where: { jsonEqual(x, $0) }) { err("enum") }
        if case .str(let str) = x {
            let n = Int64(str.unicodeScalars.count)
            if s["minLength"] != nil && n < int(s["minLength"]) { err("minLength") }
            if s["maxLength"] != nil && n > int(s["maxLength"]) { err("maxLength") }
            if let p = s["pattern"]?.s, let re = patterns[p] {
                let full = NSRange(location: 0, length: (str as NSString).length)
                let m = re.firstMatch(in: str, options: [], range: full)
                if m == nil || m!.range.location != 0 || m!.range.length != full.length { err("pattern") }
            }
        }
        if let n = numberValue(x) {
            if let lo = numberValue(s["minimum"]), n < lo { err("minimum") }
            if let hi = numberValue(s["maximum"]), n > hi { err("maximum") }
        }
        if case .arr(let a) = x {
            if s["minItems"] != nil && Int64(a.count) < int(s["minItems"]) { err("minItems") }
            if s["maxItems"] != nil && Int64(a.count) > int(s["maxItems"]) { err("maxItems") }
            if let items = s["items"] { for (i, item) in a.enumerated() { v(items, item, "\(path)/\(i)", &out) } }
        }
        if case .obj(let o) = x {
            if case .arr(let req)? = s["required"], req.contains(where: { o[JKey($0.s!)] == nil }) { err("required") }
            if s["minProperties"] != nil && Int64(o.count) < int(s["minProperties"]) { err("minProperties") }
            if s["maxProperties"] != nil && Int64(o.count) > int(s["maxProperties"]) { err("maxProperties") }
            let props: [JKey: J] = { if case .obj(let p)? = s["properties"] { return p }; return [:] }()
            for (k, value) in o { if let sub = props[k] { v(sub, value, "\(path)/\(pointerToken(k.s))", &out) } }
            if let ap = s["additionalProperties"] {
                let extra = o.keys.filter { props[$0] == nil }
                if ap == .bool(false) { if !extra.isEmpty { err("additionalProperties") } }
                else { for k in extra { v(ap, o[k]!, "\(path)/\(pointerToken(k.s))", &out) } }
            }
            if let names = s["propertyNames"] { for k in o.keys { v(names, .str(k.s), path, &out) } }
        }
        if case .arr(let all)? = s["allOf"] { for sub in all { v(sub, x, path, &out) } }
        if case .arr(let any)? = s["anyOf"], !any.contains(where: { valid($0, x) }) { err("anyOf") }
        if let cond = s["if"], let then = s["then"], valid(cond, x) { v(then, x, path, &out) }
    }
}

// MARK: CRC-32 (IEEE 802.3, as zlib.crc32 and the MCAP specification)
let crcTable: [UInt32] = (0..<256).map { n -> UInt32 in
    var c = UInt32(n)
    for _ in 0..<8 { c = (c & 1) != 0 ? 0xEDB88320 ^ (c >> 1) : c >> 1 }
    return c
}

func crc32(_ data: [UInt8], _ end: Int) -> UInt32 {
    var c: UInt32 = 0xFFFFFFFF
    for i in 0..<end { c = crcTable[Int((c ^ UInt32(data[i])) & 0xFF)] ^ (c >> 8) }
    return c ^ 0xFFFFFFFF
}
