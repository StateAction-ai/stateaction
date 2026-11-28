package open.fpvlabs.stera.framing

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class FramingAnalysisGateTest {
    @Test fun aSlowDetectorCannotQueueAnotherFrame() {
        val gate = FramingAnalysisGate()
        assertTrue(gate.tryAcquire(0))
        for (time in 33L..990L step 33L) assertFalse(gate.tryAcquire(time))
        gate.release()
        assertTrue(gate.tryAcquire(1000))
    }

    @Test fun fastDetectorAcceptsAtMostEightSamplesPerSecond() {
        val gate = FramingAnalysisGate()
        val selected = (0L until 1000 step 10).count { time ->
            if (gate.tryAcquire(time)) {
                gate.release()
                true
            } else false
        }
        assertEquals(8, selected)
    }

    @Test fun textureRotationIgnoresCropAndAccountsForFlutterVerticalFlip() {
        fun matrix(xx: Float, xy: Float, yx: Float, yy: Float) =
            FloatArray(16).apply {
                this[0] = xx
                this[1] = xy
                this[4] = yx
                this[5] = yy
                this[12] = 0.14f
                this[13] = 0.18f
            }

        assertEquals(0, surfaceTextureRotation(matrix(0.7f, 0f, 0f, -0.8f)))
        assertEquals(90, surfaceTextureRotation(matrix(0f, -0.8f, -0.7f, 0f)))
        assertEquals(180, surfaceTextureRotation(matrix(-0.7f, 0f, 0f, 0.8f)))
        assertEquals(270, surfaceTextureRotation(matrix(0f, 0.8f, 0.7f, 0f)))
    }

    @Test fun downscaledYuvConversionPreservesNeutralPixels() {
        val pixels = byteArrayOf(16, 235.toByte(), 16, 235.toByte(), 128.toByte(), 128.toByte())
        assertTrue(nv21ToArgb(pixels, 2, 2).contentEquals(
            intArrayOf(0xff000000.toInt(), 0xffffffff.toInt(), 0xff000000.toInt(), 0xffffffff.toInt())
        ))
    }
}
