package open.fpvlabs.stera.ar_recorder.sensors

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RawMotionBufferTest {
    @Test fun eachSensorKeepsItsOwnEventsTimestampsAndIdsWithoutPairing() {
        val buffer = RawMotionBuffer(capacityPerSensor = 64).apply { reset(100); beginSegment() }
        // Unequal schedules: accel every 10 ms, gyro every ~4.7 ms with jitter, interleaved.
        val accel = (0 until 5).map { 1_000_000_000L + it * 10_000_000L }
        val gyro = listOf(1_000_000_001L, 1_004_700_000L, 1_009_100_000L, 1_014_100_123L)
        accel.forEachIndexed { i, ts -> buffer.admit(MotionSensorKind.ACCEL, ts, ts + 500, 3, i.toFloat(), 0f, 9.80665f) }
        gyro.forEachIndexed { i, ts -> buffer.admit(MotionSensorKind.GYRO, ts, ts + 900, 2, 0.01f * i, -0.02f, 0f) }
        val events = buffer.drain()
        val a = events.filter { it.kind == MotionSensorKind.ACCEL }
        val g = events.filter { it.kind == MotionSensorKind.GYRO }
        assertEquals(accel, a.map { it.nativeTimestampNs })
        assertEquals(gyro, g.map { it.nativeTimestampNs })
        assertEquals((0L until 5L).toList(), a.map { it.eventId })
        assertEquals((0L until 4L).toList(), g.map { it.eventId })
        assertEquals(9.80665f, a.last().z)
        assertEquals(-0.02f, g.last().y)
        // No accel event has a gyro timestamp or vice versa: nothing was combined.
        assertTrue(a.none { it.nativeTimestampNs in gyro } && g.none { it.nativeTimestampNs in accel })
        assertEquals(5L, buffer.stats.getValue(MotionSensorKind.ACCEL).delivered.get())
        assertEquals(100.0, buffer.stats.getValue(MotionSensorKind.ACCEL).effectiveRateHz()!!, 1e-9)
    }

    @Test fun saturationOfOneSensorIsCountedOnceAndNeverEvictsOrStarvesTheOther() {
        val reasons = mutableListOf<String>()
        val buffer = RawMotionBuffer(capacityPerSensor = 4) { reasons += it }.apply { reset(100); beginSegment() }
        repeat(7) { buffer.admit(MotionSensorKind.ACCEL, 10L + it, 20L + it, 3, it.toFloat(), 0f, 0f) }
        assertTrue(buffer.admit(MotionSensorKind.GYRO, 11L, 21L, 3, 1f, 2f, 3f))
        val accelStats = buffer.stats.getValue(MotionSensorKind.ACCEL)
        assertEquals(7L, accelStats.delivered.get())
        assertEquals(4L, accelStats.enqueued.get())
        assertEquals(3L, accelStats.droppedQueueFull.get())
        assertEquals(1, reasons.size)
        assertTrue(reasons.single().startsWith(MOTION_QUEUE_SATURATED))
        assertTrue(reasons.single().contains("accel"))
        val drained = buffer.drain()
        // The first admitted events survive; later rejected events leave ID gaps as evidence.
        assertEquals(listOf(0L, 1L, 2L, 3L), drained.filter { it.kind == MotionSensorKind.ACCEL }.map { it.eventId })
        assertEquals(1, drained.count { it.kind == MotionSensorKind.GYRO })
        assertEquals(0L, buffer.stats.getValue(MotionSensorKind.GYRO).droppedQueueFull.get())
        assertEquals(reasons.single(), buffer.saturationReason())
        buffer.reset(100)
        assertNull(buffer.saturationReason())
    }

    @Test fun gapsRatesAndNonIncreasingTimestampsAreMeasuredNotRepaired() {
        val buffer = RawMotionBuffer(capacityPerSensor = 64).apply { reset(100); beginSegment() }
        val ts = listOf(0L, 10_000_000L, 20_000_000L, 55_000_000L, 55_000_000L, 50_000_000L, 65_000_000L)
        ts.forEach { buffer.admit(MotionSensorKind.GYRO, it, it, 3, 0f, 0f, 0f) }
        val stats = buffer.stats.getValue(MotionSensorKind.GYRO).toMap()
        assertEquals(ts, buffer.drain().map { it.nativeTimestampNs })
        assertEquals(2L, stats["non_increasing_timestamps"])
        assertEquals(1L, stats["gaps_over_threshold"])
        assertEquals("35000000", stats["max_interval_ns"])
        assertEquals("20000000", stats["gap_threshold_ns"])
        assertEquals(4L, stats["intervals"])
        assertEquals(4 * 1e9 / 65_000_000L, stats["effective_rate_hz"] as Double, 1e-9)
    }

    @Test fun pauseBoundaryIsNotReportedAsASensorGap() {
        val buffer = RawMotionBuffer().apply { reset(100); beginSegment() }
        buffer.admit(MotionSensorKind.ACCEL, 0L, 0L, 3, 0f, 0f, 0f)
        buffer.admit(MotionSensorKind.ACCEL, 10_000_000L, 10_000_000L, 3, 0f, 0f, 0f)
        buffer.beginSegment()
        buffer.admit(MotionSensorKind.ACCEL, 5_000_000_000L, 5_000_000_000L, 3, 0f, 0f, 0f)
        val stats = buffer.stats.getValue(MotionSensorKind.ACCEL).toMap()
        assertEquals(0L, stats["gaps_over_threshold"])
        assertEquals(2, stats["segments"])
        assertEquals(1L, stats["intervals"])
    }

    @Test fun invalidAccuracyBecomesNullAndUnavailableStatesStayExplicit() {
        val buffer = RawMotionBuffer().apply { reset(100); beginSegment() }
        buffer.admit(MotionSensorKind.ACCEL, 1L, 1L, 7, 0f, 0f, 0f)
        assertNull(buffer.drain().single().accuracy)
        val evidence = RawMotionEvidence.build(
            buffer,
            mapOf(
                MotionSensorKind.ACCEL to MotionSensorAvailability("yes", "yes", null, null),
                MotionSensorKind.GYRO to MotionSensorAvailability("no", "no", "sensor_absent", null),
            ),
            requested = true, stopFailure = null,
        )
        @Suppress("UNCHECKED_CAST") val inventory = evidence["inventory"] as List<Map<String, Any?>>
        val gyro = inventory.single { it["sensor_id"] == "gyro" }
        assertEquals("no", gyro["supported"]); assertEquals("no", gyro["observed"])
        assertEquals("0", gyro["observed_count"]); assertNull(gyro["native_clock_id"])
        assertEquals("sensor_absent", gyro["unavailable_reason"])
        assertNull(evidence["mapped_capture_time"])
        assertEquals("none", evidence["pairing"])
        val uncertain = RawMotionEvidence.build(buffer, emptyMap(), requested = true, stopFailure = "stop barrier timed out")
        @Suppress("UNCHECKED_CAST") val unknown = (uncertain["inventory"] as List<Map<String, Any?>>).first()
        assertEquals("unknown", unknown["observed"]); assertNull(unknown["observed_count"])
        assertEquals("unknown", unknown["supported"])
        assertFalse(uncertain["stop_failure_reason"] == null)
    }
}
