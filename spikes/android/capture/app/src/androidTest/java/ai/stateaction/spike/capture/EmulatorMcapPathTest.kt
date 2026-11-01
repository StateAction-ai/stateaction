package ai.stateaction.spike.capture

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Build
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.ar.core.*
import com.google.ar.core.exceptions.NotYetAvailableException
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.EnumSet

/**
 * Emulator-only qualification of the spike's real recording classes: ARCore frame -> [CameraTimestampGate]
 * -> [FramePts] -> [CaptureGl] -> [HardwareAvc] (simulation profile, software AVC) -> [CaptureSink]/[MCAPWriter]
 * with independent [SensorManager] accelerometer and gyroscope events.
 *
 * It deliberately does not instantiate [CaptureEngine]: that class requires the strict hardware 1080p profile.
 * The produced capture.mcap is verified independently by harness/capture_verify.py on the host.
 * Never runs on a physical device.
 */
@RunWith(AndroidJUnit4::class)
class EmulatorMcapPathTest {
    private class Acquisition(val epochNs: Long, val row: JSONObject)

    @Test fun realSpikeClassesRecordVerifiableMcap() {
        check(Build.HARDWARE in listOf("ranchu", "goldfish")) { "Refusing physical-device camera test: ${Build.HARDWARE}" }
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val dir = File(context.filesDir, "simulation-mcap").apply { deleteRecursively(); mkdirs() }
        val report = JSONObject().put("kind", "emulator_only_spike_classes_mcap_path").put("physical_hardware_qualified", false)
            .put("emulator_hardware", Build.HARDWARE).put("sdk_int", Build.VERSION.SDK_INT)
            .put("exercised_classes", JSONArray(listOf("CameraTimestampGate", "FramePts", "CaptureGl", "HardwareAvc", "AnnexB", "CaptureSink", "MCAPWriter", "VideoWire", "Cdr")))
            .put("not_exercised", JSONArray(listOf("CaptureEngine", "strict hardware Main4.0 1080p profile", "physical camera/IMU/clock", "depth")))
        var session: Session? = null; var graphics: CaptureGl? = null; var avc: HardwareAvc? = null; var sink: CaptureSink? = null
        val clock = CaptureClock(); val gate = CameraTimestampGate(); val pts = FramePts()
        val pending = LinkedHashMap<Long, Acquisition>(); val counts = mutableMapOf("accel" to 0L, "gyro" to 0L)
        val sensorManager = context.getSystemService(SensorManager::class.java)
        var stopping = false; var failure: Throwable? = null
        val diagnostics = JSONArray(); val rejections = JSONArray()
        var acquired = 0L; var written = 0L; var dropped = 0L; var firstNative: Long? = null; var lastFrameNs = -1L
        val listener = object : SensorEventListener {
            override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
            override fun onSensorChanged(event: SensorEvent) {
                if (stopping) return
                try {
                    val accel = event.sensor.type == Sensor.TYPE_ACCELEROMETER
                    val key = if (accel) "accel" else "gyro"
                    val count = counts.getValue(key); counts[key] = count + 1
                    val row = JSONObject().put("stream_id", key).put("event_id", count.toString())
                        .put("native_timestamp_ns", event.timestamp.toString()).put("native_clock_id", "android.elapsed_realtime")
                        .put("mapped_capture_time_ns", clock.epoch(event.timestamp).toString()).put("mapping_revision", "elapsed_epoch_1")
                        .put("axes", "android_device_native").put("units", if (accel) "m/s^2" else "rad/s")
                        .put("includes_gravity", accel).put("accuracy", event.accuracy)
                        .put("values", JSONArray(event.values.take(3))).put("sensor_name", event.sensor.name).put("sensor_vendor", event.sensor.vendor)
                    sink!!.json(if (accel) CaptureSink.ACCEL else CaptureSink.GYRO, row)
                } catch (e: Throwable) { failure = e; stopping = true }
            }
        }
        try {
            session = Session(context)
            val configs = session.getSupportedCameraConfigs(CameraConfigFilter(session).setTargetFps(EnumSet.of(CameraConfig.TargetFps.TARGET_FPS_30)).setFacingDirection(CameraConfig.FacingDirection.BACK))
            val chosen = configs.minBy { it.imageSize.width * it.imageSize.height }
            session.cameraConfig = chosen
            val width = chosen.imageSize.width; val height = chosen.imageSize.height
            sink = CaptureSink(context, dir, clock) { failure = it; stopping = true }
            fun onEncoded(frame: EncodedFrame) {
                val acq = checkNotNull(pending.remove(frame.ptsUs)) { "Encoder output ${frame.ptsUs} has no exact acquisition identity" }
                sink!!.video(frame, acq.epochNs, JSONObject(acq.row.toString()))
                written++
            }
            avc = HardwareAvc(EncoderProfile.simulation(width, height)) { onEncoded(it) }
            report.put("encoder_probe", avc.probe)
            graphics = CaptureGl().also { it.attach(avc.surface) }
            session.configure(Config(session).setUpdateMode(Config.UpdateMode.BLOCKING).setDepthMode(Config.DepthMode.DISABLED).setPlaneFindingMode(Config.PlaneFindingMode.DISABLED).setLightEstimationMode(Config.LightEstimationMode.DISABLED))
            session.setCameraTextureNames(intArrayOf(graphics.texture)); session.setDisplayGeometry(0, width, height); session.resume()
            for (type in listOf(Sensor.TYPE_ACCELEROMETER, Sensor.TYPE_GYROSCOPE)) {
                val sensor = checkNotNull(sensorManager.getDefaultSensor(type)) { "Emulator exposes no sensor $type" }
                assertTrue(sensorManager.registerListener(listener, sensor, 10_000))
            }
            val deadline = SystemClock.elapsedRealtime() + 90_000L
            while (acquired + dropped < TARGET_FRAMES && !stopping && SystemClock.elapsedRealtime() < deadline) {
                val frame = session.update()
                avc.drain(0)
                // Same guard as CaptureEngine.frameLoop: metadata is read only for a ready Frame.
                val metadataNs = if (frame.timestamp > 0L) try { frame.imageMetadata.getLong(ImageMetadata.SENSOR_TIMESTAMP).takeIf { it > 0L } } catch (e: Exception) { null } else null
                val decision = gate.observe(frame.timestamp, frame.androidCameraTimestamp, SystemClock.elapsedRealtimeNanos(), metadataNs)
                // Diagnostic: the same Frame's SENSOR_TIMESTAMP re-read after the CPU image is acquired.
                val diag = JSONObject().put("frame_ns", frame.timestamp).put("accessor_ns", frame.androidCameraTimestamp).put("metadata_before_image_ns", metadataNs ?: JSONObject.NULL)
                if (diagnostics.length() < 40 && frame.timestamp > 0L) {
                    try { frame.acquireCameraImage().close() } catch (_: NotYetAvailableException) {}
                    diag.put("metadata_after_image_ns", try { frame.imageMetadata.getLong(ImageMetadata.SENSOR_TIMESTAMP) } catch (e: Exception) { JSONObject.NULL })
                    diag.put("gate_decision", decision.toString()); diagnostics.put(diag)
                }
                // CaptureEngine aborts capture on Reject. The harness records each rejection as a finding and skips only that frame
                // so the rest of the pipeline can still be qualified; the receipt reports the count and the frame is never written.
                if (decision is CameraTimestampGate.Decision.Reject) { rejections.put(JSONObject(diag.toString()).put("reason", decision.reason)); continue }
                if (decision !is CameraTimestampGate.Decision.Accept || frame.timestamp == lastFrameNs) continue
                lastFrameNs = frame.timestamp
                try { frame.acquireCameraImage().close() } catch (e: NotYetAvailableException) { continue }
                val nativeNs = decision.cameraNs
                val epoch = clock.epoch(nativeNs)
                val origin = firstNative ?: nativeNs.also { firstNative = it }
                val frameId = acquired++
                val encoderPts = pts.allocate(nativeNs, origin)
                val row = JSONObject().put("stream_id", "rgb").put("source_frame_id", frameId.toString()).put("state", "acquired")
                    .put("native_timestamp_ns", nativeNs.toString()).put("native_clock_id", "android.camera.realtime")
                    .put("arcore_frame_timestamp_ns", frame.timestamp.toString()).put("android_camera_timestamp_ns", frame.androidCameraTimestamp.toString())
                    .put("camera_clock_source", decision.source).put("mapped_capture_time_ns", epoch.toString()).put("mapping_revision", "elapsed_epoch_1")
                    .put("encoder_pts_us", encoderPts.toString())
                sink.json(CaptureSink.FRAMES, JSONObject(row.toString()))
                val k = frame.camera.imageIntrinsics; val d = k.imageDimensions
                assertEquals(width, d[0]); assertEquals(height, d[1])
                sink.binary(CaptureSink.CAMERA_INFO, Cdr().cameraInfo(epoch, d[0], d[1], k.focalLength[0].toDouble(), k.focalLength[1].toDouble(), k.principalPoint[0].toDouble(), k.principalPoint[1].toDouble()))
                if (pending.size >= 4) {
                    sink.json(CaptureSink.FRAMES, JSONObject(row.toString()).put("state", "dropped").put("reason", "encoder_pending_limit")); dropped++
                } else {
                    pending[encoderPts] = Acquisition(epoch, JSONObject(row.toString()))
                    graphics.draw(frame, encoderPts, width, height)
                }
                avc.drain(10_000)
            }
            stopping = true
            failure?.let { throw it }
            sensorManager.unregisterListener(listener)
            avc.signalEos()
            val closeDeadline = SystemClock.elapsedRealtime() + 10_000L
            while (!avc.eos && SystemClock.elapsedRealtime() < closeDeadline) avc.drain(10_000)
            assertTrue("encoder EOS", avc.eos)
            assertTrue("every pending acquisition resolved", pending.isEmpty())
            assertTrue("frames acquired", acquired >= MIN_FRAMES)
            sink.finish()
            assertTrue(sink.closed)
            report.put("status", "passed").put("source_frames_acquired", acquired).put("video_messages_written", written).put("dropped", dropped)
                .put("encoder_pending_high_water", pending.size).put("accel_events", counts["accel"]).put("gyro_events", counts["gyro"])
                .put("writer_counts", JSONObject(sink.writtenCounts.mapValues { it.value.toString() }))
                .put("encoder_output_format", avc.observedFormat).put("sps_profile_idc", avc.observedSpsProfile).put("sps_level_idc", avc.observedSpsLevel)
                .put("clock_gate_rejections", rejections.length()).put("selected_encoder_hardware_required", false).put("image_width", width).put("image_height", height)
        } catch (e: Throwable) {
            report.put("status", "failed").put("error", e.toString()); throw e
        } finally {
            stopping = true
            try { sensorManager.unregisterListener(listener) } catch (_: Exception) {}
            try { session?.pause() } catch (e: Exception) { report.put("pause_error", e.toString()) }
            try { graphics?.close() } catch (e: Exception) { report.put("gl_close_error", e.toString()) }
            try { avc?.close() } catch (e: Exception) { report.put("encoder_close_error", e.toString()) }
            try { session?.close() } catch (e: Exception) { report.put("arcore_close_error", e.toString()) }
            report.put("clock_gate_rejection_count", rejections.length()).put("clock_diagnostics", diagnostics).put("clock_rejections", rejections)
            File(dir, "report.json").writeText(report.toString(2) + "\n")
        }
    }
    companion object { const val TARGET_FRAMES = 100L; const val MIN_FRAMES = 60L }
}
