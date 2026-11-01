package ai.stateaction.spike.capture

import org.junit.Assert.*
import org.junit.Test
import java.nio.ByteBuffer

class VideoWireTest {
    @Test fun annexBAndLengthPrefixedRoundTrip() {
        val nals = listOf(byteArrayOf(0x67, 0x4d, 0, 0x28), byteArrayOf(0x68, 0x11), byteArrayOf(0x65, 0xb8.toByte()))
        val encoded = AnnexB.join(nals)
        val decoded = AnnexB.nals(encoded)
        nals.zip(decoded).forEach { (a,b) -> assertArrayEquals(a,b) }
        val lengthPrefixed = ByteBuffer.allocate(nals.sumOf { it.size + 4 })
        nals.forEach { lengthPrefixed.putInt(it.size); lengthPrefixed.put(it) }
        assertArrayEquals(encoded, AnnexB.join(AnnexB.nals(lengthPrefixed.array())))
    }
    @Test fun detectsBFrameSlices() {
        assertTrue(AnnexB.isBFrame(byteArrayOf(0x41, 0xa0.toByte()))) // ue(0),ue(1)
        assertFalse(AnnexB.isBFrame(byteArrayOf(0x41, 0xc0.toByte()))) // ue(0),ue(0)
        assertFalse(AnnexB.isBFrame(byteArrayOf(0x65, 0xb0.toByte()))) // ue(0),ue(2)
    }
    @Test fun ptsQuantizationStaysUnique() {
        val pts = FramePts()
        assertEquals(0L, pts.allocate(10_000L, 10_000L))
        assertEquals(1L, pts.allocate(10_001L, 10_000L))
        assertEquals(33_333L, pts.allocate(33_343_000L, 10_000L))
    }
    @Test(expected = IllegalArgumentException::class) fun badPacketFails() { AnnexB.nals(byteArrayOf(0,0,0,20,0x65)) }
    @Test fun protobufIncludesTimestampAndFormat() {
        val wire = VideoWire.compressedVideo(1_800_000_000_123_456_789L, byteArrayOf(0,0,0,1,0x65))
        assertEquals(10, wire[0].toInt())
        assertTrue(String(wire).contains("camera_rgb_optical"))
        assertTrue(String(wire).endsWith("h264"))
    }
}
