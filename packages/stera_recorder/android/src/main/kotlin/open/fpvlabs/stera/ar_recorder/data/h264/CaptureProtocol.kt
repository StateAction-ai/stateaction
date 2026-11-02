package open.fpvlabs.stera.ar_recorder.data.h264

/** Pure serialization/identity boundary. It never retains an ARCore Frame, Image or codec buffer. */
object CaptureProtocol {
    const val SCHEMA = "stateaction.capture.v1"
    const val PROFILE = "h264_mcap_v1"
    const val EMULATOR_PROFILE = "h264_mcap_simulation_v1"
    const val VIDEO = "/camera/rgb/video"
    const val PROFILE_TOPIC = "/stateaction/capture_profile"
    const val CLOCKS = "/stateaction/clocks"
    const val FRAMES = "/stateaction/frame_events"
    const val ACCEL = "/stateaction/imu/accel"
    const val GYRO = "/stateaction/imu/gyro"
    const val SENSORS = "/stateaction/sensor_events"
    const val INVENTORY = "/stateaction/inventory"
    const val CLOSE = "/stateaction/close"
    const val MAX_PENDING = 4
    const val MAX_ACCESS_UNIT = 16 * 1024 * 1024 - 4096
    val TIME_BASE: Map<String, Int> = mapOf("numerator" to 1, "denominator" to 1_000_000)

    fun profile(input: Map<String, Any?>): Map<String, Any?> {
        val name = input["rgb_profile"] ?: PROFILE
        require(name == PROFILE || name == EMULATOR_PROFILE) { "Unsupported explicit H.264 profile" }
        if (name == EMULATOR_PROFILE) {
            require(input["qualification"] == "simulation_only") { "Emulator profile requires simulation_only" }
            require(input["mapped_timeline_semantics"] == "simulation_transport_only")
        }
        require(!input["recording_id"].toString().let { it == "null" || it.isBlank() }) { "recording_id required" }
        return input + mapOf(
            "capture_schema" to SCHEMA, "rgb_profile" to name, "encoder_time_base" to TIME_BASE,
            "wire_contract_revision" to "stateaction.capture.v1.1",
            "production_qualified" to false,
            "qualification" to (input["qualification"] ?: "unqualified"),
            "limits" to ((input["limits"] as? Map<*, *>)?.entries?.associate { it.key.toString() to it.value }.orEmpty() + mapOf("pending_frames" to MAX_PENDING, "access_unit_bytes" to MAX_ACCESS_UNIT,
                "mcap_chunk_target_bytes" to 1_048_576, "mcap_chunk_input_bytes" to 16 * 1024 * 1024,
                "max_queued_encoded_bytes" to 16 * 1024 * 1024,
                "writer_mode" to "synchronous_bounded_input", "chunk_index_count" to 65_536))
        )
    }

    fun decimal(map: Map<String, Any?>, key: String, nonnegative: Boolean = true): Long {
        val text = map[key] as? String ?: error("$key must be a decimal string")
        require(Regex(if (nonnegative) "0|[1-9][0-9]*" else "-?(0|[1-9][0-9]*)").matches(text)) { "Invalid $key" }
        return text.toLong().also { require(!nonnegative || it >= 0) }
    }

    /** Strict JSON; all native nanoseconds and IDs must already be decimal strings. */
    fun json(value: Any?): String = when (value) {
        null -> "null"
        is String -> "\"" + buildString { for (char in value) when (char) {
            '\\' -> append("\\\\"); '"' -> append("\\\""); '\n' -> append("\\n"); '\r' -> append("\\r"); '\t' -> append("\\t")
            else -> if (char.code < 32) append("\\u%04x".format(char.code)) else append(char)
        } } + "\""
        is Boolean, is Byte, is Short, is Int, is Long -> value.toString()
        is Float -> { require(value.isFinite()) { "Non-finite JSON number" }; value.toString() }
        is Double -> { require(value.isFinite()) { "Non-finite JSON number" }; value.toString() }
        is Map<*, *> -> value.entries.joinToString(",", "{", "}") { require(it.key is String); json(it.key) + ":" + json(it.value) }
        is List<*> -> value.joinToString(",", "[", "]") { json(it) }
        is FloatArray -> json(value.toList())
        is DoubleArray -> json(value.toList())
        is IntArray -> json(value.toList())
        else -> error("Unsupported JSON value ${value.javaClass.name}")
    }
}

/** Bounded source-ID/PTS join; no callback-order matching or all-session frame map. */
class H264FrameLedger(private val recordingId: String) {
    private val pending = LinkedHashMap<Long, Map<String, Any?>>()
    private var lastId = -1L
    private var lastPts = -1L
    private var lastWrittenPts = -1L
    var acquired = 0L; private set
    var submitted = 0L; private set
    var written = 0L; private set
    var dropped = 0L; private set
    var highWater = 0; private set

    fun validateEvent(event: Map<String, Any?>) {
        require(event["recording_id"] == recordingId && event["stream_id"] == "rgb") { "Wrong frame recording/stream" }
        val id = CaptureProtocol.decimal(event, "source_frame_id")
        val state = event["state"]
        when (state) {
            "acquired" -> {
                require(id > lastId) { "Duplicate/nonmonotonic source frame ID" }
                require(pending.size < CaptureProtocol.MAX_PENDING) { "Pending H.264 frame bound exhausted" }
                require(CaptureProtocol.decimal(event, "encoder_pts_us") > lastPts) { "Duplicate/nonmonotonic encoder PTS" }
                require(CaptureProtocol.decimal(event, "native_timestamp_ns") > 0) { "Native timestamp must be positive" }
                require(CaptureProtocol.decimal(event, "mapped_capture_time_ns") > 0) { "Mapped capture time must be positive" }
                for (key in listOf("native_clock_id", "clock_mapping_revision", "calibration_id")) require(event[key] is String && (event[key] as String).isNotBlank()) { "Missing $key" }
                require(event["native_timestamps"] is Map<*, *>) { "Original native timestamps required" }
                require(event["encoder_time_base"] == CaptureProtocol.TIME_BASE) { "Frame time base is not 1/1000000" }
            }
            "submitted", "dropped" -> {
                require(id in pending) { "Unknown or duplicate terminal source frame ID" }
                if (state == "dropped") require(event["reason"] is String && (event["reason"] as String).isNotBlank())
                checkIdentity(pending.getValue(id), event)
                if (state == "submitted") require(pending.getValue(id)["state"] != "submitted") { "Duplicate submit" }
            }
            else -> error("External frame events must be acquired/submitted/dropped; written belongs to writer")
        }
    }

    fun acceptEvent(event: Map<String, Any?>) {
        validateEvent(event)
        val id = CaptureProtocol.decimal(event, "source_frame_id")
        when (event["state"]) {
            "acquired" -> {
                // Store a detached snapshot: no mutable caller map survives the writer boundary.
                pending[id] = event.toMap(); lastId = id; lastPts = CaptureProtocol.decimal(event, "encoder_pts_us")
                acquired++; highWater = maxOf(highWater, pending.size)
            }
            "submitted" -> { pending[id] = pending.getValue(id) + ("state" to "submitted"); submitted++ }
            "dropped" -> { pending.remove(id); dropped++ }
        }
    }

    private fun checkIdentity(original: Map<String, Any?>, next: Map<String, Any?>) {
        for (key in listOf("native_timestamp_ns", "native_clock_id", "encoder_pts_us", "mapped_capture_time_ns", "calibration_id", "clock_mapping_revision")) {
            if (key in next) require(original[key] == next[key]) { "Changed frame identity: $key" }
        }
    }

    fun writtenEvent(id: Long, captureNs: Long, ptsUs: Long, sequence: Int, idr: Boolean): Map<String, Any?> {
        val frame = checkNotNull(pending[id]) { "Unknown or duplicate output source frame ID" }
        require(CaptureProtocol.decimal(frame, "encoder_pts_us") == ptsUs) { "Written PTS differs from the acquired PTS" }
        require(CaptureProtocol.decimal(frame, "mapped_capture_time_ns") == captureNs) { "Written capture time differs from the acquired capture time" }
        require(ptsUs > lastWrittenPts) { "Output PTS regressed or repeated" }
        if (written == 0L) require(idr) { "Video must start at an actual IDR" }
        return frame + mapOf("state" to "written", "output_channel" to CaptureProtocol.VIDEO, "output_sequence" to sequence, "is_idr" to idr)
    }

    fun acceptWritten(id: Long, ptsUs: Long) { check(pending.remove(id) != null); written++; lastWrittenPts = ptsUs }
    fun frameAtMappedTime(epochNs: Long): Map<String, Any?>? = pending.values.singleOrNull {
        CaptureProtocol.decimal(it, "mapped_capture_time_ns") == epochNs
    }
    fun unresolvedIds(): List<String> = pending.keys.map(Long::toString)
    fun stats(): Map<String, Any> = mapOf("acquired" to acquired, "submitted" to submitted, "written" to written,
        "dropped" to dropped, "unresolved" to pending.size, "unresolved_ids" to unresolvedIds(), "pending_high_water" to highWater)
}
