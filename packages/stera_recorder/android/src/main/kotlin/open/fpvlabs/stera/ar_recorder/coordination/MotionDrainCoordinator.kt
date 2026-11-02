package open.fpvlabs.stera.ar_recorder.coordination

import open.fpvlabs.stera.ar_recorder.data.DatasetWriter
import open.fpvlabs.stera.ar_recorder.data.MotionWriteResult
import open.fpvlabs.stera.ar_recorder.sensors.ImuCollector
import open.fpvlabs.stera.ar_recorder.sensors.RawMotionEvent

/** Minimal scheduler seam over the writer thread's `Handler`. */
interface MotionScheduler {
    fun postDelayed(task: Runnable, delayMs: Long): Boolean
    fun remove(task: Runnable)
}

/**
 * Moves raw motion events from the collector's bounded per-sensor queues to the writer on
 * its own periodic schedule. It is not driven by camera frames, so a skipped, delayed or
 * dropped video frame never drains or discards motion. Writer backpressure leaves events in
 * the bounded collector queues, whose saturation is counted and stops capture with a reason.
 */
class MotionDrainCoordinator(
    private val collector: ImuCollector,
    private val writer: DatasetWriter,
    private val intervalMs: Long = DEFAULT_INTERVAL_MS,
    private val maxPerSensorPerTick: Int = DEFAULT_MAX_PER_SENSOR_PER_TICK,
    private val onWritten: (List<RawMotionEvent>) -> Unit = {},
) {
    companion object {
        const val DEFAULT_INTERVAL_MS = 20L
        const val DEFAULT_MAX_PER_SENSOR_PER_TICK = 256
    }

    @Volatile private var scheduler: MotionScheduler? = null
    @Volatile private var running = false
    private val tick = object : Runnable {
        override fun run() {
            if (!running) return
            flushOnce(maxPerSensorPerTick)
            val current = scheduler
            if (running && current != null && !current.postDelayed(this, intervalMs)) {
                running = false
                writer.recordWriteFailure("Writer thread rejected the raw motion drain")
            }
        }
    }

    fun start(scheduler: MotionScheduler) {
        this.scheduler = scheduler
        running = true
        scheduler.remove(tick)
        check(scheduler.postDelayed(tick, 0)) { "Writer thread rejected the raw motion drain" }
    }

    /** Stops future ticks; queued events stay in the collector for [flushAll]. */
    fun stop() {
        running = false
        scheduler?.remove(tick)
    }

    /** Writes at most [maxPerSensor] events of each sensor. Call on the writer thread. */
    fun flushOnce(maxPerSensor: Int): Int {
        val events = collector.drainMotion(maxPerSensor)
        if (events.isEmpty()) return 0
        val result = try {
            writer.writeMotionEvents(events)
        } catch (error: Throwable) {
            writer.recordWriteFailure("Raw motion writer threw", error)
            MotionWriteResult(failed = events)
        }
        val resolved = result.written.size + result.failed.size + result.paused.size
        if (resolved != events.size) {
            writer.recordWriteFailure("Raw motion writer resolved $resolved of ${events.size} events")
        }
        collector.recordWritten(result.written)
        collector.recordWriteFailed(result.failed)
        collector.recordWriterPaused(result.paused)
        if (result.written.isNotEmpty()) onWritten(result.written)
        return events.size
    }

    /**
     * Drains everything already admitted; used inside writer barriers after the collector has
     * stopped. Bounded so a collector that is still delivering cannot hold the writer forever.
     */
    fun flushAll(maxRounds: Int = 10_000): Int {
        var total = 0
        repeat(maxRounds) {
            val n = flushOnce(maxPerSensorPerTick)
            if (n == 0) return total
            total += n
        }
        writer.recordWriteFailure("Raw motion final drain did not reach an empty queue")
        return total
    }
}
