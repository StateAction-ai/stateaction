package open.fpvlabs.stera.ar_recorder.finalization

import open.fpvlabs.stera.ar_recorder.data.MCAPDatasetWriter
import open.fpvlabs.stera.ar_recorder.data.MCAPWriter
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.File
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/** SA-56 review fixes: real container fsync ordering/failure, empty-capture outcome, bounded phases and late workers. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class FinalizationDurabilityTest {
    @get:Rule val temp = TemporaryFolder()

    private fun datasetWriter(events: MutableList<String>, fail: Boolean = false): MCAPDatasetWriter {
        val writer = MCAPDatasetWriter(RuntimeEnvironment.getApplication(), "test", "35")
        writer.createSessionDirectory(temp.newFolder())
        writer.containerSyncHook = { stream ->
            // At sync time the footer and closing magic must already be flushed into the file.
            events += "container_sync:magic=${CaptureOutcomePolicy.hasClosingMagic(writer.getSessionDirectory()!!.let(::File).listFiles { f -> f.extension == "mcap" }!!.single())}"
            if (fail) throw IOException("injected container fsync failure")
            stream.fd.sync()
        }
        assertTrue(writer.initializeWriters())
        writer.writeCompressedRgbFrame(100L, byteArrayOf(1, 2, 3), 200L)
        return writer
    }

    @Test fun containerIsFsyncedAfterFlushAndBeforeAnyDurableMetadata() {
        val events = mutableListOf<String>()
        val writer = datasetWriter(events)
        assertFalse(writer.containerDurable)
        assertTrue(writer.createSpatialDataZip().first)
        events += "metadata"
        writer.writeMetadata(mapOf("container_state" to "closed"))
        events += "journal_final"
        assertEquals(listOf("container_sync:magic=true", "metadata", "journal_final"), events)
        assertTrue(writer.containerDurable)
        assertEquals(true, writer.sessionDirectorySynced)
        writer.finalize()
    }

    @Test fun injectedContainerSyncFailureNeverYieldsAClosedContainerOrSuccessAck() {
        val events = mutableListOf<String>()
        val writer = datasetWriter(events, fail = true)
        val (ok, _, error) = writer.createSpatialDataZip()
        assertFalse(ok)
        assertTrue(error!!.contains("injected container fsync failure"))
        assertFalse(writer.containerDurable)
        assertTrue(writer.getWriteFailure()!!.contains("injected container fsync failure"))
        val mcap = writer.getSessionDirectory()!!.let(::File).listFiles { f -> f.extension == "mcap" }!!.single()
        // The bytes (including a closing magic) may be in the page cache, but nothing may call that closed.
        assertEquals("unclosed", CaptureOutcomePolicy.containerState(ok && writer.containerDurable, mcap))
        writer.finalize() // a second finish must not resurrect durability
        assertFalse(writer.containerDurable)
    }

    @Test fun missingSyncableStreamFailsInsteadOfSilentlySkippingDurability() {
        val file = temp.newFile("x.mcap")
        val writer = MCAPWriter()
        assertTrue(writer.open(file, profile = "", library = "t"))
        MCAPWriter::class.java.getDeclaredField("fileStream").apply { isAccessible = true }.set(writer, null)
        assertThrows(IllegalStateException::class.java) { writer.finish() }
        assertFalse(writer.containerDurable)
    }

    @Test fun defaultProductionSyncPathProvesDurabilityAndReportsDirectorySync() {
        val file = temp.newFile("prod.mcap")
        val writer = MCAPWriter()
        assertTrue(writer.open(file, profile = "", library = "t"))
        writer.finish()
        assertTrue(writer.containerDurable)
        assertEquals(true, writer.sessionDirectorySynced)
        assertEquals(false, AtomicFiles.syncDirectoryReporting(File(temp.root, "missing_dir")))
    }

    @Test fun closeUsesOnlyTheExactWriterFilename() {
        val directory = temp.newFolder()
        val file = File(directory, "writer.mcap")
        val writer = MCAPWriter()
        assertTrue(writer.open(file))
        writer.finish()
        val finished = checkNotNull(writer.finishedMcap)
        assertEquals("writer.mcap", finished.relativePath)
        assertEquals(file, finished.findIn(directory))

        val decoy = file.copyTo(File(directory, "decoy.mcap"))
        assertNull(finished.findIn(directory))
        assertTrue(file.delete())
        assertTrue(decoy.isFile)
        assertNull(finished.findIn(directory))
    }

    @Test fun emptyCaptureWithCleanCloseIsFailedQuarantinedAndNeverFinalized() {
        val zeroFrames = "Recording failed: no RGB frames were saved. Diagnostic files were preserved."
        // Clean H.264 Close(outcome=completed), closed container, no writer error, zero frames written.
        val outcome = CaptureOutcomePolicy.captureOutcome("completed", null, 0L, null, zeroFrames)
        assertEquals("failed", outcome)
        assertEquals("quarantined", CaptureOutcomePolicy.recoveryState(CaptureOutcomePolicy.CLOSED, outcome))
        assertFalse(CaptureOutcomePolicy.mayPublishFinalized(durablyFinal = true, captureFailure = zeroFrames))
        assertTrue(CaptureOutcomePolicy.mayPublishFinalized(durablyFinal = true, captureFailure = null))
        // A valid take is unchanged.
        assertEquals("completed", CaptureOutcomePolicy.captureOutcome("completed", null, 0L, null, null))
        // And the on-disk consequence: the quarantine marker the recorder writes for it keeps the original beside it.
        val dir = temp.newFolder("session_empty"); File(dir, "a.mcap").writeBytes(byteArrayOf(1))
        val journal = FinalizationJournal.begin(dir, "r")
        journal.advance(FinalizationPhase.FINALIZING_METADATA, containerState = "closed", captureOutcome = outcome)
        RecoveryScanner.quarantine(dir, "capture_outcome_$outcome", 1L)
        assertTrue(File(dir, RecoveryScanner.MARKER).isFile)
        assertEquals(FinalizationPhase.FINALIZING_METADATA, (FinalizationJournal.read(dir) as FinalizationJournal.ReadResult.Present).entry.phase)
        assertEquals(1, RecoveryScanner.scan(dir.parentFile, { 0L }, { 1L }).alreadyQuarantined.size)
    }

    @Test fun firstJournalWriteFailureIsReportedAndStartCannotBeginWithoutJournal() {
        val missing = File(temp.root, "no_such_session_dir")
        assertThrows(IOException::class.java) { FinalizationJournal.begin(missing, "r") }
        val dir = temp.newFolder("session_ok")
        val journal = FinalizationJournal.begin(dir, "r")
        // Break the directory so the first STOPPING write fails: advance throws and the phase on disk stays CAPTURING.
        dir.listFiles()!!.forEach { it.delete() }; dir.delete()
        assertThrows(IOException::class.java) { journal.advance(FinalizationPhase.STOPPING) }
    }

    @Test fun phaseRunnerReturnsResultsAndPropagatesFailures() {
        var now = 0L
        val runner = BoundedPhaseRunner()
        val budget = FinalizationBudget(totalMs = 45_000L, nowMs = { now })
        assertEquals(7, runner.run(budget, "ok", 1_000L) { 7 })
        assertThrows(IllegalStateException::class.java) { runner.run(budget, "boom", 1_000L) { throw IllegalStateException("x") } }
        assertFalse(runner.hasLateWork())
    }

    @Test fun phaseRunnerRefusesToStartOnceTheWholeDeadlineIsSpent() {
        var now = 0L
        val budget = FinalizationBudget(totalMs = 1_000L, nowMs = { now })
        now = 1_000L
        val ran = AtomicBoolean(false)
        assertThrows(FinalizationTimeout::class.java) { BoundedPhaseRunner().run(budget, "close", 500L) { ran.set(true) } }
        assertFalse(ran.get())
    }

    @Test fun slowCloseTimesOutWithoutClaimingDoneAndLateWorkerCannotPublish() {
        val budget = FinalizationBudget(totalMs = 45_000L, nowMs = { System.nanoTime() / 1_000_000L })
        val runner = BoundedPhaseRunner()
        val release = CountDownLatch(1)
        val finished = CountDownLatch(1)
        val published = AtomicInteger(0)
        val started = System.nanoTime()
        val error = assertThrows(FinalizationTimeout::class.java) {
            runner.run(budget, "close_container", 150L) { token ->
                release.await(10, TimeUnit.SECONDS) // stands in for uninterruptible OS I/O
                if (!token.cancelled) published.incrementAndGet()
                finished.countDown()
            }
        }
        assertTrue("wait must be bounded by the cap", (System.nanoTime() - started) / 1_000_000L < 3_000L)
        assertTrue(error.message!!.contains("close_container"))
        assertTrue("the stalled worker must stay visible (uncertain latch / dispose guard)", runner.hasLateWork())
        release.countDown()
        assertTrue(finished.await(5, TimeUnit.SECONDS))
        assertEquals("a late worker must not publish after the deadline", 0, published.get())
        val until = System.nanoTime() + 5_000_000_000L
        while (runner.hasLateWork() && System.nanoTime() < until) Thread.sleep(10)
        assertFalse(runner.hasLateWork())
    }
}
