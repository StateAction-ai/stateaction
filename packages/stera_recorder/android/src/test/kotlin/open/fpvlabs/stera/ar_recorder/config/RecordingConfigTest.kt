package open.fpvlabs.stera.ar_recorder.config

import open.fpvlabs.stera.ar_recorder.InvalidRecordingConfig
import open.fpvlabs.stera.ar_recorder.RecordingConfig
import org.junit.Assert.*
import org.junit.Test

class RecordingConfigTest {
    private val valid = mapOf<String, Any?>(
        "recordImu" to true, "recordDepth" to true, "recordPointCloud" to false, "recordMesh" to false,
        "recordRgb" to true, "rgbHz" to 15, "rgbVideoHeight" to 1080, "imuHz" to 100
    )

    private fun reject(map: Any?, fragment: String) {
        val error = assertThrows(InvalidRecordingConfig::class.java) { RecordingConfig.fromMap(map) }
        assertTrue("'${error.message}' should mention '$fragment'", error.message!!.contains(fragment))
    }

    @Test fun validSavedProfileIsParsedWithoutCoercion() {
        val cfg = RecordingConfig.fromMap(valid)
        assertEquals(15, cfg.recordingHz); assertEquals(1080, cfg.rgbVideoHeight)
        assertFalse(cfg.recordPointCloud); assertTrue(cfg.recordDepth)
        val eff = cfg.effective()
        assertFalse(eff.containsKey("requested_rate_honored"))
        assertEquals(false, eff["delivery_verified"])
        assertEquals("target_request_only_best_effort", eff["rate_semantics"])
    }

    @Test fun equalRateAliasesAreCompatibleButConflictsAreRejected() {
        assertEquals(15, RecordingConfig.fromMap(valid + ("recordingHz" to 15)).recordingHz)
        assertEquals(15, RecordingConfig.fromMap((valid - "rgbHz") + ("recordingHz" to 15)).recordingHz)
        reject(valid + ("recordingHz" to 60), "Conflicting RGB rate")
        val h264 = mapOf<String, Any?>("rgbCodec" to "h264", "rgbHz" to 30, "rgbVideoHeight" to 1080)
        assertEquals(30, RecordingConfig.fromMap(h264 + ("recordingHz" to 30)).recordingHz)
        reject(h264 + ("recordingHz" to 15), "Conflicting RGB rate")
    }

    @Test fun unsupportedOrMalformedValuesFailInsteadOfFallingBack() {
        reject(valid + ("rgbHz" to 24), "RGB rate")
        reject(valid + ("rgbHz" to 29.5), "RGB rate")
        reject(valid + ("rgbHz" to "30"), "must be a number")
        reject(valid + ("rgbVideoHeight" to 900), "RGB resolution")
        reject(valid + ("imuHz" to 200), "IMU rate")
        reject(valid + ("recordDepth" to "yes"), "recordDepth")
        reject("not a map", "must be a map")
    }

    @Test fun requiredStreamsCannotBeSwitchedOff() {
        reject(valid + ("recordRgb" to false), "RGB capture is required")
        reject(valid + ("recordImu" to false), "Raw IMU capture is required")
    }

    @Test fun legacyCpuProfileFailsClosedInsteadOfServingAHiddenFifteenHz() {
        // Flutter's defaults (rgbHz 30, 1080p) with the legacy JPEG profile must be refused, not run at 15 Hz.
        for (hz in listOf(5, 10, 30, 60)) reject(valid + ("rgbHz" to hz), "needs the H.264 profile")
        reject(valid + ("rgbVideoHeight" to 2160), "RGB resolution height 2160")
    }

    @Test fun h264ProfileHonorsRateAndImuAndSurfacesEveryUndeliveredStream() {
        val cfg = RecordingConfig.fromMap(mapOf("rgbCodec" to "h264", "rgbHz" to 30, "rgbVideoHeight" to 1080,
            "imuHz" to 50, "recordMesh" to true, "recordDepth" to true, "recordPointCloud" to true))
        assertEquals(50, cfg.imuHz); assertEquals("h264_mcap_v1", cfg.profile)
        val effective = cfg.effective()
        @Suppress("UNCHECKED_CAST") val deviations = effective["deviations"] as List<String>
        assertTrue(deviations.containsAll(listOf("mesh_not_recorded_by_android_capture",
            "depth_not_recorded_by_h264_profile_revision", "point_cloud_not_recorded_by_h264_profile_revision")))
        @Suppress("UNCHECKED_CAST") val eff = effective["effective"] as Map<String, Any?>
        assertEquals(30, eff["rgb_hz_target"]); assertEquals(50, eff["imu_hz_requested"])
        assertEquals(false, eff["record_depth"]); assertEquals(false, eff["record_mesh"])
        @Suppress("UNCHECKED_CAST") val req = effective["requested"] as Map<String, Any?>
        assertEquals(30, req["rgb_hz"]); assertEquals(true, req["record_depth"])
    }

    @Test fun simulationProfileIsExplicitAndNamedInEffectiveSettings() {
        val cfg = RecordingConfig.fromMap(mapOf("rgbCodec" to "h264", "h264SimulationMode" to true, "rgbHz" to 30, "rgbVideoHeight" to 480))
        assertEquals("h264_mcap_simulation_v1", cfg.profile)
        assertEquals(640, (cfg.effective()["effective"] as Map<*, *>)["rgb_requested_width"])
        assertThrows(InvalidRecordingConfig::class.java) {
            RecordingConfig.fromMap(mapOf("rgbCodec" to "h264", "h264SimulationMode" to true, "rgbHz" to 30, "rgbVideoHeight" to 1080))
        }
    }

    @Test fun absentSettingsMeanNativeDefaultsButEmptyStringsDoNot() {
        assertEquals(15, RecordingConfig.fromMap(null).recordingHz)
        assertEquals(15, RecordingConfig.fromMap(emptyMap<String, Any>()).recordingHz)
        reject(listOf(1), "must be a map")
    }
}
