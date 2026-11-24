package open.fpvlabs.stera.ar_recorder.encoding

import open.fpvlabs.stera.ar_recorder.diagnostics.captureTrace

/** Aggregates elapsed time without allocating per-frame samples. Read after the producer and writer barriers. */
internal class StageTiming(private val section: String) {
    private var calls = 0L
    private var totalNs = 0L
    private var maxNs = 0L

    inline fun <T> measure(block: () -> T): T {
        val started = System.nanoTime()
        try {
            return captureTrace(section, block)
        } finally {
            record(System.nanoTime() - started)
        }
    }

    fun record(durationNs: Long) {
        calls++
        totalNs += durationNs
        maxNs = maxOf(maxNs, durationNs)
    }

    fun report(): Map<String, Long> = mapOf("calls" to calls, "total_ns" to totalNs, "max_ns" to maxNs)
}
