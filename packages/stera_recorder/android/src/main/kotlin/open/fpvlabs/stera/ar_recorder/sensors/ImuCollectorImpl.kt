package open.fpvlabs.stera.ar_recorder.sensors

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.SystemClock
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * Registers the accelerometer and gyroscope as two independent listeners at the requested
 * period (100 Hz by default, no batching latency). Every callback is admitted to that
 * sensor's own bounded queue with the exact `SensorEvent.timestamp`; nothing is paired with
 * the other sensor's latest value, re-timestamped with callback time or synthesized.
 */
class ImuCollectorImpl(
    private val context: Context,
    private val queueCapacityPerSensor: Int = DEFAULT_MOTION_QUEUE_CAPACITY,
    private val elapsedRealtimeNanos: () -> Long = SystemClock::elapsedRealtimeNanos,
    private val stopBarrierOverride: ((Handler?) -> Unit)? = null,
    /** Waits for the old sensor thread to end; true only when it provably terminated. */
    private val awaitThreadEnd: (HandlerThread) -> Boolean = { thread -> thread.join(5_000); !thread.isAlive },
) : ImuCollector, SensorEventListener {

    private var sensorManager: SensorManager? = null
    private val sensors = HashMap<MotionSensorKind, Sensor>()
    private val availability = HashMap<MotionSensorKind, MotionSensorAvailability>()
    private var handlerThread: HandlerThread? = null
    private var handler: Handler? = null
    @Volatile private var isCollecting = false
    @Volatile private var requestedRateHz = DEFAULT_MOTION_RATE_HZ
    @Volatile private var saturationListener: (String) -> Unit = {}
    private var generationStarted = false
    private val stopFailure = AtomicReference<String?>(null)
    private val buffer = RawMotionBuffer(queueCapacityPerSensor) { reason -> saturationListener(reason) }

    override fun initialize(): Boolean {
        return try {
            val manager = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
            sensorManager = manager
            if (manager == null) {
                MotionSensorKind.values().forEach {
                    availability[it] = MotionSensorAvailability("unknown", "no", "sensor_service_unavailable", null)
                }
                return false
            }
            for (kind in MotionSensorKind.values()) {
                val type = if (kind == MotionSensorKind.ACCEL) Sensor.TYPE_ACCELEROMETER else Sensor.TYPE_GYROSCOPE
                val sensor = manager.getDefaultSensor(type)
                if (sensor == null) {
                    availability[kind] = MotionSensorAvailability("no", "no", "sensor_absent", null)
                } else {
                    sensors[kind] = sensor
                    availability[kind] = MotionSensorAvailability("yes", "unknown", null, identityOf(sensor))
                }
            }
            if (sensors.isEmpty()) return false
            handlerThread = HandlerThread("ArImuThread").apply { start() }
            handler = Handler(handlerThread!!.looper)
            true
        } catch (e: Exception) {
            println("❌ Failed to initialize IMU collector: ${e.message}")
            MotionSensorKind.values().forEach {
                availability[it] = MotionSensorAvailability("unknown", "no", "initialization_failed", null)
            }
            false
        }
    }

    private fun identityOf(sensor: Sensor): MotionSensorIdentity = MotionSensorIdentity(
        name = sensor.name ?: "", vendor = sensor.vendor ?: "", version = sensor.version, type = sensor.type,
        stringType = sensor.stringType, resolution = sensor.resolution, maximumRange = sensor.maximumRange,
        minDelayUs = sensor.minDelay, maxDelayUs = sensor.maxDelay,
        fifoReservedEventCount = sensor.fifoReservedEventCount, fifoMaxEventCount = sensor.fifoMaxEventCount,
        isWakeUp = sensor.isWakeUpSensor, reportingMode = sensor.reportingMode,
    )

    override fun configure(requestedRateHz: Int, onSaturated: (String) -> Unit) {
        check(!isCollecting) { "Cannot reconfigure IMU collection while it is running" }
        // An uncertain stop may leave a callback in flight on the old sensor thread; a new
        // recording must not share that producer. Only reinitialize() can clear it.
        stopFailure.get()?.let { throw IllegalStateException("IMU producer is not safe to reuse: $it") }
        require(requestedRateHz in 1..1_000) { "Requested IMU rate out of range" }
        this.requestedRateHz = requestedRateHz
        saturationListener = onSaturated
        buffer.reset(requestedRateHz)
        generationStarted = false
        for (kind in MotionSensorKind.values()) {
            val current = availability[kind] ?: continue
            if (current.supported == "yes") availability[kind] = current.copy(enabled = "unknown", unavailableReason = null)
        }
    }

    override fun start() {
        if (isCollecting) return
        stopFailure.get()?.let { throw IllegalStateException("IMU producer is not safe to resume: $it") }
        val manager = sensorManager ?: return
        if (generationStarted) buffer.beginSegment() else { buffer.beginSegment(); generationStarted = true }
        isCollecting = true
        val periodUs = 1_000_000 / requestedRateHz
        for ((kind, sensor) in sensors) {
            // maxReportLatencyUs = 0: deliver each event as sampled rather than batching.
            val registered = try {
                manager.registerListener(this, sensor, periodUs, 0, handler)
            } catch (e: Exception) {
                false
            }
            val current = availability.getValue(kind)
            availability[kind] = if (registered) current.copy(enabled = "yes", unavailableReason = null)
            else current.copy(enabled = "no", unavailableReason = "register_listener_failed")
        }
        println("✅ IMU collection started: independent accel/gyro at $requestedRateHz Hz requested")
    }

    override fun stop() {
        if (!isCollecting) return
        try {
            sensorManager?.unregisterListener(this)
            val sensorHandler = handler
            if (stopBarrierOverride != null) stopBarrierOverride.invoke(sensorHandler)
            else if (sensorHandler != null && Looper.myLooper() != sensorHandler.looper) {
                // Wait for any callback already queued on the sensor thread before draining.
                val barrier = CountDownLatch(1)
                check(sensorHandler.post { barrier.countDown() }) { "IMU sensor thread rejected the stop barrier" }
                check(barrier.await(5, TimeUnit.SECONDS)) { "IMU callback stop barrier timed out" }
            }
        } catch (e: Exception) {
            stopFailure.compareAndSet(null, "IMU stop completion is uncertain: ${e.javaClass.simpleName}: ${e.message}")
        } finally {
            // No later callback is admitted even if unregister or the barrier failed.
            isCollecting = false
        }
    }

    override fun onSensorChanged(event: SensorEvent?) {
        if (event == null || !isCollecting) return
        val kind = sensors.entries.firstOrNull { it.value == event.sensor }?.key ?: return
        val values = event.values
        if (values == null || values.size < 3) return
        buffer.admit(kind, event.timestamp, elapsedRealtimeNanos(), event.accuracy, values[0], values[1], values[2])
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {
        val kind = sensors.entries.firstOrNull { it.value == sensor }?.key ?: return
        buffer.stats.getValue(kind).accuracyChanges.incrementAndGet()
    }

    override fun reinitialize(): Boolean {
        check(!isCollecting) { "Cannot reinitialize IMU collection while it is running" }
        try {
            sensorManager?.unregisterListener(this)
        } catch (e: Exception) {
            // The old thread's termination below is the actual barrier.
        }
        val old = handlerThread
        old?.quitSafely()
        val ended = try {
            old == null || awaitThreadEnd(old)
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            false
        }
        // Without proof that the old producer thread ended, the uncertainty stays.
        if (!ended) return false
        handlerThread = null
        handler = null
        sensors.clear()
        availability.clear()
        buffer.drain()
        stopFailure.set(null)
        return initialize()
    }

    override fun drainMotion(maxPerSensor: Int): List<RawMotionEvent> = buffer.drain(maxPerSensor)
    override fun recordWritten(events: List<RawMotionEvent>) = buffer.recordWritten(events)
    override fun recordWriteFailed(events: List<RawMotionEvent>) = buffer.recordWriteFailed(events)
    override fun recordWriterPaused(events: List<RawMotionEvent>) = buffer.recordWriterPaused(events)
    override fun getQueueSize(): Int = buffer.queuedTotal()
    override fun getSaturationReason(): String? = buffer.saturationReason()
    override fun getStopFailureReason(): String? = stopFailure.get()
    override fun deliveredCount(kind: MotionSensorKind): Long = buffer.stats.getValue(kind).delivered.get()
    override fun writtenCount(kind: MotionSensorKind): Long = buffer.stats.getValue(kind).written.get()

    override fun motionEvidence(): Map<String, Any?> =
        RawMotionEvidence.build(buffer, availability.toMap(), requested = true, stopFailure = stopFailure.get())

    override fun getFirstTimestampNs(): Long? =
        buffer.stats.values.mapNotNull { it.firstTimestampNs() }.minOrNull()

    override fun getLastTimestampNs(): Long? =
        buffer.stats.values.mapNotNull { it.lastTimestampNs() }.maxOrNull()

    override fun getAverageCallbackLatencyNs(): Double {
        val count = getCallbackCount()
        return if (count == 0L) 0.0 else buffer.stats.values.sumOf { it.callbackLatencySumNs() }.toDouble() / count
    }

    override fun getMaxCallbackLatencyNs(): Long = buffer.stats.values.maxOf { it.maxCallbackLatencyNs() }
    override fun getCallbackCount(): Long = buffer.stats.values.sumOf { it.delivered.get() }

    override fun release() {
        stop()
        buffer.drain()
        handlerThread?.quitSafely()
        try {
            handlerThread?.join()
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
        }
        handlerThread = null
        handler = null
        sensorManager = null
        sensors.clear()
    }
}
