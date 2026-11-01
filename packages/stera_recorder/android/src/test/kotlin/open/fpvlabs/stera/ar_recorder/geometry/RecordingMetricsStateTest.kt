package open.fpvlabs.stera.ar_recorder.geometry

import open.fpvlabs.stera.ar_recorder.coordination.RecordingMetricsState
import org.junit.Assert.*
import org.junit.Test

class RecordingMetricsStateTest {
    @Test fun repeatedRenderUpdatesDoNotBecomeNewCameraFrames() {
        val metrics = RecordingMetricsState()
        assertTrue(metrics.observeArcoreFrame(100L))
        repeat(99) { assertFalse(metrics.observeArcoreFrame(100L)) }
        assertTrue(metrics.observeArcoreFrame(101L))
        assertEquals(101L, metrics.recordingFrameLoopCount)
        assertEquals(99L, metrics.repeatedArcoreFrameCount)
        assertEquals(2, metrics.arcoreFrameCount.get())
        assertEquals(2, metrics.globalArFrameIndex)
    }

    @Test fun observedAllAttemptFailureReportsOneHundredPercentNotRenderLoopRatio() {
        val metrics = RecordingMetricsState()
        metrics.recordingFrameLoopCount = 13506
        metrics.globalArFrameIndex = 579
        metrics.rgbEncodeAttemptCount = 291
        metrics.rgbEncoderFailureCount = 291
        assertEquals(1.0, metrics.encoderFailureRate(), 0.0)
        metrics.rgbEncoderFailureCount = 1
        assertEquals(1.0 / 291.0, metrics.encoderFailureRate(), 1e-12)
        metrics.lastCapturedRgbTimestampNs = 1467836033014624L
        metrics.reset(defaultFps = 15)
        assertEquals(0.0, metrics.encoderFailureRate(), 0.0)
        assertNull(metrics.lastCapturedRgbTimestampNs)
        assertEquals(0L, metrics.recordingFrameLoopCount)
        assertEquals(0L, metrics.repeatedArcoreFrameCount)
        assertEquals("deterministic_15fps_sampling", metrics.dynamicEncoderMode)
        assertEquals(15, metrics.targetEncodeFps)
    }
}
