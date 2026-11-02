package open.fpvlabs.stera.ar_recorder.finalization

/**
 * One monotonic deadline for the whole stop sequence. Every wait (writer barrier, codec end of stream, container
 * close) takes `min(phaseCap, remaining)`, so the sum of waits can never exceed [totalMs]. Exceeding it throws
 * [FinalizationTimeout]; the recorder then reports the stop as uncertain and refuses a new Start in this process.
 */
class FinalizationBudget(val totalMs: Long = TOTAL_MS, private val nowMs: () -> Long) {
    private val startedMs = nowMs()

    fun remainingMs(): Long = (totalMs - (nowMs() - startedMs)).coerceAtLeast(0L)

    fun expired(): Boolean = remainingMs() == 0L

    /** Timeout for one phase; throws when the budget is already spent. */
    fun phaseTimeoutMs(phase: String, capMs: Long): Long {
        val remaining = remainingMs()
        if (remaining == 0L) throw FinalizationTimeout("Finalization budget of ${totalMs}ms exhausted before $phase")
        return minOf(capMs, remaining)
    }

    companion object {
        const val TOTAL_MS = 45_000L
        const val WRITER_BARRIER_CAP_MS = 15_000L
        const val ENCODER_EOS_CAP_MS = 10_000L
        const val CLOSE_CAP_MS = 15_000L
        const val METADATA_CAP_MS = 10_000L
    }
}

class FinalizationTimeout(message: String) : RuntimeException(message)
