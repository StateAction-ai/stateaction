package open.fpvlabs.stera.upload

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-JVM policy tests for the OS entry points' shared loop and for the UIDT scheduling guard.
 * They prove the decisions; the real JobScheduler/WorkManager behavior is checked on the emulator.
 */
class RunLoopAndSchedulingTest {
    private class FakePort(
        val outcomes: ArrayDeque<RunOutcome?>,
        var runnable: Boolean = true,
        val throwOnRun: Throwable? = null,
    ) : RunPort {
        var resumePrompts = 0
        var failSafeReasons = ArrayList<String>()
        override fun runNext(cancel: CancelToken): RunOutcome? {
            throwOnRun?.let { throw it }
            return outcomes.removeFirstOrNull()
        }
        override fun hasRunnable() = runnable
        override fun needsResume() { resumePrompts++ }
        override fun failSafe(reason: String) { failSafeReasons += reason }
    }

    @Test fun anEmptyQueueSucceedsWithoutRetry() {
        val p = FakePort(ArrayDeque(listOf(null)), runnable = false)
        assertFalse(runLoop(p, CancelToken()))
    }

    @Test fun aRunThatFindsTheRunLockBusyWhileWorkRemainsAsksTheOsToRetryInsteadOfSucceeding() {
        // runNext returns null both for "nothing" and "lock held"; runnable work left behind means retry.
        val p = FakePort(ArrayDeque(listOf(null)), runnable = true)
        assertTrue("a stranded queue must be retried", runLoop(p, CancelToken()))
    }

    @Test fun backoffAndPolicyWaitsRetryButTerminalStatesContinueToTheNextTask() {
        val p = FakePort(
            ArrayDeque(
                listOf(
                    RunOutcome(TaskState.UPLOADED, null, null),
                    RunOutcome(TaskState.BACKOFF, "control_unavailable", 1L),
                ),
            ),
        )
        assertTrue(runLoop(p, CancelToken()))
        val q = FakePort(ArrayDeque(listOf(RunOutcome(TaskState.UPLOADED, null, null), null)), runnable = false)
        assertFalse(runLoop(q, CancelToken()))
    }

    @Test fun anUnexpectedExceptionBecomesADurableSafeStateAndAPromptNotASilentRunning() {
        val p = FakePort(ArrayDeque(), throwOnRun = IllegalStateException("secret https://x?sig=1"))
        assertFalse("no endless OS retry loop for a bug", runLoop(p, CancelToken()))
        assertEquals(listOf("engine_error"), p.failSafeReasons)
    }

    @Test fun anUnsettledOutcomeStopsTheLoopAndNeverRetriesAgainstAnUnknownJournalWrite() {
        val p = FakePort(
            ArrayDeque(listOf(RunOutcome(TaskState.NEEDS_VISIBLE_RESUME, "journal_unavailable", null, unsettled = true))),
        )
        assertFalse(runLoop(p, CancelToken()))
        assertEquals(listOf("journal_unavailable"), p.failSafeReasons)
    }

    @Test fun aVisibleResumeOutcomeShowsThePrompt() {
        val p = FakePort(ArrayDeque(listOf(RunOutcome(TaskState.NEEDS_VISIBLE_RESUME, "session_required", null), null)), runnable = false)
        runLoop(p, CancelToken())
        assertEquals(1, p.resumePrompts)
    }

    @Test fun aFailingFailSafeNeverEscapesTheJobThread() {
        val p = object : RunPort {
            override fun runNext(cancel: CancelToken): RunOutcome? = throw IllegalStateException("x")
            override fun hasRunnable() = true
            override fun needsResume() {}
            override fun failSafe(reason: String) { throw IllegalStateException("prompt failed") }
        }
        assertFalse(runLoop(p, CancelToken()))
    }

    // ---- UIDT scheduling guard ---------------------------------------------------------------

    @Test fun aJobInfoBuilderFailureLeavesADurableNeedsVisibleResumeInsteadOfEscaping() {
        val marked = ArrayList<String>()
        val r = guardedUidtSchedule({ marked += it }) { throw IllegalArgumentException("bad job combination") }
        assertFalse(r.scheduled)
        assertEquals("uidt_job_invalid", r.reason)
        assertEquals(listOf("uidt_job_invalid"), marked)
    }

    @Test fun aMissingPermissionOrADeniedStartAreDurableToo() {
        val marked = ArrayList<String>()
        assertEquals("uidt_permission_missing", guardedUidtSchedule({ marked += it }) { throw SecurityException("no") }.reason)
        assertEquals("background_start_denied", guardedUidtSchedule({ marked += it }) { 0 }.reason)
        assertEquals(listOf("uidt_permission_missing", "background_start_denied"), marked)
        val ok = guardedUidtSchedule({ marked += it }) { 1 }
        assertTrue(ok.scheduled)
        assertNull(ok.reason)
        assertEquals(2, marked.size)
    }

    // ---- status owner scoping -------------------------------------------------------------------

    @Test fun statusExposesOnlyTheBoundOwnersTasks() {
        val r = Rig(java.nio.file.Files.createTempDirectory("sa57").toFile(), 250)
        r.bindOwner(OWNER)
        r.enqueue(OWNER)
        val g = r.gate.read()
        val all = { owner: String -> r.journal.all().filter { it.ownerId == owner } }
        val own = statusView(g, OWNER, all)
        assertEquals(1, (own["tasks"] as List<*>).size)
        val foreign = statusView(g, OTHER, all)
        assertTrue("a supplied owner that is not the bound one sees nothing", (foreign["tasks"] as List<*>).isEmpty())
        r.gate.unbind()
        assertTrue((statusView(r.gate.read(), OWNER, all)["tasks"] as List<*>).isEmpty())
    }
}
