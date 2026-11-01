package open.fpvlabs.stera.ar_recorder.sensors

data class ImuSample(
    val timestampNs: Long,
    val accelX: Float,
    val accelY: Float,
    val accelZ: Float,
    val gyroX: Float,
    val gyroY: Float,
    val gyroZ: Float,
    val callbackLatencyNs: Long
)

data class RawMotionSample(val sensor: String, val eventId: Long, val timestampNs: Long,
    val callbackElapsedNs: Long, val accuracy: Int, val x: Float, val y: Float, val z: Float)

interface ImuCollector {
    fun configureRawMotion(enabled: Boolean, samplingHz: Int = 100) {}
    fun drainRawMotion(): List<RawMotionSample> = emptyList()
    fun getRawMotionDroppedCount(): Long = 0L
    fun getStopFailureReason(): String? = null
    fun initialize(): Boolean
    fun start()
    fun stop()
    fun drainSamples(): List<ImuSample>
    fun getQueueSize(): Int
    fun getFirstTimestampNs(): Long?
    fun getLastTimestampNs(): Long?
    fun getAverageCallbackLatencyNs(): Double
    fun getMaxCallbackLatencyNs(): Long
    fun getCallbackCount(): Long
    fun release()
}
