package open.fpvlabs.stera.ar_recorder.encoding

import open.fpvlabs.stera.ar_recorder.encoding.CameraTimestampGate.Decision
import open.fpvlabs.stera.ar_recorder.encoding.CpuImageIdentityPolicy.Verdict
import org.junit.Assert.*
import org.junit.Test

/**
 * Drives the same gate -> accepted.cameraNs -> identity policy sequence H264RecordingController.capture uses.
 * Physical hardware identity stays unqualified; this covers the decision seam only.
 */
class CpuImageIdentityPolicyTest {
    private fun verdict(simulation: Boolean, frameNs: Long, accessorNs: Long, imageNs: Long): Verdict {
        val accepted = CameraTimestampGate().observe(frameNs, accessorNs, 0, null) as Decision.Accept
        return CpuImageIdentityPolicy.evaluate(simulation, imageNs, accepted.cameraNs)
    }

    /** The old predicate (imageNs == Frame.timestamp) would have rejected this valid hardware frame. */
    @Test fun cameraClockEqualsImageWithDifferentFrameTimestampIsAccepted() {
        assertNotEquals(7_777L, 5_000L) // Frame.timestamp (undefined base) differs from image/camera clock
        assertEquals(Verdict.IDENTICAL, verdict(false, frameNs = 7_777, accessorNs = 5_000, imageNs = 5_000))
    }

    /** The old predicate would have accepted this: image matches Frame.timestamp but not the written RGB clock. */
    @Test fun frameTimestampEqualsImageButCameraClockDiffersIsRejected() {
        assertEquals(Verdict.MISMATCH_REJECTED, verdict(false, frameNs = 7_777, accessorNs = 5_000, imageNs = 7_777))
    }

    @Test fun genuineMismatchIsRejectedOnHardware() {
        assertEquals(Verdict.MISMATCH_REJECTED, verdict(false, frameNs = 7_777, accessorNs = 5_000, imageNs = 4_967))
    }

    @Test fun simulationMismatchIsRecordedNotSilentlyAccepted() {
        assertEquals(Verdict.MISMATCH_RECORDED_SIMULATION, verdict(true, frameNs = 7_777, accessorNs = 5_000, imageNs = 4_967))
        assertEquals(Verdict.IDENTICAL, verdict(true, frameNs = 7_777, accessorNs = 5_000, imageNs = 5_000))
    }
}
