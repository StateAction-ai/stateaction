package open.fpvlabs.stera.ar_recorder

import android.content.Intent
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import open.fpvlabs.stera.ar_recorder.finalization.CaptureOutcomePolicy
import open.fpvlabs.stera.ar_recorder.finalization.CaptureResourceGuard
import open.fpvlabs.stera.ar_recorder.finalization.FinalizationJournal
import open.fpvlabs.stera.ar_recorder.finalization.FinalizationPhase
import open.fpvlabs.stera.ar_recorder.finalization.RecoveryScanner
import open.fpvlabs.stera.ar_recorder.finalization.SalvageService
import open.fpvlabs.stera.source_integrity.AndroidFdOps
import open.fpvlabs.stera.source_integrity.ConfinedFdHasher
import open.fpvlabs.stera.source_integrity.FdIdentity
import open.fpvlabs.stera.source_integrity.FdKey
import open.fpvlabs.stera.source_integrity.SourceReadIdentity

/**
 * SA-56 on the real ArRecorderImpl / ARCore / MediaCodec path of the accelerated emulator: reasoned stops, a stop
 * that dies at every journaled phase, and a genuine process death during capture followed by reopen. Each method is
 * run as its own `am instrument` stage by scripts/test_android_finalization_e2e.py (the crash stage kills the process
 * on purpose). Emulator only; no physical device.
 */
@RunWith(AndroidJUnit4::class)
class FinalizationLifecycleInstrumentedTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val config = mapOf<String, Any>(
        "rgbCodec" to "h264", "h264SimulationMode" to true, "recordRgb" to true, "recordImu" to true,
        "recordDepth" to false, "recordPointCloud" to false, "recordMesh" to false, "recordingHz" to 30, "rgbVideoHeight" to 480)

    private fun requireEmulator() = assertTrue("Emulator simulation only; physical execution is forbidden",
        android.os.Build.HARDWARE in setOf("ranchu", "goldfish"))

    private fun await(message: String, seconds: Long = 45, predicate: () -> Boolean) {
        val until = SystemClock.elapsedRealtime() + seconds * 1000
        while (!predicate()) { assertTrue(message, SystemClock.elapsedRealtime() < until); SystemClock.sleep(100) }
    }

    private fun launch(faults: Boolean = false): H264RecorderTestActivity {
        val activity = instrumentation.startActivitySync(
            Intent(instrumentation.context, H264RecorderTestActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                .putExtra("inject_writer_faults", faults)
        ) as H264RecorderTestActivity
        assertTrue("TextureView did not attach", activity.surfaceReady.await(15, TimeUnit.SECONDS))
        return activity
    }

    private fun ready(recorder: ArRecorderImpl) {
        var init: Map<String, Any?> = emptyMap()
        instrumentation.runOnMainSync { init = recorder.initializeSession(config) }
        assertEquals(init.toString(), true, init["success"])
        await("Controller did not become READY: ${recorder.getRecordingState()}") {
            val state = recorder.getRecordingState()
            assertNotEquals("Frame loop failed: $state", "ERROR", state["state"])
            state["state"] == "READY"
        }
    }

    private fun sha256(file: File): String = MessageDigest.getInstance("SHA-256").digest(file.readBytes()).joinToString("") { "%02x".format(it) }
    private fun hashes(dir: File) = dir.listFiles()!!.filter { it.isFile }.associate { it.name to sha256(it) }
    private fun receipt(name: String, json: JSONObject) = File(instrumentation.context.filesDir, name).writeText(json.toString(2))
    private fun closedMagic(dir: File): Boolean = dir.listFiles { f -> f.extension == "mcap" }!!.single().let(CaptureOutcomePolicy::hasClosingMagic)
    private fun journalPhase(dir: File) = (FinalizationJournal.read(dir) as FinalizationJournal.ReadResult.Present).entry.phase
    private fun metadata(dir: File) = JSONObject(File(dir, "metadata.json").readText())
    private fun sessions(activity: H264RecorderTestActivity) = File(activity.getExternalFilesDir(null), "ar_sessions")

    @Test fun completedStopPublishesFinalSourceClosure() {
        requireEmulator()
        val activity = launch(); val recorder = activity.recorder
        try {
            ready(recorder)
            val start = recorder.startRecording(config)
            assertEquals(start.toString(), true, start["success"])
            val dir = File(start["outputDirectory"] as String)
            assertFalse("An open take must not have a source closure", File(dir, "metadata.json").takeIf { it.exists() }?.readText()?.contains("stateaction.native_source_close.v1") == true)
            SystemClock.sleep(3500)
            val stop = recorder.stopRecording()
            assertEquals(stop.toString(), true, stop["success"])
            assertEquals("completed", stop["captureOutcome"])
            assertEquals("closed", stop["containerState"])
            assertEquals("none", stop["recoveryState"])
            val closure = JSONObject(stop["sourceClosure"] as Map<*, *>)
            assertEquals("stateaction.native_source_close.v1", closure.getString("schema"))
            assertEquals(stop["recordingId"], closure.getString("recordingId"))
            assertEquals(stop["finalizationToken"], closure.getString("finalizationToken"))
            assertTrue(closure.getBoolean("eosDrained")); assertTrue(closure.getBoolean("footerClosed"))
            assertEquals(0, closure.getInt("unresolvedFrames"))
            assertTrue(closure.getString("durationMicros").toLong() > 0)
            val sidecar = metadata(dir)
            assertEquals(closure.getString("finalizationToken"), sidecar.getJSONObject("source_closure").getString("finalizationToken"))
            assertEquals(closure.getString("recordingId"), sidecar.getJSONObject("source_closure").getString("recordingId"))
            assertTrue(sidecar.getBoolean("container_fsync"))
            assertTrue(closedMagic(dir)); assertEquals(FinalizationPhase.FINALIZED, journalPhase(dir))
            val files = closure.getJSONArray("files")
            assertEquals(2, files.length())
            val closeIdentity = JSONObject(stop["sourceIdentity"] as Map<*, *>)
            val persisted = JSONObject(File(dir, FinalizationJournal.FILE_NAME).readText()).getJSONObject("source_identity")
            assertEquals(stop["finalizationToken"], closeIdentity.getString("finalizationToken"))
            assertEquals(persisted.toString(), closeIdentity.toString())
            assertFalse(sidecar.has("source_identity"))
            assertEquals(files.length(), closeIdentity.getJSONObject("files").length())
            val directory = closeIdentity.getJSONObject("directory")
            val rootKey = FdKey(directory.getString("dev").toLong(), directory.getString("inode").toLong())
            for (i in 0 until files.length()) {
                val file = files.getJSONObject(i)
                val relativePath = file.getString("relativePath")
                val identity = closeIdentity.getJSONObject("files").getJSONObject(relativePath)
                fun field(name: String) = identity.getString(name).toLong()
                val expected = FdIdentity(field("dev"), field("inode"), field("size"), field("mtimeNs"), field("ctimeNs"))
                val result = ConfinedFdHasher(AndroidFdOps(), SourceReadIdentity(expected, rootKey))
                    .hash(dir.canonicalPath, relativePath, 64 * 1024, 1L shl 30) { false }
                assertTrue(file.getBoolean("required"))
                assertEquals(expected, result.identity)
                assertEquals(File(dir, relativePath).length(), result.sizeBytes)
                assertFalse(file.has("sha256")); assertFalse(file.has("sizeBytes"))
            }
            val counts = closure.getJSONObject("counts")
            assertTrue(counts.getString("video_frames").toLong() > 0)
            assertEquals(sidecar.getJSONObject("h264_terminal").getJSONObject("evidence").getLong("video_messages"), counts.getString("video_frames").toLong())
            val channels = closure.getJSONArray("channels")
            assertTrue((0 until channels.length()).any { channels.getJSONObject(it).getString("schema_name") == "geometry_msgs/msg/PoseStamped" })
            assertTrue((0 until channels.length()).all { channels.getJSONObject(it).getString("clock_domain") == "unix" })
            receipt("source-closure.json", JSONObject().put("status", "passed").put("directory", dir.name).put("stop", JSONObject(stop)))
        } finally {
            recorder.disposeSession(); instrumentation.runOnMainSync { activity.finish() }
        }
    }

    @Test fun sameNameMcapReplacementAfterWriterCloseDoesNotPublishSourceIdentity() {
        requireEmulator()
        val activity = launch(); val recorder = activity.recorder
        try {
            ready(recorder)
            val start = recorder.startRecording(config)
            assertEquals(start.toString(), true, start["success"])
            val dir = File(start["outputDirectory"] as String)
            SystemClock.sleep(3500)
            var swapped: Pair<File, File>? = null
            recorder.phaseFaultHook = { phase ->
                if (phase == FinalizationPhase.FINALIZING_METADATA) {
                    val path = dir.listFiles { f -> f.extension == "mcap" }!!.single()
                    val original = File(dir, "${path.name}.original")
                    assertTrue(path.renameTo(original))
                    original.copyTo(path)
                    swapped = original to path
                }
            }
            val stop = recorder.stopRecording()
            assertEquals(stop.toString(), true, stop["success"])
            assertEquals("completed", stop["captureOutcome"])
            assertNull(stop["sourceClosure"])
            assertNull(stop["sourceIdentity"])
            val journal = JSONObject(File(dir, FinalizationJournal.FILE_NAME).readText())
            assertFalse(journal.has("source_identity"))
            val (original, replacement) = checkNotNull(swapped)
            assertEquals(sha256(original), sha256(replacement))
        } finally {
            recorder.phaseFaultHook = null
            recorder.disposeSession(); instrumentation.runOnMainSync { activity.finish() }
        }
    }

    @Test fun reasonedStopsCloseCleanlyAndStayInterrupted() {
        requireEmulator()
        val activity = launch(); val recorder = activity.recorder
        val out = JSONObject().put("takes", JSONArray())
        try {
            ready(recorder)
            val cases = listOf("low_storage" to (CaptureResourceGuard.FINALIZATION_RESERVE_BYTES to null as Int?),
                "critical_thermal" to (10L * CaptureResourceGuard.FINALIZATION_RESERVE_BYTES to CaptureResourceGuard.THERMAL_CRITICAL))
            for ((reason, probe) in cases) {
                val start = recorder.startRecording(config)
                assertEquals(start.toString(), true, start["success"])
                val dir = File(start["outputDirectory"] as String)
                assertEquals(FinalizationPhase.CAPTURING, journalPhase(dir))
                SystemClock.sleep(2500)
                recorder.resourceProbeOverride = { probe }
                await("Controlled stop for $reason did not finalize", 40) {
                    recorder.getRecordingState().let { it["state"] == "READY" && it["isRecording"] == false }
                }
                recorder.resourceProbeOverride = null
                val meta = metadata(dir)
                assertEquals(reason, meta.getString("interruption_reason"))
                assertEquals("closed", meta.getString("container_state"))
                assertEquals("interrupted", meta.getString("capture_outcome"))
                assertEquals("none", meta.getString("recovery_state"))
                assertEquals("not_evaluated_by_recorder", meta.getString("upload_admission"))
                assertEquals("simulation_640x480_30fps", meta.getString("video_profile")) // fidelity never reduced
                assertTrue(closedMagic(dir))
                assertEquals(FinalizationPhase.FINALIZED, journalPhase(dir))
                assertFalse(File(dir, RecoveryScanner.MARKER).exists())
                out.getJSONArray("takes").put(JSONObject().put("reason", reason).put("directory", dir.name)
                    .put("frames_written", meta.getJSONObject("h264_terminal").getJSONObject("evidence").getLong("written")))
            }
            out.put("status", "passed")
        } finally {
            receipt("finalization-reasoned-stops.json", out)
            recorder.disposeSession(); instrumentation.runOnMainSync { activity.finish() }
        }
    }

    @Test fun stopFaultsAtEveryPhaseStayRecoveryRequiredAndReopenSucceeds() {
        requireEmulator()
        val out = JSONObject().put("phases", JSONArray())
        val phases = listOf(FinalizationPhase.STOPPING, FinalizationPhase.DRAINING_ENCODER, FinalizationPhase.CLOSING_CONTAINER, FinalizationPhase.FINALIZING_METADATA)
        try {
            for (phase in phases) {
                val activity = launch(); val recorder = activity.recorder
                ready(recorder)
                val start = recorder.startRecording(config)
                assertEquals(start.toString(), true, start["success"])
                val dir = File(start["outputDirectory"] as String)
                SystemClock.sleep(2000)
                recorder.phaseFaultHook = { if (it == phase) throw IllegalStateException("injected death at $it") }
                val stop = recorder.stopRecording()
                recorder.phaseFaultHook = null
                assertEquals(stop.toString(), false, stop["success"])
                assertEquals("ERROR", recorder.getRecordingState()["state"])
                assertEquals("Journal must stop at the faulted phase", phase, journalPhase(dir))
                val marker = JSONObject(File(dir, RecoveryScanner.MARKER).readText())
                assertEquals("quarantined", marker.getString("recovery_state"))
                assertEquals("never_automatic", marker.getString("admission"))
                // An ERROR stop must not allow an overlapping Start.
                assertEquals(false, recorder.startRecording(config)["success"])
                recorder.disposeSession(); instrumentation.runOnMainSync { activity.finish() }
                val before = hashes(dir)

                val again = launch(); val next = again.recorder
                ready(next)
                val second = next.startRecording(config)
                assertEquals(second.toString(), true, second["success"])
                assertTrue("Faulted source was not reported quarantined",
                    next.lastRecoveryReport!!.alreadyQuarantined.contains(dir.name) || next.lastRecoveryReport!!.newlyQuarantined.contains(dir.name))
                SystemClock.sleep(2000)
                val stopped = next.stopRecording()
                assertEquals(stopped.toString(), true, stopped["success"])
                assertEquals("completed", stopped["captureOutcome"])
                assertEquals("Reopen modified a quarantined source", before, hashes(dir))
                assertEquals(phase, journalPhase(dir))
                out.getJSONArray("phases").put(JSONObject().put("phase", phase.name).put("quarantined", dir.name)
                    .put("container_closed_by_dispose", closedMagic(dir)).put("reopen_take", File(stopped["outputDirectory"] as String).name))
                next.disposeSession(); instrumentation.runOnMainSync { again.finish() }
            }
            out.put("status", "passed")
        } finally {
            receipt("finalization-phase-faults.json", out)
        }
    }

    // ── Review fixes: container fsync ordering/failure, empty capture, first stop-journal write, slow close ──

    @Test fun containerFsyncPrecedesFinalMetadataAndSyncFailureFailsClosed() {
        requireEmulator()
        val out = JSONObject()
        val activity = launch(faults = true); val recorder = activity.recorder; val writer = activity.faultWriter!!
        try {
            ready(recorder)
            // Take 1: the real fsync runs while the journal is still CLOSING_CONTAINER, before final metadata/FINALIZED.
            val phases = mutableListOf<String>()
            var tokenAtSync: Boolean? = null
            val start = recorder.startRecording(config); assertEquals(start.toString(), true, start["success"])
            val dir = File(start["outputDirectory"] as String)
            writer.containerSyncProbe = { stream ->
                phases += journalPhase(dir).name
                tokenAtSync = File(dir, "metadata.json").readText().contains("\"container_state\": \"closed\"")
                stream.fd.sync()
            }
            SystemClock.sleep(2500)
            val stop = recorder.stopRecording()
            assertEquals(stop.toString(), true, stop["success"])
            assertEquals(listOf("CLOSING_CONTAINER"), phases)
            assertEquals("final closed sidecar must not exist before the container fsync", false, tokenAtSync)
            val meta = metadata(dir)
            assertEquals("closed", meta.getString("container_state")); assertTrue(meta.getBoolean("container_fsync"))
            assertEquals(false, meta.getBoolean("power_loss_qualified"))
            assertEquals(FinalizationPhase.FINALIZED, journalPhase(dir))
            out.put("synced_take", dir.name).put("sync_observed_journal_phase", phases[0])
                .put("session_directory_fsync", meta.getString("session_directory_fsync"))

            // Take 2: the container fsync fails -> no closed, no FINALIZED, no success ack, quarantined.
            val start2 = recorder.startRecording(config); assertEquals(start2.toString(), true, start2["success"])
            val dir2 = File(start2["outputDirectory"] as String)
            writer.containerSyncProbe = { throw java.io.IOException("injected container fsync failure") }
            SystemClock.sleep(2500)
            val stop2 = recorder.stopRecording()
            writer.containerSyncProbe = null
            assertEquals(stop2.toString(), false, stop2["success"])
            val meta2 = metadata(dir2)
            assertEquals("unclosed", meta2.getString("container_state")); assertFalse(meta2.getBoolean("container_fsync"))
            assertEquals("quarantined", meta2.getString("recovery_state"))
            assertNotEquals(FinalizationPhase.FINALIZED, journalPhase(dir2))
            assertTrue(File(dir2, RecoveryScanner.MARKER).isFile)
            out.put("sync_failed_take", dir2.name).put("sync_failed_journal_phase", journalPhase(dir2).name).put("status", "passed")
        } finally {
            receipt("finalization-container-fsync.json", out)
            recorder.disposeSession(); instrumentation.runOnMainSync { activity.finish() }
        }
    }

    @Test fun zeroFrameCaptureIsFailedQuarantinedAndNeverFinalized() {
        requireEmulator()
        val out = JSONObject()
        val activity = launch(); val recorder = activity.recorder
        try {
            ready(recorder)
            var dir: File? = null; var stop: Map<String, Any?> = emptyMap()
            for (attempt in 1..6) { // stop before the first frame is written; retry if a frame raced in
                val start = recorder.startRecording(config); assertEquals(start.toString(), true, start["success"])
                dir = File(start["outputDirectory"] as String)
                stop = recorder.stopRecording()
                if (stop["success"] == false) break
            }
            assertEquals("could not obtain a zero-frame stop: $stop", false, stop["success"])
            val meta = metadata(dir!!)
            assertFalse(meta.getBoolean("capture_result_valid"))
            assertEquals("failed", meta.getString("capture_outcome")); assertEquals("quarantined", meta.getString("recovery_state"))
            assertFalse(meta.getBoolean("finalization_complete"))
            assertEquals("failed", stop["captureOutcome"]); assertEquals("quarantined", stop["recoveryState"])
            assertNotEquals(FinalizationPhase.FINALIZED, journalPhase(dir))
            assertTrue(File(dir, RecoveryScanner.MARKER).isFile)
            out.put("directory", dir.name).put("capture_outcome", meta.getString("capture_outcome"))
                .put("container_state", meta.getString("container_state")).put("journal_phase", journalPhase(dir).name).put("status", "passed")
        } finally {
            receipt("finalization-zero-frame.json", out)
            recorder.disposeSession(); instrumentation.runOnMainSync { activity.finish() }
        }
    }

    @Test fun firstStopJournalWriteFailureGatesProducersAndLatchesUncertain() {
        requireEmulator()
        val out = JSONObject()
        val activity = launch(); val recorder = activity.recorder
        try {
            ready(recorder)
            val start = recorder.startRecording(config); assertEquals(start.toString(), true, start["success"])
            val dir = File(start["outputDirectory"] as String)
            SystemClock.sleep(2000)
            // A directory squatting on the journal's temp name makes the very first stop journal write fail with an I/O error.
            assertTrue(File(dir, ".${FinalizationJournal.FILE_NAME}.tmp").mkdir())
            val stop = recorder.stopRecording()
            assertEquals(stop.toString(), false, stop["success"])
            val state = recorder.getRecordingState()
            assertEquals(false, state["isRecording"]) // producers gated off
            assertEquals("ERROR", state["state"])
            assertEquals(FinalizationPhase.CAPTURING, journalPhase(dir)) // the failed write left the previous complete journal
            assertTrue(File(dir, RecoveryScanner.MARKER).isFile)
            val again = recorder.startRecording(config)
            assertEquals(false, again["success"])
            assertTrue(again.toString(), again.toString().contains("did not prove the writer was quiet"))
            out.put("directory", dir.name).put("refused_start", again["error"]).put("journal_phase", journalPhase(dir).name).put("status", "passed")
        } finally {
            receipt("finalization-first-journal-write.json", out)
            recorder.disposeSession(); instrumentation.runOnMainSync { activity.finish() }
        }
    }

    @Test fun slowContainerCloseIsBoundedAndLateWorkerCannotPublishFinalized() {
        requireEmulator()
        val out = JSONObject()
        val activity = launch(faults = true); val recorder = activity.recorder; val writer = activity.faultWriter!!
        try {
            ready(recorder)
            val start = recorder.startRecording(config); assertEquals(start.toString(), true, start["success"])
            val dir = File(start["outputDirectory"] as String)
            val release = java.util.concurrent.CountDownLatch(1)
            val workerDone = java.util.concurrent.CountDownLatch(1)
            writer.containerSyncProbe = { stream -> // stands in for uninterruptible OS I/O; the real fsync still runs when released
                release.await(60, TimeUnit.SECONDS); stream.fd.sync(); workerDone.countDown()
            }
            SystemClock.sleep(2000)
            val began = SystemClock.elapsedRealtime()
            val stop = recorder.stopRecording()
            val elapsed = SystemClock.elapsedRealtime() - began
            writer.containerSyncProbe = null
            assertEquals(stop.toString(), false, stop["success"])
            assertTrue("stop must return within the bounded close phase, took ${elapsed}ms", elapsed < 30_000)
            assertEquals("ERROR", recorder.getRecordingState()["state"])
            assertTrue(File(dir, RecoveryScanner.MARKER).isFile)
            assertEquals(false, recorder.startRecording(config)["success"])
            release.countDown() // the stalled worker now finishes late
            assertTrue(workerDone.await(30, TimeUnit.SECONDS))
            SystemClock.sleep(1500)
            assertEquals("A late worker must not publish FINALIZED", FinalizationPhase.CLOSING_CONTAINER, journalPhase(dir))
            val meta = metadata(dir)
            assertNotEquals("closed", meta.getString("container_state"))
            assertFalse(meta.getBoolean("finalization_complete"))
            out.put("directory", dir.name).put("stop_returned_ms", elapsed).put("journal_phase_after_late_worker", journalPhase(dir).name)
                .put("sidecar_container_state", meta.getString("container_state")).put("status", "passed")
        } finally {
            receipt("finalization-slow-close.json", out)
            recorder.disposeSession(); instrumentation.runOnMainSync { activity.finish() }
        }
    }

    /** Stage A of the process-death proof: the OS process is halted mid-capture, leaving an unclosed container. */
    @Test fun crashDuringCapture() {
        requireEmulator()
        val activity = launch(); val recorder = activity.recorder
        ready(recorder)
        val start = recorder.startRecording(config)
        assertEquals(start.toString(), true, start["success"])
        SystemClock.sleep(3500)
        val dir = File(start["outputDirectory"] as String)
        receipt("finalization-crash-target.json", JSONObject().put("directory", dir.name).put("recording_id", start["recordingId"]))
        Runtime.getRuntime().halt(137) // no shutdown hooks, no finalizers: a real crash
    }

    /** Stage B: a fresh process finds the dead take, quarantines it without touching it, salvages by copy, records anew. */
    @Test fun reopenAfterCrashQuarantinesSalvagesAndRecordsAgain() {
        requireEmulator()
        val activity = launch(); val recorder = activity.recorder
        val out = JSONObject()
        try {
            val target = JSONObject(File(instrumentation.context.filesDir, "finalization-crash-target.json").readText())
            val dead = File(sessions(activity), target.getString("directory"))
            assertTrue(dead.isDirectory)
            val before = hashes(dead)
            assertFalse("The crashed container must be unclosed", closedMagic(dead))
            assertEquals(FinalizationPhase.CAPTURING, journalPhase(dead))
            assertFalse(File(dead, "metadata.json").exists())
            ready(recorder)
            val start = recorder.startRecording(config)
            assertEquals(start.toString(), true, start["success"])
            assertTrue(recorder.lastRecoveryReport!!.newlyQuarantined.contains(dead.name))
            val marker = JSONObject(File(dead, RecoveryScanner.MARKER).readText())
            assertEquals("journal_phase_capturing", marker.getString("reason"))
            assertEquals("never_automatic", marker.getString("admission"))
            val after = hashes(dead).filterKeys { it != RecoveryScanner.MARKER }
            assertEquals("Scanner modified the crashed original", before, after)

            val salvage = SalvageService.salvage(dead, { SystemClock.elapsedRealtime() }, { System.currentTimeMillis() }) as SalvageService.Result.Salvaged
            assertEquals(before, hashes(dead).filterKeys { it != RecoveryScanner.MARKER })
            val manifest = JSONObject(File(salvage.directory, SalvageService.MANIFEST).readText())
            assertFalse(manifest.getBoolean("auto_admit"))
            assertEquals(before.getValue(before.keys.first { it.endsWith(".mcap") }), sha256(File(salvage.directory, before.keys.first { it.endsWith(".mcap") })))

            SystemClock.sleep(2500)
            val stop = recorder.stopRecording()
            assertEquals(stop.toString(), true, stop["success"])
            assertEquals("completed", stop["captureOutcome"])
            out.put("dead_session", dead.name).put("salvage_directory", salvage.directory.name)
                .put("derived_recording_id", salvage.derivedRecordingId).put("original_recording_id", target.getString("recording_id"))
                .put("reopen_take", File(stop["outputDirectory"] as String).name).put("original_hashes", JSONObject(before as Map<*, *>))
                .put("status", "passed")
        } finally {
            receipt("finalization-crash-reopen.json", out)
            recorder.disposeSession(); instrumentation.runOnMainSync { activity.finish() }
        }
    }
}
