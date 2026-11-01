package open.fpvlabs.stera.ar_recorder.config

import open.fpvlabs.stera.ar_recorder.RecordingConfig
import org.junit.Assert.*
import org.junit.Test

class RecordingConfigH264Test {
    @Test fun legacyDefaultsRemainJpeg() {
        val config = RecordingConfig.fromMap(null)
        assertEquals("jpeg", config.rgbCodec)
        assertFalse(config.h264SimulationMode)
        assertEquals(720, config.rgbLandscapeHeight)
    }

    @Test fun flutterRgbRateAndHardwareProfileAreRetained() {
        val config = RecordingConfig.fromMap(mapOf("rgbCodec" to "h264", "rgbHz" to 30, "rgbVideoHeight" to 1080))
        assertTrue(config.isH264)
        assertEquals(30, config.recordingHz)
        assertEquals(1920, config.rgbLandscapeWidth)
        assertEquals(1080, config.rgbLandscapeHeight)
        assertEquals(100, config.imuHz)
    }

    @Test fun simulationIsExplicitAndHasItsOwnRaster() {
        val config = RecordingConfig.fromMap(mapOf("rgbCodec" to "h264", "h264SimulationMode" to true, "rgbHz" to 30, "rgbVideoHeight" to 480))
        assertEquals(640, config.rgbLandscapeWidth)
        assertEquals(480, config.rgbLandscapeHeight)
    }

    @Test fun invalidOrDowngradedRequestsFail() {
        val baseline = mapOf<String, Any>("rgbCodec" to "h264", "rgbHz" to 30, "rgbVideoHeight" to 1080)
        for (delta in listOf(
            mapOf("rgbCodec" to "hevc"),
            mapOf("rgbHz" to 15),
            mapOf("rgbHz" to 30.5),
            mapOf("rgbVideoHeight" to 720),
            mapOf("recordRgb" to false),
            mapOf("recordImu" to false),
            mapOf("recordDepth" to "false"),
            mapOf("imuHz" to 50),
            mapOf("h264SimulationMode" to "true")
        )) {
            try {
                RecordingConfig.fromMap(baseline + delta)
                fail("Accepted invalid request $delta")
            } catch (_: IllegalArgumentException) { }
        }
    }

    @Test fun simulationCannotChangeTheLegacyCodecImplicitly() {
        try {
            RecordingConfig.fromMap(mapOf("h264SimulationMode" to true))
            fail("Simulation without H.264 was accepted")
        } catch (_: IllegalArgumentException) { }
    }
}
