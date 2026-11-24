package open.fpvlabs.stera.ar_recorder.encoding

import android.graphics.ImageFormat
import android.media.ImageReader
import android.media.ImageWriter
import android.os.Bundle
import android.os.Debug
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.nio.ByteBuffer
import java.util.concurrent.locks.LockSupport

@RunWith(AndroidJUnit4::class)
class H264EncoderThroughputInstrumentedTest {
    @Test fun simulationEncoderKeepsUpWithNominal30FpsFeed() {
        assertTrue("Software encoder test requires the guarded emulator", H264RgbEncoder.isEmulator())
        val profile = H264EncoderProfile.SIMULATION
        val encodedPts = mutableListOf<Long>()
        val acceptedPts = mutableListOf<Long>()
        var lastSubmissionElapsedNs = 0L
        val encoder = H264RgbEncoder(profile) { encodedPts.add(it.ptsUs) }
        try {
            ImageReader.newInstance(profile.width, profile.height, ImageFormat.YUV_420_888, 2).use { reader ->
                ImageWriter.newInstance(reader.surface, 1).use { writer ->
                    writer.dequeueInputImage().use { source ->
                        for ((index, plane) in source.planes.withIndex()) {
                            val data = plane.buffer
                            val offset = data.position()
                            val width = if (index == 0) profile.width else profile.width / 2
                            val height = if (index == 0) profile.height else profile.height / 2
                            val rowStride = plane.rowStride
                            val pixelStride = plane.pixelStride
                            for (row in 0 until height) {
                                for (col in 0 until width) {
                                    val value = if (index == 0) 16 + (row + col) % 220 else 128
                                    data.put(offset + row * rowStride + col * pixelStride, value.toByte())
                                }
                            }
                        }
                        val luma = source.planes[0].buffer
                        val rowStride = source.planes[0].rowStride
                        val offset = luma.position()
                        val started = SystemClock.elapsedRealtimeNanos()
                        for (frame in 0 until FRAME_COUNT) {
                            val captureNs = frame * 1_000_000_000L / profile.fps
                            while (true) {
                                val remainingNs = started + captureNs - SystemClock.elapsedRealtimeNanos()
                                if (remainingNs <= 0) break
                                LockSupport.parkNanos(remainingNs)
                            }
                            // Move one scanline's luma each frame to submit distinct images.
                            luma.put(offset + (frame % profile.height) * rowStride, 235.toByte())
                            val ptsUs = captureNs / 1_000L
                            val slotEnd = started + (frame + 1) * 1_000_000_000L / profile.fps
                            val waitUs = (slotEnd - SystemClock.elapsedRealtimeNanos()) / 1_000L
                            if (waitUs > 0 && encoder.submit(source, ptsUs, waitUs) {}) acceptedPts.add(ptsUs)
                        }
                        lastSubmissionElapsedNs = SystemClock.elapsedRealtimeNanos() - started
                        val lastScheduledNs = (FRAME_COUNT - 1) * 1_000_000_000L / profile.fps
                        assertTrue("30 fps feed accumulated ${(lastSubmissionElapsedNs - lastScheduledNs) / 1e6} ms of delay",
                            lastSubmissionElapsedNs <= lastScheduledNs + MAX_SCHEDULE_LAG_NS)
                    }
                }
            }
            encoder.finish()
            assertTrue("Only ${acceptedPts.size}/$FRAME_COUNT inputs were accepted",
                acceptedPts.size >= FRAME_COUNT - MAX_DROPPED)
            assertEquals("Every accepted PTS must appear exactly once, in order", acceptedPts, encodedPts)
            InstrumentationRegistry.getInstrumentation().sendStatus(0, Bundle().apply {
                putString("encoder", encoder.codecName)
                putInt("scheduled_frames", FRAME_COUNT)
                putInt("encoded_frames", encodedPts.size)
                putLong("last_submission_elapsed_ns", lastSubmissionElapsedNs)
            })
        } finally {
            encoder.close()
        }
    }

    @Test fun strided1080pPlaneCopyFitsCpuBudget() {
        assertTrue("Run timing on the guarded emulator", H264RgbEncoder.isEmulator())
        val width = 1920
        val height = 1080
        val luma = ByteBuffer.allocateDirect(width * height)
        val chroma = ByteBuffer.allocateDirect(width * height / 2)
        val u = chroma.duplicate()
        val v = chroma.duplicate().apply { position(1) }
        val codecLuma = ByteBuffer.allocateDirect(width * height)
        val codecU = ByteBuffer.allocateDirect(width * height / 4)
        val codecV = ByteBuffer.allocateDirect(width * height / 4)
        val copier = YuvPlaneCopier()
        fun copy() {
            copier.copy(width, height, luma, width, 1, codecLuma, width, 1)
            copier.copy(width / 2, height / 2, u, width, 2, codecU, width / 2, 1)
            copier.copy(width / 2, height / 2, v, width, 2, codecV, width / 2, 1)
        }
        repeat(30) { copy() }
        val samples = LongArray(60) {
            val begin = Debug.threadCpuTimeNanos()
            copy()
            Debug.threadCpuTimeNanos() - begin
        }.sortedArray()
        val p95Ns = samples[56]
        assertTrue("1080p YUV copy CPU p95: ${p95Ns / 1e6} ms", p95Ns in 1L..10_000_000L)
        InstrumentationRegistry.getInstrumentation().sendStatus(0, Bundle().apply {
            putLong("copy_1080p_cpu_p95_ns", p95Ns)
        })
    }

    private companion object {
        const val FRAME_COUNT = 150
        const val MAX_DROPPED = 1 // At most 1% of the nominal 30 fps feed.
        const val MAX_SCHEDULE_LAG_NS = 100_000_000L // Wall time allowance for the final callback and host scheduling.
    }
}
