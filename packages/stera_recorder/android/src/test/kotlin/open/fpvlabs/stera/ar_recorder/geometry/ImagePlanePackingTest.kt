package open.fpvlabs.stera.ar_recorder.geometry

import java.nio.ByteBuffer
import org.junit.Assert.*
import org.junit.Test

class ImagePlanePackingTest {
    @Test fun planarYuvPreservesAsymmetricImageOrientationAndChromaOrder() {
        fun plane(values: ByteArray, row: Int) = ImagePlanePacking.Plane(ByteBuffer.wrap(values), row, 1)
        val result = ImagePlanePacking.yuv420ToNv21(4, 2,
            plane(byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8), 4),
            plane(byteArrayOf(10, 11), 2), plane(byteArrayOf(20, 21), 2))
        assertArrayEquals(byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8, 20, 10, 21, 11), result)
    }

    @Test fun paddedRowsInterleavedChromaAndBufferPositionAreRespected() {
        val y = ByteBuffer.wrap(byteArrayOf(99, 1, 2, 3, 4, 99, 99, 5, 6, 7, 8)); y.position(1)
        // Shared chroma storage; last sample has no trailing padding, as allowed by Android Image.
        val chroma = byteArrayOf(20, 10, 21, 11)
        val v = ByteBuffer.wrap(chroma); val u = ByteBuffer.wrap(chroma); u.position(1)
        val result = ImagePlanePacking.yuv420ToNv21(4, 2,
            ImagePlanePacking.Plane(y, 6, 1), ImagePlanePacking.Plane(u, 4, 2), ImagePlanePacking.Plane(v, 4, 2))
        assertArrayEquals(byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8, 20, 10, 21, 11), result)
        assertEquals(1, y.position()); assertEquals(1, u.position()); assertEquals(0, v.position())
    }

    @Test fun depth16PreservesBytesWithRowAndPixelPadding() {
        val bytes = byteArrayOf(1, 2, 99, 99, 3, 4, 99, 99, 99, 99, 5, 6, 99, 99, 7, 8)
        val result = ByteArray(8)
        ImagePlanePacking.copyPlane(ImagePlanePacking.Plane(ByteBuffer.wrap(bytes), 10, 4), 2, 2, 2, result)
        assertArrayEquals(byteArrayOf(1, 2, 3, 4, 5, 6, 7, 8), result)
    }

    @Test(expected = IllegalArgumentException::class)
    fun truncatedPlaneFailsRatherThanReadingUninitializedBytes() {
        ImagePlanePacking.copyPlane(ImagePlanePacking.Plane(ByteBuffer.wrap(byteArrayOf(1, 2, 3)), 2, 1), 2, 2, 1, ByteArray(4))
    }

    @Test(expected = IllegalArgumentException::class)
    fun partialCropIsRejectedRatherThanSilentlyChangingIntrinsics() {
        ImagePlanePacking.requireFullCrop(640, 480, 10, 0, 630, 480)
    }

    @Test(expected = IllegalArgumentException::class)
    fun oddYuvDimensionsAreRejected() {
        val p = ImagePlanePacking.Plane(ByteBuffer.allocate(12), 4, 1)
        ImagePlanePacking.yuv420ToNv21(3, 2, p, p, p)
    }
}
