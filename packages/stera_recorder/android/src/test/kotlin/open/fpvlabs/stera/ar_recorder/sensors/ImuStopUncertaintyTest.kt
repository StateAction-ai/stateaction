package open.fpvlabs.stera.ar_recorder.sensors

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Handler
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.mockito.Mockito
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class ImuStopUncertaintyTest {
    @Test fun failedStopRemainsObservableAcrossResumeAndClearsOnlyForNewTake() {
        val context = Mockito.mock(Context::class.java)
        val manager = Mockito.mock(SensorManager::class.java)
        val accel = Mockito.mock(Sensor::class.java)
        val gyro = Mockito.mock(Sensor::class.java)
        Mockito.`when`(context.getSystemService(Context.SENSOR_SERVICE)).thenReturn(manager)
        Mockito.`when`(manager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)).thenReturn(accel)
        Mockito.`when`(manager.getDefaultSensor(Sensor.TYPE_GYROSCOPE)).thenReturn(gyro)
        Mockito.`when`(manager.registerListener(Mockito.any(SensorEventListener::class.java),
            Mockito.any(Sensor::class.java), Mockito.anyInt(), Mockito.any(Handler::class.java))).thenReturn(true)
        var failBarrier = true
        val collector = ImuCollectorImpl(context) {
            if (failBarrier) throw IllegalStateException("injected callback stop barrier timeout")
        }
        try {
            assertTrue(collector.initialize())
            collector.configureRawMotion(true, 100)
            collector.start()
            collector.stop() // Must retain failure without throwing past EOS/close cleanup.
            val failure = collector.getStopFailureReason()
            assertNotNull(failure)
            assertTrue(failure!!.contains("injected callback stop barrier timeout"))
            failBarrier = false
            collector.start() // Resume must not erase the uncertainty from this take.
            collector.stop()
            assertEquals(failure, collector.getStopFailureReason())
            collector.configureRawMotion(true, 100) // A new recording generation resets it.
            assertNull(collector.getStopFailureReason())
            collector.start()
            collector.stop()
            assertNull(collector.getStopFailureReason())
        } finally { collector.release() }
    }
}
