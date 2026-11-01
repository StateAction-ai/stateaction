package open.fpvlabs.stera.ar_recorder.geometry

import open.fpvlabs.stera.ar_recorder.coordination.RecordingMetricsState
import org.junit.Assert.*
import org.junit.Test

class CaptureOutcomeTest {
    @Test fun zeroRgbCannotBeSuccessfulAndReportsFirstCaptureFailure() {
        val metrics = RecordingMetricsState()
        metrics.firstRgbCaptureError = "Native image timestamp mismatch"
        assertTrue(metrics.captureFailureReason(0)!!.contains("no RGB frames"))
        assertTrue(metrics.captureFailureReason(0)!!.contains("Native image timestamp mismatch"))
        assertNull(metrics.captureFailureReason(1))
    }

    @Test fun oneGoodFrameDoesNotMaskWriteOrFinalizationFailure() {
        val metrics = RecordingMetricsState()
        assertTrue(metrics.captureFailureReason(1, "disk full")!!.contains("disk full"))
        assertTrue(metrics.captureFailureReason(300, "footer failed")!!.contains("footer failed"))
        assertNull(metrics.captureFailureReason(300))
    }

    @Test fun errorDoesNotLeakIntoTheNextRecording() {
        val metrics = RecordingMetricsState()
        metrics.firstRgbCaptureError = "Old failed capture"
        metrics.reset()
        assertNull(metrics.firstRgbCaptureError)
        assertFalse(metrics.captureFailureReason(0)!!.contains("Old failed capture"))
    }
}
