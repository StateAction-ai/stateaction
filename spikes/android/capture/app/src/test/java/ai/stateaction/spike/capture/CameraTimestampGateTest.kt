package ai.stateaction.spike.capture

import org.junit.Assert.*
import org.junit.Test

class CameraTimestampGateTest {
    @Test fun reproducesPhysicalZeroTimestampWithoutCrashingAtFirstFrame() {
        val gate=CameraTimestampGate()
        // Observed failure: positive ARCore Frame, missing Android camera time.
        val first=gate.observe(123_456_789L,0L,1_000_000_000L)
        assertEquals(CameraTimestampGate.Decision.Wait("android_camera_timestamp_unavailable"),first)
        assertEquals(CameraTimestampGate.Decision.Wait("android_camera_timestamp_unavailable"),gate.observe(156_790_122L,0L,2_056_000_000L))
    }
    @Test fun missingNativeClockTimesOutWithoutInventedMapping() {
        val gate=CameraTimestampGate(5_000L)
        gate.observe(200L,0L,100L)
        assertEquals(CameraTimestampGate.Decision.Reject("required_camera_clock_unavailable_timeout"),gate.observe(300L,0L,5_100L))
    }
    @Test fun validSourceAfterWarmupKeepsExactNativeValue() {
        val gate=CameraTimestampGate()
        gate.observe(0L,0L,100L)
        gate.observe(1_000_000_000L,0L,200L)
        val source=9_000_000_123_456_789L
        assertEquals(CameraTimestampGate.Decision.Accept(source),gate.observe(33L,source,300L))
        assertEquals(CameraTimestampGate.Decision.Duplicate,gate.observe(34L,source,400L))
        assertEquals(CameraTimestampGate.Decision.Accept(source+1L),gate.observe(35L,source+1L,500L))
    }
    @Test fun regressionIsDistinctFromOptionalAbsence() {
        val gate=CameraTimestampGate()
        gate.observe(1L,1000L,100L)
        assertEquals(CameraTimestampGate.Decision.Reject("android_camera_timestamp_regressed"),gate.observe(2L,999L,200L))
    }
    @Test fun eachSessionResetsItsOwnClockHistory() {
        val first=CameraTimestampGate(); first.observe(1L,1000L,100L)
        assertEquals(CameraTimestampGate.Decision.Accept(5L),CameraTimestampGate().observe(1L,5L,101L))
    }
    @Test fun missingOptionalAndroidAccessorUsesAssociatedSensorMetadata() {
        val gate=CameraTimestampGate()
        val source=596_496_703_000L
        assertEquals(CameraTimestampGate.Decision.Accept(source,"frame_metadata_sensor_timestamp"),gate.observe(596_976_904_406L,0L,700_000_000_000L,source))
        // CPU Image.timestamp is deliberately absent from this API: emulator proved
        // it may differ from the HAL sensor clock despite a same-frame association.
    }
    @Test fun differentCameraClockEvidenceIsRejectedInsteadOfNearestMatch() {
        val gate=CameraTimestampGate()
        assertEquals(CameraTimestampGate.Decision.Reject("camera_metadata_timestamp_disagreement"),gate.observe(596_976_904_406L,596_496_703_000L,700_000_000_000L,596_496_703_001L))
    }
}
