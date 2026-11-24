package open.fpvlabs.stera.ar_recorder.encoding

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.nio.ByteBuffer

class YuvPlaneCopierTest {
    private val copier = YuvPlaneCopier()

    @Test fun packedRowsHonorPositionsAndLeavePaddingUntouched() {
        val src = ByteBuffer.wrap(byteArrayOf(-1, 1, 2, -1, -1, 3, 4)).apply { position(1) }
        val dst = ByteBuffer.wrap(ByteArray(8) { -1 }).apply { position(2); limit(7) }
        copier.copy(2, 2, src, 4, 1, dst, 3, 1)
        assertArrayEquals(byteArrayOf(-1, -1, 1, 2, -1, 3, 4, -1), dst.array())
        assertEquals(1, src.position())
        assertEquals(2, dst.position())
        assertEquals(7, dst.limit())
    }

    @Test fun interleavedChromaCopiesNeitherPartnerSamplesNorTrailingPadding() {
        val packedU = ByteBuffer.wrap(byteArrayOf(1, 2, 3, 4))
        val interleavedV = ByteBuffer.wrap(byteArrayOf(7, -1, 8, -1, -1, 9, -1, 10))
        val bytes = ByteBuffer.wrap(ByteArray(10) { -1 })
        val u = bytes.duplicate().apply { position(1); limit(9) }
        val v = bytes.duplicate().apply { position(2) }
        copier.copy(2, 2, packedU, 2, 1, u, 5, 2)
        copier.copy(2, 2, interleavedV, 5, 2, v, 5, 2)
        assertArrayEquals(byteArrayOf(-1, 1, 7, 2, 8, -1, 3, 9, 4, 10), bytes.array())
    }

    @Test fun interleavedSourcePacksToPlanarDestination() {
        val src = ByteBuffer.wrap(byteArrayOf(-1, 1, -1, 2, -1, 3, -1, 4)).apply { position(1) }
        val dst = ByteBuffer.wrap(ByteArray(4))
        copier.copy(2, 2, src, 4, 2, dst, 2, 1)
        assertArrayEquals(byteArrayOf(1, 2, 3, 4), dst.array())
    }

    @Test fun shortLastRowIsRejectedBeforeAnyWrites() {
        val src = ByteBuffer.wrap(byteArrayOf(1, 2, -1, 3))
        val dst = ByteBuffer.wrap(ByteArray(4) { -1 })
        assertThrows(IllegalArgumentException::class.java) {
            copier.copy(2, 2, src, 3, 1, dst, 2, 1)
        }
        assertArrayEquals(ByteArray(4) { -1 }, dst.array())
    }
}
