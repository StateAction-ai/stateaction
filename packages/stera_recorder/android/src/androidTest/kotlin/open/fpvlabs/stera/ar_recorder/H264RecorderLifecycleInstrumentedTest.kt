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

/** Keeps the real MCAP writer; only adds deliberate faults through its own failure path. */
class FaultInjectingDatasetWriter(val actual: DatasetWriter) : DatasetWriter by actual {
    @Volatile var failNextInitialization = false
    override fun initializeWriters(): Boolean {
        val initialized = actual.initializeWriters()
        if (failNextInitialization) {
            failNextInitialization = false
            error("injected after real MCAP initialization")
        }
        return initialized
    }
}

/** Only Flutter's texture-registry boundary is substituted. ARCore, the camera, ArRecorderImpl, the producer and
 * writer threads, MediaCodec, the H.264 controller and finalization are the real recorder code. */
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
        "recordingHz" to 30, "rgbVideoHeight" to 480
    )

    private fun requireEmulator() = assertTrue("Emulator simulation only; physical execution is forbidden",
        android.os.Build.HARDWARE in setOf("ranchu", "goldfish"))

    private fun await(message: String, seconds: Long = 45, predicate: () -> Boolean) {
        val until = SystemClock.elapsedRealtime() + seconds * 1000
        while (!predicate()) {
            assertTrue(message, SystemClock.elapsedRealtime() < until)
            SystemClock.sleep(100)
        }
    }

    private fun launch(faults: Boolean): H264RecorderTestActivity {
        val activity = instrumentation.startActivitySync(
            Intent(instrumentation.context, H264RecorderTestActivity::class.java)
                .putExtra("inject_writer_faults", faults).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
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

    private fun closedMcap(directory: File): File {
        val file = directory.listFiles()?.single { it.extension == "mcap" } ?: error("Missing MCAP in $directory")
        java.io.RandomAccessFile(file, "r").use {
            it.seek(it.length() - 8)
            val tail = ByteArray(8); it.readFully(tail)
            assertArrayEquals("MCAP not closed", byteArrayOf(0x89.toByte(), 0x4d, 0x43, 0x41, 0x50, 0x30, 0x0d, 0x0a), tail)
        }
        return file
    }

    private fun take(stop: Map<String, Any?>, label: String): JSONObject {
        val directory = File(stop["outputDirectory"] as String)
        val metadata = JSONObject(File(directory, "metadata.json").readText())
        return JSONObject().put("label", label).put("directory", directory.name).put("mcap", closedMcap(directory).name)
            .put("recording_id", stop["recordingId"]).put("frames_recorded", stop["framesRecorded"])
            .put("capture_outcome", metadata.optString("capture_outcome")).put("container_state", metadata.optString("container_state"))
            .put("h264_terminal", metadata.optJSONObject("h264_terminal"))
    }

    @Test fun existingControllerRecordsConsecutiveTakesPauseCancelAndRetry() {
        requireEmulator()
        val activity = launch(faults = false)
        val recorder = activity.recorder
        val receipt = JSONObject().put("fixture_kind", "existing_recorder_arcore_emulator_simulation")
            .put("hardware_qualified", false).put("takes", JSONArray())
        val ids = mutableSetOf<String>()
        try {
            ready(recorder)
            // The hardware candidate must refuse explicitly on an emulator, before any file exists.
            val sessions = File(activity.getExternalFilesDir(null), "ar_sessions")
            val before = sessions.list()?.toSet().orEmpty()
            val hardware = recorder.startRecording(config + mapOf("h264SimulationMode" to false, "rgbVideoHeight" to 1080))
            assertEquals(hardware.toString(), false, hardware["success"])
            assertEquals(hardware.toString(), "H264_PREFLIGHT", hardware["errorCode"])
            assertEquals("READY", recorder.getRecordingState()["state"])
            assertEquals("Preflight created files", before, sessions.list()?.toSet().orEmpty())
            receipt.put("hardware_profile_preflight_error", hardware["error"])
            repeat(2) { index ->
                val start = recorder.startRecording(config)
                assertEquals(start.toString(), true, start["success"])
                SystemClock.sleep(3500)
                if (index == 0) {
                    assertEquals(true, recorder.pauseRecording()["success"])
                    SystemClock.sleep(300)
                    assertEquals(true, recorder.resumeRecording()["success"])
                    SystemClock.sleep(2000)
                } else {
                    assertEquals(true, recorder.pauseRecording()["success"])
                }
                val stop = recorder.stopRecording()
                assertEquals(stop.toString(), true, stop["success"])
                assertTrue("No actual frames: $stop", (stop["framesRecorded"] as Number).toInt() > 10)
                val result = take(stop, if (index == 0) "pause_resume" else "stopped_while_paused")
                assertEquals("completed", result.getString("capture_outcome"))
                assertTrue("Recording identity reused", ids.add(stop["recordingId"] as String))
                receipt.getJSONArray("takes").put(result)
                assertEquals("READY", recorder.getRecordingState()["state"])
            }
            val cancelled = recorder.startRecording(config)
            assertEquals(cancelled.toString(), true, cancelled["success"])
            SystemClock.sleep(1200)
            val cancelledDirectory = File(cancelled["outputDirectory"] as String)
            assertEquals(true, recorder.cancelRecording()["success"])
            assertFalse("Cancelled data still exists", cancelledDirectory.exists())
            assertEquals("READY", recorder.getRecordingState()["state"])
            val retry = recorder.startRecording(config + ("recordingId" to "6f1c2b9e-0d4a-4f7e-8a3b-2c5d9e1f0a7b"))
            assertEquals(retry.toString(), true, retry["success"])
            SystemClock.sleep(3000)
            val retried = recorder.stopRecording()
            assertEquals(retried.toString(), true, retried["success"])
            assertEquals("Caller recording identity not preserved", "6f1c2b9e-0d4a-4f7e-8a3b-2c5d9e1f0a7b", retried["recordingId"])
            receipt.getJSONArray("takes").put(take(retried, "after_cancel_with_caller_id"))
            receipt.put("cancel_deleted_session", true).put("status", "passed")
        } finally {
            File(instrumentation.context.filesDir, "h264-lifecycle-result.json").writeText(receipt.toString(2))
            recorder.disposeSession()
            instrumentation.runOnMainSync { activity.finish() }
        }
    }

    @Test fun startupAndWriterFailuresFinalizeExplicitlyAndAllowRetry() {
        requireEmulator()
        val activity = launch(faults = true)
        val recorder = activity.recorder
        val writer = checkNotNull(activity.faultWriter)
        val receipt = JSONObject().put("hardware_qualified", false).put("takes", JSONArray())
        try {
            ready(recorder)
            writer.failNextInitialization = true
            val failedStart = recorder.startRecording(config)
            assertEquals(failedStart.toString(), false, failedStart["success"])
            assertEquals("READY", recorder.getRecordingState()["state"])
            val failedStartDirectory = File(checkNotNull(writer.getSessionDirectory()))
            receipt.put("startup_failure_mcap", closedMcap(failedStartDirectory).absolutePath)
            val retry = recorder.startRecording(config)
            assertEquals(retry.toString(), true, retry["success"])
            assertNotEquals(failedStartDirectory.absolutePath, retry["outputDirectory"])
            SystemClock.sleep(2500)
            val retried = recorder.stopRecording()
            assertEquals(retried.toString(), true, retried["success"])
            receipt.getJSONArray("takes").put(take(retried, "immediate_retry_after_startup_failure"))
            // A writer failure mid-take must auto-stop, close the container and mark the take failed.
            val failing = recorder.startRecording(config)
            assertEquals(failing.toString(), true, failing["success"])
            val failingDirectory = File(failing["outputDirectory"] as String)
            SystemClock.sleep(1500)
            writer.recordWriteFailure("injected writer failure during an active take")
            await("Writer failure was not stopped and finalized", 30) {
                recorder.getRecordingState().let { it["state"] == "READY" && it["isRecording"] == false }
            }
            closedMcap(failingDirectory)
            val metadata = JSONObject(File(failingDirectory, "metadata.json").readText())
            assertFalse(metadata.getBoolean("capture_result_valid"))
            assertEquals("failed", metadata.getString("capture_outcome"))
            receipt.put("writer_failure_directory", failingDirectory.name).put("writer_failure_outcome", metadata.getString("capture_outcome"))
            val recovery = recorder.startRecording(config)
            assertEquals(recovery.toString(), true, recovery["success"])
            SystemClock.sleep(2500)
            val recovered = recorder.stopRecording()
            assertEquals(recovered.toString(), true, recovered["success"])
            receipt.getJSONArray("takes").put(take(recovered, "recovery_after_writer_failure"))
            receipt.put("status", "passed")
        } finally {
            File(instrumentation.context.filesDir, "h264-failure-result.json").writeText(receipt.toString(2))
            recorder.disposeSession()
            instrumentation.runOnMainSync { activity.finish() }
        }
    }
}
