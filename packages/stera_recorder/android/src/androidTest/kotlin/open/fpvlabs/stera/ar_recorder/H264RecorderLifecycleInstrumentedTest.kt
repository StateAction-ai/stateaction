package open.fpvlabs.stera.ar_recorder

import android.app.Activity
import android.content.Intent
import android.graphics.SurfaceTexture
import android.os.Bundle
import android.os.SystemClock
import android.view.TextureView
import android.view.WindowManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.flutter.view.TextureRegistry
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.mockito.Mockito
import open.fpvlabs.stera.ar_recorder.data.DatasetWriter
import open.fpvlabs.stera.ar_recorder.data.MCAPDatasetWriter

/** Deliberate faults retain the real MCAP writer and its complete close path. */
class FaultInjectingDatasetWriter(val actual: DatasetWriter) : DatasetWriter by actual {
    @Volatile var failNextInitialization = false
    @Volatile var failNextVideoWrite = false
    override fun initializeWriters(): Boolean {
        val initialized = actual.initializeWriters()
        if (failNextInitialization) {
            failNextInitialization = false
            error("injected after real MCAP initialization")
        }
        return initialized
    }
    override fun writeH264AccessUnit(sourceFrameId: Long, captureTimeNs: Long, encoderPtsUs: Long, annexB: ByteArray): Boolean {
        if (failNextVideoWrite) {
            failNextVideoWrite = false
            actual.recordWriteFailure("injected native writer access-unit failure")
            return false
        }
        return actual.writeH264AccessUnit(sourceFrameId, captureTimeNs, encoderPtsUs, annexB)
    }
}

/** Only the Flutter texture-registry boundary is substituted. Camera, ARCore,
 * ArRecorderImpl, producer/writer threads, encoder and finalization are real. */
class H264RecorderTestActivity : Activity() {
    val surfaceReady = CountDownLatch(1)
    lateinit var recorder: ArRecorderImpl
    var faultWriter: FaultInjectingDatasetWriter? = null
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val texture = TextureView(this)
        texture.surfaceTextureListener = object : TextureView.SurfaceTextureListener {
            override fun onSurfaceTextureAvailable(surface: SurfaceTexture, width: Int, height: Int) {
                val registry = Mockito.mock(TextureRegistry::class.java)
                val entry = Mockito.mock(TextureRegistry.SurfaceTextureEntry::class.java)
                Mockito.`when`(entry.surfaceTexture()).thenReturn(surface)
                Mockito.`when`(entry.id()).thenReturn(1L)
                Mockito.`when`(registry.createSurfaceTexture()).thenReturn(entry)
                faultWriter = if (intent.getBooleanExtra("inject_writer_faults", false)) FaultInjectingDatasetWriter(
                    MCAPDatasetWriter(this@H264RecorderTestActivity, android.os.Build.MODEL, android.os.Build.VERSION.RELEASE)
                ) else null
                recorder = ArRecorderImpl(this@H264RecorderTestActivity, registry, faultWriter)
                surfaceReady.countDown()
            }
            override fun onSurfaceTextureSizeChanged(surface: SurfaceTexture, width: Int, height: Int) = Unit
            override fun onSurfaceTextureUpdated(surface: SurfaceTexture) = Unit
            override fun onSurfaceTextureDestroyed(surface: SurfaceTexture) = true
        }
        setContentView(texture)
    }
}

@RunWith(AndroidJUnit4::class)
class H264RecorderLifecycleInstrumentedTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val config = mapOf<String, Any>(
        "rgbCodec" to "h264", "h264SimulationMode" to true,
        "recordRgb" to true, "recordImu" to true, "recordDepth" to false,
        "recordPointCloud" to false, "recordMesh" to false,
        "recordingHz" to 30, "rgbVideoHeight" to 1080
    )

    private fun await(message: String, seconds: Long = 45, predicate: () -> Boolean) {
        val until = SystemClock.elapsedRealtime() + seconds * 1000
        while (!predicate()) {
            assertTrue(message, SystemClock.elapsedRealtime() < until)
            SystemClock.sleep(100)
        }
    }

    @Test fun existingControllerRecordsRepeatedTakesWithPauseAndCancellation() {
        // Refuse accidental physical execution even when called outside the script.
        val emulator = android.os.Build.FINGERPRINT.startsWith("generic") ||
            android.os.Build.HARDWARE in setOf("ranchu", "goldfish")
        assertTrue("Emulator simulation only; physical execution is forbidden", emulator)
        val activity = instrumentation.startActivitySync(
            Intent(instrumentation.context, H264RecorderTestActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ) as H264RecorderTestActivity
        assertTrue("TextureView did not attach", activity.surfaceReady.await(15, TimeUnit.SECONDS))
        val recorder = activity.recorder
        val receipt = JSONObject().put("fixture_kind", "existing_recorder_arcore_emulator_simulation")
            .put("hardware_qualified", false).put("takes", JSONArray())
        try {
            var init: Map<String, Any?> = emptyMap()
            instrumentation.runOnMainSync { init = recorder.initializeSession(config) }
            assertEquals(init.toString(), true, init["success"])
            await("Controller did not become READY: ${recorder.getRecordingState()}") {
                val state = recorder.getRecordingState()
                assertNotEquals("Frame loop failed: $state", "ERROR", state["state"])
                state["state"] == "READY"
            }
            repeat(2) { take ->
                val start = recorder.startRecording(config)
                assertEquals(start.toString(), true, start["success"])
                SystemClock.sleep(3500)
                if (take == 0) {
                    assertEquals(true, recorder.pauseRecording()["success"])
                    SystemClock.sleep(300)
                    assertEquals(true, recorder.resumeRecording()["success"])
                    SystemClock.sleep(2000)
                } else {
                    assertEquals(true, recorder.pauseRecording()["success"])
                }
                val stop = recorder.stopRecording()
                receipt.getJSONArray("takes").put(JSONObject(stop).put("stopped_while_paused", take == 1))
                assertEquals(stop.toString(), true, stop["success"])
                assertTrue("No actual frames finalized: $stop", (stop["framesRecorded"] as Number).toInt() > 2)
                val directory = File(stop["outputDirectory"] as String)
                assertTrue("No closed MCAP produced", directory.listFiles()?.any { it.extension == "mcap" && it.length() > 0 } == true)
                assertTrue("No metadata sidecar", File(directory, "metadata.json").isFile)
                assertEquals("READY", recorder.getRecordingState()["state"])
                SystemClock.sleep(1100) // legacy session names have one-second resolution
            }
            val cancelledStart = recorder.startRecording(config)
            assertEquals(cancelledStart.toString(), true, cancelledStart["success"])
            SystemClock.sleep(1200)
            val cancelledDirectory = File(cancelledStart["outputDirectory"] as String)
            val cancel = recorder.cancelRecording()
            assertEquals(cancel.toString(), true, cancel["success"])
            assertFalse("Cancelled data still exists", cancelledDirectory.exists())
            assertEquals("READY", recorder.getRecordingState()["state"])
            SystemClock.sleep(1100)
            val recovery = recorder.startRecording(config)
            assertEquals(recovery.toString(), true, recovery["success"])
            SystemClock.sleep(3000)
            val recovered = recorder.stopRecording()
            assertEquals(recovered.toString(), true, recovered["success"])
            assertTrue((recovered["framesRecorded"] as Number).toInt() > 2)
            receipt.getJSONArray("takes").put(JSONObject(recovered).put("after_cancel", true))
            receipt.put("cancel_deleted_session", true).put("status", "passed")
        } finally {
            File(instrumentation.context.filesDir, "h264-lifecycle-result.json").writeText(receipt.toString(2))
            recorder.disposeSession()
            instrumentation.runOnMainSync { activity.finish() }
        }
    }

    @Test fun startupAndWriterFailuresFinalizeAndAllowRetry() {
        assertTrue("Emulator only", android.os.Build.HARDWARE in setOf("ranchu", "goldfish"))
        val activity = instrumentation.startActivitySync(
            Intent(instrumentation.context, H264RecorderTestActivity::class.java)
                .putExtra("inject_writer_faults", true).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        ) as H264RecorderTestActivity
        assertTrue(activity.surfaceReady.await(15, TimeUnit.SECONDS))
        val recorder = activity.recorder
        val writer = checkNotNull(activity.faultWriter)
        val receipt = JSONObject().put("hardware_qualified", false)
        fun closed(directory: File) {
            val file = directory.listFiles()?.single { it.extension == "mcap" } ?: error("Missing MCAP")
            assertTrue(file.length() >= 16)
            java.io.RandomAccessFile(file, "r").use {
                it.seek(it.length() - 8)
                val tail = ByteArray(8); it.readFully(tail)
                assertArrayEquals(byteArrayOf(0x89.toByte(), 0x4d, 0x43, 0x41, 0x50, 0x30, 0x0d, 0x0a), tail)
            }
        }
        try {
            instrumentation.runOnMainSync { assertEquals(true, recorder.initializeSession(config)["success"]) }
            await("Fault controller not READY") { recorder.getRecordingState()["state"] == "READY" }
            writer.failNextInitialization = true
            val failedStart = recorder.startRecording(config)
            assertEquals(failedStart.toString(), false, failedStart["success"])
            assertEquals("READY", recorder.getRecordingState()["state"])
            val failedStartDirectory = File(checkNotNull(writer.getSessionDirectory()))
            closed(failedStartDirectory)
            // Immediate retry verifies unique directories, without a timestamp sleep.
            val retry = recorder.startRecording(config)
            assertEquals(retry.toString(), true, retry["success"])
            assertNotEquals(failedStartDirectory.absolutePath, retry["outputDirectory"])
            SystemClock.sleep(2500)
            val successfulRetry = recorder.stopRecording()
            assertEquals(successfulRetry.toString(), true, successfulRetry["success"])
            closed(File(successfulRetry["outputDirectory"] as String))
            receipt.put("startup_failure_closed", true).put("startup_immediate_retry_success", true)
            writer.failNextVideoWrite = true
            val failedWriteStart = recorder.startRecording(config)
            assertEquals(failedWriteStart.toString(), true, failedWriteStart["success"])
            val failedWriteDirectory = File(failedWriteStart["outputDirectory"] as String)
            await("Writer failure was not stopped and finalized", 30) {
                !writer.failNextVideoWrite && recorder.getRecordingState()["state"] == "READY" &&
                    recorder.getRecordingState()["isRecording"] == false
            }
            closed(failedWriteDirectory)
            val metadata = JSONObject(File(failedWriteDirectory, "metadata.json").readText())
            assertFalse(metadata.getBoolean("capture_result_valid"))
            assertEquals("failed", metadata.getString("capture_outcome"))
            assertEquals("closed", metadata.getString("container_state"))
            val recovery = recorder.startRecording(config)
            assertEquals(recovery.toString(), true, recovery["success"])
            SystemClock.sleep(2500)
            assertEquals(true, recorder.stopRecording()["success"])
            receipt.put("writer_failure_autostopped", true).put("writer_failure_closed", true)
                .put("failed_recording_not_valid", true).put("writer_failure_retry_success", true).put("status", "passed")
        } finally {
            File(instrumentation.context.filesDir, "h264-failure-result.json").writeText(receipt.toString(2))
            recorder.disposeSession()
            instrumentation.runOnMainSync { activity.finish() }
        }
    }
}
