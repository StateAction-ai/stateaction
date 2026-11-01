package open.fpvlabs.stera.ar_recorder.encoding

import android.media.Image
import java.nio.ByteBuffer
import org.junit.Assert.*
import org.junit.Test
import org.mockito.Mockito

class H264NativeContractTest {
    @Test fun optionalAccessorCanWaitThenAcceptSameFrameMetadataWithoutInventingImageClock() {
        val gate = CameraTimestampGate(timeoutNs = 100)
        assertTrue(gate.observe(7, -1, 1, null) is CameraTimestampGate.Decision.Wait)
        val accepted = gate.observe(8, -1, 50, 900) as CameraTimestampGate.Decision.Accept
        assertEquals(900L, accepted.cameraNs)
        assertEquals("frame_metadata_sensor_timestamp", accepted.source)
        assertEquals(CameraTimestampGate.Decision.Duplicate, gate.observe(9, 900, 51, 900))
        assertTrue(gate.observe(10, 901, 52, 902) is CameraTimestampGate.Decision.Reject)
    }
    @Test fun missingClockTerminatesAndPositiveRegressionRejects() {
        val gate = CameraTimestampGate(timeoutNs = 100)
        assertTrue(gate.observe(7, 0, 10) is CameraTimestampGate.Decision.Wait)
        assertTrue(gate.observe(8, 0, 110) is CameraTimestampGate.Decision.Reject)
        val gate2 = CameraTimestampGate()
        assertTrue(gate2.observe(7, 200, 10) is CameraTimestampGate.Decision.Accept)
        assertTrue(gate2.observe(8, 199, 11) is CameraTimestampGate.Decision.Reject)
    }
    @Test fun ptsUsesActualVariableCadenceAndRetainsSubmicrosecondOrdering() {
        val pts = FramePts()
        assertEquals(0L, pts.allocate(1_000_000, 1_000_000))
        assertEquals(33_333L, pts.allocate(34_333_999, 1_000_000))
        assertEquals(33_334L, pts.allocate(34_334_000, 1_000_000))
        assertEquals(100_000L, pts.allocate(101_000_000, 1_000_000))
    }
    @Test fun codecPlaneCopyHandlesPaddingPixelStrideAndPositionWithoutChangingSource() {
        fun plane(buffer: ByteBuffer, row: Int, pixel: Int): Image.Plane = Mockito.mock(Image.Plane::class.java).also {
            Mockito.`when`(it.buffer).thenReturn(buffer); Mockito.`when`(it.rowStride).thenReturn(row); Mockito.`when`(it.pixelStride).thenReturn(pixel)
        }
        fun image(planes: Array<Image.Plane>): Image = Mockito.mock(Image::class.java).also {
            Mockito.`when`(it.width).thenReturn(4); Mockito.`when`(it.height).thenReturn(2); Mockito.`when`(it.planes).thenReturn(planes)
        }
        val sy = ByteBuffer.wrap(byteArrayOf(99,1,2,3,4,99,99,5,6,7,8)).apply { position(1) }
        val su = ByteBuffer.wrap(byteArrayOf(99,21,99,22)).apply { position(1) }
        val sv = ByteBuffer.wrap(byteArrayOf(31,99,32))
        val dy = ByteBuffer.allocate(20).apply { position(2) }
        val du = ByteBuffer.allocate(8).apply { position(1) }
        val dv = ByteBuffer.allocate(8)
        H264RgbEncoder.copyYuv(image(arrayOf(plane(sy,6,1),plane(su,4,2),plane(sv,4,2))),
            image(arrayOf(plane(dy,8,1),plane(du,6,2),plane(dv,6,2))))
        assertEquals(1, sy.position()); assertEquals(1, su.position()); assertEquals(0, sv.position())
        assertEquals(listOf<Byte>(1,2,3,4), (2..5).map { dy.get(it) })
        assertEquals(listOf<Byte>(5,6,7,8), (10..13).map { dy.get(it) })
        assertEquals(21.toByte(), du.get(1)); assertEquals(22.toByte(), du.get(3))
        assertEquals(31.toByte(), dv.get(0)); assertEquals(32.toByte(), dv.get(2))
    }
    @Test fun annexBAndLengthPrefixedPacketsNormalizeAndBSliceIsRejected() {
        val idr = byteArrayOf(0x65, 0xb8.toByte())
        assertArrayEquals(idr, AnnexB.nals(byteArrayOf(0,0,0,2) + idr).single())
        assertArrayEquals(idr, AnnexB.nals(AnnexB.join(listOf(idr))).single())
        assertFalse(AnnexB.isBFrame(idr))
        assertTrue(AnnexB.isBFrame(byteArrayOf(0x41, 0xa0.toByte())))
    }
}
