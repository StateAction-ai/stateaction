package open.fpvlabs.stera.ar_recorder.data

import open.fpvlabs.stera.ar_recorder.data.h264.CaptureProtocol
import open.fpvlabs.stera.ar_recorder.sensors.MOTION_AXES
import open.fpvlabs.stera.ar_recorder.sensors.MOTION_NATIVE_CLOCK_ID
import open.fpvlabs.stera.ar_recorder.sensors.MotionSensorKind
import open.fpvlabs.stera.ar_recorder.sensors.RawMotionEvent

/** Outcome of one writer call; every offered event is resolved exactly once. */
data class MotionWriteResult(
    val written: List<RawMotionEvent> = emptyList(),
    val failed: List<RawMotionEvent> = emptyList(),
    val paused: List<RawMotionEvent> = emptyList(),
)

/**
 * SA-50 `stateaction.capture.MotionEvent.v1` JSON for `/stateaction/imu/{accel,gyro}`.
 * Values are the float32 SensorEvent values (shortest round-trip decimal), the timestamp
 * is the original native timestamp, and there is no clock mapping (`mapped_capture_time_ns`
 * is null) until a declared mapping exists.
 */
object MotionEventWire {
    const val SCHEMA_NAME = "stateaction.capture.MotionEvent.v1"
    const val SCHEMA_ENCODING = "jsonschema"
    const val MESSAGE_ENCODING = "json"
    const val SCHEMA_ASSET = "stateaction/capture/MotionEvent.schema.json"
    private val UUID = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")

    fun message(recordingId: String, event: RawMotionEvent): Map<String, Any?> {
        require(UUID.matches(recordingId)) { "recording_id must be a canonical lowercase UUID" }
        require(event.eventId >= 0 && event.nativeTimestampNs >= 0 && event.callbackElapsedNs >= 0) {
            "Motion event IDs and timestamps must be non-negative"
        }
        val values = listOf(event.x, event.y, event.z)
        require(values.all { it.isFinite() && it in -1_000_000f..1_000_000f }) { "Motion value out of contract range" }
        return linkedMapOf(
            "recording_id" to recordingId,
            "event_id" to event.eventId.toString(),
            "native_timestamp_ns" to event.nativeTimestampNs.toString(),
            "native_clock_id" to MOTION_NATIVE_CLOCK_ID,
            "unit" to event.kind.unit,
            "mapped_capture_time_ns" to null,
            "callback_elapsed_ns" to event.callbackElapsedNs.toString(),
            "accuracy" to event.accuracy,
            "values" to values,
            "axes" to MOTION_AXES,
            "includes_gravity" to event.kind.includesGravity,
        )
    }

    fun encode(recordingId: String, event: RawMotionEvent): ByteArray =
        CaptureProtocol.json(message(recordingId, event)).toByteArray(Charsets.UTF_8)

    /** Registers one schema and the two independent channels; returns channel IDs by sensor. */
    fun register(writer: MCAPWriter, schemaJson: String): Map<MotionSensorKind, Int> {
        val schemaId = writer.addSchema(SCHEMA_NAME, SCHEMA_ENCODING, schemaJson)
        return MotionSensorKind.values().associateWith { writer.addChannel(it.topic, MESSAGE_ENCODING, schemaId) }
    }

    /**
     * Writes events in the given order. MCAP log and publish time are the original native
     * timestamp. A failure resolves the failing and every later event as failed.
     */
    fun write(writer: MCAPWriter, channels: Map<MotionSensorKind, Int>, recordingId: String,
              events: List<RawMotionEvent>, onBytes: (Int) -> Unit = {}): Pair<MotionWriteResult, Throwable?> {
        val written = ArrayList<RawMotionEvent>(events.size)
        for ((index, event) in events.withIndex()) {
            try {
                val data = encode(recordingId, event)
                writer.addMessage(channels.getValue(event.kind), event.nativeTimestampNs, event.nativeTimestampNs, data)
                written.add(event)
                onBytes(data.size + 22)
            } catch (error: Throwable) {
                return MotionWriteResult(written = written, failed = events.subList(index, events.size).toList()) to error
            }
        }
        return MotionWriteResult(written = written) to null
    }
}
