package open.fpvlabs.stera.ar_recorder

/**
 * Mirrors Flutter [RecordingConfig] arguments for startRecording / session prefs.
 */
data class RecordingConfig(
    val recordImu: Boolean = true,
    val recordDepth: Boolean = true,
    val recordPointCloud: Boolean = true,
    val recordMesh: Boolean = true,
    val recordRgb: Boolean = true,
    val recordingHz: Int = 15,
    val rgbVideoHeight: Int = 720,
    val imuHz: Int = 100,
    val rgbCodec: String = "jpeg",
    val h264SimulationMode: Boolean = false,
    /** Optional caller-owned capture identity (canonical lowercase UUID); the recorder generates one otherwise. */
    val recordingId: String? = null
) {
    init {
        require(rgbCodec == "jpeg" || rgbCodec == "h264") { "Unsupported RGB codec: $rgbCodec" }
        require(!h264SimulationMode || isH264) { "H.264 simulation requires rgbCodec=h264" }
        require(recordingId == null || UUID_PATTERN.matches(recordingId)) { "recordingId must be a canonical lowercase UUID" }
        if (isH264) {
            require(recordRgb) { "H.264 capture requires the RGB stream" }
            require(recordingHz == 30) { "The H.264 profile requires 30 Hz; no FPS fallback" }
            require(imuHz == 50 || imuHz == 100) { "Unsupported IMU rate" }
            if (!h264SimulationMode) {
                require(rgbVideoHeight == 1080) { "The hardware H.264 profile requires 1080p" }
            }
        }
    }

    val isH264: Boolean get() = rgbCodec == "h264"
    val rgbHz: Int get() = recordingHz
    val rgbLandscapeWidth: Int get() = if (h264SimulationMode) 640 else if (rgbVideoHeight >= 1080) 1920 else 1280
    val rgbLandscapeHeight: Int get() = if (h264SimulationMode) 480 else if (rgbVideoHeight >= 1080) 1080 else 720

    companion object {
        private val supportedHz = setOf(15, 30, 60)
        val UUID_PATTERN = Regex("[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
        private val supportedRgbHeights = setOf(720, 1080)

        fun fromMap(map: Any?): RecordingConfig {
            val m = map as? Map<*, *> ?: return RecordingConfig()
            val codec = m["rgbCodec"] ?: "jpeg"
            require(codec is String && codec in setOf("jpeg", "h264")) { "Unsupported RGB codec: $codec" }
            val simulation = m["h264SimulationMode"] ?: false
            require(simulation is Boolean) { "h264SimulationMode must be a boolean" }
            val h264 = codec == "h264"
            val rawHz = m["rgbHz"] ?: m["recordingHz"] ?: if (h264) 30 else 15
            val rawHeight = m["rgbVideoHeight"] ?: if (h264) 1080 else 720
            val rawImuHz = m["imuHz"] ?: 100
            val recordingId = m["recordingId"]
            require(recordingId == null || recordingId is String) { "recordingId must be a string" }
            if (h264) {
                for (key in listOf("recordImu", "recordDepth", "recordPointCloud", "recordMesh", "recordRgb")) {
                    require(!m.containsKey(key) || m[key] is Boolean) { "$key must be a boolean" }
                }
                require(rawHz is Number && rawHz.toDouble() == 30.0) { "The H.264 profile requires an explicit supported 30 Hz request" }
                require(rawHeight is Number && rawHeight.toDouble() in setOf(480.0, 720.0, 1080.0)) { "Unsupported H.264 raster request" }
                require(rawImuHz is Number && rawImuHz.toDouble() in setOf(50.0, 100.0)) { "Unsupported IMU rate" }
            }
            val hz = (rawHz as? Number)?.toInt() ?: 15
            val rgbH = (rawHeight as? Number)?.toInt() ?: 720
            return RecordingConfig(
                recordImu = m["recordImu"] as? Boolean ?: true,
                recordDepth = m["recordDepth"] as? Boolean ?: true,
                recordPointCloud = m["recordPointCloud"] as? Boolean ?: true,
                recordMesh = m["recordMesh"] as? Boolean ?: true,
                recordRgb = m["recordRgb"] as? Boolean ?: true,
                recordingHz = if (hz in supportedHz) hz else 15,
                rgbVideoHeight = if (h264 && simulation) 480 else if (rgbH in supportedRgbHeights) rgbH else 720,
                imuHz = (rawImuHz as? Number)?.toInt()?.takeIf { it == 50 || it == 100 } ?: 100,
                rgbCodec = codec,
                h264SimulationMode = simulation,
                recordingId = recordingId as String?
            )
        }
    }
}
