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
        assertEquals(true, cfg.effective()["requested_rate_honored"])
    }

    @Test fun flutterRgbHzKeyIsHonoredInsteadOfBeingIgnored() {
        assertEquals(60, RecordingConfig.fromMap(valid + ("rgbHz" to 60)).recordingHz)
        assertEquals(10, RecordingConfig.fromMap((valid - "rgbHz") + ("recordingHz" to 10)).recordingHz)
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

    @Test fun requested30HzIsReportedAsNotHonoredNeverSilentlyServedAs15() {
        val effective = RecordingConfig.fromMap(valid + ("rgbHz" to 30) + ("rgbVideoHeight" to 1080)).effective()
        assertEquals(false, effective["requested_rate_honored"])
        @Suppress("UNCHECKED_CAST") val deviations = effective["deviations"] as List<String>
        assertTrue(deviations.contains("rgb_hz_requested_30_effective_15"))
        @Suppress("UNCHECKED_CAST") val eff = effective["effective"] as Map<String, Any?>
        assertEquals(15, eff["rgb_hz_target"]); assertEquals(false, eff["imu_rate_verified"])
        @Suppress("UNCHECKED_CAST") val req = effective["requested"] as Map<String, Any?>
        assertEquals(30, req["rgb_hz"])
    }

    @Test fun absentSettingsMeanNativeDefaultsButEmptyStringsDoNot() {
        assertEquals(15, RecordingConfig.fromMap(null).recordingHz)
        assertEquals(15, RecordingConfig.fromMap(emptyMap<String, Any>()).recordingHz)
        reject(listOf(1), "must be a map")
    }
}
