package open.fpvlabs.stera.ar_recorder.coordination

import android.content.Context
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.os.Handler
import android.os.SystemClock
import com.google.ar.core.Frame
import com.google.ar.core.ImageMetadata
import com.google.ar.core.exceptions.MetadataNotFoundException
import com.google.ar.core.exceptions.NotYetAvailableException
import open.fpvlabs.stera.ar_recorder.data.DatasetWriter
import open.fpvlabs.stera.ar_recorder.encoding.CameraTimestampGate
import open.fpvlabs.stera.ar_recorder.encoding.FramePts
import open.fpvlabs.stera.ar_recorder.encoding.H264RgbEncoder
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/** Owns immutable frame identity/clock evidence and the bounded codec PTS join. No Frame escapes capture(). */
class H264RecordingController(
    context: Context,
    val recordingId: String,
    val simulation: Boolean,
    val recordImu: Boolean,
    val recordDepth: Boolean = true,
    val recordPointCloud: Boolean = true,
    depthSupported: Boolean,
    cameraId: String,
    private val writer: DatasetWriter,
    private val writerHandler: Handler,
    private val metrics: RecordingMetricsState
) {
    private data class Pending(val id: Long, val captureTimeNs: Long)
    private val pending = linkedMapOf<Long, Pending>()
    private val pts = FramePts()
    private val gate = CameraTimestampGate()
    private val queuedWrites = AtomicInteger()
    private val queuedVideos = AtomicInteger()
    private val queuedVideoBytes = AtomicLong()
    private val peakQueuedVideoBytes = AtomicLong()
    private var originNs: Long? = null
    private var sourceId = 0L
    private var lastImageNs: Long? = null
    private var submittedFrameIdentity: Map<String, Any?>? = null
    private var fatalError: String? = null
    private var cameraUnavailableCount = 0L
    private var clockWaitCount = 0L
    private var backpressureSkipCount = 0L
    private val anchorBeforeNs = SystemClock.elapsedRealtimeNanos()
    private val unixAnchorNs = System.currentTimeMillis() * 1_000_000L
    private val anchorAfterNs = SystemClock.elapsedRealtimeNanos()
    private val elapsedAnchorNs = anchorBeforeNs + (anchorAfterNs - anchorBeforeNs) / 2
    private val realtime: Boolean
    private val encoder: H264RgbEncoder
    val profile: Map<String, Any?>
    val clocks: Map<String, Any?>

    init {
        require(!simulation || H264RgbEncoder.isEmulator()) { "Simulation mode requires verified Android emulator" }
        val cameraManager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val source = cameraManager.getCameraCharacteristics(cameraId).get(CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE)
        realtime = source == CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE_REALTIME
        require(realtime || simulation) { "Camera SENSOR_INFO_TIMESTAMP_SOURCE is not REALTIME; H.264 capture cannot claim clock mapping" }
        val sensors = context.getSystemService(Context.SENSOR_SERVICE) as android.hardware.SensorManager
        val accelAvailable = sensors.getDefaultSensor(android.hardware.Sensor.TYPE_ACCELEROMETER) != null
        val gyroAvailable = sensors.getDefaultSensor(android.hardware.Sensor.TYPE_GYROSCOPE) != null
        require(!recordImu || (accelAvailable && gyroAvailable)) { "Required independent accelerometer/gyroscope unavailable" }
        encoder = H264RgbEncoder(simulation) { ptsUs, bytes ->
            val identity = checkNotNull(pending.remove(ptsUs)) { "Unexpected encoder PTS $ptsUs" }
            val totalBytes = queuedVideoBytes.addAndGet(bytes.size.toLong())
            if (totalBytes > MAX_QUEUED_VIDEO_BYTES) {
                queuedVideoBytes.addAndGet(-bytes.size.toLong())
                error("Aggregate encoded writer byte budget exceeded")
            }
            peakQueuedVideoBytes.accumulateAndGet(totalBytes, ::maxOf)
            if (queuedVideos.incrementAndGet() > 4) {
                queuedVideos.decrementAndGet(); queuedVideoBytes.addAndGet(-bytes.size.toLong())
                error("Bounded H.264 writer queue exhausted")
            }
            try {
                queue {
                    try {
                        check(writer.writeH264AccessUnit(identity.id, identity.captureTimeNs, ptsUs, bytes)) { "H.264 writer rejected access unit" }
                        metrics.encodedVideoFrameCount.incrementAndGet()
                    } finally { queuedVideos.decrementAndGet(); queuedVideoBytes.addAndGet(-bytes.size.toLong()) }
                }
            } catch (error: Throwable) {
                queuedVideos.decrementAndGet(); queuedVideoBytes.addAndGet(-bytes.size.toLong())
                throw error
            }
        }
        profile = mapOf(
            "recording_id" to recordingId,
            "rgb_profile" to if (simulation) "h264_mcap_simulation_v1" else "h264_mcap_v1",
            "qualification" to if (simulation) "simulation_only" else "unqualified",
            "production_qualified" to false,
            "mapped_timeline_semantics" to if (simulation) "simulation_transport_only" else "camera_capture_epoch",
            "camera_clock_status" to if (realtime) "realtime_source_verified" else "unverified",
            "camera_id" to cameraId,
            "device" to mapOf("manufacturer" to android.os.Build.MANUFACTURER, "model" to android.os.Build.MODEL,
                "android_release" to android.os.Build.VERSION.RELEASE, "api_level" to android.os.Build.VERSION.SDK_INT),
            "calibration_id" to "per_frame_rgb_image_intrinsics",
            "distortion_status" to "not_exposed_by_arcore",
            "encoder" to mapOf("name" to encoder.codecName, "hardware" to encoder.hardware,
                "width" to encoder.width, "height" to encoder.height, "fps" to encoder.fps,
                "bitrate" to encoder.bitrate, "requested_profile" to "Main", "requested_level" to if (simulation) "3.1" else "4.0",
                "b_frames" to 0, "idr_interval_seconds" to 1, "input" to "ARCore CPU YUV_420_888 copied to codec input Image actual strides"),
            "streams" to mapOf("rgb" to mapOf("width" to encoder.width, "height" to encoder.height,
                "orientation" to "native_cpu_unrotated", "calibration" to "camera.imageIntrinsics",
                "required" to true, "requested" to true, "supported" to true, "enabled" to true, "observed" to false),
                "accel" to mapOf("required" to recordImu, "requested" to recordImu, "supported" to accelAvailable, "enabled" to recordImu, "observed" to false),
                "gyro" to mapOf("required" to recordImu, "requested" to recordImu, "supported" to gyroAvailable, "enabled" to recordImu, "observed" to false),
                "depth" to mapOf("required" to false, "requested" to recordDepth, "supported" to depthSupported, "enabled" to (recordDepth && depthSupported), "observed" to false),
                "pointcloud" to mapOf("required" to false, "requested" to recordPointCloud, "supported" to "arcore_conditional", "enabled" to recordPointCloud, "observed" to false)),
            "limits" to mapOf("max_pending_frames" to 4, "max_queued_access_units" to 4, "max_access_unit_bytes" to H264RgbEncoder.MAX_ACCESS_UNIT_BYTES, "max_queued_encoded_bytes" to MAX_QUEUED_VIDEO_BYTES)
        )
        clocks = mapOf("mapping_revision" to "android_elapsed_to_unix_v1", "source_clock_id" to "android.elapsed_realtime",
            "target_clock_id" to "unix_epoch_ns", "source_anchor_ns" to elapsedAnchorNs.toString(),
            "target_anchor_ns" to unixAnchorNs.toString(), "uncertainty_ns" to (1_000_000L + anchorAfterNs - anchorBeforeNs).toString(),
            "camera_timestamp_source" to source, "camera_clock_verified" to realtime,
            "arcore_frame_clock" to "undefined_native_preserved", "arcore_image_clock" to "source_specific_native_preserved",
            "simulation_transport_only" to (simulation && !realtime))
    }

    private fun queue(block: () -> Unit) {
        if (queuedWrites.incrementAndGet() > 128) {
            queuedWrites.decrementAndGet(); error("Bounded H.264 evidence writer queue exhausted")
        }
        if (!writerHandler.post {
            try { block() } catch (error: Throwable) { writer.recordWriteFailure("H.264 write failed: ${error.message}", error) }
            finally { queuedWrites.decrementAndGet() }
        }) {
            queuedWrites.decrementAndGet(); error("H.264 writer queue rejected evidence")
        }
    }

    /** Returns true only when a real acquired image was queued into the codec. */
    fun capture(frame: Frame, intrinsics: Map<String, Any>, trackingState: String): Boolean {
        submittedFrameIdentity = null
        if (fatalError != null) return false
        try {
            encoder.drain()
            if (pending.size + queuedVideos.get() >= 4) {
                backpressureSkipCount++; metrics.rgbEncoderFailureCount++; metrics.droppedFrameCount.incrementAndGet(); return false
            }
            val receiptNs = SystemClock.elapsedRealtimeNanos()
            val frameNs = frame.timestamp
            val accessorNs = try { frame.androidCameraTimestamp } catch (_: Exception) { 0L }
            val sensorNs = try { frame.imageMetadata.getLong(ImageMetadata.SENSOR_TIMESTAMP).takeIf { it > 0 } }
                catch (_: NotYetAvailableException) { null } catch (_: MetadataNotFoundException) { null }
            val decision = if (simulation && !realtime) CameraTimestampGate.Decision.Accept(receiptNs, "simulation_host_receipt")
                else gate.observe(frameNs, accessorNs, receiptNs, sensorNs)
            val accepted = when (decision) {
                is CameraTimestampGate.Decision.Wait -> { clockWaitCount++; return false }
                CameraTimestampGate.Decision.Duplicate -> return false
                is CameraTimestampGate.Decision.Reject -> error(decision.reason)
                is CameraTimestampGate.Decision.Accept -> decision
            }
            val image = try { frame.acquireCameraImage() } catch (_: NotYetAvailableException) { cameraUnavailableCount++; return false }
            image.use {
                require(image.timestamp > 0 && (lastImageNs == null || image.timestamp > lastImageNs!!)) { "Missing or nonmonotonic CPU image timestamp" }
                require(image.width == (intrinsics.getValue("imageWidth") as Number).toInt() && image.height == (intrinsics.getValue("imageHeight") as Number).toInt()) { "Image/calibration raster mismatch" }
                val id = sourceId++
                val nativeNs = accepted.cameraNs
                val mappedNs = Math.addExact(unixAnchorNs, Math.subtractExact(nativeNs, elapsedAnchorNs))
                val start = originNs ?: nativeNs.also { originNs = it }
                val ptsUs = pts.allocate(nativeNs, start)
                val event = mapOf<String, Any?>(
                    "recording_id" to recordingId, "stream_id" to "rgb", "source_frame_id" to id.toString(), "state" to "acquired",
                    "native_timestamp_ns" to nativeNs.toString(),
                    "native_clock_id" to if (simulation && !realtime) "android.elapsed_realtime_receipt" else "android.camera.sensor_timestamp",
                    "mapped_capture_time_ns" to mappedNs.toString(), "clock_mapping_revision" to "android_elapsed_to_unix_v1",
                    "calibration_id" to "rgb_$id", "encoder_pts_us" to ptsUs.toString(),
                    "encoder_time_base" to mapOf("numerator" to 1, "denominator" to 1_000_000),
                    "native_timestamps" to mapOf("arcore_frame_timestamp_ns" to frameNs.toString(), "arcore_image_timestamp_ns" to image.timestamp.toString(),
                        "android_camera_timestamp_ns" to accessorNs.toString(), "metadata_sensor_timestamp_ns" to sensorNs?.toString(),
                        "host_receipt_elapsed_ns" to receiptNs.toString(), "camera_clock_source" to accepted.source),
                    "tracking_state" to trackingState, "rgb_intrinsics" to intrinsics,
                    "width" to image.width, "height" to image.height, "raster" to "native_cpu_unrotated",
                    "simulation_transport_only" to (simulation && !realtime))
                queue { writer.writeH264FrameEvent(event); writer.writeIntrinsics(mappedNs, intrinsics) }
                pending[ptsUs] = Pending(id, mappedNs)
                val submitted = encoder.submit(image, ptsUs) {
                    queue { writer.writeH264FrameEvent(event + ("state" to "submitted")) }
                    metrics.submittedToEncoderFrameCount.incrementAndGet()
                }
                if (!submitted) {
                    pending.remove(ptsUs)
                    queue { writer.writeH264FrameEvent(event + mapOf("state" to "dropped", "reason" to "codec_input_backpressure")) }
                    metrics.rgbEncoderFailureCount++; metrics.droppedFrameCount.incrementAndGet(); return false
                }
                lastImageNs = image.timestamp
                metrics.lastCapturedRgbTimestampNs = image.timestamp
                metrics.actualVideoWidth = image.width; metrics.actualVideoHeight = image.height
                metrics.rgbTimestampRange.record(image.timestamp)
                submittedFrameIdentity = event
                return true
            }
        } catch (error: Throwable) {
            fatalError = "${error.javaClass.simpleName}: ${error.message}"
            if (metrics.firstRgbCaptureError == null) metrics.firstRgbCaptureError = fatalError
            writer.recordWriteFailure("H.264 capture failed: $fatalError", error)
            return false
        }
    }

    fun writeRawMotion(samples: List<open.fpvlabs.stera.ar_recorder.sensors.RawMotionSample>, dropped: Long) {
        if (fatalError != null) return
        if (dropped > 0) {
            fatalError = "Independent IMU queue overflow: $dropped events lost"
            writer.recordWriteFailure(fatalError!!); return
        }
        if (samples.isEmpty()) return
        try { queue {
            for (sample in samples) writer.writeRawMotionEvent(sample.sensor, mapOf(
                "recording_id" to recordingId, "stream_id" to sample.sensor, "event_id" to sample.eventId.toString(),
                "native_timestamp_ns" to sample.timestampNs.toString(), "native_clock_id" to "android.elapsed_realtime",
                "mapped_capture_time_ns" to (unixAnchorNs + sample.timestampNs - elapsedAnchorNs).toString(),
                "clock_mapping_revision" to "android_elapsed_to_unix_v1", "callback_elapsed_ns" to sample.callbackElapsedNs.toString(),
                "accuracy" to sample.accuracy, "x" to sample.x, "y" to sample.y, "z" to sample.z,
                "unit" to if (sample.sensor == "accel") "m/s^2" else "rad/s",
                "axes" to "android_device_x_right_y_up_z_out_of_screen", "includes_gravity" to (sample.sensor == "accel")))
        } } catch (error: Throwable) {
            fatalError = "Independent IMU writer failed: ${error.message}"
            writer.recordWriteFailure(fatalError!!, error)
        }
    }

    fun currentSubmittedIdentity(): Map<String, Any?>? = submittedFrameIdentity?.toMap()

    fun writePose(timestampNs: Long, pose: FloatArray, trackingState: String): Boolean {
        if (fatalError != null) return false
        return try { queue { writer.writePoseRow(timestampNs, pose, trackingState) }; true }
        catch (error: Throwable) { fatalError = "Pose writer queue failed: ${error.message}"; writer.recordWriteFailure(fatalError!!, error); false }
    }

    fun writeFrameGeometry(timestampNs: Long, geometry: Map<String, Any?>) {
        if (fatalError != null) return
        try { queue { writer.writeCaptureFrameInfo(timestampNs, geometry) } }
        catch (error: Throwable) { fatalError = "Geometry writer queue failed: ${error.message}"; writer.recordWriteFailure(fatalError!!, error) }
    }

    fun writeDeviceHealth(timestampNs: Long, snapshot: RuntimeHealthManager.CachedDeviceMetrics) {
        if (fatalError != null) return
        try { queue {
            writer.writeDeviceMetrics(timestampNs, snapshot.batteryLevel, snapshot.batteryState, snapshot.batteryStateStr,
                snapshot.cpuUsage, snapshot.memoryUsedMb, snapshot.memoryAvailableMb, snapshot.thermalState, snapshot.thermalStateStr)
        } } catch (error: Throwable) {
            fatalError = "Device health writer failed: ${error.message}"
            writer.recordWriteFailure(fatalError!!, error)
        }
    }

    fun finish() {
        try {
            encoder.finish()
            check(pending.isEmpty()) { "Unresolved H.264 PTS identities: ${pending.size}" }
            fatalError?.let { error(it) }
        } finally { encoder.close() }
    }
    fun abort() { encoder.close(); pending.clear() }
    fun terminalStats(): Map<String, Any?> = mapOf("encoder_eos_seen" to encoder.eosSeen,
        "encoder_submitted_count" to encoder.submitted, "requested_sync_frames" to encoder.requestedSyncFrames, "encoder_output_count" to encoder.output,
        "unresolved_encoder_identities" to pending.size, "encoder_actual_format" to encoder.actualFormat,
        "queued_encoded_bytes" to queuedVideoBytes.get(), "peak_queued_encoded_bytes" to peakQueuedVideoBytes.get(),
        "max_queued_encoded_bytes" to MAX_QUEUED_VIDEO_BYTES,
        "first_h264_error" to fatalError, "camera_unavailable_count" to cameraUnavailableCount,
        "clock_wait_count" to clockWaitCount, "backpressure_skip_count" to backpressureSkipCount, "qualification" to if (simulation) "simulation_only" else "unqualified")
    companion object { const val MAX_QUEUED_VIDEO_BYTES = 16L * 1024L * 1024L }
}
