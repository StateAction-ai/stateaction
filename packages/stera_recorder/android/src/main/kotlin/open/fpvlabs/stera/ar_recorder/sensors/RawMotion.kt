package open.fpvlabs.stera.ar_recorder.sensors

import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * Independent raw motion sensors. Each Android `SensorEvent` becomes exactly one
 * [RawMotionEvent] of one kind: accelerometer and gyroscope values are never paired,
 * re-timestamped, resampled or interpolated.
 */
enum class MotionSensorKind(
    val id: String,
    val topic: String,
    val unit: String,
    /** Android TYPE_ACCELEROMETER includes gravity; the field does not apply to a gyro. */
    val includesGravity: Boolean?,
    val androidStringType: String,
) {
    ACCEL("accel", "/stateaction/imu/accel", "m/s^2", true, "android.sensor.accelerometer"),
    GYRO("gyro", "/stateaction/imu/gyro", "rad/s", null, "android.sensor.gyroscope");
}

/** Clock of `SensorEvent.timestamp`; it is never mapped onto the camera or wall clock here. */
const val MOTION_NATIVE_CLOCK_ID = "android.elapsed_realtime"
const val MOTION_AXES = "android_device"
const val DEFAULT_MOTION_RATE_HZ = 100
/** About 40 s per sensor at 100 Hz; independent of any visual queue or pool. */
const val DEFAULT_MOTION_QUEUE_CAPACITY = 4_096
const val MOTION_QUEUE_SATURATED = "E_MOTION_QUEUE_SATURATED"

data class RawMotionEvent(
    val kind: MotionSensorKind,
    /** Per-sensor delivery ordinal within one recording; gaps mean admitted events were lost. */
    val eventId: Long,
    /** Exact original `SensorEvent.timestamp`. */
    val nativeTimestampNs: Long,
    /** `SystemClock.elapsedRealtimeNanos()` read in the callback (delivery, not sample time). */
    val callbackElapsedNs: Long,
    /** `SensorEvent.accuracy` (-1..3), or null when the platform reported something else. */
    val accuracy: Int?,
    val x: Float,
    val y: Float,
    val z: Float,
)

/** Static description of one physical/virtual sensor as reported by the platform. */
data class MotionSensorIdentity(
    val name: String,
    val vendor: String,
    val version: Int,
    val type: Int,
    val stringType: String?,
    val resolution: Float,
    val maximumRange: Float,
    val minDelayUs: Int,
    val maxDelayUs: Int,
    val fifoReservedEventCount: Int,
    val fifoMaxEventCount: Int,
    val isWakeUp: Boolean,
    val reportingMode: Int,
) {
    fun toMap(): Map<String, Any?> = mapOf(
        "name" to name, "vendor" to vendor, "version" to version, "type" to type,
        "string_type" to stringType, "resolution" to resolution.toDouble(),
        "maximum_range" to maximumRange.toDouble(), "min_delay_us" to minDelayUs,
        "max_delay_us" to maxDelayUs, "fifo_reserved_event_count" to fifoReservedEventCount,
        "fifo_max_event_count" to fifoMaxEventCount, "is_wake_up" to isWakeUp,
        "reporting_mode" to reportingMode,
    )
}

/** Platform availability/registration result; "unknown" is never collapsed into yes/no. */
data class MotionSensorAvailability(
    val supported: String,
    val enabled: String,
    val unavailableReason: String?,
    val identity: MotionSensorIdentity?,
) {
    companion object {
        val NOT_CONFIGURED = MotionSensorAvailability("unknown", "unknown", "not_initialized", null)
    }
}

/**
 * Delivery-side statistics for one sensor. Updated on the single sensor callback thread
 * (and the writer thread for write outcomes), read after the stop barrier.
 */
class MotionChannelStats(val kind: MotionSensorKind) {
    @Volatile var requestedRateHz: Int = DEFAULT_MOTION_RATE_HZ; private set
    val delivered = AtomicLong()
    val enqueued = AtomicLong()
    val droppedQueueFull = AtomicLong()
    val written = AtomicLong()
    val writeFailed = AtomicLong()
    val discardedWriterPaused = AtomicLong()
    val accuracyChanges = AtomicLong()
    private val lock = Any()
    private var first: Long? = null
    private var last: Long? = null
    private var segmentLast: Long? = null
    private var segments = 0
    private var intervals = 0L
    private var intervalSumNs = 0L
    private var minGapNs: Long? = null
    private var maxGapNs: Long? = null
    private var gapsOverThreshold = 0L
    private var nonIncreasing = 0L
    private var maxCallbackLatencyNs = 0L
    private var callbackLatencySumNs = 0L

    fun reset(rateHz: Int) = synchronized(lock) {
        requestedRateHz = rateHz
        listOf(delivered, enqueued, droppedQueueFull, written, writeFailed, discardedWriterPaused, accuracyChanges)
            .forEach { it.set(0) }
        first = null; last = null; segmentLast = null; segments = 0; intervals = 0; intervalSumNs = 0
        minGapNs = null; maxGapNs = null; gapsOverThreshold = 0; nonIncreasing = 0
        maxCallbackLatencyNs = 0; callbackLatencySumNs = 0
    }

    /** A pause/resume boundary: the paused interval is not reported as a sensor gap. */
    fun beginSegment() = synchronized(lock) { segmentLast = null; segments++ }

    /** Gap threshold: twice the requested sampling period. */
    val gapThresholdNs: Long get() = 2L * 1_000_000_000L / requestedRateHz.coerceAtLeast(1)

    fun recordDelivery(nativeTimestampNs: Long, callbackElapsedNs: Long) = synchronized(lock) {
        delivered.incrementAndGet()
        first = first ?: nativeTimestampNs
        last = nativeTimestampNs
        val previous = segmentLast
        if (previous != null) {
            val gap = nativeTimestampNs - previous
            if (gap <= 0) nonIncreasing++ else {
                intervals++; intervalSumNs += gap
                minGapNs = minOf(minGapNs ?: gap, gap); maxGapNs = maxOf(maxGapNs ?: gap, gap)
                if (gap > gapThresholdNs) gapsOverThreshold++
            }
        }
        // A non-increasing timestamp is preserved as delivered and counted, never "fixed".
        segmentLast = if (previous == null || nativeTimestampNs > previous) nativeTimestampNs else previous
        val latency = (callbackElapsedNs - nativeTimestampNs).coerceAtLeast(0)
        callbackLatencySumNs += latency
        maxCallbackLatencyNs = maxOf(maxCallbackLatencyNs, latency)
    }

    fun firstTimestampNs(): Long? = synchronized(lock) { first }
    fun lastTimestampNs(): Long? = synchronized(lock) { last }
    fun maxCallbackLatencyNs(): Long = synchronized(lock) { maxCallbackLatencyNs }
    fun callbackLatencySumNs(): Long = synchronized(lock) { callbackLatencySumNs }

    /** Measured from delivered original timestamps only; null when fewer than two intervals exist. */
    fun effectiveRateHz(): Double? = synchronized(lock) {
        if (intervals < 1 || intervalSumNs <= 0) null else intervals * 1e9 / intervalSumNs
    }

    fun toMap(): Map<String, Any?> = synchronized(lock) {
        mapOf(
            "topic" to kind.topic, "unit" to kind.unit, "axes" to MOTION_AXES,
            "includes_gravity" to kind.includesGravity, "native_clock_id" to MOTION_NATIVE_CLOCK_ID,
            "requested_rate_hz" to requestedRateHz,
            "requested_period_us" to 1_000_000 / requestedRateHz.coerceAtLeast(1),
            "effective_rate_hz" to (if (intervals < 1 || intervalSumNs <= 0) null else intervals * 1e9 / intervalSumNs),
            "delivered" to delivered.get(), "enqueued" to enqueued.get(), "written" to written.get(),
            "dropped" to mapOf(
                "queue_full" to droppedQueueFull.get(),
                "write_failed" to writeFailed.get(),
                "writer_paused" to discardedWriterPaused.get(),
            ),
            "first_native_timestamp_ns" to first?.toString(),
            "last_native_timestamp_ns" to last?.toString(),
            "segments" to segments,
            "intervals" to intervals,
            "min_interval_ns" to minGapNs?.toString(),
            "max_interval_ns" to maxGapNs?.toString(),
            "gap_threshold_ns" to gapThresholdNs.toString(),
            "gaps_over_threshold" to gapsOverThreshold,
            "non_increasing_timestamps" to nonIncreasing,
            "accuracy_changes" to accuracyChanges.get(),
            "max_callback_latency_ns" to maxCallbackLatencyNs.toString(),
        )
    }
}

/**
 * One bounded FIFO per sensor. A full queue never blocks the sensor thread, never evicts
 * already-admitted events and never borrows capacity from the other sensor: the rejected
 * event is counted and the first saturation is reported once so capture can stop with a reason.
 */
class RawMotionBuffer(
    capacityPerSensor: Int = DEFAULT_MOTION_QUEUE_CAPACITY,
    private val onSaturated: (String) -> Unit = {},
) {
    init { require(capacityPerSensor in 1..1_000_000) { "Motion queue capacity out of range" } }
    val capacity = capacityPerSensor
    private val queues = MotionSensorKind.values().associateWith { ArrayBlockingQueue<RawMotionEvent>(capacityPerSensor) }
    val stats = MotionSensorKind.values().associateWith { MotionChannelStats(it) }
    private val nextId = MotionSensorKind.values().associateWith { AtomicLong() }
    private val saturation = AtomicReference<String?>(null)
    private val highWater = MotionSensorKind.values().associateWith { AtomicLong() }

    fun reset(rateHz: Int) {
        queues.values.forEach { it.clear() }
        stats.values.forEach { it.reset(rateHz) }
        nextId.values.forEach { it.set(0) }
        highWater.values.forEach { it.set(0) }
        saturation.set(null)
    }

    fun beginSegment() = stats.values.forEach { it.beginSegment() }

    /** Called from the sensor callback thread with a detached copy of the event values. */
    fun admit(kind: MotionSensorKind, nativeTimestampNs: Long, callbackElapsedNs: Long, accuracy: Int?,
              x: Float, y: Float, z: Float): Boolean {
        val channel = stats.getValue(kind)
        channel.recordDelivery(nativeTimestampNs, callbackElapsedNs)
        val event = RawMotionEvent(kind, nextId.getValue(kind).getAndIncrement(), nativeTimestampNs,
            callbackElapsedNs, accuracy?.takeIf { it in -1..3 }, x, y, z)
        val queue = queues.getValue(kind)
        if (!queue.offer(event)) {
            channel.droppedQueueFull.incrementAndGet()
            val reason = "$MOTION_QUEUE_SATURATED: ${kind.id} queue full at ${queue.size}/$capacity events"
            if (saturation.compareAndSet(null, reason)) onSaturated(reason)
            return false
        }
        channel.enqueued.incrementAndGet()
        highWater.getValue(kind).accumulateAndGet(queue.size.toLong(), ::maxOf)
        return true
    }

    /** Drains up to [maxPerSensor] events of each sensor, in delivery order per sensor. */
    fun drain(maxPerSensor: Int = Int.MAX_VALUE): List<RawMotionEvent> {
        val out = ArrayList<RawMotionEvent>()
        for (queue in queues.values) queue.drainTo(out, maxPerSensor)
        return out
    }

    fun queued(kind: MotionSensorKind): Int = queues.getValue(kind).size
    fun queuedTotal(): Int = queues.values.sumOf { it.size }
    fun highWater(kind: MotionSensorKind): Long = highWater.getValue(kind).get()
    fun saturationReason(): String? = saturation.get()

    fun recordWritten(events: List<RawMotionEvent>) =
        events.groupingBy { it.kind }.eachCount().forEach { (kind, n) -> stats.getValue(kind).written.addAndGet(n.toLong()) }

    fun recordWriteFailed(events: List<RawMotionEvent>) =
        events.groupingBy { it.kind }.eachCount().forEach { (kind, n) -> stats.getValue(kind).writeFailed.addAndGet(n.toLong()) }

    fun recordWriterPaused(events: List<RawMotionEvent>) =
        events.groupingBy { it.kind }.eachCount().forEach { (kind, n) -> stats.getValue(kind).discardedWriterPaused.addAndGet(n.toLong()) }
}

/** Builds the per-recording evidence block, including the SA-50 Inventory sensor entries. */
object RawMotionEvidence {
    fun inventoryEntry(kind: MotionSensorKind, availability: MotionSensorAvailability, stats: MotionChannelStats,
                       requested: Boolean, observationKnown: Boolean): Map<String, Any?> {
        val delivered = stats.delivered.get()
        return mapOf(
            "sensor_id" to kind.id,
            "kind" to kind.androidStringType,
            "requested" to if (requested) "yes" else "no",
            "supported" to availability.supported,
            "enabled" to availability.enabled,
            "observed" to when { !observationKnown -> "unknown"; delivered > 0 -> "yes"; else -> "no" },
            "observed_count" to if (observationKnown) delivered.toString() else null,
            "native_clock_id" to if (availability.supported == "yes") MOTION_NATIVE_CLOCK_ID else null,
            "unavailable_reason" to availability.unavailableReason,
        )
    }

    fun build(buffer: RawMotionBuffer, availability: Map<MotionSensorKind, MotionSensorAvailability>,
              requested: Boolean, stopFailure: String?): Map<String, Any?> {
        val observationKnown = stopFailure == null
        return mapOf(
            "semantics" to "independent_raw_sensor_events",
            "pairing" to "none",
            "timestamp_source" to "SensorEvent.timestamp",
            "mapped_capture_time" to null,
            "clock_mapping" to mapOf("state" to "unavailable", "reason" to "no_declared_motion_clock_mapping"),
            "queue_capacity_per_sensor" to buffer.capacity,
            "saturation_reason" to buffer.saturationReason(),
            "stop_failure_reason" to stopFailure,
            "inventory" to MotionSensorKind.values().map {
                inventoryEntry(it, availability[it] ?: MotionSensorAvailability.NOT_CONFIGURED, buffer.stats.getValue(it),
                    requested, observationKnown)
            },
            "sensors" to MotionSensorKind.values().associate { kind ->
                kind.id to (buffer.stats.getValue(kind).toMap() + mapOf(
                    "queue_high_water" to buffer.highWater(kind),
                    "queued_at_evidence" to buffer.queued(kind),
                    "hardware" to availability[kind]?.identity?.toMap(),
                ))
            },
            // Fused/derived motion is not produced by the Android raw path; it is named separately.
            "fused_motion" to mapOf(
                "attitude" to mapOf("state" to "unavailable", "provenance" to "not_produced"),
                "derived_angular_velocity" to mapOf("state" to "unavailable", "provenance" to "not_produced"),
                "covariance" to mapOf("state" to "unavailable", "provenance" to "not_produced"),
            ),
        )
    }
}
