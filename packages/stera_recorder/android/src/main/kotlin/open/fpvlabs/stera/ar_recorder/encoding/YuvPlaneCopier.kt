package open.fpvlabs.stera.ar_recorder.encoding

import java.nio.ByteBuffer

/** Copies one visible YUV plane between the camera and codec without touching padding or the other chroma plane. */
internal class YuvPlaneCopier {
    private var sourceRow = ByteArray(0)
    private var destinationRow = ByteArray(0)

    fun copy(
        width: Int,
        height: Int,
        source: ByteBuffer,
        sourceRowStride: Int,
        sourcePixelStride: Int,
        destination: ByteBuffer,
        destinationRowStride: Int,
        destinationPixelStride: Int,
    ) {
        val sourceBytes = rowBytes(width, sourcePixelStride)
        val destinationBytes = rowBytes(width, destinationPixelStride)
        requirePlane(source, height, sourceRowStride, sourceBytes)
        requirePlane(destination, height, destinationRowStride, destinationBytes)

        val src = source.duplicate()
        val dst = destination.duplicate()
        val srcStart = src.position()
        val dstStart = dst.position()

        if (sourcePixelStride == 1 && destinationPixelStride == 1) {
            if (sourceRowStride == width && destinationRowStride == width) {
                src.limit(srcStart + width * height)
                dst.put(src)
                return
            }
            for (row in 0 until height) {
                val srcOffset = srcStart + row * sourceRowStride
                src.limit(srcOffset + width)
                src.position(srcOffset)
                dst.position(dstStart + row * destinationRowStride)
                dst.put(src)
            }
            return
        }

        if (sourceRow.size < sourceBytes) sourceRow = ByteArray(sourceBytes)
        if (destinationRow.size < destinationBytes) destinationRow = ByteArray(destinationBytes)
        for (row in 0 until height) {
            src.position(srcStart + row * sourceRowStride)
            src.get(sourceRow, 0, sourceBytes)
            val dstOffset = dstStart + row * destinationRowStride
            dst.position(dstOffset)
            // Interleaved U/V planes can share storage. Preserve the bytes between this plane's samples.
            if (destinationPixelStride != 1) {
                dst.get(destinationRow, 0, destinationBytes)
                dst.position(dstOffset)
            }
            for (col in 0 until width) {
                destinationRow[col * destinationPixelStride] = sourceRow[col * sourcePixelStride]
            }
            dst.put(destinationRow, 0, destinationBytes)
        }
    }

    private fun rowBytes(width: Int, pixelStride: Int): Int {
        require(width > 0 && pixelStride > 0)
        return Math.addExact(Math.multiplyExact(width - 1, pixelStride), 1)
    }

    private fun requirePlane(buffer: ByteBuffer, height: Int, rowStride: Int, rowBytes: Int) {
        require(height > 0 && rowStride >= rowBytes)
        val required = (height - 1L) * rowStride + rowBytes
        require(required <= buffer.remaining()) { "YUV plane does not cover its visible samples" }
    }
}
