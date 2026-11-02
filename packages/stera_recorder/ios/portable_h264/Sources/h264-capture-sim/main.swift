import Foundation
@testable import H264TestSupport
@testable import StateActionH264

// Writes scenario capture files through the production session/controller with
// the scripted encoder, into the directory given as the only argument:
//   <scenario>.mcap           the capture file (FileCaptureSink, real file I/O)
//   <scenario>.evidence.json  the sidecar evidence
//   <scenario>.expect.json    the summary the controller reported
// `tool/check_ios_h264_capture.py` judges them with the SA-50 reference checker
// and ffmpeg. Simulation only: no camera, VideoToolbox or Apple clock is involved.

struct Scenario {
    let name: String
    let recordingId: String
    let configure: (ScriptedH264Encoder) -> Void
    let maxPending: Int
    let drive: (H264CaptureController<ScriptedH264Encoder>, ScriptedH264Encoder) throws -> H264CaptureOutcome
}

func submit(_ c: H264CaptureController<ScriptedH264Encoder>, _ i: Int, calibration: String = "rgb_0") throws {
    let n = CaptureHarness.native(i)
    try c.submit(i, rasterWidth: 64, rasterHeight: 48, native: n,
                 nativeTimestamps: CaptureHarness.nativeTimestamps(n), calibrationId: calibration)
}

let scenarios: [Scenario] = [
    Scenario(name: "valid_three_gops", recordingId: "00000000-0000-4000-8000-000000000001", configure: { _ in }, maxPending: 4) { c, _ in
        for i in 0..<15 { try submit(c, i) }
        return .completed
    },
    Scenario(name: "delayed_callbacks", recordingId: "00000000-0000-4000-8000-000000000002", configure: { $0.deferOutputs = true }, maxPending: 4) { c, e in
        for i in 0..<3 { try submit(c, i) }
        e.release()
        for i in 3..<7 { try submit(c, i) }
        e.release()
        return .completed
    },
    Scenario(name: "identity_faults", recordingId: "00000000-0000-4000-8000-000000000003",
             configure: { $0.faults = [2: .wrongPts, 3: .noRefcon, 4: .drop, 5: .configOnly, 6: .truncatedLength] }, maxPending: 4) { c, _ in
        for i in 0..<10 { try submit(c, i) }
        return .completed
    },
    Scenario(name: "first_output_not_idr", recordingId: "00000000-0000-4000-8000-000000000004",
             configure: { $0.faults = [1: .nonIdrInsteadOfIdr] }, maxPending: 4) { c, _ in
        for i in 0..<6 { try submit(c, i) }
        return .completed
    },
    Scenario(name: "pending_bound", recordingId: "00000000-0000-4000-8000-000000000005", configure: { $0.deferOutputs = true }, maxPending: 2) { c, e in
        for i in 0..<5 { try submit(c, i) }
        e.release()
        for i in 5..<8 { try submit(c, i) }
        return .completed
    },
    Scenario(name: "interrupted", recordingId: "00000000-0000-4000-8000-000000000006",
             configure: { $0.deferOutputs = true; $0.hangOnComplete = true }, maxPending: 4) { c, e in
        try submit(c, 0); try submit(c, 1)
        e.release()
        try submit(c, 2); try submit(c, 3)
        return .aborted("app_backgrounded")
    },
    Scenario(name: "encoder_failure", recordingId: "00000000-0000-4000-8000-000000000007",
             configure: { $0.faults = [3: .fail(-12903)] }, maxPending: 4) { c, _ in
        for i in 0..<6 { try submit(c, i) }
        return .completed
    },
    Scenario(name: "calibration_reset", recordingId: "00000000-0000-4000-8000-000000000008", configure: { _ in }, maxPending: 4) { c, _ in
        for i in 0..<4 { try submit(c, i, calibration: "rgb_0") }
        for i in 4..<8 { try submit(c, i, calibration: "rgb_1") }
        return .completed
    },
    Scenario(name: "session_a", recordingId: "00000000-0000-4000-8000-00000000000a", configure: { _ in }, maxPending: 4) { c, _ in
        for i in 0..<10 { try submit(c, i) }
        return .completed
    },
    Scenario(name: "session_b", recordingId: "00000000-0000-4000-8000-00000000000b",
             configure: { $0.spsLevelOverride = 0x1F; $0.nalLengthSize = 2 }, maxPending: 4) { c, _ in
        for i in 0..<10 { try submit(c, i) }
        return .completed
    },
]

let args = CommandLine.arguments
guard args.count == 2 else {
    FileHandle.standardError.write(Data("usage: h264-capture-sim <output-dir>\n".utf8))
    exit(2)
}
let out = URL(fileURLWithPath: args[1], isDirectory: true)
try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
for s in scenarios {
    let enc = try ScriptedH264Encoder()
    s.configure(enc)
    let config = CaptureHarness.configuration(recordingId: s.recordingId, maxPending: s.maxPending)
    let sink = try FileCaptureSink(url: out.appendingPathComponent("\(s.name).mcap"), flushThresholdBytes: 4096)
    let controller = try H264CaptureController(encoder: enc, session: CaptureHarness.session(config, sink: sink))
    let outcome = try s.drive(controller, enc)
    let summary = try controller.finish(outcome: outcome)
    try controller.session.evidenceJSON().data().write(to: out.appendingPathComponent("\(s.name).evidence.json"))
    let expect: CaptureJSON = .object([
        ("outcome", .string(summary.outcome)),
        ("acquired", .decimal(summary.acquired)), ("submitted", .decimal(summary.submitted)),
        ("written", .decimal(summary.written)), ("dropped", .decimal(summary.dropped)),
        ("unresolved", .decimal(summary.unresolved)), ("idr_messages", .decimal(summary.idrMessages)),
        ("drop_reasons", .object(summary.dropReasons.sorted { $0.key < $1.key }.map { ($0.key, CaptureJSON.decimal($0.value)) })),
        ("sps_hex", .string(enc.parameterSets.sps[0].map { String(format: "%02x", $0) }.joined())),
    ])
    try expect.data().write(to: out.appendingPathComponent("\(s.name).expect.json"))
    print("\(s.name): \(summary.outcome) written=\(summary.written) dropped=\(summary.dropped) bytes=\(summary.bytesWritten)")
}
