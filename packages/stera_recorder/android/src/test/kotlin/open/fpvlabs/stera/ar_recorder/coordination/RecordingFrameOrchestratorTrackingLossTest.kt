package open.fpvlabs.stera.ar_recorder.coordination

import android.graphics.ImageFormat
import android.graphics.Rect
import android.media.Image
import android.os.Handler
import com.google.ar.core.Camera
import com.google.ar.core.Frame
import com.google.ar.core.TrackingFailureReason
import com.google.ar.core.TrackingState
import open.fpvlabs.stera.ar_recorder.RecordingConfig
import open.fpvlabs.stera.ar_recorder.data.DatasetWriter
import open.fpvlabs.stera.ar_recorder.encoding.CpuImageEncoder
import open.fpvlabs.stera.ar_recorder.encoding.FrameSamplerImpl
import open.fpvlabs.stera.ar_recorder.session.ArFrameProcessor
import open.fpvlabs.stera.ar_recorder.session.ArSessionManager
import open.fpvlabs.stera.ar_recorder.session.FrameProcessingPipeline
import java.nio.ByteBuffer
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.mockito.ArgumentCaptor
import org.mockito.ArgumentMatchers
import org.mockito.ArgumentMatchers.anyLong
import org.mockito.ArgumentMatchers.anyString
import org.mockito.Mockito.*
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Drives the real per-frame orchestrator, sampler, CPU JPEG encoder and saved-raster calibration
 * through a TRACKING -> lost -> TRACKING sequence using mocked ARCore frames/cameras.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class RecordingFrameOrchestratorTrackingLossTest {
    @Suppress("UNCHECKED_CAST") private fun <T> anyK(): T { ArgumentMatchers.any<Any>(); return null as T }
    @Suppress("UNCHECKED_CAST") private fun <T> eqK(v: T): T { ArgumentMatchers.eq(v); return v }
    @Suppress("UNCHECKED_CAST")
    private fun captureInfo(c: ArgumentCaptor<Map<*, *>>): Map<String, Any?> { c.capture(); return emptyMap() }
    private val calibration = mapOf<String, Any>(
        "focalLengthX" to 20.0, "focalLengthY" to 21.0, "principalPointX" to 15.5, "principalPointY" to 7.5,
        "imageWidth" to 32, "imageHeight" to 16)

    private fun image(timestampNs: Long): Image {
        val image = mock(Image::class.java)
        val y = ByteArray(3 + 15 * 40 + 32) { (it % 200).toByte() }
        val chroma = ByteArray(7 * 34 + 32) { 128.toByte() }
        fun plane(bytes: ByteArray, row: Int, pixel: Int, offset: Int = 0): Image.Plane {
            val p = mock(Image.Plane::class.java)
            `when`(p.buffer).thenAnswer { ByteBuffer.wrap(bytes).apply { position(offset) } }
            `when`(p.rowStride).thenReturn(row); `when`(p.pixelStride).thenReturn(pixel)
            return p
        }
        `when`(image.format).thenReturn(ImageFormat.YUV_420_888)
        `when`(image.width).thenReturn(32); `when`(image.height).thenReturn(16)
        `when`(image.timestamp).thenReturn(timestampNs)
        `when`(image.cropRect).thenReturn(Rect(0, 0, 32, 16))
        val planes = arrayOf(plane(y, 40, 1, 3), plane(chroma, 34, 2, 1), plane(chroma, 34, 2))
        `when`(image.planes).thenReturn(planes)
        return image
    }

    /** Robolectric cannot JPEG-compress; real YUV->JPEG is covered by CpuImageEncoder tests/instrumentation. */
    private class FakeJpegEncoder : CpuImageEncoder() {
        override fun encode(frame: Frame, intrinsics: Map<String, Any>, quality: Int, previousRgbTimestampNs: Long?,
                            onDiagnostics: (Map<String, Any?>) -> Unit): EncodedImage {
            val ts = frame.timestamp + 3
            require(previousRgbTimestampNs == null || ts > previousRgbTimestampNs)
            return EncodedImage(byteArrayOf(1, 2, 3), ts, 32, 16)
        }
    }

    private fun frame(timestampNs: Long): Frame {
        val f = mock(Frame::class.java)
        `when`(f.timestamp).thenReturn(timestampNs)
        `when`(f.androidCameraTimestamp).thenReturn(timestampNs - 7)
        `when`(f.acquireCameraImage()).thenAnswer { image(timestampNs + 3) }
        return f
    }

    private fun camera(state: TrackingState, reason: TrackingFailureReason): Camera {
        val c = mock(Camera::class.java)
        `when`(c.trackingState).thenReturn(state)
        `when`(c.trackingFailureReason).thenReturn(reason)
        return c
    }

    @Test fun lostTrackingKeepsRgbAndIntrinsicsButExportsNoPoseAndExplainsWhy() {
        val metrics = RecordingMetricsState()
        val sampler = FrameSamplerImpl(15)
        val writer = mock(DatasetWriter::class.java)
        val processor = mock(ArFrameProcessor::class.java)
        val session = mock(ArSessionManager::class.java)
        val health = mock(RuntimeHealthManager::class.java)
        `when`(session.isDepthSupported).thenReturn(false)
        `when`(processor.extractTrackingState(anyK())).thenAnswer {
            if ((it.arguments[0] as Camera).trackingState == TrackingState.TRACKING) "TRACKING" else "PAUSED"
        }
        `when`(processor.extractPose(anyK())).thenReturn(floatArrayOf(1f, 2f, 3f, 0f, 0f, 0f, 1f))
        `when`(processor.extractIntrinsics(anyK())).thenReturn(calibration)
        `when`(processor.getPointCloudPoolAvailableCount()).thenReturn(0)
        val handler = mock(Handler::class.java)
        `when`(handler.post(anyK())).thenAnswer { (it.arguments[0] as Runnable).run(); true }

        val orchestrator = RecordingFrameOrchestrator(metrics, health, FrameProcessingPipeline(),
            FrameProcessingCoordinator(sampler), processor, sampler, writer, session, { _, _ -> }, FakeJpegEncoder())
        orchestrator.channels = RecordingConfig()
        sampler.configure(15)

        val steps = listOf(
            camera(TrackingState.TRACKING, TrackingFailureReason.NONE),
            camera(TrackingState.PAUSED, TrackingFailureReason.INSUFFICIENT_LIGHT),
            camera(TrackingState.PAUSED, TrackingFailureReason.EXCESSIVE_MOTION),
            camera(TrackingState.TRACKING, TrackingFailureReason.NONE))
        steps.forEachIndexed { i, cam ->
            orchestrator.processFrame(frame(1_000_000_000L + i * 100_000_000L), cam, false, handler, 0L) { 0L }
        }

        // RGB saved for every frame, including both lost-tracking frames.
        verify(writer, times(4)).writeCompressedRgbFrame(anyLong(), anyK(), anyLong())
        verify(writer, times(4)).writeIntrinsics(anyLong(), anyK())
        // Pose exported only for the two TRACKING frames: never a stale one during loss.
        verify(writer, times(2)).writePoseRow(anyLong(), anyK(), eqK("TRACKING"))
        verify(writer, never()).writePoseRow(anyLong(), anyK(), eqK("PAUSED"))
        assertEquals(2, metrics.poseFrameCount.get())
        assertEquals(4, metrics.encodedVideoFrameCount.get())
        assertEquals(1, metrics.trackingPauseCount)

        val infoCaptor = ArgumentCaptor.forClass(Map::class.java)
        verify(writer, times(4)).writeCaptureFrameInfo(anyLong(), captureInfo(infoCaptor))
        @Suppress("UNCHECKED_CAST")
        val info = infoCaptor.allValues as List<Map<String, Any?>>
        assertEquals(listOf(true, false, false, true), info.map { it["pose_valid"] })
        assertEquals(listOf(null, "INSUFFICIENT_LIGHT", "EXCESSIVE_MOTION", null), info.map { it["tracking_failure_reason"] })
        assertEquals(listOf(true, true, true, true), info.map { it["rgb_encoded"] })
        // Lost-tracking frame still records the exact saved raster and its calibration.
        assertEquals(32, info[1]["rgb_width"]); assertEquals(16, info[1]["rgb_height"])
        @Suppress("UNCHECKED_CAST") val raster = info[1]["saved_raster"] as Map<String, Any>
        assertEquals(32, raster["saved_width"]); assertEquals(true, raster["is_identity"])
        @Suppress("UNCHECKED_CAST") val k = info[1]["rgb_intrinsics"] as Map<String, Any>
        assertEquals(20.0, k["focalLengthX"]); assertEquals(15.5, k["principalPointX"])
        assertEquals(false, info[1]["cross_stream_clock_verified"])
    }
}
