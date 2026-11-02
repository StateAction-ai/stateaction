package open.fpvlabs.stera.ar_recorder.finalization

import open.fpvlabs.stera.ar_recorder.data.MCAPWriter
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.File
import java.io.RandomAccessFile
import java.security.MessageDigest

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class FinalizationPolicyTest {
    @get:Rule val temp = TemporaryFolder()

    @Test fun budgetCapsEveryPhaseAndThrowsWhenSpent() {
        var now = 0L
        val budget = FinalizationBudget(totalMs = 1_000L, nowMs = { now })
        assertEquals(400L, budget.phaseTimeoutMs("a", 400L))
        now = 800L
        assertEquals(200L, budget.phaseTimeoutMs("b", 15_000L))
        now = 1_000L
        assertTrue(budget.expired())
        assertThrows(FinalizationTimeout::class.java) { budget.phaseTimeoutMs("c", 10L) }
    }

    @Test fun lowStorageAndCriticalHeatStopWithReasonAndNeverReduceFidelity() {
        val reserve = CaptureResourceGuard.FINALIZATION_RESERVE_BYTES
        assertEquals(CaptureResourceGuard.Decision.Continue, CaptureResourceGuard.evaluate(reserve + 1, 3))
        val low = CaptureResourceGuard.evaluate(reserve, null) as CaptureResourceGuard.Decision.Stop
        assertEquals("low_storage", low.reason)
        val hot = CaptureResourceGuard.evaluate(10L * reserve, CaptureResourceGuard.THERMAL_CRITICAL) as CaptureResourceGuard.Decision.Stop
        assertEquals("critical_thermal", hot.reason)
        assertEquals(CaptureResourceGuard.Decision.Continue, CaptureResourceGuard.evaluate(10L * reserve, null))
        // Storage wins when both trip so the reserve reason is never hidden by heat.
        assertEquals("low_storage", (CaptureResourceGuard.evaluate(0, 5) as CaptureResourceGuard.Decision.Stop).reason)
    }

    @Test fun outcomeSeparatesContainerFromCaptureResult() {
        assertEquals("completed", CaptureOutcomePolicy.captureOutcome("completed", null, 0, null))
        assertEquals("interrupted", CaptureOutcomePolicy.captureOutcome("aborted", "low_storage", 0, null))
        assertEquals("failed", CaptureOutcomePolicy.captureOutcome("failed", "low_storage", 2, null))
        assertEquals("unresolved", CaptureOutcomePolicy.captureOutcome("aborted", "low_storage", 2, null))
        assertEquals("unresolved", CaptureOutcomePolicy.captureOutcome(null, null, 0, null))
        assertEquals("failed", CaptureOutcomePolicy.captureOutcome("aborted", "critical_thermal", 0, "disk full"))
        assertEquals("aborted", CaptureOutcomePolicy.captureOutcome("aborted", null, 0, null))
        assertEquals("failed" to "boom", CaptureOutcomePolicy.closeFor("low_storage", "boom"))
        assertEquals("aborted" to "interrupted:low_storage", CaptureOutcomePolicy.closeFor("low_storage", null))
        assertEquals("completed" to null, CaptureOutcomePolicy.closeFor(null, null))
        // A cleanly closed interruption is not quarantined; a closed failure or any unclosed file is.
        assertEquals("none", CaptureOutcomePolicy.recoveryState("closed", "interrupted"))
        assertEquals("none", CaptureOutcomePolicy.recoveryState("closed", "completed"))
        assertEquals("quarantined", CaptureOutcomePolicy.recoveryState("closed", "unresolved"))
        assertEquals("quarantined", CaptureOutcomePolicy.recoveryState("closed", "failed"))
        assertEquals("quarantined", CaptureOutcomePolicy.recoveryState("unclosed", "completed"))
    }

    private fun mcap(finish: Boolean): File {
        val file = temp.newFile(if (finish) "closed.mcap" else "open.mcap")
        val writer = MCAPWriter()
        assertTrue(writer.open(file, profile = "", library = "test"))
        val schema = writer.addSchema("s", "jsonschema", "{}".toByteArray())
        val channel = writer.addChannel("/t", "json", schema, emptyMap())
        repeat(20) { writer.addMessage(channel, it * 1000L, it * 1000L, "{}".toByteArray(), it) }
        if (finish) writer.finish() else writer.forceFlushChunk()
        return file
    }

    @Test fun closedStateRequiresFinishedWriterAndClosingMagic() {
        val closed = mcap(true)
        assertEquals("closed", CaptureOutcomePolicy.containerState(true, closed))
        assertEquals("unclosed", CaptureOutcomePolicy.containerState(false, closed))
        val cut = temp.newFile("cut.mcap").also { closed.copyTo(it, overwrite = true) }
        RandomAccessFile(cut, "rw").use { it.setLength(cut.length() - 3) }
        assertEquals("unclosed", CaptureOutcomePolicy.containerState(true, cut))
        assertEquals("unclosed", CaptureOutcomePolicy.containerState(true, temp.newFile("empty.mcap")))
    }

    @Test fun salvageCopiesBytesDerivesIdentityAndNeverTouchesTheOriginal() {
        val base = temp.newFolder("sessions")
        val source = File(base, "session_x").also { it.mkdir() }
        val payload = ByteArray(300_000) { (it * 31).toByte() }
        File(source, "session_data_x.mcap").writeBytes(payload)
        File(source, "frame_log.csv").writeText("a,b\n")
        assertEquals("source_not_quarantined", (SalvageService.salvage(source, { 0L }, { 1L }) as SalvageService.Result.Refused).reason)
        RecoveryScanner.quarantine(source, "journal_phase_draining_encoder", 1L)
        val before = source.listFiles()!!.associate { it.name to it.readBytes().toList() }

        val result = SalvageService.salvage(source, { 0L }, { 42L }, reserveBytes = 0L) as SalvageService.Result.Salvaged
        val again = SalvageService.salvage(source, { 0L }, { 43L }, reserveBytes = 0L) as SalvageService.Result.Salvaged

        assertEquals(before, source.listFiles()!!.associate { it.name to it.readBytes().toList() }) // originals and marker untouched
        assertArrayEquals(payload, File(result.directory, "session_data_x.mcap").readBytes())
        assertFalse(File(result.directory, RecoveryScanner.MARKER).exists())
        val manifest = org.json.JSONObject(File(result.directory, SalvageService.MANIFEST).readText())
        assertEquals(result.derivedRecordingId, manifest.getString("derived_recording_id"))
        assertFalse(manifest.getBoolean("auto_admit"))
        assertEquals("salvaged_unverified", manifest.getString("capture_outcome"))
        assertEquals("byte_copy_no_repair_no_reencode", manifest.getString("derivation"))
        val expected = MessageDigest.getInstance("SHA-256").digest(payload).joinToString("") { "%02x".format(it) }
        val mcapRecord = manifest.getJSONArray("files").let { a -> (0 until a.length()).map { a.getJSONObject(it) }.first { it.getString("name").endsWith(".mcap") } }
        assertEquals(expected, mcapRecord.getString("sha256"))
        assertEquals(expected, mcapRecord.getString("copy_sha256"))
        assertTrue(result.parentDirectorySynced) // rename's parent entry forced (supported on this filesystem)
        assertEquals(result.derivedRecordingId, again.derivedRecordingId) // identity is a function of original bytes
        assertNotEquals(result.directory, again.directory)
        assertTrue(base.listFiles()!!.none { it.name.startsWith(".salvage_tmp_") })
        // The scanner never mistakes a derived directory for a session.
        assertEquals(0, RecoveryScanner.scan(base, { 0L }, { 1L }).newlyQuarantined.size)
    }

    @Test fun salvageRefusesWhenSpaceCannotCoverCopyAndReserve() {
        val source = temp.newFolder("sessions2", "session_y").also { File(it, "a.mcap").writeBytes(byteArrayOf(1)) }
        RecoveryScanner.quarantine(source, "x", 1L)
        val refused = SalvageService.salvage(source, { 0L }, { 1L }, reserveBytes = Long.MAX_VALUE / 2) as SalvageService.Result.Refused
        assertEquals("insufficient_space_for_copy_and_reserve", refused.reason)
    }
}
