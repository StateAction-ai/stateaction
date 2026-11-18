package open.fpvlabs.stera.ar_recorder.geometry

import org.junit.Assert.*
import org.junit.Test

class H264CalibrationTest {
    private fun k(w: Int = 1920, h: Int = 1080, fx: Double = 1500.0, cx: Double = 960.5) = mapOf<String, Any>(
        "focalLengthX" to fx, "focalLengthY" to 1498.0, "principalPointX" to cx, "principalPointY" to 540.25,
        "imageWidth" to w, "imageHeight" to h)

    @Test fun matchingSourceAndEncodedRasterIsRecordedAsActualCalibrationWithKAndP() {
        val c = H264Calibration(1920, 1080)
        assertNull(c.observe(0, 1920, 1080, k()))
        assertNull(c.observe(1, 1920, 1080, k()))
        assertEquals("yes", c.inventoryState)
        val report = c.report(1920, 1080)
        assertEquals(true, report["encoded_dimensions_match_saved_raster"])
        assertEquals(2L, report["accepted_frames"])
        @Suppress("UNCHECKED_CAST") val rev = (report["revisions"] as List<Map<String, Any?>>).single()
        assertEquals(k(), rev["source_intrinsics"])
        assertEquals(listOf(1500.0, 0.0, 960.5, 0.0, 1498.0, 540.25, 0.0, 0.0, 1.0), rev["K_3x3_row_major"])
        assertEquals(listOf(1500.0, 0.0, 960.5, 0.0, 0.0, 1498.0, 540.25, 0.0, 0.0, 0.0, 1.0, 0.0), rev["P_3x4_row_major"])
    }

    @Test fun requestedDimensionsAreNotReportedAsActualEncodedDimensions() {
        val c = H264Calibration(1920, 1080)
        c.observe(0, 1920, 1080, k())
        val none = c.report(null, null)
        assertNull(none["encoded_width"]); assertEquals(false, none["encoded_dimensions_match_saved_raster"])
        assertEquals(1920, none["requested_encoder_width"])
        assertEquals(false, c.report(1280, 720)["encoded_dimensions_match_saved_raster"])
    }

    @Test fun impossibleMappingsAreRejectedAndNeverCalibrated() {
        val c = H264Calibration(1920, 1080)
        assertTrue(c.observe(0, 1280, 720, k(1280, 720))!!.contains("does not map"))   // would need a resize
        assertTrue(c.observe(1, 1920, 1080, k(1280, 720))!!.contains("does not describe"))  // K for another raster
        assertTrue(c.observe(2, 1920, 1080, null)!!.contains("unavailable"))
        assertEquals("no", c.inventoryState)
        assertEquals(3L, c.report(null, null)["rejected_frames"])
        assertNotNull(c.firstRejection)
    }

    @Test fun changedIntrinsicsAreNotClaimedAsOneVerifiedCalibration() {
        val c = H264Calibration(1920, 1080)
        c.observe(0, 1920, 1080, k()); c.observe(1, 1920, 1080, k(fx = 1510.0))
        assertEquals("unknown", c.inventoryState)
        assertEquals(1L, c.report(1920, 1080)["calibration_changes"])
        assertEquals(2, (c.report(1920, 1080)["revisions"] as List<*>).size)
    }

    @Test fun capCountersCountChangesNotFramesAndStayBounded() {
        val c = H264Calibration(1920, 1080)
        // 8 distinct stored revisions (7 changes), then 10 identical frames at a 9th value: one change, one overflow.
        for (i in 0 until 8) c.observe(i.toLong(), 1920, 1080, k(fx = 1500.0 + i))
        for (i in 8 until 18) c.observe(i.toLong(), 1920, 1080, k(fx = 1600.0))
        var r = c.report(1920, 1080)
        assertEquals(8, (r["revisions"] as List<*>).size)
        assertEquals(8L, r["calibration_changes"]); assertEquals(1L, r["revisions_not_stored"])
        assertEquals(18L, r["accepted_frames"])
        // Oscillation between two unstored values counts each real change, not each frame.
        for (i in 18 until 30) c.observe(i.toLong(), 1920, 1080, k(fx = if (i % 2 == 0) 1700.0 else 1600.0))
        r = c.report(1920, 1080)
        assertEquals(8, (r["revisions"] as List<*>).size)
        assertEquals(8L + 12L, r["calibration_changes"]); assertEquals(1L + 12L, r["revisions_not_stored"])
        assertEquals("unknown", c.inventoryState)
        // Repeating the same unstored value adds nothing.
        c.observe(30, 1920, 1080, k(fx = 1600.0)); c.observe(31, 1920, 1080, k(fx = 1600.0))
        assertEquals(8L + 12L, c.report(1920, 1080)["calibration_changes"])
    }

    @Test fun noFramesMeansUnavailableNotYes() {
        assertEquals("unavailable", H264Calibration(1920, 1080).inventoryState)
    }
}
