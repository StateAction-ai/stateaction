package open.fpvlabs.stera.ar_recorder.session

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RearCameraLensTest {
    @Test fun requiresKnownFovWiderThanDefaultAndCloseToWidestHardwareLens() {
        val normal = RearCameraLens.horizontalFieldOfView(7.0f, 5.0f)
        val wide = RearCameraLens.horizontalFieldOfView(5.5f, 2.0f)
        assertTrue(RearCameraLens.isUltrawide(wide, normal, wide))
        assertFalse(RearCameraLens.isUltrawide(normal, normal, wide))
        assertFalse(RearCameraLens.isUltrawide(wide, normal, 150.0))
        assertFalse(RearCameraLens.isUltrawide(wide, null, wide))
        assertNull(RearCameraLens.horizontalFieldOfView(6.0f, 0f))
    }
}
