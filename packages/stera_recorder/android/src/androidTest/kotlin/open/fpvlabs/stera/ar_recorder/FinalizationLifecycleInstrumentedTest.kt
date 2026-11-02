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

    private fun launch(): H264RecorderTestActivity {
        val activity = instrumentation.startActivitySync(
            Intent(instrumentation.context, H264RecorderTestActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
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
