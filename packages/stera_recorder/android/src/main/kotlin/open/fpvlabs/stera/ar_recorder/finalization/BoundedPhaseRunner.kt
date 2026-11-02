package open.fpvlabs.stera.ar_recorder.finalization

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.ConcurrentHashMap

/**
 * Runs one finalization phase (container close, zip, sidecar write) on a daemon worker and waits for it with a
 * timeout taken from the [FinalizationBudget]. Uninterruptible OS I/O cannot be cancelled, so a timeout does not claim
 * the work finished: it cancels the [Token], remembers the still-running worker ([hasLateWork]) and throws
 * [FinalizationTimeout], which the recorder turns into the uncertain latch and a quarantined, never-closed result.
 * Work must check [Token.cancelled] before every publishing step so a late worker cannot publish after the deadline.
 */
class BoundedPhaseRunner {
    class Token { private val flag = AtomicBoolean(false); val cancelled: Boolean get() = flag.get(); internal fun cancel() = flag.set(true) }

    private val late = ConcurrentHashMap.newKeySet<Thread>()

    /** True while a worker whose phase timed out is still executing (its I/O may still land on disk). */
    fun hasLateWork(): Boolean = late.any { it.isAlive }

    fun <T> run(budget: FinalizationBudget, phase: String, capMs: Long, work: (Token) -> T): T {
        val timeoutMs = budget.phaseTimeoutMs(phase, capMs)
        val token = Token()
        val done = CountDownLatch(1)
        var result: Result<T>? = null
        val worker = Thread({
            try { result = Result.success(work(token)) } catch (error: Throwable) { result = Result.failure(error) }
            finally { done.countDown(); late.remove(Thread.currentThread()) }
        }, "stera-finalize-$phase").apply { isDaemon = true }
        late.add(worker) // registered before start so a fast timeout can never miss it; removed by the worker when it ends
        worker.start()
        if (!done.await(timeoutMs, TimeUnit.MILLISECONDS)) {
            token.cancel()
            throw FinalizationTimeout("Finalization phase $phase did not finish within ${timeoutMs}ms; its I/O may still be running")
        }
        late.remove(worker)
        return result!!.getOrThrow()
    }
}
