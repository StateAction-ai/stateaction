import Foundation

/// Original native frame time exactly as the platform reported it, plus the
/// derived integer nanoseconds and the rule that derived them. ARKit's
/// `ARFrame.timestamp` is a `TimeInterval` (float64 seconds); its bit pattern is
/// kept so the original value is recoverable byte for byte.
struct NativeFrameTimestamp: Equatable {
    /// Named native clock domain of `rawSeconds` (never merged with other domains).
    let clockId: String
    let rawSeconds: Double
    let nanoseconds: Int64

    static let roundingRule = "float64_seconds_to_nearest_ns_ties_away"

    init?(clockId: String, rawSeconds: Double) {
        guard rawSeconds.isFinite, rawSeconds > 0 else { return nil }
        let scaled = (rawSeconds * 1_000_000_000).rounded(.toNearestOrAwayFromZero)
        guard scaled < 9.2e18 else { return nil }
        self.clockId = clockId
        self.rawSeconds = rawSeconds
        self.nanoseconds = Int64(scaled)
    }

    init(clockId: String, nanoseconds: Int64) {
        self.clockId = clockId
        self.rawSeconds = Double(nanoseconds) / 1_000_000_000
        self.nanoseconds = nanoseconds
    }

    /// IEEE-754 bit pattern of the original seconds value (canonical decimal).
    var rawSecondsBits: String { String(rawSeconds.bitPattern) }
}

/// Keys for FrameEvent `native_timestamps` written by the iOS producer.
/// PROPOSED: published capture v1.1 only allows `arcore_*` keys here; these
/// names are the iOS request to the follow-up contract revision (see
/// `ios/portable_h264/README.md`). Values stay int64 decimals.
enum H264NativeTimestampKeys {
    static let arkitFrameNs = "arkit_frame_timestamp_ns"
    /// IEEE-754 bit pattern of the original `ARFrame.timestamp` seconds (sign
    /// bit is 0 for valid times, so it fits int64 exactly).
    static let arkitFrameF64Bits = "arkit_frame_timestamp_f64_bits"

    static func arkitFrame(_ n: NativeFrameTimestamp) -> [(String, Int64)] {
        [(arkitFrameNs, n.nanoseconds), (arkitFrameF64Bits, Int64(bitPattern: n.rawSeconds.bitPattern))]
    }
}

/// Explicit epoch-based recorder-time policy: one fixed host anchor pairs a
/// native reading with a Unix-epoch reading taken back to back. Mapped capture
/// time = `epochAnchorNs + (native - nativeAnchorNs)`. It is derived evidence
/// under `revision`; original native clocks stay in the frame evidence.
struct FixedHostAnchor: Equatable {
    static let method = "fixed_host_anchor"
    static let targetClockId = "unix"

    /// Domain the native anchor was read from.
    let nativeClockId: String
    let nativeAnchorNs: Int64
    let epochAnchorNs: Int64
    /// Width of the back-to-back read window, or nil when unknown.
    let uncertaintyNs: Int64?
    let revision: String
    /// `same_domain` only when the anchor domain is proven equal to the stream
    /// domain; otherwise `unverified`.
    let status: String

    func mapToEpoch(nativeNs: Int64) -> Int64? {
        let (delta, o1) = nativeNs.subtractingReportingOverflow(nativeAnchorNs)
        guard !o1 else { return nil }
        let (mapped, o2) = epochAnchorNs.addingReportingOverflow(delta)
        guard !o2, mapped > 0 else { return nil }
        return mapped
    }
}

/// Log-time plausibility guard used before any MCAP message is written.
///
/// The legacy recorder MCAP uses native uptime nanoseconds as log time and
/// rejects values above twice the current uptime (catches epoch values leaking
/// in). The H.264 capture profile instead uses **epoch-mapped** capture time as
/// log time, which that uptime-only guard would reject wholesale. The policy is
/// therefore explicit per file.
enum CaptureLogTimePolicy: Equatable {
    case nativeUptime
    /// Accepts `[anchorEpochNs - maxBackwardNs, anchorEpochNs + maxForwardNs]`.
    case epochMapped(anchorEpochNs: Int64, maxBackwardNs: Int64, maxForwardNs: Int64)

    static let defaultMaxBackwardNs: Int64 = 60 * 1_000_000_000
    static let defaultMaxForwardNs: Int64 = 12 * 60 * 60 * 1_000_000_000

    static func epochMapped(anchorEpochNs: Int64) -> CaptureLogTimePolicy {
        .epochMapped(anchorEpochNs: anchorEpochNs, maxBackwardNs: defaultMaxBackwardNs, maxForwardNs: defaultMaxForwardNs)
    }

    func isPlausible(logTimeNs: UInt64, currentUptimeNs: UInt64) -> Bool {
        switch self {
        case .nativeUptime:
            let threshold = currentUptimeNs &* 2
            return threshold == 0 || logTimeNs <= threshold
        case let .epochMapped(anchor, back, forward):
            guard logTimeNs <= UInt64(Int64.max) else { return false }
            let t = Int64(logTimeNs)
            let low = anchor > back ? anchor - back : 0
            let (high, overflow) = anchor.addingReportingOverflow(forward)
            return t >= low && (overflow || t <= high)
        }
    }
}

/// Integer microsecond encoder PTS from native nanoseconds. Strictly increasing
/// within a session; the original nanoseconds remain in frame evidence.
struct EncoderPtsAllocator {
    private(set) var originNs: Int64?
    private(set) var previousUs: Int64 = -1

    mutating func allocate(nativeNs: Int64) -> Int64? {
        if originNs == nil { originNs = nativeNs }
        guard let origin = originNs, nativeNs >= origin else { return nil }
        let candidate = (nativeNs - origin) / 1000
        guard candidate > previousUs else { return nil }
        previousUs = candidate
        return candidate
    }
}
