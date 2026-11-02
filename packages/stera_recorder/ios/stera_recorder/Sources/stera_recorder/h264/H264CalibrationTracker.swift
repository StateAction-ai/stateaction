import Foundation

/// Assigns label-safe calibration IDs from per-frame pinhole intrinsics. A new
/// ID is issued only when the intrinsics move beyond `tolerancePx` from the
/// current calibration's reference (ARKit intrinsics jitter with focus), and at
/// most `maxCalibrations` IDs exist (SA-50 Inventory bound 64). Per-recording
/// instance: a new recording always starts again from `<prefix>_0`.
struct H264CalibrationTracker {
    struct Intrinsics: Equatable {
        let fx: Double, fy: Double, cx: Double, cy: Double
        let width: Int, height: Int
    }

    let prefix: String
    let tolerancePx: Double
    let maxCalibrations: Int
    private(set) var reference: Intrinsics?
    private(set) var count = 0
    private(set) var capReached = false

    init(prefix: String = "rgb", tolerancePx: Double = 1.0, maxCalibrations: Int = 64) {
        self.prefix = prefix
        self.tolerancePx = tolerancePx
        self.maxCalibrations = maxCalibrations
    }

    var currentId: String? { count == 0 ? nil : "\(prefix)_\(count - 1)" }

    /// Returns the calibration ID for a frame with these intrinsics, or nil when
    /// the values are unusable.
    mutating func calibrationId(for k: Intrinsics) -> String? {
        guard [k.fx, k.fy, k.cx, k.cy].allSatisfy({ $0.isFinite && $0 > 0 }), k.width > 0, k.height > 0 else { return nil }
        if let r = reference, r.width == k.width, r.height == k.height,
           abs(r.fx - k.fx) <= tolerancePx, abs(r.fy - k.fy) <= tolerancePx,
           abs(r.cx - k.cx) <= tolerancePx, abs(r.cy - k.cy) <= tolerancePx {
            return currentId
        }
        if count >= maxCalibrations {
            capReached = true
            return currentId
        }
        reference = k
        count += 1
        return currentId
    }
}
