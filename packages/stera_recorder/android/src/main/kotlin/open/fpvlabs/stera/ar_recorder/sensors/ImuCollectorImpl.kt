package open.fpvlabs.stera.ar_recorder.sensors

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.atomic.AtomicReference

/**
 * Collects accelerometer and gyroscope data from device sensors.
 * Buffers the latest reading from each sensor and emits combined samples
 * containing both accel and gyro values.
 */
class ImuCollectorImpl(
    private val context: Context,
    private val stopBarrierOverride: ((Handler?) -> Unit)? = null
) : ImuCollector, SensorEventListener {

    companion object {
        private const val SENSOR_RATE = SensorManager.SENSOR_DELAY_FASTEST
    }

    private var sensorManager: SensorManager? = null
    private var accelerometer: Sensor? = null
    private var gyroscope: Sensor? = null

    private var handlerThread: HandlerThread? = null
    private var handler: Handler? = null

    private val sampleQueue = ConcurrentLinkedQueue<ImuSample>()

    @Volatile private var isCollecting: Boolean = false
    private val rawQueue = ArrayBlockingQueue<RawMotionSample>(20_000)
    private var rawEnabled = false
    private var samplingPeriodUs = 10_000
    private var rawAccelEventId = 0L
    private var rawGyroEventId = 0L
    @Volatile private var rawDropped = 0L
    private val stopFailure = AtomicReference<String?>(null)
    override fun configureRawMotion(enabled: Boolean, samplingHz: Int) {
        check(!isCollecting)
        rawEnabled = enabled
        // A resume uses start(), so uncertainty survives pause/resume and is cleared only
        // when the recorder explicitly configures the next recording generation.
        stopFailure.set(null)
        rawQueue.clear(); rawAccelEventId = 0; rawGyroEventId = 0; rawDropped = 0
        samplingPeriodUs = 1_000_000 / samplingHz.coerceIn(1, 200)
    }
    override fun drainRawMotion(): List<RawMotionSample> = mutableListOf<RawMotionSample>().also { rawQueue.drainTo(it) }
    override fun getRawMotionDroppedCount(): Long = rawDropped
    override fun getStopFailureReason(): String? = stopFailure.get()

    // Latest readings for pairing
    @Volatile private var latestAccelX: Float = 0f
    @Volatile private var latestAccelY: Float = 0f
    @Volatile private var latestAccelZ: Float = 0f
    @Volatile private var hasAccel: Boolean = false

    @Volatile private var latestGyroX: Float = 0f
    @Volatile private var latestGyroY: Float = 0f
    @Volatile private var latestGyroZ: Float = 0f
    @Volatile private var hasGyro: Boolean = false

    @Volatile
    private var firstTimestampNs: Long? = null
    @Volatile
    private var lastTimestampNs: Long? = null
    @Volatile
    private var totalCallbackLatencyNs: Long = 0L
    @Volatile
    private var maxCallbackLatencyNs: Long = 0L
    @Volatile
    private var callbackCount: Long = 0L

    override fun initialize(): Boolean {
        try {
            sensorManager = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager

            if (sensorManager == null) {
                println("❌ SensorManager not available")
                return false
            }

            accelerometer = sensorManager?.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
            gyroscope = sensorManager?.getDefaultSensor(Sensor.TYPE_GYROSCOPE)

            if (accelerometer == null) {
                println("⚠️ Accelerometer not available")
            }

            if (gyroscope == null) {
                println("⚠️ Gyroscope not available")
            }

            if (accelerometer == null && gyroscope == null) {
                println("❌ No IMU sensors available")
                return false
            }

            handlerThread = HandlerThread("ArImuThread").apply { start() }
            handler = Handler(handlerThread!!.looper)

            println("✅ IMU collector initialized")
            return true

        } catch (e: Exception) {
            println("❌ Failed to initialize IMU collector: ${e.message}")
            e.printStackTrace()
            return false
        }
    }

    override fun start() {
        if (isCollecting) return

        try {
            sampleQueue.clear()
            rawQueue.clear()
            firstTimestampNs = null
            lastTimestampNs = null
            totalCallbackLatencyNs = 0L
            maxCallbackLatencyNs = 0L
            callbackCount = 0L
            hasAccel = false
            hasGyro = false

            isCollecting = true
            accelerometer?.let { sensor ->
                val registered = sensorManager?.registerListener(this, sensor, if (rawEnabled) samplingPeriodUs else SENSOR_RATE, handler) == true
                check(!rawEnabled || registered) { "Required independent raw ${sensor.name} registration failed" }
            }

            gyroscope?.let { sensor ->
                val registered = sensorManager?.registerListener(this, sensor, if (rawEnabled) samplingPeriodUs else SENSOR_RATE, handler) == true
                check(!rawEnabled || registered) { "Required independent raw ${sensor.name} registration failed" }
            }

            isCollecting = true
            println("✅ IMU collection started")

        } catch (e: Exception) {
            isCollecting = false
            sensorManager?.unregisterListener(this)
            println("❌ Failed to start IMU collection: ${e.message}")
            e.printStackTrace()
            if (rawEnabled) throw IllegalStateException("Required independent IMU collection failed", e)
        }
    }

    override fun stop() {
        if (!isCollecting) return

        try {
            sensorManager?.unregisterListener(this)
            isCollecting = false
            val sensorHandler = handler
            if (stopBarrierOverride != null) stopBarrierOverride.invoke(sensorHandler)
            else if (sensorHandler != null && android.os.Looper.myLooper() != sensorHandler.looper) {
                val barrier = java.util.concurrent.CountDownLatch(1)
                check(sensorHandler.post { barrier.countDown() })
                check(barrier.await(5, java.util.concurrent.TimeUnit.SECONDS)) { "IMU callback stop barrier timed out" }
            }
            println("✅ IMU collection stopped")
        } catch (e: Exception) {
            stopFailure.compareAndSet(null, "IMU stop completion is uncertain: ${e.javaClass.simpleName}: ${e.message}")
            println("❌ Failed to stop IMU collection: ${e.message}")
            e.printStackTrace()
        } finally {
            // Even if unregister or the callback barrier fails, no later callback may be
            // admitted to the recording. The retained failure prevents a completed result.
            isCollecting = false
        }
    }

    override fun onSensorChanged(event: SensorEvent?) {
        event?.let {
            if (!isCollecting) return
            if (rawEnabled) {
                val kind = when (it.sensor.type) { Sensor.TYPE_ACCELEROMETER -> "accel"; Sensor.TYPE_GYROSCOPE -> "gyro"; else -> return }
                val now = SystemClock.elapsedRealtimeNanos()
                if (!rawQueue.offer(RawMotionSample(kind, if (kind == "accel") rawAccelEventId++ else rawGyroEventId++, it.timestamp, now, it.accuracy, it.values[0], it.values[1], it.values[2]))) rawDropped++
                firstTimestampNs = firstTimestampNs ?: it.timestamp; lastTimestampNs = it.timestamp
                callbackCount++; totalCallbackLatencyNs += (now - it.timestamp).coerceAtLeast(0)
                maxCallbackLatencyNs = maxOf(maxCallbackLatencyNs, (now - it.timestamp).coerceAtLeast(0))
                return
            }
            when (it.sensor.type) {
                Sensor.TYPE_ACCELEROMETER -> {
                    latestAccelX = it.values[0]
                    latestAccelY = it.values[1]
                    latestAccelZ = it.values[2]
                    hasAccel = true
                }
                Sensor.TYPE_GYROSCOPE -> {
                    latestGyroX = it.values[0]
                    latestGyroY = it.values[1]
                    latestGyroZ = it.values[2]
                    hasGyro = true
                }
                else -> return
            }

            // Only emit combined samples once both sensors have reported
            if (!hasAccel || !hasGyro) return

            val callbackNowNs = SystemClock.elapsedRealtimeNanos()
            val callbackLatencyNs = callbackNowNs - it.timestamp

            val sample = ImuSample(
                timestampNs = it.timestamp,
                accelX = latestAccelX,
                accelY = latestAccelY,
                accelZ = latestAccelZ,
                gyroX = latestGyroX,
                gyroY = latestGyroY,
                gyroZ = latestGyroZ,
                callbackLatencyNs = callbackLatencyNs
            )

            sampleQueue.offer(sample)
            firstTimestampNs = firstTimestampNs ?: it.timestamp
            lastTimestampNs = it.timestamp
            callbackCount++
            totalCallbackLatencyNs += callbackLatencyNs
            if (callbackLatencyNs > maxCallbackLatencyNs) {
                maxCallbackLatencyNs = callbackLatencyNs
            }
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {
        // Not used
    }

    override fun drainSamples(): List<ImuSample> {
        val samples = mutableListOf<ImuSample>()
        while (true) {
            val sample = sampleQueue.poll() ?: break
            samples.add(sample)
        }
        return samples
    }

    override fun getQueueSize(): Int = sampleQueue.size

    override fun getFirstTimestampNs(): Long? = firstTimestampNs

    override fun getLastTimestampNs(): Long? = lastTimestampNs

    override fun getAverageCallbackLatencyNs(): Double {
        return if (callbackCount == 0L) 0.0 else totalCallbackLatencyNs.toDouble() / callbackCount.toDouble()
    }

    override fun getMaxCallbackLatencyNs(): Long = maxCallbackLatencyNs

    override fun getCallbackCount(): Long = callbackCount

    override fun release() {
        stop()
        sampleQueue.clear()
        rawQueue.clear()

        handlerThread?.quitSafely()
        try {
            handlerThread?.join()
        } catch (e: InterruptedException) {
            e.printStackTrace()
        }
        handlerThread = null
        handler = null

        sensorManager = null
        accelerometer = null
        gyroscope = null

        println("✅ IMU collector released")
    }
}
