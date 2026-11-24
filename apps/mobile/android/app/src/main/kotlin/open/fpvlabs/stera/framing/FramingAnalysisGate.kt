package open.fpvlabs.stera.framing

/** One job in flight, with 8 Hz as the ceiling even when inference is fast. */
internal class FramingAnalysisGate(private val intervalMs: Long = 125) {
    private var busy = false
    private var lastStartedAt: Long? = null

    @Synchronized
    fun tryAcquire(nowMs: Long): Boolean {
        val previous = lastStartedAt
        if (busy || (previous != null && nowMs - previous < intervalMs)) return false
        busy = true
        lastStartedAt = nowMs
        return true
    }

    @Synchronized
    fun release() {
        busy = false
    }
}


// Flutter inverts the SurfaceTexture sampling transform, then flips the Y
// axis. The transformed image's positive X axis gives the applied rotation.
internal fun surfaceTextureRotation(matrix: FloatArray): Int {
    val determinant = matrix[0] * matrix[5] - matrix[1] * matrix[4]
    if (determinant >= 0f) return 0
    val x = -matrix[5]
    val y = -matrix[1]
    return if (kotlin.math.abs(x) >= kotlin.math.abs(y)) {
        if (x >= 0f) 0 else 180
    } else {
        if (y >= 0f) 90 else 270
    }
}
