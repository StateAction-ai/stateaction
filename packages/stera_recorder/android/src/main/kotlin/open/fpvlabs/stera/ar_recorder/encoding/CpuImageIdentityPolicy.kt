package open.fpvlabs.stera.ar_recorder.encoding

/**
 * Decides whether the acquired CPU image is the capture whose native camera clock was accepted for this frame.
 *
 * The identity reference is the accepted native camera clock (`Frame.androidCameraTimestamp`, or the gated metadata
 * fallback), because that is the value written as the RGB clock. `Frame.timestamp` has an undefined time base: it is
 * kept as separate evidence and is never an equality requirement. No timestamp is invented or retimed.
 */
object CpuImageIdentityPolicy {
    enum class Verdict {
        /** Image timestamp equals the accepted camera clock. */
        IDENTICAL,
        /** Mismatch tolerated only by the explicitly unqualified simulation profile; counted, never a hardware pass. */
        MISMATCH_RECORDED_SIMULATION,
        /** Hardware mismatch: the image is a different capture. Counted terminal drop; never encoded as valid. */
        MISMATCH_REJECTED,
    }

    fun evaluate(simulation: Boolean, imageNs: Long, acceptedCameraNs: Long): Verdict = when {
        imageNs == acceptedCameraNs -> Verdict.IDENTICAL
        simulation -> Verdict.MISMATCH_RECORDED_SIMULATION
        else -> Verdict.MISMATCH_REJECTED
    }
}
