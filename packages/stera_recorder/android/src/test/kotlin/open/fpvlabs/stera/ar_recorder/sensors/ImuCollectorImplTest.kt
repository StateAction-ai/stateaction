package open.fpvlabs.stera.ar_recorder.sensors

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Handler
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.mockito.Mockito
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.SensorEventBuilder

/** Platform callbacks into the real collector; sensors are Mockito doubles of the framework. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class ImuCollectorImplTest {
    private val context: Context = Mockito.mock(Context::class.java)
    private val manager: SensorManager = Mockito.mock(SensorManager::class.java)
    private val accel: Sensor = Mockito.mock(Sensor::class.java)
    private val gyro: Sensor = Mockito.mock(Sensor::class.java)
    private var now = 0L
    private val collectors = mutableListOf<ImuCollectorImpl>()

    private fun collector(withGyro: Boolean = true, capacity: Int = DEFAULT_MOTION_QUEUE_CAPACITY,
                          barrier: ((Handler?) -> Unit)? = null): ImuCollectorImpl {
        Mockito.`when`(context.getSystemService(Context.SENSOR_SERVICE)).thenReturn(manager)
        Mockito.`when`(manager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)).thenReturn(accel)
        Mockito.`when`(manager.getDefaultSensor(Sensor.TYPE_GYROSCOPE)).thenReturn(if (withGyro) gyro else null)
        Mockito.`when`(accel.name).thenReturn("Virtual accel")
        Mockito.`when`(gyro.name).thenReturn("Virtual gyro")
        Mockito.`when`(manager.registerListener(Mockito.any(SensorEventListener::class.java), Mockito.any(Sensor::class.java),
            Mockito.anyInt(), Mockito.anyInt(), Mockito.any(Handler::class.java))).thenReturn(true)
        return ImuCollectorImpl(context, capacity, { now }, barrier).also { collectors += it }
    }

    @After fun release() = collectors.forEach { it.release() }

    private fun event(sensor: Sensor, timestampNs: Long, accuracy: Int, vararg values: Float): SensorEvent =
        SensorEventBuilder.newBuilder().setSensor(sensor).setTimestamp(timestampNs).setAccuracy(accuracy)
            .setValues(values).build()

    @Test fun registersEachSensorIndependentlyAt100HzWithoutBatching() {
        val imu = collector()
        imu.initialize(); imu.configure(); imu.start()
        Mockito.verify(manager).registerListener(Mockito.eq(imu), Mockito.eq(accel), Mockito.eq(10_000), Mockito.eq(0), Mockito.any(Handler::class.java))
        Mockito.verify(manager).registerListener(Mockito.eq(imu), Mockito.eq(gyro), Mockito.eq(10_000), Mockito.eq(0), Mockito.any(Handler::class.java))
    }

    @Test fun everyCallbackBecomesOneRawEventWithItsOriginalTimestampAndValues() {
        val imu = collector()
        imu.initialize(); imu.configure(); imu.start()
        // Gyro reports first and twice as often; under the old pairing, each callback carried
        // the other sensor's latest values. Here each event carries only its own reading.
        now = 2_000_000_000L
        imu.onSensorChanged(event(gyro, 1_000_000_000L, 3, 0.1f, 0.2f, 0.3f))
        imu.onSensorChanged(event(accel, 1_000_400_000L, 2, 0.5f, -0.25f, 9.80665f))
        imu.onSensorChanged(event(gyro, 1_005_000_000L, 3, 0.4f, 0.5f, 0.6f))
        imu.onSensorChanged(event(gyro, 1_010_000_000L, 3, 0.7f, 0.8f, 0.9f))
        imu.onSensorChanged(event(accel, 1_010_400_000L, 2, 1.5f, -1.25f, 9.5f))
        val events = imu.drainMotion()
        assertEquals(5, events.size)
        val a = events.filter { it.kind == MotionSensorKind.ACCEL }
        val g = events.filter { it.kind == MotionSensorKind.GYRO }
        assertEquals(listOf(1_000_400_000L, 1_010_400_000L), a.map { it.nativeTimestampNs })
        assertEquals(listOf(1_000_000_000L, 1_005_000_000L, 1_010_000_000L), g.map { it.nativeTimestampNs })
        assertEquals(listOf(0.5f, -0.25f, 9.80665f), listOf(a[0].x, a[0].y, a[0].z))
        assertEquals(listOf(0.7f, 0.8f, 0.9f), listOf(g[2].x, g[2].y, g[2].z))
        assertEquals(listOf(2, 2), a.map { it.accuracy })
        assertTrue(events.all { it.callbackElapsedNs == 2_000_000_000L })
        assertEquals(2L, imu.deliveredCount(MotionSensorKind.ACCEL))
        assertEquals(3L, imu.deliveredCount(MotionSensorKind.GYRO))
        @Suppress("UNCHECKED_CAST")
        val sensors = imu.motionEvidence()["sensors"] as Map<String, Map<String, Any?>>
        assertEquals(100, sensors.getValue("gyro")["requested_rate_hz"])
        assertEquals(200.0, sensors.getValue("gyro")["effective_rate_hz"] as Double, 1e-9)
        assertEquals("Virtual accel", (sensors.getValue("accel")["hardware"] as Map<*, *>)["name"])
    }

    @Test fun eventsOutsideRecordingOrFromOtherSensorsAreNotAdmitted() {
        val imu = collector()
        imu.initialize(); imu.configure()
        imu.onSensorChanged(event(accel, 1L, 3, 0f, 0f, 0f)) // before start
        imu.start()
        imu.onSensorChanged(event(Mockito.mock(Sensor::class.java), 2L, 3, 0f, 0f, 0f))
        imu.stop()
        imu.onSensorChanged(event(gyro, 3L, 3, 0f, 0f, 0f)) // after stop barrier
        assertTrue(imu.drainMotion().isEmpty())
        assertEquals(0L, imu.getCallbackCount())
    }

    @Test fun missingGyroIsExplicitlyUnavailableWhileAccelStillRecords() {
        val imu = collector(withGyro = false)
        assertTrue(imu.initialize())
        imu.configure(); imu.start()
        imu.onSensorChanged(event(accel, 5L, 3, 1f, 2f, 3f))
        imu.stop()
        @Suppress("UNCHECKED_CAST")
        val inventory = imu.motionEvidence()["inventory"] as List<Map<String, Any?>>
        val g = inventory.single { it["sensor_id"] == "gyro" }
        val a = inventory.single { it["sensor_id"] == "accel" }
        assertEquals(listOf("yes", "no", "no", "no", "0", "sensor_absent"),
            listOf(g["requested"], g["supported"], g["enabled"], g["observed"], g["observed_count"], g["unavailable_reason"]))
        assertEquals(listOf("yes", "yes", "yes", "1", MOTION_NATIVE_CLOCK_ID),
            listOf(a["supported"], a["enabled"], a["observed"], a["observed_count"], a["native_clock_id"]))
    }

    @Test fun failedRegistrationIsReportedNotHidden() {
        val imu = collector()
        Mockito.`when`(manager.registerListener(Mockito.any(SensorEventListener::class.java), Mockito.eq(gyro),
            Mockito.anyInt(), Mockito.anyInt(), Mockito.any(Handler::class.java))).thenReturn(false)
        imu.initialize(); imu.configure(); imu.start()
        @Suppress("UNCHECKED_CAST")
        val g = (imu.motionEvidence()["inventory"] as List<Map<String, Any?>>).single { it["sensor_id"] == "gyro" }
        assertEquals("no", g["enabled"]); assertEquals("register_listener_failed", g["unavailable_reason"])
    }

    @Test fun saturationReportsAReasonOnceWithExactCounts() {
        val reasons = mutableListOf<String>()
        val imu = collector(capacity = 3)
        imu.initialize(); imu.configure(100) { reasons += it }; imu.start()
        repeat(5) { imu.onSensorChanged(event(accel, 100L + it, 3, 0f, 0f, 0f)) }
        imu.onSensorChanged(event(gyro, 200L, 3, 0f, 0f, 0f))
        assertEquals(1, reasons.size)
        assertEquals(reasons.single(), imu.getSaturationReason())
        @Suppress("UNCHECKED_CAST")
        val accelStats = (imu.motionEvidence()["sensors"] as Map<String, Map<String, Any?>>).getValue("accel")
        assertEquals(5L, accelStats["delivered"]); assertEquals(3L, accelStats["enqueued"])
        assertEquals(2L, (accelStats["dropped"] as Map<*, *>)["queue_full"])
        assertEquals(4, imu.drainMotion().size)
    }

    @Test fun failedStopRemainsObservableAcrossResumeAndClearsOnlyForNewRecording() {
        var failBarrier = true
        val imu = collector(barrier = { if (failBarrier) throw IllegalStateException("injected stop barrier timeout") })
        imu.initialize(); imu.configure(); imu.start()
        imu.stop()
        val failure = imu.getStopFailureReason()
        assertNotNull(failure)
        assertTrue(failure!!.contains("injected stop barrier timeout"))
        @Suppress("UNCHECKED_CAST")
        val inventory = imu.motionEvidence()["inventory"] as List<Map<String, Any?>>
        assertTrue(inventory.all { it["observed"] == "unknown" && it["observed_count"] == null })
        failBarrier = false
        imu.start(); imu.stop()
        assertEquals(failure, imu.getStopFailureReason())
        imu.configure()
        assertNull(imu.getStopFailureReason())
    }
}
