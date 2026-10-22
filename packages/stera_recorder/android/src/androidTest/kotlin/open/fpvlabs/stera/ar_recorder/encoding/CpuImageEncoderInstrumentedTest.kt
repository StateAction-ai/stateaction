package open.fpvlabs.stera.ar_recorder.encoding

import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.ImageFormat
import android.graphics.Rect
import android.media.Image
import java.nio.ByteBuffer
import java.io.File
import open.fpvlabs.stera.ar_recorder.data.MCAPDatasetWriter
import open.fpvlabs.stera.ar_recorder.geometry.CaptureGeometry
import open.fpvlabs.stera.ar_recorder.session.DepthFrameData
import org.junit.Assert.*
import org.junit.Test
import org.mockito.Mockito
import org.junit.runner.RunWith
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry

@RunWith(AndroidJUnit4::class)
class CpuImageEncoderInstrumentedTest {
    private val nativeTimestamp = 1453692090123456L
    private val frameTimestamp = 1453692090999999L
    private val calibration = mapOf<String, Any>("imageWidth" to 32, "imageHeight" to 16)

    @Test fun actualAndroidJpegEncoderAcceptsSeparateArcoreClockAndPreservesPixels() {
        val source = TestImage(nativeTimestamp)
        var diagnostics: Map<String, Any?>? = null
        val encoded = CpuImageEncoder().encodeImage(frameTimestamp, nativeTimestamp, { source.image }, calibration, 95) {
            diagnostics = it
        }
        assertTrue(source.closed)
        assertEquals(nativeTimestamp, encoded.timestampNs)
        assertEquals("complete", diagnostics?.get("stage"))
        assertTrue(encoded.jpeg.size > 100)
        val bitmap = BitmapFactory.decodeByteArray(encoded.jpeg, 0, encoded.jpeg.size)
        assertNotNull(bitmap)
        assertEquals(32, bitmap.width); assertEquals(16, bitmap.height)
        // Asymmetric source: a flipped, cropped, or mis-strided image fails this ordering.
        val tl = Color.red(bitmap.getPixel(4, 3))
        val tr = Color.red(bitmap.getPixel(25, 3))
        val bl = Color.red(bitmap.getPixel(4, 12))
        val br = Color.red(bitmap.getPixel(25, 12))
        assertTrue("Pixel orientation/stride mismatch: $tl,$tr,$bl,$br", tl < tr && tr < bl && bl < br)
        bitmap.recycle()
    }

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

    @Test fun actualAndroidEncoderAndMcapWriterExportCrossClockFixture() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val writer = MCAPDatasetWriter(context, "synthetic_android_fixture", "35")
        val directory = writer.createSessionDirectory(File(context.filesDir, "geometry-fixtures"))!!
        assertTrue(writer.initializeWriters())
        val rgbK = mapOf<String, Any>("imageWidth" to 32, "imageHeight" to 16,
            "focalLengthX" to 30.0, "focalLengthY" to 30.0,
            "principalPointX" to 15.5, "principalPointY" to 7.5)
        val mapping = CaptureGeometry.rgbToDepthMatrix(32, 16, 8, 4,
            floatArrayOf(0f, 0f, 1f, 0f, 0f, 1f, 1f, 1f))
        val depthK = CaptureGeometry.depthIntrinsics(rgbK, 8, 4, mapping)
        var releasedDepth = 0
        try {
            for (index in 0..2) {
                val eventTime = frameTimestamp + index * 33_333_333L
                val cameraTime = nativeTimestamp + index * 33_333_333L
                val depthTime = nativeTimestamp - 10_000_000L // repeated native time; distinct frame associations
                val source = TestImage(cameraTime)
                val encoded = CpuImageEncoder().encodeImage(eventTime, cameraTime, { source.image }, rgbK, 95)
                assertTrue(source.closed)
                writer.writeIntrinsics(cameraTime, rgbK)
                writer.writePoseRow(eventTime, floatArrayOf(index * 0.01f, 0f, 0f, 0f, 0f, 0f, 1f), "TRACKING")
                writer.writeCompressedRgbFrame(cameraTime, encoded.jpeg, eventTime)
                val depthBytes = ByteArray(8 * 4 * 2)
                for (pixel in 0 until 32) {
                    val depthMm = 700 + index * 10 + pixel
                    depthBytes[pixel * 2] = (depthMm and 255).toByte()
                    depthBytes[pixel * 2 + 1] = (depthMm ushr 8).toByte()
                }
                writer.writeDepthIntrinsics(depthTime, depthK)
                assertTrue(writer.writeDepthFrame(depthTime,
                    DepthFrameData(depthBytes, depthBytes.size, depthTime, 8, 4, 2, 2, 16,
                        release = { releasedDepth++ }), eventTime))
                writer.writeCaptureFrameInfo(eventTime, mapOf(
                    "capture_geometry_version" to CaptureGeometry.VERSION,
                    "frame_timestamp_ns" to eventTime, "android_camera_timestamp_ns" to cameraTime,
                    "rgb_timestamp_ns" to cameraTime, "depth_timestamp_ns" to depthTime,
                    "cross_stream_clock_verified" to false, "tracking_state" to "TRACKING",
                    "rgb_encoded" to true, "depth_available" to true,
                    "rgb_width" to 32, "rgb_height" to 16, "depth_width" to 8, "depth_height" to 4,
                    "rgb_intrinsics" to rgbK, "depth_intrinsics" to depthK,
                    "rgb_pixel_to_depth_pixel" to mapping.toList()))
            }
            writer.writeMetadata(mapOf("capture_geometry_version" to CaptureGeometry.VERSION,
                "capture_geometry" to CaptureGeometry.metadata(), "capture_result_valid" to true,
                "device_model" to "synthetic_android_fixture", "android_version" to "35",
                "session_start_timestamp_ns" to frameTimestamp, "rgb_written_count" to 3))
            assertEquals(3, writer.getRecordingStats()["rgbFrameCount"])
        } finally { writer.finalize() }
        assertEquals(3, releasedDepth)
        assertTrue(directory.listFiles()!!.any { it.extension == "mcap" && it.length() > 0 })
        android.util.Log.i("SteraCaptureFixture", directory.absolutePath)
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
