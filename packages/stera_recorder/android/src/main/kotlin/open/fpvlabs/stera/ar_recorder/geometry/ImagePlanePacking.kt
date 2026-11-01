package open.fpvlabs.stera.ar_recorder.geometry

import java.nio.ByteBuffer

/** Copies Android planes without assuming contiguous rows, planar chroma, or trailing padding. */
object ImagePlanePacking {
    data class Plane(val buffer: ByteBuffer, val rowStride: Int, val pixelStride: Int)

    fun copyPlane(plane: Plane, width: Int, height: Int, bytesPerSample: Int,
                  target: ByteArray, targetOffset: Int = 0, targetPixelStride: Int = bytesPerSample) {
        require(width > 0 && height > 0 && bytesPerSample > 0)
        require(plane.pixelStride >= bytesPerSample && plane.rowStride >= (width - 1) * plane.pixelStride + bytesPerSample)
        require(targetPixelStride >= bytesPerSample && targetOffset >= 0)
        val source = plane.buffer.duplicate()
        val start = source.position()
        val required = (height - 1).toLong() * plane.rowStride + (width - 1).toLong() * plane.pixelStride + bytesPerSample
        require(required <= source.remaining()) { "Image plane is truncated" }
        require(targetOffset.toLong() + (width.toLong() * height - 1) * targetPixelStride + bytesPerSample <= target.size)
        if (plane.pixelStride == bytesPerSample && targetPixelStride == bytesPerSample) {
            val rowBytes = width * bytesPerSample
            for (y in 0 until height) {
                source.position(start + y * plane.rowStride)
                source.get(target, targetOffset + y * rowBytes, rowBytes)
            }
            return
        }
        for (y in 0 until height) {
            for (x in 0 until width) {
                val input = start + y * plane.rowStride + x * plane.pixelStride
                val output = targetOffset + (y * width + x) * targetPixelStride
                for (byte in 0 until bytesPerSample) target[output + byte] = source.get(input + byte)
            }
        }
    }

    fun yuv420ToNv21(width: Int, height: Int, y: Plane, u: Plane, v: Plane): ByteArray {
        require(width > 0 && height > 0 && width % 2 == 0 && height % 2 == 0) {
            "NV21 JPEG encoding requires even full image dimensions"
        }
        val size = Math.multiplyExact(width, height)
        val output = ByteArray(Math.addExact(size, size / 2))
        copyPlane(y, width, height, 1, output)
        copyPlane(v, width / 2, height / 2, 1, output, size, 2)
        copyPlane(u, width / 2, height / 2, 1, output, size + 1, 2)
        return output
    }

    /** Cropping silently changes K; this contract deliberately records the entire native image. */
    fun requireFullCrop(width: Int, height: Int, left: Int, top: Int, right: Int, bottom: Int) {
        require(left == 0 && top == 0 && right == width && bottom == height) {
            "Partial Image.cropRect is unsupported by the native full-frame geometry contract"
        }
    }
}
