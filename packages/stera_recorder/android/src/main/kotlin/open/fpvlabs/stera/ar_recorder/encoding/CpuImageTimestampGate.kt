package open.fpvlabs.stera.ar_recorder.encoding

/**
 * Checks successive images returned by Frame.acquireCameraImage(), which associates each image with the current
 * ARCore Frame. Image timestamps are source-specific and only compared to earlier timestamps from that source.
 */
internal class CpuImageTimestampGate {
    private var lastImageNs = 0L

    fun accept(imageNs: Long): Boolean {
        check(imageNs > 0 && imageNs >= lastImageNs) { "Missing or regressing camera image timestamp" }
        if (imageNs == lastImageNs) return false
        lastImageNs = imageNs
        return true
    }
}
