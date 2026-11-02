package open.fpvlabs.stera.ar_recorder.coordination

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Handler
import java.io.File
import open.fpvlabs.stera.ar_recorder.data.MCAPDatasetWriter
import open.fpvlabs.stera.ar_recorder.data.McapReader
import open.fpvlabs.stera.ar_recorder.sensors.ImuCollectorImpl
import open.fpvlabs.stera.ar_recorder.sensors.MOTION_QUEUE_SATURATED
import open.fpvlabs.stera.ar_recorder.sensors.MotionSensorKind
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.mockito.Mockito
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.shadows.SensorEventBuilder

/**
 * The recorder's motion lifecycle (start, pause/resume, saturation stop, stop barrier)
 * with the production collector, drain coordinator, MCAP writer and failure classification.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class MotionCaptureControllerTest {
    @get:Rule val temporary = TemporaryFolder()

    private class ManualScheduler : MotionScheduler {
        val tasks = mutableListOf<Runnable>()
        override fun postDelayed(task: Runnable, delayMs: Long): Boolean { tasks += task; return true }
        override fun remove(task: Runnable) { tasks.removeAll { it === task } }
        fun tick() { val pending = tasks.toList(); tasks.clear(); pending.forEach { it.run() } }
    }

    private inner class Rig(capacity: Int, barrier: ((Handler?) -> Unit)? = {}, threadEnds: () -> Boolean = { true }) {
        val accel: Sensor = Mockito.mock(Sensor::class.java)
        val gyro: Sensor = Mockito.mock(Sensor::class.java)
        val imu: ImuCollectorImpl
        val writer = MCAPDatasetWriter(RuntimeEnvironment.getApplication(), "test", "35")
        val scheduler = ManualScheduler()
        val mainQueue = mutableListOf<Runnable>()
        val writerQueue = mutableListOf<Runnable>()
        var halted = 0
        val controller: MotionCaptureController

        init {
            val context = Mockito.mock(Context::class.java)
            val manager = Mockito.mock(SensorManager::class.java)
            Mockito.`when`(context.getSystemService(Context.SENSOR_SERVICE)).thenReturn(manager)
            Mockito.`when`(manager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)).thenReturn(accel)
            Mockito.`when`(manager.getDefaultSensor(Sensor.TYPE_GYROSCOPE)).thenReturn(gyro)
            Mockito.`when`(manager.registerListener(Mockito.any(SensorEventListener::class.java), Mockito.any(Sensor::class.java),
                Mockito.anyInt(), Mockito.anyInt(), Mockito.any(Handler::class.java))).thenReturn(true)
            imu = ImuCollectorImpl(context, capacity, { 9_000_000_000L }, barrier, { threadEnds() })
            assertTrue(imu.initialize())
            writer.createSessionDirectory(temporary.newFolder())
            assertTrue(writer.initializeWriters())
            val drain = MotionDrainCoordinator(imu, writer)
            controller = MotionCaptureController(imu, writer, drain,
                postToMain = { mainQueue += it }, postToWriter = { writerQueue += it; true }, haltCapture = { halted++ })
        }

        fun deliver(sensor: Sensor, ts: Long) = imu.onSensorChanged(SensorEventBuilder.newBuilder().setSensor(sensor)
            .setTimestamp(ts).setAccuracy(3).setValues(floatArrayOf(1f, 2f, 3f)).build())

        fun runMain() { val pending = mainQueue.toList(); mainQueue.clear(); pending.forEach { it.run() } }
        fun runWriter() { val pending = writerQueue.toList(); writerQueue.clear(); pending.forEach { it.run() } }

        /** The same order as ArRecorderImpl.stopRecording: stop, then the writer barrier tail. */
        fun stop(): File {
            controller.stopCollection()
            runWriter()
            controller.finishOnWriter()
            writer.finalize()
            return File(writer.getSessionDirectory()!!).listFiles()!!.single { it.name.endsWith(".mcap") }
        }

        fun ids(mcap: File, kind: MotionSensorKind): List<Long> = McapReader.read(mcap.readBytes()).messages(kind.topic)
            .map { JSONObject(String(it.data, Charsets.UTF_8)).getString("event_id").toLong() }
    }

    @Test fun saturationStopsCaptureWithAReasonRefusesResumeAndFailsTheRecording() {
        val rig = Rig(capacity = 8)
        rig.controller.start(rig.scheduler)
        // The writer is stalled (no ticks) while 12 accel events arrive.
        repeat(12) { rig.deliver(rig.accel, 1_000_000_000L + it * 10_000_000L) }
        assertEquals(1, rig.mainQueue.size)
        rig.runMain()
        val reason = rig.controller.stopReason
        assertNotNull(reason)
        assertTrue(reason!!.startsWith(MOTION_QUEUE_SATURATED))
        assertEquals(1, rig.halted)
        // Capture is halted: later sensor callbacks are not admitted and resume is refused.
        rig.deliver(rig.accel, 2_000_000_000L)
        rig.deliver(rig.gyro, 2_000_000_001L)
        assertEquals(12L, rig.imu.deliveredCount(MotionSensorKind.ACCEL))
        assertEquals(0L, rig.imu.deliveredCount(MotionSensorKind.GYRO))
        assertEquals(reason, rig.controller.resume(rig.scheduler))
        val mcap = rig.stop()
        val failure = rig.writer.getWriteFailure()
        assertNotNull(failure)
        assertTrue(failure!!.startsWith(MOTION_QUEUE_SATURATED))
        val classified = RecordingMetricsState().captureFailureReason(1, failure)
        assertTrue(classified!!.contains(MOTION_QUEUE_SATURATED))
        // Every admitted event was still written; rejected ones are counted, not invented.
        assertEquals((0L until 8L).toList(), rig.ids(mcap, MotionSensorKind.ACCEL))
        @Suppress("UNCHECKED_CAST")
        val accel = (rig.imu.motionEvidence()["sensors"] as Map<String, Map<String, Any?>>).getValue("accel")
        assertEquals(12L, accel["delivered"]); assertEquals(8L, accel["written"])
        assertEquals(4L, (accel["dropped"] as Map<*, *>)["queue_full"])
    }

    @Test fun uncertainImuStopCannotFinalizeAsSuccess() {
        val rig = Rig(capacity = 64, barrier = { throw IllegalStateException("injected callback barrier timeout") })
        rig.controller.start(rig.scheduler)
        rig.deliver(rig.gyro, 5L)
        val mcap = rig.stop()
        val failure = rig.writer.getWriteFailure()
        assertTrue(failure!!.contains("IMU stop completion is uncertain"))
        assertTrue(RecordingMetricsState().captureFailureReason(1, failure) != null)
        assertEquals(listOf(0L), rig.ids(mcap, MotionSensorKind.GYRO))
    }

    @Test fun uncertainPauseRefusesResumeAndTheNextRecordingCannotReuseTheOldProducer() {
        var failBarrier = true
        var threadEnded = false
        val rig = Rig(capacity = 64,
            barrier = { if (failBarrier) throw IllegalStateException("injected pause barrier timeout") },
            threadEnds = { threadEnded })
        rig.controller.start(rig.scheduler)
        rig.deliver(rig.accel, 10_000_000L)
        rig.controller.pause()()
        failBarrier = false
        rig.deliver(rig.accel, 20_000_000L) // a late callback after the uncertain pause
        val refused = rig.controller.resume(rig.scheduler)
        assertNotNull(refused)
        assertTrue(refused!!.contains("injected pause barrier timeout"))
        rig.deliver(rig.accel, 30_000_000L)
        val mcap = rig.stop()
        assertTrue(rig.writer.getWriteFailure()!!.contains("IMU stop completion is uncertain"))
        assertEquals(listOf(0L), rig.ids(mcap, MotionSensorKind.ACCEL))
        // Next recording: the old sensor thread has not provably ended, so start is refused
        // and nothing is admitted into a new source.
        val next = MCAPDatasetWriter(RuntimeEnvironment.getApplication(), "test", "35")
        next.createSessionDirectory(temporary.newFolder()); assertTrue(next.initializeWriters())
        val nextController = MotionCaptureController(rig.imu, next, MotionDrainCoordinator(rig.imu, next),
            postToMain = { it.run() }, postToWriter = { it.run(); true }, haltCapture = {})
        assertThrows(IllegalStateException::class.java) { nextController.start(rig.scheduler) }
        rig.deliver(rig.accel, 40_000_000L)
        assertEquals(0, rig.imu.drainMotion().size)
        // Once it provably ended, a fresh producer starts a clean recording.
        threadEnded = true
        nextController.start(rig.scheduler)
        rig.deliver(rig.accel, 50_000_000L)
        nextController.stopCollection(); nextController.finishOnWriter(); next.finalize()
        assertNull(next.getWriteFailure())
        val nextMcap = File(next.getSessionDirectory()!!).listFiles()!!.single { it.name.endsWith(".mcap") }
        val events = McapReader.read(nextMcap.readBytes()).messages(MotionSensorKind.ACCEL.topic)
            .map { JSONObject(String(it.data, Charsets.UTF_8)) }
        assertEquals(listOf("0"), events.map { it.getString("event_id") })
        assertEquals(listOf("50000000"), events.map { it.getString("native_timestamp_ns") })
    }

    @Test fun pauseFlushesBeforeWritersPauseAndResumeContinuesTheSameRecording() {
        val rig = Rig(capacity = 64)
        rig.controller.start(rig.scheduler)
        rig.deliver(rig.accel, 10_000_000L)
        rig.deliver(rig.gyro, 10_500_000L)
        val tail = rig.controller.pause()
        tail()
        rig.writer.pauseWriters()
        rig.deliver(rig.accel, 20_000_000L) // after pause: not admitted
        rig.writer.resumeWriters()
        assertNull(rig.controller.resume(rig.scheduler))
        rig.deliver(rig.accel, 5_010_000_000L)
        rig.scheduler.tick()
        val mcap = rig.stop()
        assertNull(rig.writer.getWriteFailure())
        assertEquals(listOf(0L, 1L), rig.ids(mcap, MotionSensorKind.ACCEL))
        assertEquals(listOf(0L), rig.ids(mcap, MotionSensorKind.GYRO))
        @Suppress("UNCHECKED_CAST")
        val accel = (rig.imu.motionEvidence()["sensors"] as Map<String, Map<String, Any?>>).getValue("accel")
        assertEquals(0L, accel["gaps_over_threshold"]) // the pause is a segment boundary, not a gap
        assertEquals(0L, (accel["dropped"] as Map<*, *>)["writer_paused"])
    }

    @Test fun cleanStopWritesEverythingWithoutFailure() {
        val rig = Rig(capacity = 64)
        rig.controller.start(rig.scheduler)
        repeat(5) { rig.deliver(rig.accel, 100L + it * 10_000_000L); rig.deliver(rig.gyro, 200L + it * 5_000_000L) }
        val mcap = rig.stop()
        assertNull(rig.writer.getWriteFailure())
        assertNull(rig.controller.stopReason)
        assertEquals(5, rig.ids(mcap, MotionSensorKind.ACCEL).size)
        assertEquals(5, rig.ids(mcap, MotionSensorKind.GYRO).size)
    }
}
