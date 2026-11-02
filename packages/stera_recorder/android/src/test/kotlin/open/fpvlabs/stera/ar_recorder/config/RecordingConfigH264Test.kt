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
            mapOf("recordDepth" to "false"),
            mapOf("imuHz" to 60),
            mapOf("recordingId" to "SESSION_1"),
            mapOf("recordingId" to "0b6f5e1c-3d2a-0c8e-9f1a-5e2d7c4b3a19"),
            mapOf("recordingId" to "0B6F5E1C-3D2A-4C8E-9F1A-5E2D7C4B3A19"),
            mapOf("recordingId" to 7),
            mapOf("h264SimulationMode" to "true")
        )) {
            try {
                RecordingConfig.fromMap(baseline + delta)
                fail("Accepted invalid request $delta")
            } catch (_: IllegalArgumentException) { }
        }
    }

    @Test fun callerRecordingIdentityIsRetainedVerbatim() {
        val id = "0b6f5e1c-3d2a-4c8e-9f1a-5e2d7c4b3a19"
        assertEquals(id, RecordingConfig.fromMap(mapOf("rgbCodec" to "h264", "rgbHz" to 30, "rgbVideoHeight" to 1080, "recordingId" to id)).recordingId)
        assertNull(RecordingConfig.fromMap(mapOf("rgbCodec" to "h264", "rgbHz" to 30, "rgbVideoHeight" to 1080)).recordingId)
    }

    @Test fun simulationCannotChangeTheLegacyCodecImplicitly() {
        try {
            RecordingConfig.fromMap(mapOf("h264SimulationMode" to true))
            fail("Simulation without H.264 was accepted")
        } catch (_: IllegalArgumentException) { }
    }
}
