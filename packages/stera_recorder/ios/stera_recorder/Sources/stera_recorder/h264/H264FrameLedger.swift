import Foundation

/// Immutable acquisition identity of one RGB frame. Every later FrameEvent for
/// the frame repeats it verbatim (SA-50 `E_FRAME_IDENTITY`).
struct H264FrameIdentity: Equatable {
    let sourceFrameId: Int64
    let native: NativeFrameTimestamp
    let mappedCaptureTimeNs: Int64
    let clockMappingRevision: String
    let calibrationId: String
    let encoderPtsUs: Int64
    /// Original native timestamps as (key, ns) pairs, preserved in order.
    let nativeTimestamps: [(String, Int64)]

    static func == (a: H264FrameIdentity, b: H264FrameIdentity) -> Bool {
        a.sourceFrameId == b.sourceFrameId && a.native == b.native
            && a.mappedCaptureTimeNs == b.mappedCaptureTimeNs
            && a.clockMappingRevision == b.clockMappingRevision
            && a.calibrationId == b.calibrationId && a.encoderPtsUs == b.encoderPtsUs
            && a.nativeTimestamps.map { $0.0 } == b.nativeTimestamps.map { $0.0 }
            && a.nativeTimestamps.map { $0.1 } == b.nativeTimestamps.map { $0.1 }
    }
}

/// Bounded join between encoder outputs and acquisitions. Outputs are matched
/// by `sourceFrameRefCon` (the source frame ID) **and** checked against the
/// acquired PTS — never by callback order. Only `maxPending` frames may be in
/// flight, which bounds retained camera pixel buffers inside the encoder.
final class H264FrameLedger {
    enum State: Equatable { case acquired, submitted }

    enum LedgerError: Error, Equatable {
        case pendingBoundExhausted
        case nonMonotonicSourceId
        case nonMonotonicPts
        case unknownSourceFrame(Int64)
        case duplicateSubmit(Int64)
        case ptsIdentityMismatch(expected: Int64, actual: Int64)
        case outputPtsRegressed
    }

    let maxPending: Int
    private var pending: [Int64: (identity: H264FrameIdentity, state: State)] = [:]
    private var order: [Int64] = []
    private var lastSourceId: Int64 = 0
    private var lastPtsUs: Int64 = -1
    private var lastWrittenPtsUs: Int64 = -1

    private(set) var acquired: Int64 = 0
    private(set) var submitted: Int64 = 0
    private(set) var written: Int64 = 0
    private(set) var dropped: Int64 = 0
    private(set) var highWater = 0
    private(set) var dropReasons: [String: Int64] = [:]

    init(maxPending: Int) {
        precondition(maxPending >= 1 && maxPending <= 64)
        self.maxPending = maxPending
    }

    var pendingCount: Int { pending.count }
    var hasCapacity: Bool { pending.count < maxPending }
    var unresolvedIds: [Int64] { order }

    func identity(of id: Int64) -> H264FrameIdentity? { pending[id]?.identity }
    func state(of id: Int64) -> State? { pending[id]?.state }

    func acquire(_ identity: H264FrameIdentity) throws {
        guard identity.sourceFrameId > lastSourceId else { throw LedgerError.nonMonotonicSourceId }
        guard identity.encoderPtsUs > lastPtsUs else { throw LedgerError.nonMonotonicPts }
        guard pending.count < maxPending else { throw LedgerError.pendingBoundExhausted }
        pending[identity.sourceFrameId] = (identity, .acquired)
        order.append(identity.sourceFrameId)
        lastSourceId = identity.sourceFrameId
        lastPtsUs = identity.encoderPtsUs
        acquired += 1
        highWater = max(highWater, pending.count)
    }

    /// Acquired but refused admission (e.g. pending bound exhausted): counted as
    /// acquired and immediately dropped, never retained.
    func acquireAndDrop(_ identity: H264FrameIdentity, reason: String) throws {
        guard identity.sourceFrameId > lastSourceId else { throw LedgerError.nonMonotonicSourceId }
        guard identity.encoderPtsUs > lastPtsUs else { throw LedgerError.nonMonotonicPts }
        lastSourceId = identity.sourceFrameId
        lastPtsUs = identity.encoderPtsUs
        acquired += 1
        dropped += 1
        dropReasons[reason, default: 0] += 1
    }

    func markSubmitted(_ id: Int64) throws {
        guard let entry = pending[id] else { throw LedgerError.unknownSourceFrame(id) }
        guard entry.state == .acquired else { throw LedgerError.duplicateSubmit(id) }
        pending[id] = (entry.identity, .submitted)
        submitted += 1
    }

    /// Validates an encoder output against the acquired identity without
    /// resolving it.
    func checkOutput(id: Int64, ptsUs: Int64) throws -> H264FrameIdentity {
        guard let entry = pending[id] else { throw LedgerError.unknownSourceFrame(id) }
        guard entry.identity.encoderPtsUs == ptsUs else {
            throw LedgerError.ptsIdentityMismatch(expected: entry.identity.encoderPtsUs, actual: ptsUs)
        }
        guard ptsUs > lastWrittenPtsUs else { throw LedgerError.outputPtsRegressed }
        return entry.identity
    }

    func resolveWritten(_ id: Int64) {
        guard let entry = pending.removeValue(forKey: id) else { return }
        order.removeAll { $0 == id }
        lastWrittenPtsUs = entry.identity.encoderPtsUs
        written += 1
    }

    @discardableResult
    func resolveDropped(_ id: Int64, reason: String) -> H264FrameIdentity? {
        guard let entry = pending.removeValue(forKey: id) else { return nil }
        order.removeAll { $0 == id }
        dropped += 1
        dropReasons[reason, default: 0] += 1
        return entry.identity
    }
}
