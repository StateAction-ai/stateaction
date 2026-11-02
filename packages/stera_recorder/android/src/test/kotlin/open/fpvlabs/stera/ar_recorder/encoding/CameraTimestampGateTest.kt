package open.fpvlabs.stera.ar_recorder.encoding

import open.fpvlabs.stera.ar_recorder.encoding.CameraTimestampGate.Decision
import open.fpvlabs.stera.ar_recorder.encoding.CameraTimestampGate.MetadataAssociation
import org.junit.Assert.*
import org.junit.Test

class CameraTimestampGateTest {
    @Test fun matchingMetadataIsKeptAsSameCaptureEvidence() {
        val decision = CameraTimestampGate().observe(10, 1_000, 0, 1_000) as Decision.Accept
        assertEquals(1_000, decision.cameraNs)
        assertEquals(1_000L, decision.metadataSensorNs)
        assertEquals(MetadataAssociation.MATCHED, decision.metadata)
    }

    /** SA-60 finding: metadata one capture behind the accessor must not abort the take or be reported as this image. */
    @Test fun staleMetadataIsExcludedAndCountedWithoutAborting() {
        val gate = CameraTimestampGate()
        assertTrue(gate.observe(10, 1_000, 0, 1_000) is Decision.Accept)
        val stale = gate.observe(20, 1_033, 1, 1_000) as Decision.Accept
        assertEquals(1_033, stale.cameraNs)
        assertNull(stale.metadataSensorNs)
        assertEquals(MetadataAssociation.STALE, stale.metadata)
        val ahead = gate.observe(30, 1_066, 2, 1_099) as Decision.Accept
        assertNull(ahead.metadataSensorNs)
        assertEquals(1L, gate.staleMetadata)
        assertEquals(1L, gate.aheadMetadata)
    }

    @Test fun metadataIsOnlyUsedWhenTheAccessorIsUnavailable() {
        val decision = CameraTimestampGate().observe(10, 0, 0, 2_000) as Decision.Accept
        assertEquals(2_000, decision.cameraNs)
        assertEquals("frame_metadata_sensor_timestamp", decision.source)
        assertEquals(MetadataAssociation.ONLY_SOURCE, decision.metadata)
    }

    @Test fun frameTimestampIsNeverUsedAsTheCameraClock() {
        val gate = CameraTimestampGate(timeoutNs = 100)
        assertTrue(gate.observe(10, 0, 0, null) is Decision.Wait)
        assertEquals("required_camera_clock_unavailable_timeout", (gate.observe(10, 0, 100, null) as Decision.Reject).reason)
    }

    @Test fun repeatedAndRegressedClocksAreExplicit() {
        val gate = CameraTimestampGate()
        assertTrue(gate.observe(10, 1_000, 0, null) is Decision.Accept)
        assertSame(Decision.Duplicate, gate.observe(10, 1_000, 1, null))
        assertEquals("android_camera_timestamp_regressed", (gate.observe(10, 999, 2, null) as Decision.Reject).reason)
        assertTrue(gate.observe(0, 2_000, 3, null) is Decision.Wait)
    }
}
