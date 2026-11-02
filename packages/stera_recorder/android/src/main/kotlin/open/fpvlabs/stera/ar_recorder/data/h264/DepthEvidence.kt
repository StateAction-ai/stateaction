package open.fpvlabs.stera.ar_recorder.data.h264

import java.nio.ByteBuffer

/**
 * SA-55: pure, JVM-testable depth/confidence plane and provenance helpers. Nothing here touches ARCore, retains an
 * Image, or writes a file. The wire shape produced by [DepthEvidence.event] is a PROPOSAL until the strict capture
 * contract is revised (see docs/components/android-depth-provenance.md); it is not yet written to MCAP.
 *
 * Rules enforced here (each covered by DepthEvidenceTest):
 *  - sample bytes are copied verbatim (no scaling, clamping or quantization); only stride padding is removed,
 *  - ARCore raw estimated depth and dense estimated depth are different source kinds and never share a stream,
 *  - missing confidence is an explicit state, never a zero-filled plane,
 *  - a repeated native depth timestamp is rejected, so a low-rate depth stream cannot be duplicated to fake cadence.
 */
object DepthEvidence {
    /** Depth source kinds. Both are estimates; neither is a measured time-of-flight or metric-accuracy claim. */
    enum class SourceKind(val label: String, val streamId: String) {
        ARCORE_RAW_DEPTH_ESTIMATED("arcore_raw_depth_estimated", "depth_raw"),
        ARCORE_DENSE_DEPTH_ESTIMATED("arcore_dense_depth_estimated", "depth_dense"),
    }

    /** Per-take stream availability. Mirrors the contract's explicit unavailable/unknown states. */
    enum class Availability(val label: String) {
        DISABLED("disabled"),            // not requested by the recording configuration
        UNSUPPORTED("unsupported"),      // device/session reports no depth support
        UNAVAILABLE("unavailable"),      // supported and enabled, but no frame was obtainable
        UNKNOWN("unknown"),              // support could not be determined
        OBSERVED("observed"),            // at least one native depth image was retained
    }

    /** Native sample layouts. Units/bit meaning are stated, never converted. */
    enum class SampleFormat(val label: String, val sampleBytes: Int) {
        /** android.graphics.ImageFormat.DEPTH16: little-endian uint16; ARCore depth in millimetres. */
        DEPTH16_MM("depth16", 2),
        /** ARCore raw depth confidence image: uint8, 0 = lowest .. 255 = highest. */
        CONFIDENCE_U8("uint8", 1),
    }

    /** A native image plane as handed over by the platform (stride may exceed the visible width). */
    class PlaneLayout(
        val width: Int,
        val height: Int,
        val rowStrideBytes: Int,
        val pixelStrideBytes: Int,
        val format: SampleFormat,
    ) {
        init {
            require(width > 0 && height > 0) { "Plane must be non-empty" }
            require(pixelStrideBytes >= format.sampleBytes) { "Pixel stride smaller than a sample" }
            require(rowStrideBytes >= (width - 1) * pixelStrideBytes + format.sampleBytes) { "Row stride smaller than a row" }
        }
        val minimumBufferBytes: Long get() = (height - 1).toLong() * rowStrideBytes + (width - 1).toLong() * pixelStrideBytes + format.sampleBytes
    }

    /** Pixel-space crop of a native plane. Recorded so a cropped plane is never mistaken for the full field of view. */
    data class Crop(val x: Int, val y: Int, val width: Int, val height: Int) {
        init { require(x >= 0 && y >= 0 && width > 0 && height > 0) { "Invalid crop" } }
        fun fits(layout: PlaneLayout) = x.toLong() + width <= layout.width && y.toLong() + height <= layout.height
    }

    /**
     * Copies the (optionally cropped) plane into a tight little-endian-preserving array. The bytes of every sample are
     * copied unchanged; the row/pixel stride padding is dropped. The source buffer position and limit are untouched.
     */
    fun copyPlane(source: ByteBuffer, layout: PlaneLayout, crop: Crop? = null): ByteArray {
        val region = crop ?: Crop(0, 0, layout.width, layout.height)
        require(region.fits(layout)) { "Crop exceeds the native plane" }
        val src = source.duplicate()
        require(src.limit() >= layout.minimumBufferBytes) { "Buffer smaller than the declared stride layout" }
        val sample = layout.format.sampleBytes
        val out = ByteArray(Math.multiplyExact(Math.multiplyExact(region.width, region.height), sample))
        var o = 0
        for (row in 0 until region.height) {
            val rowStart = (region.y + row).toLong() * layout.rowStrideBytes
            for (col in 0 until region.width) {
                val at = Math.toIntExact(rowStart + (region.x + col).toLong() * layout.pixelStrideBytes)
                for (b in 0 until sample) out[o++] = src.get(at + b)
            }
        }
        return out
    }

    /** Plane descriptor stored beside the retained bytes: native layout plus the stored (tight) layout. */
    fun planeDescriptor(layout: PlaneLayout, crop: Crop?): Map<String, Any?> {
        val region = crop ?: Crop(0, 0, layout.width, layout.height)
        return linkedMapOf(
            "format" to layout.format.label,
            "sample_bytes" to layout.format.sampleBytes,
            "byte_order" to if (layout.format.sampleBytes > 1) "little" else "not_applicable",
            "native_width" to layout.width, "native_height" to layout.height,
            "native_row_stride_bytes" to layout.rowStrideBytes, "native_pixel_stride_bytes" to layout.pixelStrideBytes,
            "stored_width" to region.width, "stored_height" to region.height,
            "stored_row_stride_bytes" to region.width * layout.format.sampleBytes,
            "crop" to if (crop == null) null else mapOf("x" to crop.x, "y" to crop.y, "width" to crop.width, "height" to crop.height),
            "precision" to "native_not_quantized",
            "units" to if (layout.format == SampleFormat.DEPTH16_MM) "millimetre" else "arcore_confidence_0_lowest_255_highest",
        )
    }

    /** Confidence companion of a depth image. Exactly one of the states; never a fabricated plane. */
    sealed class Confidence {
        /** A real separate confidence plane retained at native shape/type. */
        class Separate(val plane: Map<String, Any?>) : Confidence()
        /** The source provides no confidence for this depth kind. */
        object NotProvided : Confidence()
        /** The source provides confidence but the frame did not deliver it. */
        object Unavailable : Confidence()
    }

    fun confidenceDescriptor(confidence: Confidence): Map<String, Any?> = when (confidence) {
        is Confidence.Separate -> linkedMapOf<String, Any?>("state" to "separate_image") + confidence.plane
        Confidence.NotProvided -> mapOf("state" to "not_provided_by_source", "plane" to null)
        Confidence.Unavailable -> mapOf("state" to "unavailable_for_frame", "plane" to null)
    }

    /** Native identity of one retained depth observation. Time and clock are the source's own, never remapped here. */
    class Observation(
        val recordingId: String,
        val kind: SourceKind,
        val eventId: Long,
        val nativeTimestampNs: Long,
        val nativeClockId: String,
        val mappedCaptureTimeNs: Long?,
        val associatedSourceFrameId: Long?,
        val calibrationId: String?,
        val depthPlane: Map<String, Any?>,
        val confidence: Confidence,
        val payloadBytes: Int,
    ) {
        init {
            require(eventId >= 0 && nativeTimestampNs > 0 && payloadBytes > 0) { "Invalid depth observation" }
            require(Regex("^[a-z][a-z0-9_]{0,31}(\\.[a-z][a-z0-9_]{0,31}){0,3}$").matches(nativeClockId)) { "Bad clock id" }
        }
    }

    /** PROPOSED depth event metadata. Timestamps and IDs are int64 decimal strings, as in the published contract. */
    fun event(o: Observation): Map<String, Any?> = linkedMapOf(
        "recording_id" to o.recordingId,
        "stream_id" to o.kind.streamId,
        "event_id" to o.eventId.toString(),
        "state" to Availability.OBSERVED.label,
        "source_kind" to o.kind.label,
        "estimate" to true,
        "native_timestamp_ns" to o.nativeTimestampNs.toString(),
        "native_clock_id" to o.nativeClockId,
        "mapped_capture_time_ns" to o.mappedCaptureTimeNs?.toString(),
        "association_source_frame_id" to o.associatedSourceFrameId?.toString(),
        "calibration_id" to o.calibrationId,
        "depth" to o.depthPlane,
        "confidence" to confidenceDescriptor(o.confidence),
        "payload_bytes" to o.payloadBytes,
        "derived_from" to null,
    )

    /** Explicit non-observed stream state (disabled/unsupported/unavailable/unknown). Carries no depth or confidence values. */
    fun streamState(recordingId: String, kind: SourceKind, availability: Availability, reason: String): Map<String, Any?> {
        require(availability != Availability.OBSERVED) { "Observed streams are described by event()" }
        require(Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$").matches(reason)) { "Reason must be a label" }
        return linkedMapOf("recording_id" to recordingId, "stream_id" to kind.streamId, "source_kind" to kind.label,
            "state" to availability.label, "reason" to reason, "observed_count" to null)
    }

    /**
     * Maps requested/supported/enabled/observed facts to one availability. Order matters: "disabled" wins over
     * "unsupported" because an unrequested stream is not a device failure.
     */
    fun availability(requested: Boolean, supported: Boolean?, enabled: Boolean, observedCount: Long): Availability = when {
        !requested -> Availability.DISABLED
        supported == null -> Availability.UNKNOWN
        !supported -> Availability.UNSUPPORTED
        !enabled -> Availability.DISABLED
        observedCount > 0 -> Availability.OBSERVED
        else -> Availability.UNAVAILABLE
    }

    /**
     * Rejects a depth observation whose native timestamp repeats or goes backwards for its stream. This is what stops a
     * slower depth stream from being re-emitted at the RGB cadence: one native depth image yields at most one event.
     */
    class CadenceGuard {
        private val last = HashMap<SourceKind, Long>()
        var rejectedDuplicates = 0L; private set
        var rejectedRegressions = 0L; private set
        fun accept(kind: SourceKind, nativeTimestampNs: Long): Boolean {
            val prev = last[kind]
            if (prev != null && nativeTimestampNs == prev) { rejectedDuplicates++; return false }
            if (prev != null && nativeTimestampNs < prev) { rejectedRegressions++; return false }
            last[kind] = nativeTimestampNs
            return true
        }
    }
}

/** Camera metadata the platform may or may not expose. A missing field is an explicit declaration, never zero. */
object CameraProvenance {
    class Field private constructor(val value: Any?, val reason: String?) {
        companion object {
            fun reported(value: Any) = Field(value, null)
            fun unavailable(reason: String) = Field(null, reason)
        }
        fun toWire(): Map<String, Any?> =
            if (value != null) mapOf("state" to "reported", "value" to value) else mapOf("state" to "unavailable", "reason" to reason)
    }

    class Exposed(
        val exposureTimeNs: Long? = null, val sensitivityIso: Int? = null, val focusDistanceDiopters: Float? = null,
        val frameDurationNs: Long? = null, val rollingShutterSkewNs: Long? = null,
    )

    /** Non-finite floats are not valid JSON numbers; they become an unavailable declaration instead of a fake value. */
    fun metadata(exposed: Exposed, unavailableReason: String = "not_exposed_by_platform"): Map<String, Any?> {
        fun f(v: Number?): Field = when {
            v == null -> Field.unavailable(unavailableReason)
            v is Float && !v.isFinite() -> Field.unavailable("nonfinite_value_from_platform")
            v is Double && !v.isFinite() -> Field.unavailable("nonfinite_value_from_platform")
            else -> Field.reported(v)
        }
        return linkedMapOf(
            "exposure_time_ns" to f(exposed.exposureTimeNs).toWire(),
            "sensitivity_iso" to f(exposed.sensitivityIso).toWire(),
            "focus_distance_diopters" to f(exposed.focusDistanceDiopters).toWire(),
            "frame_duration_ns" to f(exposed.frameDurationNs).toWire(),
            "rolling_shutter_skew_ns" to f(exposed.rollingShutterSkewNs).toWire(),
            // These are statements about what is NOT known; they are not measurements.
            "lens_distortion" to mapOf("state" to "assumption", "model" to "none_assumed", "measured" to false),
            "camera_extrinsics" to mapOf("state" to "assumption", "model" to "unspecified", "measured" to false),
            "confidence_noise" to mapOf("state" to "assumption", "model" to "static_placeholder", "measured" to false),
            "timing_accuracy" to "unverified",
        )
    }
}

/** Optional mesh/point-cloud stream semantics. A snapshot is never presented as an event stream. */
object OptionalGeometry {
    enum class Mode(val label: String) {
        ACTUAL_EVENTS("actual_events"), FINAL_SNAPSHOT("final_snapshot"), UNSUPPORTED("unsupported"), DISABLED("disabled"), UNKNOWN("unknown")
    }

    /** One coordinate as observed: raw IEEE-754 bits are kept and non-finite values are flagged, never replaced or dropped. */
    fun coordinate(v: Float): Map<String, Any?> {
        val flag = when {
            v.isNaN() -> "nan"
            v == Float.POSITIVE_INFINITY -> "positive_infinity"
            v == Float.NEGATIVE_INFINITY -> "negative_infinity"
            else -> null
        }
        return linkedMapOf("bits" to (v.toRawBits().toLong() and 0xFFFFFFFFL), "value" to if (flag == null) v else null, "nonfinite" to flag)
    }

    /** A stream state record; only ACTUAL_EVENTS may claim per-event timing, only FINAL_SNAPSHOT a single end-of-take capture. */
    fun streamState(stream: String, mode: Mode, count: Long?): Map<String, Any?> {
        require(Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$").matches(stream))
        require(count == null || count >= 0)
        if (mode == Mode.UNSUPPORTED || mode == Mode.DISABLED || mode == Mode.UNKNOWN) require(count == null) { "A ${mode.label} stream has no count" }
        return linkedMapOf("stream_id" to stream, "mode" to mode.label, "count" to count?.toString(),
            "per_event_timing" to (mode == Mode.ACTUAL_EVENTS))
    }
}
