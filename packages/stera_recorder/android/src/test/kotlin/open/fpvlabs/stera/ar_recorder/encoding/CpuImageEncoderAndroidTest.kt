package open.fpvlabs.stera.ar_recorder.encoding

import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.ImageFormat
import android.graphics.Rect
import android.media.Image
import java.nio.ByteBuffer
import org.junit.Assert.*
import org.junit.Test
import org.mockito.Mockito
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class CpuImageEncoderAndroidTest {
    private val nativeTimestamp = 1453692090123456L
    private val frameTimestamp = 1453692090999999L
    private val calibration = mapOf<String, Any>("imageWidth" to 32, "imageHeight" to 16)

    @Test fun staleNativeImageIsRejectedWithEvidenceAndClosed() {
        val source = TestImage(nativeTimestamp - 33_333_333)
        var diagnostics: Map<String, Any?>? = null
        assertThrows(IllegalArgumentException::class.java) {
            CpuImageEncoder().encodeImage(frameTimestamp, nativeTimestamp, { source.image }, calibration, 80) { diagnostics = it }
        }
        assertTrue(source.closed)
        assertEquals("validate_image_geometry", diagnostics?.get("stage"))
        assertEquals(source.timestampNs, diagnostics?.get("image_timestamp_ns"))
        assertEquals(nativeTimestamp, diagnostics?.get("android_camera_timestamp_ns"))
        assertNotNull(diagnostics?.get("error_message"))
    }

    @Test fun truncatedNativePlaneIsRejectedWithEvidenceAndClosed() {
        val source = TestImage(nativeTimestamp, truncateY = true)
        var diagnostics: Map<String, Any?>? = null
        assertThrows(IllegalArgumentException::class.java) {
            CpuImageEncoder().encodeImage(frameTimestamp, nativeTimestamp, { source.image }, calibration, 80) { diagnostics = it }
        }
        assertTrue(source.closed)
        assertEquals("pack_yuv_planes", diagnostics?.get("stage"))
    }

    @Test fun imageCalibrationMismatchKeepsObservedDimensionsAndCloses() {
        val source = TestImage(nativeTimestamp)
        var diagnostics: Map<String, Any?>? = null
        assertThrows(IllegalArgumentException::class.java) {
            CpuImageEncoder().encodeImage(frameTimestamp, nativeTimestamp, { source.image },
                mapOf("imageWidth" to 640, "imageHeight" to 480), 80) { diagnostics = it }
        }
        assertTrue(source.closed)
        assertEquals(32, diagnostics?.get("image_width"))
        assertEquals(16, diagnostics?.get("image_height"))
        assertEquals(listOf(0, 0, 32, 16), diagnostics?.get("crop_rect"))
    }

    private class TestImage(val timestampNs: Long, truncateY: Boolean = false) {
        var closed = false
        val image: Image = Mockito.mock(Image::class.java)
        init {
            val y = ByteArray(3 + 15 * 40 + 32)
            for (row in 0 until 16) for (col in 0 until 32) {
                y[3 + row * 40 + col] = (if (row < 8) { if (col < 16) 25 else 85 } else { if (col < 16) 150 else 220 }).toByte()
            }
            val yBuffer = ByteBuffer.wrap(if (truncateY) y.copyOf(y.size - 1) else y).apply { position(3) }
            val chroma = ByteArray(7 * 34 + 32) { 128.toByte() }
            fun plane(bytes: ByteBuffer, row: Int, pixel: Int): Image.Plane {
                val result = Mockito.mock(Image.Plane::class.java)
                Mockito.`when`(result.buffer).thenReturn(bytes)
                Mockito.`when`(result.rowStride).thenReturn(row)
                Mockito.`when`(result.pixelStride).thenReturn(pixel)
                return result
            }
            val planes = arrayOf(plane(yBuffer, 40, 1),
                plane(ByteBuffer.wrap(chroma).apply { position(1) }, 34, 2),
                plane(ByteBuffer.wrap(chroma), 34, 2))
            Mockito.`when`(image.format).thenReturn(ImageFormat.YUV_420_888)
            Mockito.`when`(image.width).thenReturn(32)
            Mockito.`when`(image.height).thenReturn(16)
            Mockito.`when`(image.timestamp).thenReturn(timestampNs)
            Mockito.`when`(image.planes).thenReturn(planes)
            Mockito.`when`(image.cropRect).thenReturn(Rect(0, 0, 32, 16))
            Mockito.doAnswer { closed = true; null }.`when`(image).close()
        }
    }
}
