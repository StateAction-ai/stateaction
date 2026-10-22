package open.fpvlabs.stera.ar_recorder.geometry

import org.junit.Assert.*
import org.junit.Test

class CaptureGeometryTest {
    @Test fun opticalForwardMapsToNegativeCameraZAndOpticalDownToNegativeCameraY() {
        val q = CaptureGeometry.opticalToCameraQuaternion
        fun rotate(v: DoubleArray): DoubleArray {
            val u = q.copyOfRange(0, 3)
            val dot = u.indices.sumOf { u[it] * v[it] }
            val norm = u.sumOf { it * it }
            val cross = doubleArrayOf(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0])
            return DoubleArray(3) { 2 * dot * u[it] + (q[3] * q[3] - norm) * v[it] + 2 * q[3] * cross[it] }
        }
        assertArrayEquals(doubleArrayOf(1.0, 0.0, 0.0), rotate(doubleArrayOf(1.0, 0.0, 0.0)), 1e-12)
        assertArrayEquals(doubleArrayOf(0.0, -1.0, 0.0), rotate(doubleArrayOf(0.0, 1.0, 0.0)), 1e-12)
        assertArrayEquals(doubleArrayOf(0.0, 0.0, -1.0), rotate(doubleArrayOf(0.0, 0.0, 1.0)), 1e-12)
    }

    @Test fun depthCropPreservesCameraRaysWithShiftedPrincipalPoint() {
        // A 640x480 CPU image mapped to a 160x90 center crop: y=0 maps outside depth.
        val h = CaptureGeometry.rgbToDepthMatrix(640, 480, 160, 90,
            floatArrayOf(0f, -1f/6f, 1f, -1f/6f, 0f, 7f/6f, 1f, 7f/6f))
        val rgb = mapOf<String, Any>("imageWidth" to 640, "imageHeight" to 480,
            "focalLengthX" to 500.0, "focalLengthY" to 510.0,
            "principalPointX" to 318.0, "principalPointY" to 237.0)
        val depth = CaptureGeometry.depthIntrinsics(rgb, 160, 90, h)
        assertEquals(125.0, depth["focalLengthX"] as Double, 1e-5)
        assertEquals(127.5, depth["focalLengthY"] as Double, 1e-5)
        assertEquals(79.5, depth["principalPointX"] as Double, 1e-5)
        assertEquals(44.25, depth["principalPointY"] as Double, 1e-5)
        val u = 410.0; val v = 301.0
        assertEquals((u - 318) / 500, (h[0] * u + h[2] - depth["principalPointX"] as Double) / (depth["focalLengthX"] as Double), 1e-8)
        assertEquals((v - 237) / 510, (h[4] * v + h[5] - depth["principalPointY"] as Double) / (depth["focalLengthY"] as Double), 1e-8)
    }

    @Test(expected = IllegalArgumentException::class)
    fun reflectedDepthMappingIsRejected() {
        CaptureGeometry.rgbToDepthMatrix(640, 480, 160, 120, floatArrayOf(1f, 1f, 0f, 1f, 1f, 0f, 0f, 0f))
    }

    @Test(expected = IllegalArgumentException::class)
    fun mismatchedImageCalibrationIsRejected() {
        CaptureGeometry.requireRgbContract(1280, 720, 1920, 1080, 1_000_000L, 1_000_000L, 1_000_000L)
    }

    @Test(expected = IllegalArgumentException::class)
    fun imageTimestampMustMatchAndroidCameraTimestamp() {
        CaptureGeometry.requireRgbContract(640, 480, 640, 480, 1_000_000L, 2_000_000L, 1_000_001L)
    }

    @Test fun separateArcoreClockIsAcceptedOnlyWithExactNativeCameraMatch() {
        CaptureGeometry.requireRgbContract(640, 480, 640, 480, 1_000_000L, 9_999_999L, 1_000_000L)
    }

    @Test fun validRgbContractAndMetadataAreExplicit() {
        CaptureGeometry.requireRgbContract(640, 480, 640, 480, 1_000_000L, 1_000_000L, 1_000_000L)
        assertEquals("native_cpu_unrotated", CaptureGeometry.metadata()["rgb_orientation"])
        assertEquals(false, CaptureGeometry.metadata()["rgb_resize_crop_applied"])
    }
}
