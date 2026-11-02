package open.fpvlabs.stera.ar_recorder.data

import open.fpvlabs.stera.ar_recorder.data.DepthEvidenceTestSupport.depth16
import open.fpvlabs.stera.ar_recorder.data.h264.CameraProvenance
import open.fpvlabs.stera.ar_recorder.data.h264.CaptureProtocol
import open.fpvlabs.stera.ar_recorder.data.h264.DepthEvidence
import open.fpvlabs.stera.ar_recorder.data.h264.DepthEvidence.Availability
import open.fpvlabs.stera.ar_recorder.data.h264.DepthEvidence.Confidence
import open.fpvlabs.stera.ar_recorder.data.h264.DepthEvidence.Crop
import open.fpvlabs.stera.ar_recorder.data.h264.DepthEvidence.PlaneLayout
import open.fpvlabs.stera.ar_recorder.data.h264.DepthEvidence.SampleFormat
import open.fpvlabs.stera.ar_recorder.data.h264.DepthEvidence.SourceKind
import open.fpvlabs.stera.ar_recorder.data.h264.OptionalGeometry
import org.junit.Assert.*
import org.junit.Test
import java.nio.ByteBuffer

object DepthEvidenceTestSupport {
    /** Little-endian uint16 samples with row padding of 0xEE bytes so stride bugs show up as wrong values. */
    fun depth16(w: Int, h: Int, rowStride: Int, value: (Int, Int) -> Int): ByteBuffer {
        val b = ByteArray(rowStride * h) { 0xEE.toByte() }
        for (y in 0 until h) for (x in 0 until w) {
            val v = value(x, y)
            b[y * rowStride + x * 2] = (v and 0xFF).toByte(); b[y * rowStride + x * 2 + 1] = (v shr 8).toByte()
        }
        return ByteBuffer.wrap(b)
    }
}

class DepthEvidenceTest {
    private val rec = "0b6f5e1c-3d2a-4c8e-9f1a-5e2d7c4b3a19"
    private fun layout(w: Int = 4, h: Int = 3, stride: Int = 12) = PlaneLayout(w, h, stride, 2, SampleFormat.DEPTH16_MM)

    @Test fun strideIsRemovedAndEverySampleByteIsPreserved() {
        // Includes 0xFFFF and the 13-bit boundary: nothing may be clamped or rescaled.
        val src = depth16(4, 3, 12) { x, y -> if (x == 3 && y == 2) 0xFFFF else 8191 - x * 1000 - y }
        val out = DepthEvidence.copyPlane(src, layout())
        assertEquals(4 * 3 * 2, out.size)
        assertTrue("padding bytes must not leak", out.none { it == 0xEE.toByte() })
        assertEquals(0xFF.toByte(), out[out.size - 1]); assertEquals(0xFF.toByte(), out[out.size - 2])
        assertEquals((8191 and 0xFF).toByte(), out[0]); assertEquals((8191 shr 8).toByte(), out[1])
    }

    @Test fun cropCopiesOnlyTheRegionAndDescriptorSaysSo() {
        val src = depth16(4, 3, 12) { x, y -> y * 100 + x }
        val crop = Crop(1, 1, 2, 2)
        val out = DepthEvidence.copyPlane(src, layout(), crop)
        val values = (0 until 4).map { (out[it * 2].toInt() and 0xFF) or ((out[it * 2 + 1].toInt() and 0xFF) shl 8) }
        assertEquals(listOf(101, 102, 201, 202), values)
        val d = DepthEvidence.planeDescriptor(layout(), crop)
        assertEquals(mapOf("x" to 1, "y" to 1, "width" to 2, "height" to 2), d["crop"])
        assertEquals(4, d["stored_row_stride_bytes"]); assertEquals(12, d["native_row_stride_bytes"])
        assertEquals("native_not_quantized", d["precision"]); assertEquals("millimetre", d["units"])
        assertNull(DepthEvidence.planeDescriptor(layout(), null)["crop"])
    }

    @Test fun pixelStrideLargerThanSampleIsHonoured() {
        val b = ByteBuffer.wrap(byteArrayOf(1, 0, 9, 9, 2, 0, 9, 9))
        val out = DepthEvidence.copyPlane(b, PlaneLayout(2, 1, 8, 4, SampleFormat.DEPTH16_MM))
        assertArrayEquals(byteArrayOf(1, 0, 2, 0), out)
    }

    @Test fun copyDoesNotDisturbSourceBufferAndRejectsBadGeometry() {
        val src = depth16(4, 3, 12) { _, _ -> 5 }
        src.position(7)
        DepthEvidence.copyPlane(src, layout())
        assertEquals(7, src.position()); assertEquals(36, src.limit())
        src.limit(20) // a truncated visible region is rejected rather than read past its limit
        assertThrows(IllegalArgumentException::class.java) { DepthEvidence.copyPlane(src, layout()) }
        assertEquals(7, src.position()); assertEquals(20, src.limit())
        assertThrows(IllegalArgumentException::class.java) { DepthEvidence.copyPlane(src, layout(), Crop(3, 0, 2, 1)) }
        assertThrows(IllegalArgumentException::class.java) { DepthEvidence.copyPlane(ByteBuffer.allocate(10), layout()) }
        assertThrows(IllegalArgumentException::class.java) { PlaneLayout(4, 3, 7, 2, SampleFormat.DEPTH16_MM) }
    }

    @Test fun confidencePlaneKeepsNativeUint8ShapeAndIsNeverZeroFilled() {
        val conf = ByteBuffer.wrap(byteArrayOf(0, 7, 0, 0, 255.toByte(), 3, 0, 0))   // 2x2, row stride 4
        val cl = PlaneLayout(2, 2, 4, 1, SampleFormat.CONFIDENCE_U8)
        assertArrayEquals(byteArrayOf(0, 7, 255.toByte(), 3), DepthEvidence.copyPlane(conf, cl))
        val sep = DepthEvidence.confidenceDescriptor(Confidence.Separate(DepthEvidence.planeDescriptor(cl, null)))
        assertEquals("separate_image", sep["state"]); assertEquals("uint8", sep["format"])
        val none = DepthEvidence.confidenceDescriptor(Confidence.NotProvided)
        assertEquals("not_provided_by_source", none["state"]); assertNull(none["plane"])
        assertEquals("unavailable_for_frame", DepthEvidence.confidenceDescriptor(Confidence.Unavailable)["state"])
    }

    private fun obs(kind: SourceKind, conf: Confidence, frame: Long? = 7) = DepthEvidence.Observation(
        rec, kind, 3, 123_456_789_012L, "android.camera.sensor_timestamp", null, frame, "rgb_arcore_image_intrinsics",
        DepthEvidence.planeDescriptor(layout(), null), conf, 24)

    @Test fun rawAndDenseDepthAreDistinctSourceKindsAndStreams() {
        val raw = DepthEvidence.event(obs(SourceKind.ARCORE_RAW_DEPTH_ESTIMATED, Confidence.Unavailable))
        val dense = DepthEvidence.event(obs(SourceKind.ARCORE_DENSE_DEPTH_ESTIMATED, Confidence.NotProvided))
        assertEquals("arcore_raw_depth_estimated", raw["source_kind"]); assertEquals("depth_raw", raw["stream_id"])
        assertEquals("arcore_dense_depth_estimated", dense["source_kind"]); assertEquals("depth_dense", dense["stream_id"])
        assertEquals(true, raw["estimate"]); assertNotEquals(raw["stream_id"], dense["stream_id"])
    }

    @Test fun eventKeepsOriginalClockSourceAssociationAndNullsForUnknownMappingAndFrame() {
        val e = DepthEvidence.event(obs(SourceKind.ARCORE_RAW_DEPTH_ESTIMATED, Confidence.Unavailable, frame = null))
        assertEquals("123456789012", e["native_timestamp_ns"]); assertEquals("android.camera.sensor_timestamp", e["native_clock_id"])
        assertNull(e["mapped_capture_time_ns"]); assertNull(e["association_source_frame_id"]); assertNull(e["derived_from"])
        // The payload must serialize with the recorder's strict JSON writer (no NaN, no numbers for int64 IDs).
        val json = CaptureProtocol.json(e)
        assertTrue(json.contains("\"native_timestamp_ns\":\"123456789012\""))
        assertTrue(json.contains("\"association_source_frame_id\":null"))
    }

    @Test fun availabilityStatesAreExplicitAndNotFabricated() {
        assertEquals(Availability.DISABLED, DepthEvidence.availability(false, true, true, 5))
        assertEquals(Availability.UNKNOWN, DepthEvidence.availability(true, null, true, 0))
        assertEquals(Availability.UNSUPPORTED, DepthEvidence.availability(true, false, false, 0))
        assertEquals(Availability.DISABLED, DepthEvidence.availability(true, true, false, 0))
        assertEquals(Availability.UNAVAILABLE, DepthEvidence.availability(true, true, true, 0))
        assertEquals(Availability.OBSERVED, DepthEvidence.availability(true, true, true, 1))
        val s = DepthEvidence.streamState(rec, SourceKind.ARCORE_RAW_DEPTH_ESTIMATED, Availability.UNSUPPORTED, "device_reports_unsupported")
        assertNull(s["observed_count"]); assertFalse(s.containsKey("depth")); assertFalse(s.containsKey("confidence"))
        assertThrows(IllegalArgumentException::class.java) { DepthEvidence.streamState(rec, SourceKind.ARCORE_RAW_DEPTH_ESTIMATED, Availability.OBSERVED, "x") }
        assertThrows(IllegalArgumentException::class.java) { DepthEvidence.streamState(rec, SourceKind.ARCORE_RAW_DEPTH_ESTIMATED, Availability.UNKNOWN, "has space") }
    }

    @Test fun lowRateDepthIsNeverDuplicatedToAFasterCadence() {
        val g = DepthEvidence.CadenceGuard()
        // RGB at 30 Hz would offer the same depth image 3 times; only the first is accepted.
        assertTrue(g.accept(SourceKind.ARCORE_RAW_DEPTH_ESTIMATED, 1_000))
        assertFalse(g.accept(SourceKind.ARCORE_RAW_DEPTH_ESTIMATED, 1_000))
        assertFalse(g.accept(SourceKind.ARCORE_RAW_DEPTH_ESTIMATED, 1_000))
        assertFalse(g.accept(SourceKind.ARCORE_RAW_DEPTH_ESTIMATED, 900))
        assertTrue(g.accept(SourceKind.ARCORE_RAW_DEPTH_ESTIMATED, 1_100))
        assertEquals(2, g.rejectedDuplicates); assertEquals(1, g.rejectedRegressions)
        // The same timestamp on the other depth kind is independent evidence.
        assertTrue(g.accept(SourceKind.ARCORE_DENSE_DEPTH_ESTIMATED, 1_100))
    }

    @Test fun cameraMetadataDeclaresUnavailableInsteadOfZero() {
        val m = CameraProvenance.metadata(CameraProvenance.Exposed(exposureTimeNs = 8_000_000L, focusDistanceDiopters = Float.NaN))
        @Suppress("UNCHECKED_CAST") fun f(k: String) = m[k] as Map<String, Any?>
        assertEquals(mapOf("state" to "reported", "value" to 8_000_000L), f("exposure_time_ns"))
        assertEquals("unavailable", f("sensitivity_iso")["state"]); assertFalse(f("sensitivity_iso").containsKey("value"))
        assertEquals("nonfinite_value_from_platform", f("focus_distance_diopters")["reason"])
        assertEquals("not_exposed_by_platform", f("rolling_shutter_skew_ns")["reason"])
        for (k in listOf("lens_distortion", "camera_extrinsics", "confidence_noise")) {
            assertEquals("assumption", f(k)["state"]); assertEquals(false, f(k)["measured"])
        }
        assertEquals("unverified", m["timing_accuracy"])
        CaptureProtocol.json(m) // must be valid strict JSON
    }

    @Test fun nonfiniteGeometryObservationsAreKeptWithFlags() {
        val nan = OptionalGeometry.coordinate(Float.NaN)
        assertEquals("nan", nan["nonfinite"]); assertNull(nan["value"]); assertEquals(0x7fc00000L, nan["bits"])
        assertEquals("positive_infinity", OptionalGeometry.coordinate(Float.POSITIVE_INFINITY)["nonfinite"])
        assertEquals("negative_infinity", OptionalGeometry.coordinate(Float.NEGATIVE_INFINITY)["nonfinite"])
        val ok = OptionalGeometry.coordinate(1.5f)
        assertNull(ok["nonfinite"]); assertEquals(1.5f, ok["value"]); assertEquals(0x3fc00000L, ok["bits"])
        CaptureProtocol.json(nan)
    }

    @Test fun meshAndPointCloudModesDistinguishEventsSnapshotsAndUnsupported() {
        val ev = OptionalGeometry.streamState("point_cloud", OptionalGeometry.Mode.ACTUAL_EVENTS, 12)
        val snap = OptionalGeometry.streamState("mesh", OptionalGeometry.Mode.FINAL_SNAPSHOT, 1)
        val uns = OptionalGeometry.streamState("mesh", OptionalGeometry.Mode.UNSUPPORTED, null)
        assertEquals(true, ev["per_event_timing"]); assertEquals(false, snap["per_event_timing"]); assertEquals(false, uns["per_event_timing"])
        assertNull(uns["count"]); assertEquals("12", ev["count"])
        assertThrows(IllegalArgumentException::class.java) { OptionalGeometry.streamState("mesh", OptionalGeometry.Mode.UNSUPPORTED, 0) }
    }

    @Test fun inventoryDeclaresDepthExplicitlyForEachCapabilityWithoutObservedCounts() {
        fun depth(requested: Boolean, supported: Boolean): Map<String, Any?> {
            val plan = open.fpvlabs.stera.ar_recorder.data.h264.H264Evidence.SensorPlan(
                open.fpvlabs.stera.ar_recorder.data.h264.H264Evidence.CAMERA_CLOCK, true, true, true, requested, supported)
            val (sensors, _) = open.fpvlabs.stera.ar_recorder.data.h264.H264Evidence.inventory(plan, 10, 5, 5)
            return sensors.single { it["sensor_id"] == "depth" }
        }
        val disabled = depth(false, true); val unsupported = depth(true, false); val unrecorded = depth(true, true)
        assertEquals("no", disabled["requested"]); assertNull(disabled["unavailable_reason"])
        assertEquals("device_reports_unsupported", unsupported["unavailable_reason"])
        assertEquals("depth_payload_not_in_contract_revision", unrecorded["unavailable_reason"])
        for (d in listOf(disabled, unsupported, unrecorded)) {
            assertEquals("no", d["enabled"]); assertEquals("no", d["observed"]); assertNull(d["observed_count"]); assertNull(d["native_clock_id"])
        }
    }
}
