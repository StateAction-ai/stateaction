package open.fpvlabs.stera.ar_recorder.data

import open.fpvlabs.stera.ar_recorder.data.h264.AnnexB
import open.fpvlabs.stera.ar_recorder.data.h264.CaptureProtocol
import open.fpvlabs.stera.ar_recorder.data.h264.H264FrameLedger
import open.fpvlabs.stera.ar_recorder.data.h264.VideoWire
import open.fpvlabs.stera.ar_recorder.sensors.MotionSensorKind
import open.fpvlabs.stera.ar_recorder.sensors.RawMotionEvent

/**
 * Writes one `h264_mcap_v1` (or explicitly simulation-only) recording into an open [MCAPWriter] using exactly the
 * `stateaction.capture.v1.1` channel table: the JSON evidence topics, `/camera/rgb/video` and `/tracking/pose`.
 * Legacy CDR streams (JPEG, depth, point clouds, TF, device metrics) are never registered here; the portable
 * readers reject undeclared topics. Pure JVM code: tests replay it without a device.
 *
 * Callers serialize access (the recorder uses its single writer thread); every public method is synchronized
 * anyway so a late callback cannot interleave records.
 */
class H264CaptureWriter(
    private val mcap: MCAPWriter,
    profileInput: Map<String, Any?>,
    clocks: Map<String, Any?>,
    private val asset: (String) -> ByteArray,
    private val transportNow: () -> Long,
) {
    val profile: Map<String, Any?> = CaptureProtocol.profile(profileInput)
    val recordingId: String = profile.getValue("recording_id").toString()
    private val clocks: Map<String, Any?> = clocks + ("recording_id" to recordingId)
    private val ledger = H264FrameLedger(recordingId)
    private val channels = mutableMapOf<String, Int>()
    private val sequences = mutableMapOf<String, Int>()
    private val dropReasons = sortedMapOf<String, Long>()
    private var sensorEvents = 0L
    private var poseMessages = 0L
    private var invalidPoses = 0L
    private var videoMessages = 0L
    private val motionCounts = MotionSensorKind.values().associateWith { 0L }.toMutableMap()
    private var opened = false
    var closed = false; private set
    var closeOutcome: String? = null; private set

    init {
        require(Regex(UUID).matches(recordingId)) { "recording_id must be a canonical lowercase UUID" }
        val streamClocks = this.clocks["stream_clocks"] as? Map<*, *> ?: error("Clocks.stream_clocks required")
        require(streamClocks["rgb"] is String) { "The rgb stream clock must be declared" }
    }

    @Synchronized fun open() {
        check(!opened) { "Capture evidence already opened" }
        val descriptor = asset("foxglove-compressed-video.desc")
        val video = mcap.addSchema("foxglove.CompressedVideo", "protobuf", descriptor)
        channels[CaptureProtocol.VIDEO] = mcap.addChannel(CaptureProtocol.VIDEO, "protobuf", video, emptyMap())
        val schemas = mutableMapOf<String, Int>()
        for ((topic, name) in JSON_TOPICS) {
            val schema = schemas.getOrPut(name) { mcap.addSchema("stateaction.capture.$name.v1", "jsonschema", asset("$name.schema.json")) }
            channels[topic] = mcap.addChannel(topic, "json", schema, emptyMap())
        }
        val pose = mcap.addSchema(POSE_SCHEMA, "ros2msg", asset("geometry_msgs-PoseStamped.ros2msg"))
        channels[POSE_TOPIC] = mcap.addChannel(POSE_TOPIC, "cdr", pose, emptyMap())
        opened = true
        json(CaptureProtocol.PROFILE_TOPIC, profile)
        json(CaptureProtocol.CLOCKS, this.clocks)
    }

    /** acquired / submitted / dropped evidence; written events are produced only by [accessUnit]. */
    @Synchronized fun frameEvent(event: Map<String, Any?>) {
        checkOpen()
        ledger.validateEvent(event)
        json(CaptureProtocol.FRAMES, event)
        ledger.acceptEvent(event)
        if (event["state"] == "dropped") {
            val reason = event["reason"] as String
            dropReasons[reason] = (dropReasons[reason] ?: 0L) + 1
        }
    }

    /** One complete image access unit plus its `written` FrameEvent; returns the IDR flag. */
    @Synchronized fun accessUnit(sourceFrameId: Long, captureTimeNs: Long, encoderPtsUs: Long, annexB: ByteArray): Boolean {
        checkOpen()
        val idr = AnnexB.validateAccessUnit(annexB)
        val sequence = sequences.getOrDefault(CaptureProtocol.VIDEO, 0)
        val event = ledger.writtenEvent(sourceFrameId, captureTimeNs, encoderPtsUs, sequence, idr)
        val payload = VideoWire.compressedVideo(captureTimeNs, annexB, OPTICAL_FRAME)
        mcap.addMessage(channels.getValue(CaptureProtocol.VIDEO), captureTimeNs, captureTimeNs, payload, sequence)
        sequences[CaptureProtocol.VIDEO] = sequence + 1
        videoMessages++
        json(CaptureProtocol.FRAMES, event)
        ledger.acceptWritten(sourceFrameId, encoderPtsUs)
        return idr
    }

    /**
     * ARCore camera pose of an acquired frame. A tracking pose writes one `/tracking/pose` message; any other tracking
     * state writes only explicit `pose_valid=false` evidence, so tracking loss is never silent.
     */
    @Synchronized fun pose(frame: Map<String, Any?>, trackingState: String, pose: FloatArray?) {
        checkOpen()
        require(trackingState in setOf("tracking", "paused", "lost", "unknown")) { "Unknown tracking state" }
        require(frame["recording_id"] == recordingId && frame["state"] == "acquired") { "Pose needs an acquired frame identity" }
        val valid = trackingState == "tracking" && pose != null
        val mapped = CaptureProtocol.decimal(frame, "mapped_capture_time_ns")
        val outputChannel: String
        val outputSequence: Int
        if (valid) {
            require(pose!!.size == 7 && pose.all { it.isFinite() }) { "Pose requires finite tx,ty,tz,qx,qy,qz,qw" }
            val data = CDRSerializer.serializePoseStamped(mapped, POSE_FRAME, pose[0], pose[1], pose[2], pose[3], pose[4], pose[5], pose[6])
            outputSequence = sequences.getOrDefault(POSE_TOPIC, 0)
            mcap.addMessage(channels.getValue(POSE_TOPIC), mapped, mapped, data, outputSequence)
            sequences[POSE_TOPIC] = outputSequence + 1
            outputChannel = POSE_TOPIC
            poseMessages++
        } else {
            outputChannel = CaptureProtocol.SENSORS
            outputSequence = sequences.getOrDefault(CaptureProtocol.SENSORS, 0)
            invalidPoses++
        }
        json(CaptureProtocol.SENSORS, mapOf(
            "recording_id" to recordingId, "stream_id" to "pose", "event_id" to sensorEvents.toString(),
            "native_timestamp_ns" to frame["native_timestamp_ns"], "native_clock_id" to frame["native_clock_id"],
            "mapped_capture_time_ns" to frame["mapped_capture_time_ns"],
            "output_channel" to outputChannel, "output_sequence" to outputSequence,
            "source_kind" to "arcore_pose", "calibration_id" to frame["calibration_id"],
            "association_source_frame_id" to frame["source_frame_id"],
            "tracking_state" to trackingState, "pose_valid" to valid,
        ))
        sensorEvents++
    }

    /**
     * Independent raw motion from SA-53's producer, encoded with its exact [MotionEventWire] payload on the contract
     * accel/gyro channels. Every offered event is resolved once: written, or failed with every later event.
     */
    @Synchronized fun motionEvents(events: List<RawMotionEvent>, logTime: (Long) -> Long, onBytes: (Int) -> Unit = {}): Pair<MotionWriteResult, Throwable?> {
        val written = ArrayList<RawMotionEvent>(events.size)
        for ((index, event) in events.withIndex()) {
            try {
                checkOpen()
                val data = MotionEventWire.encode(recordingId, event)
                val time = logTime(event.nativeTimestampNs).coerceAtLeast(0L)
                val sequence = sequences.getOrDefault(event.kind.topic, 0)
                mcap.addMessage(channels.getValue(event.kind.topic), time, time, data, sequence)
                sequences[event.kind.topic] = sequence + 1
                motionCounts[event.kind] = motionCounts.getValue(event.kind) + 1
                written.add(event)
                onBytes(data.size + 22)
            } catch (error: Throwable) {
                return MotionWriteResult(written = written, failed = events.subList(index, events.size).toList()) to error
            }
        }
        return MotionWriteResult(written = written) to null
    }

    @Synchronized fun motionCount(kind: MotionSensorKind): Long = motionCounts.getValue(kind)

    /**
     * Writes the Inventory and the terminal Close exactly once. `completed` is downgraded to `failed` when frames are
     * unresolved or when no video was written.
     */
    @Synchronized fun close(outcome: String, failureReason: String?, sensors: List<Map<String, Any?>>, calibrations: List<Map<String, Any?>>): Map<String, Any?> {
        checkOpen()
        check(!closed) { "Close already written" }
        require(outcome in setOf("completed", "failed", "aborted")) { "Unsupported outcome" }
        val unresolved = ledger.unresolvedIds().size.toLong()
        val completionFailure = when {
            outcome != "completed" -> null
            unresolved != 0L -> "unresolved_frames"
            videoMessages == 0L -> "no_rgb_frames_written"
            else -> null
        }
        val finalOutcome = if (completionFailure == null) outcome else "failed"
        val reason = failureReason ?: completionFailure ?: "capture_failed".takeIf { finalOutcome == "failed" }
        json(CaptureProtocol.INVENTORY, mapOf("recording_id" to recordingId, "sensors" to sensors, "calibrations" to calibrations))
        val stats = ledger.stats()
        val close = mapOf(
            "recording_id" to recordingId, "outcome" to finalOutcome,
            "failure_reason" to reason?.let(::text),
            "frames" to mapOf(
                "acquired" to stats.getValue("acquired").toString(), "submitted" to stats.getValue("submitted").toString(),
                "written" to stats.getValue("written").toString(), "dropped" to stats.getValue("dropped").toString(),
                "unresolved" to unresolved.toString()),
            "video_messages" to videoMessages.toString(),
            "drops" to dropReasons.entries.take(32).map { mapOf("reason" to it.key, "count" to it.value.toString()) },
            "motion_events" to mapOf("accel" to motionCounts.getValue(MotionSensorKind.ACCEL).toString(),
                "gyro" to motionCounts.getValue(MotionSensorKind.GYRO).toString()),
            "sensor_events" to sensorEvents.toString(),
        )
        json(CaptureProtocol.CLOSE, close)
        closed = true
        closeOutcome = finalOutcome
        return close
    }

    @Synchronized fun acquiredCount(): Long = ledger.acquired

    /** Small source-manifest declaration from the actual closed writer, never from file names alone.
     * clock_domain describes MCAP log/publish time (Unix); original native clocks remain in payloads.
     * Hashes and sizes are deliberately absent: SA-18 computes them after final metadata closes.
     */
    @Synchronized fun sourceManifestEvidence(): Map<String, Any?> {
        check(closed && closeOutcome == "completed") { "Capture is not a completed source" }
        val nativeClocks = (clocks["stream_clocks"] as Map<*, *>).values.map { it as String }
        val declarations = channels.keys.sorted().map { topic ->
            val encoding = when (topic) { CaptureProtocol.VIDEO -> "protobuf"; POSE_TOPIC -> "cdr"; else -> "json" }
            val schema = when (topic) {
                CaptureProtocol.VIDEO -> "foxglove.CompressedVideo"
                POSE_TOPIC -> POSE_SCHEMA
                else -> "stateaction.capture.${JSON_TOPICS.toMap().getValue(topic)}.v1"
            }
            mapOf("topic" to topic, "message_encoding" to encoding, "schema_name" to schema,
                "clock_domain" to "unix", "message_count" to sequences.getOrDefault(topic, 0).toString())
        }
        return mapOf(
            "clockDomains" to (nativeClocks + "unix").distinct().sorted(),
            "channels" to declarations,
            "counts" to mapOf("video_frames" to videoMessages.toString(), "dropped_video_frames" to ledger.dropped.toString(),
                "motion_events" to motionCounts.values.sum().toString()),
        )
    }

    @Synchronized fun stats(): Map<String, Any?> = ledger.stats() + mapOf(
        "video_messages" to videoMessages, "pose_messages" to poseMessages, "invalid_pose_events" to invalidPoses,
        "sensor_events" to sensorEvents, "drops" to dropReasons.toMap(),
        "motion_events" to motionCounts.mapKeys { it.key.id }, "closed" to closed, "close_outcome" to closeOutcome,
    )

    private fun checkOpen() = check(opened && !closed) { "Capture evidence is not open" }

    private fun json(topic: String, value: Map<String, Any?>) {
        val bytes = CaptureProtocol.json(value).toByteArray(Charsets.UTF_8)
        val now = transportNow()
        val sequence = sequences.getOrDefault(topic, 0)
        mcap.addMessage(channels.getValue(topic), now, now, bytes, sequence)
        sequences[topic] = sequence + 1
    }

    companion object {
        const val OPTICAL_FRAME = "camera_optical_frame"
        const val POSE_FRAME = "world"
        const val POSE_TOPIC = "/tracking/pose"
        const val POSE_SCHEMA = "geometry_msgs/msg/PoseStamped"
        const val UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"
        val JSON_TOPICS = listOf(
            CaptureProtocol.PROFILE_TOPIC to "Profile", CaptureProtocol.CLOCKS to "Clocks",
            CaptureProtocol.INVENTORY to "Inventory", CaptureProtocol.FRAMES to "FrameEvent",
            CaptureProtocol.SENSORS to "SensorEvent", CaptureProtocol.ACCEL to "MotionEvent",
            CaptureProtocol.GYRO to "MotionEvent", CaptureProtocol.CLOSE to "Close",
        )

        /** Contract `text`: 1..256 printable ASCII. */
        fun text(value: String): String {
            val printable = value.map { if (it.code in 32..126) it else '?' }.joinToString("").trim()
            return printable.ifEmpty { "capture_failed" }.take(256)
        }
    }
}
