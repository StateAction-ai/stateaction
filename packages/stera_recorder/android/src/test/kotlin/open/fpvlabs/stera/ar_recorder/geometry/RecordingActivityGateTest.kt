package open.fpvlabs.stera.ar_recorder.geometry

import open.fpvlabs.stera.ar_recorder.coordination.RecordingActivityGate
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.*
import org.junit.Test

class RecordingActivityGateTest {
    @Test fun stoppingWaitsForInFlightCaptureAndPreventsLateEnqueue() {
        val gate = RecordingActivityGate()
        val producerEntered = CountDownLatch(1)
        val producerMayFinish = CountDownLatch(1)
        val stopAttempted = CountDownLatch(1)
        val completedWrites = AtomicInteger(0)
        val pool = Executors.newFixedThreadPool(2)
        try {
            gate.set(true)
            val producer = pool.submit {
                gate.withActiveRecording {
                    producerEntered.countDown()
                    check(producerMayFinish.await(5, TimeUnit.SECONDS))
                    completedWrites.incrementAndGet()
                }
            }
            assertTrue(producerEntered.await(5, TimeUnit.SECONDS))
            val stopper = pool.submit {
                stopAttempted.countDown()
                gate.set(false)
                assertEquals(1, completedWrites.get())
            }
            assertTrue(stopAttempted.await(5, TimeUnit.SECONDS))
            assertFalse(stopper.isDone)
            producerMayFinish.countDown()
            producer.get(5, TimeUnit.SECONDS)
            stopper.get(5, TimeUnit.SECONDS)
            gate.withActiveRecording { completedWrites.incrementAndGet() }
            assertEquals(1, completedWrites.get())
        } finally {
            producerMayFinish.countDown()
            pool.shutdownNow()
        }
    }
}
