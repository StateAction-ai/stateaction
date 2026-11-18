package open.fpvlabs.stera.ar_recorder

/** A saved/selected capture setting this build cannot honor. Raised before any recorder side effect. */
class InvalidRecordingConfig(message: String) : IllegalArgumentException(message)

/**
 * Mirrors Flutter [RecordingConfig] arguments for startRecording / session prefs.
 *
 * Parsing is strict: wrong types, unknown values and settings the selected capture profile cannot
 * deliver raise [InvalidRecordingConfig] instead of being coerced to a default. What the build
 * will actually do is described by [effective]; every difference from the request is listed, never hidden.
 *
 * Two profiles exist. `h264` is the production profile (1080p/30 hardware, or the explicit 640x480 simulation
 * profile). `jpeg` is the legacy CPU JPEG profile: it records ARCore's CPU raster at its fixed 15 Hz target and is
 * only available when explicitly selected AND requested at exactly 15 Hz; it never serves a 30 Hz request.
 */
data class RecordingConfig(
    val recordImu: Boolean = true,
    val recordDepth: Boolean = true,
    val recordPointCloud: Boolean = true,
    val recordMesh: Boolean = true,
    val recordRgb: Boolean = true,
    val recordingHz: Int = CPU_JPEG_RGB_HZ,
    val rgbVideoHeight: Int = 720,
    val imuHz: Int = DEFAULT_IMU_HZ,
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
            require(imuHz in supportedImuHz) { "Unsupported IMU rate" }
            if (h264SimulationMode) {
                require(rgbVideoHeight == 480) { "The H.264 simulation profile is 640x480; request rgbVideoHeight=480" }
            } else {
                require(rgbVideoHeight == 1080) { "The hardware H.264 profile requires 1080p" }
            }
        } else {
            require(recordingHz == CPU_JPEG_RGB_HZ) {
                "The legacy CPU JPEG profile records ${CPU_JPEG_RGB_HZ} Hz only; $recordingHz Hz needs the H.264 profile (rgbCodec=h264)"
            }
            require(rgbVideoHeight in cpuJpegHeights) { "Unsupported RGB resolution height $rgbVideoHeight for the CPU JPEG profile; supported values are ${cpuJpegHeights.sorted()}" }
        }
    }

    val isH264: Boolean get() = rgbCodec == "h264"
    val rgbHz: Int get() = recordingHz
    val profile: String get() = when {
        !isH264 -> PROFILE_CPU_JPEG
        h264SimulationMode -> "h264_mcap_simulation_v1"
        else -> "h264_mcap_v1"
    }
    val rgbLandscapeWidth: Int get() = if (h264SimulationMode) 640 else if (rgbVideoHeight >= 1080) 1920 else 1280
    val rgbLandscapeHeight: Int get() = if (h264SimulationMode) 480 else if (rgbVideoHeight >= 1080) 1080 else 720

    /**
     * Requested vs actually delivered behaviour, with reasons. Deviations are the unrequested-but-not-delivered
     * streams; they are returned to Flutter at start and persisted in the recording metadata.
     */
    fun effective(): Map<String, Any?> {
        val deviations = mutableListOf<String>()
        // Mesh is never recorded by Android capture. Depth / point clouds are recorded by the legacy CPU profile only.
        if (recordMesh) deviations += "mesh_not_recorded_by_android_capture"
        if (isH264 && recordDepth) deviations += "depth_not_recorded_by_h264_profile_revision"
        if (isH264 && recordPointCloud) deviations += "point_cloud_not_recorded_by_h264_profile_revision"
        return linkedMapOf(
            "profile" to profile,
            "requested" to linkedMapOf<String, Any?>(
                "rgb_codec" to rgbCodec, "h264_simulation_mode" to h264SimulationMode,
                "record_imu" to recordImu, "record_depth" to recordDepth, "record_point_cloud" to recordPointCloud,
                "record_mesh" to recordMesh, "record_rgb" to recordRgb, "rgb_hz" to recordingHz,
                "rgb_video_height" to rgbVideoHeight, "imu_hz" to imuHz),
            "effective" to linkedMapOf<String, Any?>(
                "record_imu" to recordImu,
                "record_depth" to (recordDepth && !isH264), "record_point_cloud" to (recordPointCloud && !isH264),
                "record_mesh" to false, "record_rgb" to true, "rgb_hz_target" to recordingHz,
                "rgb_requested_width" to rgbLandscapeWidth, "rgb_requested_height" to rgbLandscapeHeight,
                // The saved raster is whatever the encoder/CPU image actually produced; it is recorded per capture.
                "rgb_raster" to if (isH264) "encoded_h264_raster_checked_against_source_at_start" else "arcore_cpu_image_native_recorded_per_frame",
                // Raw motion is requested at imu_hz from the sensor stack; the delivered rate is not verified.
                "imu_hz_requested" to imuHz, "imu_rate_verified" to false),
            "deviations" to deviations,
            // RGB/IMU rates are best-effort targets handed to ARCore/the sensor stack. Nothing here observes
            // delivered cadence, so delivery is explicitly unverified; actual counts/timestamps are recorded elsewhere.
            "rate_semantics" to "target_request_only_best_effort",
            "delivery_verified" to false
        )
    }

    companion object {
        const val PROFILE_CPU_JPEG = "android_arcore_cpu_jpeg_v3"
        const val CPU_JPEG_RGB_HZ = 15
        const val DEFAULT_IMU_HZ = 100
        private val supportedHz = setOf(5, 10, 15, 30, 60)
        private val cpuJpegHeights = setOf(720, 1080)
        private val h264Heights = setOf(480, 720, 1080)
        private val supportedImuHz = setOf(50, 100)
        val UUID_PATTERN = Regex("[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")

        private fun bool(m: Map<*, *>, key: String, default: Boolean): Boolean {
            if (!m.containsKey(key) || m[key] == null) return default
            return m[key] as? Boolean ?: throw InvalidRecordingConfig("Capture setting $key must be true or false, not ${m[key]}")
        }

        private fun int(m: Map<*, *>, keys: List<String>, default: Int, allowed: Set<Int>, label: String): Int {
            val present = keys.filter { m[it] != null }
            val values = present.map { key ->
                val n = m[key] as? Number ?: throw InvalidRecordingConfig("Capture setting $key must be a number, not ${m[key]}")
                val d = n.toDouble()
                if (d != Math.rint(d) || d.toInt() !in allowed) {
                    throw InvalidRecordingConfig("Unsupported $label ${m[key]}; supported values are ${allowed.sorted()}")
                }
                d.toInt()
            }
            // Equal aliases (rgbHz + legacy recordingHz) are compatible; conflicting ones are ambiguous.
            if (values.toSet().size > 1) {
                throw InvalidRecordingConfig("Conflicting $label settings: " + present.zip(values).joinToString { (k, v) -> "$k=$v" })
            }
            return values.firstOrNull() ?: default
        }

        /** `null` means "no saved settings": native defaults. Anything else must be a valid settings map. */
        fun fromMap(map: Any?): RecordingConfig {
            if (map == null) return RecordingConfig()
            val m = map as? Map<*, *> ?: throw InvalidRecordingConfig("Capture settings must be a map, not ${map.javaClass.simpleName}")
            val codec = m["rgbCodec"] ?: "jpeg"
            if (codec !is String || codec !in setOf("jpeg", "h264")) throw InvalidRecordingConfig("Unsupported RGB codec: $codec; use jpeg or h264")
            val simulation = bool(m, "h264SimulationMode", false)
            val h264 = codec == "h264"
            val recordingId = m["recordingId"]
            if (recordingId != null && recordingId !is String) throw InvalidRecordingConfig("recordingId must be a string")
            val cfg = try {
                RecordingConfig(
                    recordImu = bool(m, "recordImu", true),
                    recordDepth = bool(m, "recordDepth", true),
                    recordPointCloud = bool(m, "recordPointCloud", true),
                    recordMesh = bool(m, "recordMesh", true),
                    recordRgb = bool(m, "recordRgb", true),
                    // Flutter sends rgbHz; recordingHz is the legacy native key. Equal aliases are fine, conflicts are not.
                    recordingHz = int(m, listOf("rgbHz", "recordingHz"), if (h264) 30 else CPU_JPEG_RGB_HZ, supportedHz, "RGB rate (Hz)"),
                    rgbVideoHeight = int(m, listOf("rgbVideoHeight"), if (h264 && simulation) 480 else if (h264) 1080 else 720, if (h264) h264Heights else setOf(720, 1080, 2160), "RGB resolution height"),
                    imuHz = int(m, listOf("imuHz"), DEFAULT_IMU_HZ, supportedImuHz, "IMU rate (Hz)"),
                    rgbCodec = codec, h264SimulationMode = simulation, recordingId = recordingId as String?
                )
            } catch (e: InvalidRecordingConfig) {
                throw e
            } catch (e: IllegalArgumentException) {
                throw InvalidRecordingConfig(e.message ?: "Unsupported capture settings")
            }
            // Required RGB cannot be switched off: every downstream stage consumes it.
            if (!cfg.recordRgb) throw InvalidRecordingConfig("RGB capture is required and cannot be disabled")
            // The independent raw-motion stream (SA-53) has no off switch in this build.
            if (!cfg.recordImu) throw InvalidRecordingConfig("Raw IMU capture is required and cannot be disabled")
            return cfg
        }
    }
}
