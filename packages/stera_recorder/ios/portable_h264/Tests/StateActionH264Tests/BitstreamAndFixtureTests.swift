import Foundation
import XCTest
@testable import H264TestSupport
@testable import StateActionH264

final class BitstreamTests: XCTestCase {
    private func prefixed(_ nals: [Data], size: Int) -> Data {
        var out = Data()
        for nal in nals {
            var n = nal.count
            var p = [UInt8](repeating: 0, count: size)
            for k in stride(from: size - 1, through: 0, by: -1) { p[k] = UInt8(n & 0xFF); n >>= 8 }
            out.append(contentsOf: p); out.append(nal)
        }
        return out
    }

    func testLengthPrefixedSplitHonorsFormatDescriptionLengthSize() throws {
        let nals = try ContractFixtures.baselineNals()
        let p = Array(nals[4...4])
        for size in [1, 2, 4] {
            XCTAssertEqual(try H264Bitstream.splitLengthPrefixed(prefixed(p, size: size), nalLengthSize: size), p)
        }
        let idr = [nals[2], nals[3]]  // 622/571-byte NALs do not fit a 1-byte prefix
        XCTAssertEqual(try H264Bitstream.splitLengthPrefixed(prefixed(idr, size: 2), nalLengthSize: 2), idr)
        // Assuming 4 for 2-byte-prefixed data must fail, never silently mis-split.
        XCTAssertThrowsError(try H264Bitstream.splitLengthPrefixed(prefixed(idr, size: 2), nalLengthSize: 4))
        XCTAssertThrowsError(try H264Bitstream.splitLengthPrefixed(Data([0, 0, 0, 1]), nalLengthSize: 3)) {
            XCTAssertEqual($0 as? H264CaptureError, .unsupportedNalLengthSize(3))
        }
        XCTAssertThrowsError(try H264Bitstream.splitLengthPrefixed(Data([0, 0, 0, 9, 0x41]), nalLengthSize: 4))
        XCTAssertThrowsError(try H264Bitstream.splitLengthPrefixed(Data([0, 0, 0, 0]), nalLengthSize: 4))
    }

    func testAccessUnitClassificationMatchesContract() throws {
        let n = try ContractFixtures.baselineNals()
        XCTAssertTrue(try H264Bitstream.validateAccessUnit(nals: [n[0], n[1], n[2], n[3]]))
        XCTAssertFalse(try H264Bitstream.validateAccessUnit(nals: [n[4]]))
        XCTAssertThrowsError(try H264Bitstream.validateAccessUnit(nals: [n[2], n[3]])) {
            XCTAssertEqual($0 as? H264CaptureError, .missingParameterSets)
        }
        XCTAssertThrowsError(try H264Bitstream.validateAccessUnit(nals: [n[0], n[1]])) {
            XCTAssertEqual($0 as? H264CaptureError, .configOnly)
        }
        XCTAssertThrowsError(try H264Bitstream.validateAccessUnit(nals: [n[4], n[5]])) {
            XCTAssertEqual($0 as? H264CaptureError, .multipleAccessUnits)
        }
        let b = try ContractFixtures.bFrameNals()
        let bSlices = b.filter { H264Bitstream.nalType($0) == 1 }
        let bSlice = try XCTUnwrap(bSlices.first { (try? H264Bitstream.sliceHeader($0).sliceType % 5) == 1 })
        XCTAssertThrowsError(try H264Bitstream.validateAccessUnit(nals: [bSlice])) {
            XCTAssertEqual($0 as? H264CaptureError, .bFrame)
        }
    }

    func testAnnexBRoundTripAndJunkRejected() throws {
        let n = try ContractFixtures.baselineNals()
        XCTAssertEqual(try H264Bitstream.splitAnnexB(H264Bitstream.joinAnnexB(n)), n)
        XCTAssertThrowsError(try H264Bitstream.splitAnnexB(Data([0x42]) + H264Bitstream.joinAnnexB(n)))
    }
}

final class EncoderBufferFixtureTests: XCTestCase {
    /// Replays every case of the shared SA-50 `fixtures/encoder_buffers.json`
    /// through the Swift assembler and compares exact AU bytes (SHA-256), IDR
    /// flags, PTS and reject codes.
    func testSharedEncoderBufferContract() throws {
        let url = ContractFixtures.captureDir.appendingPathComponent("fixtures/encoder_buffers.json")
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let sourcesMap = try XCTUnwrap(root["sources"] as? [String: String])
        var sources: [String: [Data]] = [:]
        for (k, path) in sourcesMap {
            sources[k] = try H264Bitstream.splitAnnexB(Data(contentsOf: ContractFixtures.captureDir.appendingPathComponent(path)))
        }
        let cases = try XCTUnwrap(root["cases"] as? [String: [String: Any]])
        XCTAssertGreaterThanOrEqual(cases.count, 9)
        for (name, c) in cases.sorted(by: { $0.key < $1.key }) {
            let buffers = try XCTUnwrap(c["buffers"] as? [[String: Any]]).map { b -> H264EncoderBuffer in
                var data = Data()
                if let range = b["nals"] as? [Int], let src = b["source"] as? String {
                    data = H264Bitstream.joinAnnexB(Array(sources[src]![range[0]..<range[1]]))
                    if let bytes = b["bytes"] as? [Int] { data = data.subdata(in: bytes[0]..<bytes[1]) }
                }
                return H264EncoderBuffer(flags: b["flags"] as! Int, ptsUs: b["pts_us"] as! String, annexB: data)
            }
            let expect = try XCTUnwrap(c["expect"] as? [String: Any])
            let result = H264BufferSequenceReplay.assemble(buffers)
            XCTAssertEqual(result.errors, expect["errors"] as? [String], name)
            let aus = try XCTUnwrap(expect["aus"] as? [[String: Any]])
            XCTAssertEqual(result.accessUnits.count, aus.count, name)
            for (got, want) in zip(result.accessUnits, aus) {
                XCTAssertEqual(got.annexB.count, want["bytes"] as? Int, name)
                XCTAssertEqual(SHA256Digest.hex(got.annexB), want["sha256"] as? String, name)
                XCTAssertEqual(got.isIdr, want["idr"] as? Bool, name)
                XCTAssertEqual(String(got.ptsUs), want["pts_us"] as? String, name)
            }
        }
    }
}

final class ClockPolicyTests: XCTestCase {
    func testNativeTimestampPreservesOriginalRepresentation() throws {
        let raw = 12345.678901234
        let n = try XCTUnwrap(NativeFrameTimestamp(clockId: "apple.arkit_frame_timestamp", rawSeconds: raw))
        XCTAssertEqual(n.nanoseconds, 12_345_678_901_234)
        XCTAssertEqual(Double(bitPattern: UInt64(n.rawSecondsBits)!), raw)
        let keys = H264NativeTimestampKeys.arkitFrame(n)
        XCTAssertEqual(keys[0].1, n.nanoseconds)
        XCTAssertEqual(Double(bitPattern: UInt64(bitPattern: keys[1].1)), raw)
        XCTAssertNil(NativeFrameTimestamp(clockId: "x", rawSeconds: .nan))
        XCTAssertNil(NativeFrameTimestamp(clockId: "x", rawSeconds: 0))
    }

    func testFixedAnchorMappingAndOverflow() {
        let a = CaptureHarness.configuration().anchor
        XCTAssertEqual(a.mapToEpoch(nativeNs: CaptureHarness.nativeAnchorNs + 5), CaptureHarness.epochAnchorNs + 5)
        XCTAssertNil(a.mapToEpoch(nativeNs: Int64.min))
        XCTAssertNil(FixedHostAnchor(nativeClockId: "a", nativeAnchorNs: 0, epochAnchorNs: Int64.max - 1, uncertaintyNs: nil, revision: "r", status: "unverified").mapToEpoch(nativeNs: 10))
    }

    func testUptimeGuardRejectsEpochButEpochPolicyAcceptsMappedTime() {
        let uptimeNs: UInt64 = 3_600 * 1_000_000_000
        let epoch = UInt64(CaptureHarness.epochAnchorNs)
        // Legacy writer guard: epoch-ns log time is implausible against uptime.
        XCTAssertFalse(CaptureLogTimePolicy.nativeUptime.isPlausible(logTimeNs: epoch, currentUptimeNs: uptimeNs))
        XCTAssertTrue(CaptureLogTimePolicy.nativeUptime.isPlausible(logTimeNs: uptimeNs, currentUptimeNs: uptimeNs))
        let policy = CaptureLogTimePolicy.epochMapped(anchorEpochNs: CaptureHarness.epochAnchorNs)
        XCTAssertTrue(policy.isPlausible(logTimeNs: epoch, currentUptimeNs: uptimeNs))
        XCTAssertTrue(policy.isPlausible(logTimeNs: epoch + 3_600_000_000_000, currentUptimeNs: uptimeNs))
        // Uptime-scale value leaking into an epoch file is rejected, as is a far-future one.
        XCTAssertFalse(policy.isPlausible(logTimeNs: uptimeNs, currentUptimeNs: uptimeNs))
        XCTAssertFalse(policy.isPlausible(logTimeNs: epoch + 13 * 3_600_000_000_000, currentUptimeNs: uptimeNs))
        XCTAssertFalse(policy.isPlausible(logTimeNs: UInt64.max, currentUptimeNs: uptimeNs))
    }

    func testPtsAllocatorIsStrictlyIncreasingAndNeverInvents() {
        var p = EncoderPtsAllocator()
        XCTAssertEqual(p.allocate(nativeNs: 1_000_000_000), 0)
        XCTAssertEqual(p.allocate(nativeNs: 1_033_333_333), 33_333)
        XCTAssertNil(p.allocate(nativeNs: 1_033_333_900))  // same microsecond: refuse, do not invent
        XCTAssertNil(p.allocate(nativeNs: 999_999_999))
        XCTAssertEqual(p.allocate(nativeNs: 1_066_666_667), 66_666)
    }
}

final class McapWriterTests: XCTestCase {
    func testWriterLayoutCrcAndPerChannelSequence() throws {
        let sink = MemoryCaptureSink()
        let w = try CaptureMcapWriter(sink: sink, library: "t", logTimePolicy: .epochMapped(anchorEpochNs: 1_000_000_000_000), currentUptimeNs: { 1 })
        let s = try w.addSchema(name: "x", encoding: "jsonschema", data: Data("{}".utf8))
        let a = try w.addChannel(schemaId: s, topic: "/a", messageEncoding: "json")
        let b = try w.addChannel(schemaId: s, topic: "/b", messageEncoding: "json")
        XCTAssertEqual(try w.addMessage(channelId: a, logTime: 1_000_000_000_000, publishTime: 0, data: Data("{}".utf8)), 0)
        XCTAssertEqual(try w.addMessage(channelId: b, logTime: 1_000_000_000_000, publishTime: 0, data: Data("{}".utf8)), 0)
        XCTAssertEqual(try w.addMessage(channelId: a, logTime: 1_000_000_000_001, publishTime: 0, data: Data("{}".utf8)), 1)
        XCTAssertThrowsError(try w.addMessage(channelId: a, logTime: 5, publishTime: 0, data: Data())) {
            XCTAssertEqual($0 as? CaptureMcapWriter.WriterError, .implausibleLogTime(5))
        }
        try w.finish()
        XCTAssertTrue(sink.closed)
        let bytes = [UInt8](sink.bytes)
        XCTAssertEqual(Array(bytes.prefix(8)), CaptureMcapWriter.magic)
        XCTAssertEqual(Array(bytes.suffix(8)), CaptureMcapWriter.magic)
        // DataEnd = op 0x0F, len 4, crc; then Footer (op 2, len 20) + magic.
        let dataEndAt = bytes.count - 8 - 29 - 13
        XCTAssertEqual(bytes[dataEndAt], 0x0F)
        var crc = CRC32(); crc.update(Data(bytes[..<dataEndAt]))
        let stored = bytes[(dataEndAt + 9)..<(dataEndAt + 13)].enumerated().reduce(UInt32(0)) { $0 | UInt32($1.element) << (8 * UInt32($1.offset)) }
        XCTAssertEqual(stored, crc.value)
        XCTAssertNotEqual(stored, 0)
        XCTAssertThrowsError(try w.addMessage(channelId: a, logTime: 1_000_000_000_000, publishTime: 0, data: Data()))
    }

    func testCrc32MatchesZlibCheckValue() {
        var c = CRC32(); c.update(Data("123456789".utf8))
        XCTAssertEqual(c.value, 0xCBF4_3926)
    }

    func testStrictJsonEncoding() {
        let v: CaptureJSON = .object([("a", .string("q\"\\\n\u{01}é")), ("b", .decimal(9_223_372_036_854_775_807)), ("c", .array([.null, .bool(true), .int(-1)]))])
        XCTAssertEqual(v.encoded(), #"{"a":"q\"\\\n\u0001é","b":"9223372036854775807","c":[null,true,-1]}"#)
    }
}
