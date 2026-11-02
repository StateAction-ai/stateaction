package open.fpvlabs.stera.ar_recorder.finalization

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class FinalizationJournalAndRecoveryTest {
    @get:Rule val temp = TemporaryFolder()
    private val id = "0b6f5e1c-3d2a-4c8e-9f1a-5e2d7c4b3a19"
    private var mono = 0L

    private fun session(name: String, mcap: ByteArray? = byteArrayOf(1, 2, 3), metadata: Boolean = false): File {
        val dir = temp.newFolder("base", name)
        mcap?.let { File(dir, "session_data_x.mcap").writeBytes(it) }
        if (metadata) File(dir, "metadata.json").writeText("{}")
        return dir
    }

    private fun scan(base: File, max: Int = 128, budget: Long = 1_500L) =
        RecoveryScanner.scan(base, { mono }, { 1_800_000_000_000L }, max, budget)

    @Test fun phasesPersistAndOnlyMoveForward() {
        val dir = session("session_a")
        val journal = FinalizationJournal.begin(dir, id)
        assertEquals(FinalizationPhase.CAPTURING, (FinalizationJournal.read(dir) as FinalizationJournal.ReadResult.Present).entry.phase)
        journal.advance(FinalizationPhase.STOPPING, stopReason = "low_storage")
        journal.advance(FinalizationPhase.DRAINING_ENCODER)
        val entry = (FinalizationJournal.read(dir) as FinalizationJournal.ReadResult.Present).entry
        assertEquals(FinalizationPhase.DRAINING_ENCODER, entry.phase)
        assertEquals("low_storage", entry.stopReason)
        assertEquals(2L, entry.sequence)
        assertThrows(IllegalStateException::class.java) { journal.advance(FinalizationPhase.STOPPING) }
        journal.advance(FinalizationPhase.FINALIZED, containerState = "closed", captureOutcome = "interrupted")
        assertThrows(IllegalStateException::class.java) { journal.advance(FinalizationPhase.FINALIZED) }
        assertTrue(File(dir, FinalizationJournal.FILE_NAME).readText().contains("\"final\":true"))
        assertEquals(listOf(FinalizationJournal.FILE_NAME, "session_data_x.mcap"), dir.list()!!.sorted()) // no temp leftovers
    }

    @Test fun beginRefusesToReuseAJournal() {
        val dir = session("session_a")
        FinalizationJournal.begin(dir, id)
        assertThrows(IllegalStateException::class.java) { FinalizationJournal.begin(dir, id) }
    }

    @Test fun everyNonFinalPhaseIsQuarantinedWithoutTouchingOriginals() {
        val base = temp.newFolder("base2")
        val originals = mutableMapOf<String, ByteArray>()
        for (phase in FinalizationPhase.values().filter { it != FinalizationPhase.FINALIZED }) {
            val dir = File(base, "session_${phase.name.lowercase()}").also { it.mkdir() }
            File(dir, "session_data_x.mcap").writeBytes(ByteArray(100) { (it + phase.ordinal).toByte() })
            val journal = FinalizationJournal.begin(dir, id)
            for (next in FinalizationPhase.values().filter { it.ordinal in 1..phase.ordinal }) journal.advance(next)
            originals[dir.name] = File(dir, "session_data_x.mcap").readBytes()
        }
        val report = scan(base)
        assertEquals(5, report.newlyQuarantined.size)
        for ((name, bytes) in originals) {
            val dir = File(base, name)
            assertArrayEquals(bytes, File(dir, "session_data_x.mcap").readBytes())
            val marker = JSONObject(File(dir, RecoveryScanner.MARKER).readText())
            assertEquals("quarantined", marker.getString("recovery_state"))
            assertEquals("never_automatic", marker.getString("admission"))
            assertEquals("unverified", marker.getString("container_state"))
            assertEquals(id, marker.getString("recording_id"))
            assertTrue(marker.getString("reason").startsWith("journal_phase_"))
        }
        val again = scan(base)
        assertEquals(0, again.newlyQuarantined.size)
        assertEquals(5, again.alreadyQuarantined.size)
    }

    @Test fun finalizedAndLegacySessionsAreLeftAlone() {
        val base = temp.newFolder("base3")
        val done = File(base, "session_done").also { it.mkdir() }
        FinalizationJournal.begin(done, id).advance(FinalizationPhase.FINALIZED)
        File(base, "session_legacy").also { it.mkdir(); File(it, "metadata.json").writeText("{}") }
        File(base, "session_empty").mkdir()
        val report = scan(base)
        assertEquals(0, report.newlyQuarantined.size)
        assertEquals(1, report.finalized)
        assertEquals(2, report.legacyWithoutJournal)
        assertFalse(File(done, RecoveryScanner.MARKER).exists())
    }

    @Test fun missingJournalWithContainerAndUnreadableJournalAreQuarantined() {
        val base = temp.newFolder("base4")
        File(base, "session_nojournal").also { it.mkdir(); File(it, "session_data_x.mcap").writeBytes(byteArrayOf(9)) }
        File(base, "session_garbage").also {
            it.mkdir(); File(it, FinalizationJournal.FILE_NAME).writeText("{\"version\":1,\"recording_id\":"); File(it, "session_data_x.mcap").writeBytes(byteArrayOf(9))
        }
        val report = scan(base)
        assertEquals(listOf("session_garbage", "session_nojournal"), report.newlyQuarantined)
        assertEquals("journal_unreadable", JSONObject(File(base, "session_garbage/${RecoveryScanner.MARKER}").readText()).getString("reason"))
        assertEquals("no_journal_no_metadata", JSONObject(File(base, "session_nojournal/${RecoveryScanner.MARKER}").readText()).getString("reason"))
    }

    @Test fun scanIsBoundedByCountAndTime() {
        val base = temp.newFolder("base5")
        repeat(10) { i -> File(base, "session_%02d".format(i)).also { it.mkdir(); File(it, "a.mcap").writeBytes(byteArrayOf(1)) } }
        val byCount = scan(base, max = 3)
        assertTrue(byCount.truncated)
        assertEquals(3, byCount.scanned)
        val clock = intArrayOf(0)
        val byTime = RecoveryScanner.scan(base, { (clock[0]++ * 600).toLong() }, { 1L }, 128, 1_500L)
        assertTrue(byTime.truncated)
        assertTrue(byTime.scanned < 10)
    }
}
