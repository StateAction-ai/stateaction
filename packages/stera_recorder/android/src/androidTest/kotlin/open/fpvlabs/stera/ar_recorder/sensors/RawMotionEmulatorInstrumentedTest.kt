package open.fpvlabs.stera.ar_recorder.sensors

import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import open.fpvlabs.stera.ar_recorder.coordination.MotionDrainCoordinator
import open.fpvlabs.stera.ar_recorder.coordination.MotionScheduler
import open.fpvlabs.stera.ar_recorder.data.MCAPDatasetWriter
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * SA-53 simulation path on an emulator: the production collector registers the platform's
 * real (virtual) accelerometer and gyroscope, the independent drain writes through the
 * production MCAP writer while a slow, lossy "video" producer shares the writer thread.
 * Output stays in the test app's files directory for an `adb pull` and offline verifier.
 */
@RunWith(AndroidJUnit4::class)
class RawMotionEmulatorInstrumentedTest {
    @Test fun independentRawEventsSurviveSlowAndDroppedVideoWrites() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val writerThread = HandlerThread("sa53-writer").apply { start() }
        val writerHandler = Handler(writerThread.looper)
        val imu = ImuCollectorImpl(context)
        val writer = MCAPDatasetWriter(context, "emulator", "instrumented")
        val out = File(context.getExternalFilesDir(null) ?: context.filesDir, "sa53").apply { deleteRecursively(); mkdirs() }
        try {
            assertNotNull(writer.createSessionDirectory(out))
            assertTrue(writer.initializeWriters())
            assertTrue("emulator must expose motion sensors", imu.initialize())
            val reasons = mutableListOf<String>()
            imu.configure(DEFAULT_MOTION_RATE_HZ) { synchronized(reasons) { reasons += it } }
            val drain = MotionDrainCoordinator(imu, writer)
            drain.start(object : MotionScheduler {
                override fun postDelayed(task: Runnable, delayMs: Long) = writerHandler.postDelayed(task, delayMs)
                override fun remove(task: Runnable) = writerHandler.removeCallbacks(task)
            })
            imu.start()
            var written = 0; var dropped = 0
            val deadline = System.nanoTime() + 3_000_000_000L
            var frame = 0
            while (System.nanoTime() < deadline) {
                val ts = android.os.SystemClock.elapsedRealtimeNanos()
                if (frame % 3 == 2) dropped++ else {
                    val slow = frame % 5 == 0
                    writerHandler.post {
                        // Visual backpressure: some video writes block the writer for 150 ms.
                        if (slow) Thread.sleep(150)
                        writer.writeCompressedRgbFrame(ts, byteArrayOf(1, 2, 3), ts)
                    }
                    written++
                }
                frame++
                Thread.sleep(33)
            }
            imu.stop()
            drain.stop()
            val barrier = CountDownLatch(1)
            writerHandler.post { drain.flushAll(); barrier.countDown() }
            assertTrue(barrier.await(30, TimeUnit.SECONDS))
            assertNull(imu.getStopFailureReason())
            assertTrue("no saturation expected: $reasons", reasons.isEmpty())
            for (kind in MotionSensorKind.values()) {
                val delivered = imu.deliveredCount(kind)
                assertTrue("$kind delivered no events", delivered > 0)
                assertEquals("$kind: every delivered event must be written", delivered, imu.writtenCount(kind))
            }
            assertEquals(0, imu.getQueueSize())
            val evidence = imu.motionEvidence() + mapOf("video_frames_written" to written, "video_frames_dropped" to dropped)
            val metadataBarrier = CountDownLatch(1)
            writerHandler.post {
                writer.writeMetadata(mapOf("raw_motion" to evidence, "capture_recording_id" to writer.getCaptureRecordingId()))
                writer.finalize()
                metadataBarrier.countDown()
            }
            assertTrue(metadataBarrier.await(30, TimeUnit.SECONDS))
            assertNull(writer.getWriteFailure())
            Log.i("SA53", "raw motion output: ${writer.getSessionDirectory()} evidence=$evidence")
        } finally {
            imu.release()
            writerThread.quitSafely()
        }
    }
}
