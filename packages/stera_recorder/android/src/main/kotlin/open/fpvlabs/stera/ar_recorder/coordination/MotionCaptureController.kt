package open.fpvlabs.stera.ar_recorder.coordination

import open.fpvlabs.stera.ar_recorder.data.DatasetWriter
import open.fpvlabs.stera.ar_recorder.sensors.DEFAULT_MOTION_RATE_HZ
import open.fpvlabs.stera.ar_recorder.sensors.ImuCollector

/**
 * Recorder-side lifecycle of raw motion for one recording: start, pause/resume, stop and
 * the reasoned capture stop on queue saturation. [ArRecorderImpl] delegates here so the
 * same code is exercised by JVM tests with the real collector, drain and MCAP writer.
 */
class MotionCaptureController(
    private val collector: ImuCollector,
    private val writer: DatasetWriter,
    private val drain: MotionDrainCoordinator,
    /** Runs on the recorder's main thread (saturation is reported from the sensor thread). */
    private val postToMain: (Runnable) -> Unit,
    /** Runs on the writer thread; false when the writer rejected the task. */
    private val postToWriter: (Runnable) -> Boolean,
    /** Stops admitting camera frames for the remainder of the recording. */
    private val haltCapture: () -> Unit,
    private val log: (String) -> Unit = {},
) {
    @Volatile var stopReason: String? = null
        private set

    fun start(scheduler: MotionScheduler, requestedRateHz: Int = DEFAULT_MOTION_RATE_HZ) {
        // A previous uncertain stop must not leak old callbacks into this recording's source.
        collector.getStopFailureReason()?.let { previous ->
            check(collector.reinitialize()) { "IMU producer is not safe to reuse: $previous" }
        }
        stopReason = null
        collector.configure(requestedRateHz) { reason -> postToMain(Runnable { onSaturated(reason) }) }
        collector.start()
        drain.start(scheduler)
    }

    /** Call before the writer pause barrier; the returned tail must run on the writer thread. */
    fun pause(): () -> Unit {
        collector.stop()
        drain.stop()
        return { drain.flushAll() }
    }

    /**
     * Returns a reason instead of resuming when capture was stopped for motion loss or the
     * pause could not prove that sensor callbacks ended.
     */
    fun resume(scheduler: MotionScheduler): String? {
        stopReason?.let { return it }
        collector.getStopFailureReason()?.let { return it }
        collector.start()
        drain.start(scheduler)
        return null
    }

    /** Stops acquisition and ticks; already admitted events stay queued for [finishOnWriter]. */
    fun stopCollection() {
        collector.stop()
        drain.stop()
    }

    /**
     * Writer-thread stop barrier tail: writes every admitted event, then applies sticky
     * failures so an uncertain stop or saturated queue can never finalize as success.
     */
    fun finishOnWriter() {
        drain.flushAll()
        collector.getStopFailureReason()?.let { writer.recordWriteFailure(it) }
        collector.getSaturationReason()?.let { writer.recordWriteFailure(it) }
    }

    /** Main-thread handler for the collector's first saturation report. */
    fun onSaturated(reason: String) {
        if (stopReason != null) return
        stopReason = reason
        log("Capture stopped: $reason")
        // Writer-owned failure state is updated on the writer thread; [finishOnWriter]
        // re-applies the collector's reason, so a rejected post cannot lose it.
        postToWriter(Runnable { writer.recordWriteFailure(reason) })
        haltCapture()
        collector.stop()
    }
}
