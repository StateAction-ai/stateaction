package open.fpvlabs.stera.ar_recorder.geometry

import org.junit.Assert.*
import org.junit.Test

class SavedRasterTest {
    private val k = mapOf<String, Any>(
        "focalLengthX" to 500.0, "focalLengthY" to 510.0,
        "principalPointX" to 318.0, "principalPointY" to 237.0,
        "imageWidth" to 640, "imageHeight" to 480
    )

    private fun Map<String, Any>.d(key: String) = (getValue(key) as Number).toDouble()

    @Test fun identityKeepsCalibrationExactly() {
        val raster = SavedRaster.identity(640, 480)
        assertTrue(raster.isIdentity)
        val out = raster.intrinsics(k)
        for (key in listOf("focalLengthX", "focalLengthY", "principalPointX", "principalPointY"))
            assertEquals(key, k.d(key), out.d(key), 1e-12)
        assertEquals(640, out["imageWidth"]); assertEquals(480, out["imageHeight"])
    }

    @Test fun halfResizeScalesFocalAndShiftsPrincipalPointByCentreConvention() {
        val raster = SavedRaster(640, 480, scaledWidth = 320, scaledHeight = 240)
        val out = raster.intrinsics(k)
        assertEquals(250.0, out.d("focalLengthX"), 1e-9)
        assertEquals(255.0, out.d("focalLengthY"), 1e-9)
        assertEquals((318 + 0.5) * 0.5 - 0.5, out.d("principalPointX"), 1e-9)
        assertEquals((237 + 0.5) * 0.5 - 0.5, out.d("principalPointY"), 1e-9)
        assertEquals(320, out["imageWidth"]); assertEquals(240, out["imageHeight"])
    }

    @Test fun centreCropShiftsPrincipalPointAndKeepsFocal() {
        val raster = SavedRaster(640, 480, cropLeft = 80, cropTop = 60, cropWidth = 480, cropHeight = 360,
            scaledWidth = 480, scaledHeight = 360)
        val out = raster.intrinsics(k)
        assertEquals(500.0, out.d("focalLengthX"), 1e-9)
        assertEquals(238.0, out.d("principalPointX"), 1e-9)
        assertEquals(177.0, out.d("principalPointY"), 1e-9)
        assertEquals(480, out["imageWidth"]); assertEquals(360, out["imageHeight"])
    }

    @Test fun quarterTurnSwapsDimensionsButHasNoCanonicalIntrinsics() {
        val raster = SavedRaster(640, 480, rotationCwDegrees = 90)
        assertEquals(480, raster.savedWidth); assertEquals(640, raster.savedHeight)
        assertThrows(IllegalArgumentException::class.java) { raster.intrinsics(k) }
        // a source corner lands on the matching saved corner
        assertArrayEquals(doubleArrayOf(479.0, 0.0), raster.mapPoint(0.0, 0.0), 1e-9)
        assertArrayEquals(doubleArrayOf(0.0, 639.0), raster.mapPoint(639.0, 479.0), 1e-9)
    }

    @Test fun mirrorAndRotate270AreInvertibleBijectionsOnPixelGrid() {
        for ((rot, mirror) in listOf(0 to true, 90 to false, 180 to false, 270 to false, 270 to true, 180 to true)) {
            val raster = SavedRaster(8, 6, scaledWidth = 8, scaledHeight = 6, rotationCwDegrees = rot, mirrorHorizontal = mirror)
            val seen = HashSet<Pair<Int, Int>>()
            for (y in 0 until 6) for (x in 0 until 8) {
                val p = raster.mapPoint(x.toDouble(), y.toDouble())
                val sx = Math.round(p[0]).toInt(); val sy = Math.round(p[1]).toInt()
                assertEquals(p[0], sx.toDouble(), 1e-9); assertEquals(p[1], sy.toDouble(), 1e-9)
                assertTrue("$rot/$mirror ($x,$y)->($sx,$sy)", sx in 0 until raster.savedWidth && sy in 0 until raster.savedHeight)
                assertTrue(seen.add(sx to sy))
            }
            assertEquals(48, seen.size)
        }
    }

    @Test fun mirrorPixelMapFlipsXButCanonicalIntrinsicsAreRefused() {
        val raster = SavedRaster(640, 480, mirrorHorizontal = true)
        assertArrayEquals(doubleArrayOf(639.0 - 318.0, 237.0), raster.mapPoint(318.0, 237.0), 1e-9)
        assertThrows(IllegalArgumentException::class.java) { raster.intrinsics(k) }
        assertThrows(IllegalArgumentException::class.java) { SavedRaster(640, 480, rotationCwDegrees = 180).intrinsics(k) }
    }

    @Test fun calibrationForAnotherRasterIsRejected() {
        assertThrows(IllegalArgumentException::class.java) { SavedRaster.identity(1280, 720).intrinsics(k) }
        assertThrows(IllegalArgumentException::class.java) { SavedRaster.identity(640, 480).intrinsics(k - "focalLengthX") }
        assertThrows(IllegalArgumentException::class.java) { SavedRaster(640, 480, cropLeft = 600, cropWidth = 100) }
        assertThrows(IllegalArgumentException::class.java) { SavedRaster(640, 480, rotationCwDegrees = 45) }
    }

    @Test fun evidenceMapRecordsEveryStepOfTheChain() {
        val map = SavedRaster(640, 480, scaledWidth = 320, scaledHeight = 240, rotationCwDegrees = 90).toMap()
        assertEquals(240, map["saved_width"]); assertEquals(320, map["saved_height"])
        assertEquals("crop,resize,rotate_cw,mirror_horizontal", map["operation_order"])
        assertEquals(false, map["is_identity"])
        assertEquals(9, (map["source_to_saved_3x3_row_major"] as List<*>).size)
    }
}
