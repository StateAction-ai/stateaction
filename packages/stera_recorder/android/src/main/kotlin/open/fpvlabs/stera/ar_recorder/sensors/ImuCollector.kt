package open.fpvlabs.stera.ar_recorder.sensors

/**
 * Independent accelerometer and gyroscope acquisition. Each delivered SensorEvent is kept
 * as its own [RawMotionEvent] with its original timestamp; there is no combined sample.
 */
interface ImuCollector {
    /** Resolves sensors; returns false only when neither raw sensor exists. */
    fun initialize(): Boolean

    /**
     * Starts a new recording generation: clears queues and counts. Refuses (throws) while a
     * previous stop is uncertain. Pause/resume use [start]/[stop] and keep this evidence.
     */
    fun configure(requestedRateHz: Int = DEFAULT_MOTION_RATE_HZ, onSaturated: (String) -> Unit = {})
    /** Refuses (throws) after an uncertain stop until [reinitialize] succeeds. */
    fun start()
    fun stop()
    /**
     * Replaces the sensor thread and registrations after an uncertain stop. Returns true only
     * when the old producer thread provably ended; otherwise the uncertainty is kept.
     */
    fun reinitialize(): Boolean
    fun drainMotion(maxPerSensor: Int = Int.MAX_VALUE): List<RawMotionEvent>
    fun recordWritten(events: List<RawMotionEvent>)
    fun recordWriteFailed(events: List<RawMotionEvent>)
    fun recordWriterPaused(events: List<RawMotionEvent>)
    fun getQueueSize(): Int
    fun getSaturationReason(): String?
    fun getStopFailureReason(): String?
    /** Requested/effective rates, gaps, counts, drops, sensor identity and SA-50 inventory states. */
    fun motionEvidence(): Map<String, Any?>
    fun deliveredCount(kind: MotionSensorKind): Long
    fun writtenCount(kind: MotionSensorKind): Long
    fun getFirstTimestampNs(): Long?
    fun getLastTimestampNs(): Long?
    fun getAverageCallbackLatencyNs(): Double
    fun getMaxCallbackLatencyNs(): Long
    fun getCallbackCount(): Long
    fun release()
}
