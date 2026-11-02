package open.fpvlabs.stera.ar_recorder

/** A saved/selected capture setting this build cannot honor. Raised before any recorder side effect. */
class InvalidRecordingConfig(message: String) : IllegalArgumentException(message)

/**
 * Mirrors Flutter [RecordingConfig] arguments for startRecording / session prefs.
 *
 * Parsing is strict: wrong types, unknown values and settings the selected capture profile cannot
 * deliver raise [InvalidRecordingConfig] instead of being coerced to a default. What the build
 * will actually do is described by [effective]; differences from the request are listed, never hidden.
 */
data class RecordingConfig(
    val recordImu: Boolean = true,
    val recordDepth: Boolean = true,
    val recordPointCloud: Boolean = true,
    val recordMesh: Boolean = true,
    val recordRgb: Boolean = true,
    val recordingHz: Int = CPU_JPEG_RGB_HZ,
    val rgbVideoHeight: Int = 720,
    val imuHz: Int = DEFAULT_IMU_HZ
) {
    val rgbLandscapeWidth: Int get() = if (rgbVideoHeight >= 1080) 1920 else 1280
    val rgbLandscapeHeight: Int get() = if (rgbVideoHeight >= 1080) 1080 else 720

    /** Requested vs actually delivered behaviour of the CPU JPEG capture path, with reasons. */
    fun effective(): Map<String, Any?> {
        val deviations = mutableListOf<String>()
        if (recordingHz != CPU_JPEG_RGB_HZ) deviations += "rgb_hz_requested_${recordingHz}_effective_$CPU_JPEG_RGB_HZ"
        deviations += "rgb_height_${rgbVideoHeight}_requested_raster_is_arcore_cpu_image_recorded_per_frame"
        if (recordMesh) deviations += "mesh_not_recorded_by_android_capture"
        return linkedMapOf(
            "profile" to PROFILE_CPU_JPEG,
            "requested" to linkedMapOf<String, Any?>(
                "record_imu" to recordImu, "record_depth" to recordDepth, "record_point_cloud" to recordPointCloud,
                "record_mesh" to recordMesh, "record_rgb" to recordRgb, "rgb_hz" to recordingHz,
                "rgb_video_height" to rgbVideoHeight, "imu_hz" to imuHz),
            "effective" to linkedMapOf<String, Any?>(
                "record_imu" to recordImu, "record_depth" to recordDepth, "record_point_cloud" to recordPointCloud,
                "record_mesh" to false, "record_rgb" to true, "rgb_hz_target" to CPU_JPEG_RGB_HZ,
                // The raster is whatever ARCore's CPU image provides; it is recorded per frame, not assumed.
                "rgb_raster" to "arcore_cpu_image_native_recorded_per_frame",
                // Raw motion cadence is the device's sensor rate; imu_hz is only the request.
                "imu_hz_requested" to imuHz, "imu_rate_verified" to false),
            "deviations" to deviations,
            "requested_rate_honored" to (recordingHz == CPU_JPEG_RGB_HZ)
        )
    }

    companion object {
        const val PROFILE_CPU_JPEG = "android_arcore_cpu_jpeg_v3"
        const val CPU_JPEG_RGB_HZ = 15
        const val DEFAULT_IMU_HZ = 100
        private val supportedHz = setOf(5, 10, 15, 30, 60)
        private val supportedRgbHeights = setOf(720, 1080, 2160)
        private val supportedImuHz = setOf(50, 100)

        private fun bool(m: Map<*, *>, key: String, default: Boolean): Boolean {
            if (!m.containsKey(key) || m[key] == null) return default
            return m[key] as? Boolean ?: throw InvalidRecordingConfig("Capture setting $key must be true or false, not ${m[key]}")
        }

        private fun int(m: Map<*, *>, keys: List<String>, default: Int, allowed: Set<Int>, label: String): Int {
            val key = keys.firstOrNull { m[it] != null } ?: return default
            val n = m[key] as? Number ?: throw InvalidRecordingConfig("Capture setting $key must be a number, not ${m[key]}")
            val d = n.toDouble()
            if (d != Math.rint(d) || d.toInt() !in allowed) {
                throw InvalidRecordingConfig("Unsupported $label ${m[key]}; supported values are ${allowed.sorted()}")
            }
            return d.toInt()
        }

        /** `null` means "no saved settings": native defaults. Anything else must be a valid settings map. */
        fun fromMap(map: Any?): RecordingConfig {
            if (map == null) return RecordingConfig()
            val m = map as? Map<*, *> ?: throw InvalidRecordingConfig("Capture settings must be a map, not ${map.javaClass.simpleName}")
            val cfg = RecordingConfig(
                recordImu = bool(m, "recordImu", true),
                recordDepth = bool(m, "recordDepth", true),
                recordPointCloud = bool(m, "recordPointCloud", true),
                recordMesh = bool(m, "recordMesh", true),
                recordRgb = bool(m, "recordRgb", true),
                // Flutter sends rgbHz; recordingHz is the legacy native key.
                recordingHz = int(m, listOf("rgbHz", "recordingHz"), CPU_JPEG_RGB_HZ, supportedHz, "RGB rate (Hz)"),
                rgbVideoHeight = int(m, listOf("rgbVideoHeight"), 720, supportedRgbHeights, "RGB resolution height"),
                imuHz = int(m, listOf("imuHz"), DEFAULT_IMU_HZ, supportedImuHz, "IMU rate (Hz)")
            )
            // Required RGB cannot be switched off: every downstream stage consumes it.
            if (!cfg.recordRgb) throw InvalidRecordingConfig("RGB capture is required and cannot be disabled")
            // The independent raw-motion stream (SA-53) has no off switch in this build.
            if (!cfg.recordImu) throw InvalidRecordingConfig("Raw IMU capture is required and cannot be disabled")
            return cfg
        }
    }
}
