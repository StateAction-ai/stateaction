package open.fpvlabs.stera.ar_recorder.coordination

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.os.Handler
import android.os.SystemClock
import com.google.ar.core.Frame
import com.google.ar.core.ImageMetadata
import com.google.ar.core.exceptions.MetadataNotFoundException
import com.google.ar.core.exceptions.NotYetAvailableException
import open.fpvlabs.stera.ar_recorder.data.DatasetWriter
import open.fpvlabs.stera.ar_recorder.data.h264.CaptureProtocol
import open.fpvlabs.stera.ar_recorder.data.h264.H264CaptureSetup
import open.fpvlabs.stera.ar_recorder.data.h264.H264Evidence
import open.fpvlabs.stera.ar_recorder.finalization.CaptureOutcomePolicy
import open.fpvlabs.stera.ar_recorder.encoding.CameraTimestampGate
import open.fpvlabs.stera.ar_recorder.encoding.H264AccessUnit
import open.fpvlabs.stera.ar_recorder.encoding.CpuImageIdentityPolicy
import open.fpvlabs.stera.ar_recorder.encoding.H264EncoderProfile
import open.fpvlabs.stera.ar_recorder.encoding.H264PreflightException
import open.fpvlabs.stera.ar_recorder.encoding.H264RgbEncoder
import open.fpvlabs.stera.ar_recorder.data.h264.FramePts
import open.fpvlabs.stera.ar_recorder.geometry.H264Calibration
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/**
 * Owns one H.264 take: frame identity and original clocks, the bounded encoder-PTS join and the bounded writer
 * queue. The ARCore Frame and CPU Image never leave [capture]; only detached evidence and encoded bytes cross to the
 * writer thread, and no imagery crosses the Flutter bridge.
 *
 * Construction is the preflight: an unsupported encoder, camera clock or emulator/hardware mismatch throws before any
 * file is created.
 */
class H264RecordingController(
    context: Context,
    val recordingId: String,
    val encoderProfile: H264EncoderProfile,
    cameraId: String,
    imuRequested: Boolean,
    depthRequested: Boolean,
    depthSupported: Boolean,
    private val writer: DatasetWriter,
    private val writerHandler: Handler,
    private val metrics: RecordingMetricsState,
) {
    private data class Pending(val id: Long, val captureTimeNs: Long)

    private val pending = LinkedHashMap<Long, Pending>()
    private val pts = FramePts()
    private val gate = CameraTimestampGate()
    /** Saved-raster calibration for exactly the pixels this take encodes (identity: no crop/resize/rotation). */
    val calibration = H264Calibration(encoderProfile.width, encoderProfile.height)
    private val queuedWrites = AtomicInteger()
    private val queuedVideoBytes = AtomicLong()
    private val peakQueuedVideoBytes = AtomicLong()
    private val peakQueuedWrites = AtomicInteger()
    private val anchor: H264Evidence.Anchor
    private val realtimeCameraClock: Boolean
    private val rgbClock: String
    private val encoder: H264RgbEncoder
    private var originNs: Long? = null
    private var nextSourceId = 0L
    private var lastImageNs = 0L
    private var cameraImageUnavailable = 0L
    private var backpressureSkips = 0L
    private var repeatedCpuImages = 0L
    private var cpuImageFrameMismatches = 0L
    private var codecInputDrops = 0L
    private var calibrationRejected = 0L
    @Volatile var failure: String? = null; private set
    @Volatile var interruptionReason: String? = null; private set
    val setup: H264CaptureSetup

    init {
        val cameraManager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val source = cameraManager.getCameraCharacteristics(cameraId).get(CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE)
        realtimeCameraClock = source == CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE_REALTIME
        if (!realtimeCameraClock && !encoderProfile.simulation) {
            throw H264PreflightException("Camera $cameraId timestamp source is not REALTIME; capture time cannot be mapped")
        }
        rgbClock = if (realtimeCameraClock) H264Evidence.CAMERA_CLOCK else H264Evidence.SIMULATION_RECEIPT_CLOCK
        val sensors = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
        val plan = H264Evidence.SensorPlan(rgbClock, imuRequested,
            sensors.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) != null, sensors.getDefaultSensor(Sensor.TYPE_GYROSCOPE) != null,
            depthRequested, depthSupported)
        val before = SystemClock.elapsedRealtimeNanos()
        val epoch = System.currentTimeMillis() * 1_000_000L
        anchor = H264Evidence.Anchor(before, epoch, SystemClock.elapsedRealtimeNanos())
        encoder = H264RgbEncoder(encoderProfile, ::onAccessUnit)
        val profile = mutableMapOf<String, Any?>(
            "recording_id" to recordingId, "rgb_profile" to encoderProfile.name,
            "qualification" to if (encoderProfile.simulation) "simulation_only" else "unqualified",
            "encoder" to mapOf("codec" to "h264", "profile" to "main", "name" to encoderLabel(encoder.codecName),
                "hardware" to encoder.hardware, "width" to encoderProfile.width, "height" to encoderProfile.height,
                "fps" to encoderProfile.fps, "bitrate" to encoderProfile.bitrate, "b_frames" to 0, "idr_interval_seconds" to 1),
            "limits" to mapOf("pending_frames" to CaptureProtocol.MAX_PENDING, "access_unit_bytes" to CaptureProtocol.MAX_ACCESS_UNIT,
                "max_queued_encoded_bytes" to MAX_QUEUED_VIDEO_BYTES.toInt()),
        )
        if (encoderProfile.simulation) profile["mapped_timeline_semantics"] = "simulation_transport_only"
        setup = H264CaptureSetup(profile, H264Evidence.clocks(recordingId, anchor, rgbClock, realtimeCameraClock)) { acquired, accel, gyro ->
            H264Evidence.inventory(plan, acquired, accel, gyro, calibration.inventoryState)
        }
    }

    /**
     * Called on the producer thread for every unique ARCore frame while recording. Returns true only when an acquired
     * image was queued into the codec. Tracking state never gates RGB; it is recorded as explicit pose evidence.
     */
    fun capture(frame: Frame, trackingState: String, pose: FloatArray?, sourceIntrinsics: Map<String, Any>?): Boolean {
        if (failure != null) return false
        return try {
            encoder.drain()
            if (pending.size >= CaptureProtocol.MAX_PENDING || queuedWrites.get() >= MAX_QUEUED_WRITES - 4) {
                backpressureSkips++; metrics.droppedFrameCount.incrementAndGet(); return false
            }
            val receiptNs = SystemClock.elapsedRealtimeNanos()
            val frameNs = frame.timestamp
            val accessorNs = try { frame.androidCameraTimestamp } catch (_: Exception) { 0L }
            val metadataNs = try { frame.imageMetadata.getLong(ImageMetadata.SENSOR_TIMESTAMP).takeIf { it > 0 } }
                catch (_: NotYetAvailableException) { null } catch (_: MetadataNotFoundException) { null }
            val decision = if (!realtimeCameraClock) CameraTimestampGate.Decision.Accept(receiptNs, "simulation_host_receipt", null, CameraTimestampGate.MetadataAssociation.ABSENT)
                else gate.observe(frameNs, accessorNs, receiptNs, metadataNs)
            val accepted = when (decision) {
                is CameraTimestampGate.Decision.Wait, CameraTimestampGate.Decision.Duplicate -> return false
                is CameraTimestampGate.Decision.Reject -> error("Camera clock rejected: ${decision.reason}")
                is CameraTimestampGate.Decision.Accept -> decision
            }
            val image = try { frame.acquireCameraImage() } catch (_: NotYetAvailableException) { cameraImageUnavailable++; return false }
            image.use {
                check(image.timestamp > 0 && image.timestamp >= lastImageNs) { "Missing or regressing camera image timestamp" }
                // ARCore can hand back the previous CPU image for a newer Frame: it is not a new image.
                if (image.timestamp == lastImageNs) { repeatedCpuImages++; return false }
                // Hardware identity: the accepted native camera clock (the value written as the RGB clock) describes this
                // capture, so the encoded CPU image must carry it. Frame.timestamp has an undefined time base and stays
                // separate evidence. A different capture is skipped and counted, never relabelled.
                when (CpuImageIdentityPolicy.evaluate(encoderProfile.simulation, image.timestamp, accepted.cameraNs)) {
                    CpuImageIdentityPolicy.Verdict.IDENTICAL -> Unit
                    CpuImageIdentityPolicy.Verdict.MISMATCH_RECORDED_SIMULATION -> cpuImageFrameMismatches++
                    CpuImageIdentityPolicy.Verdict.MISMATCH_REJECTED -> { cpuImageFrameMismatches++; lastImageNs = image.timestamp; return false }
                }
                if (image.width != encoderProfile.width || image.height != encoderProfile.height) {
                    throw H264PreflightException("Camera image ${image.width}x${image.height} differs from ${encoderProfile.width}x${encoderProfile.height}; no resize fallback")
                }
                // The calibration must describe the pixels about to be encoded; an impossible mapping is rejected here,
                // before any frame identity exists, and counted.
                calibration.observe(nextSourceId, image.width, image.height, sourceIntrinsics)?.let { reason ->
                    calibrationRejected++
                    if (metrics.firstRgbCaptureError == null) metrics.firstRgbCaptureError = "Calibration rejected: $reason"
                    return false
                }
                val id = nextSourceId++
                val mappedNs = anchor.map(accepted.cameraNs)
                val ptsUs = pts.allocate(accepted.cameraNs, originNs ?: accepted.cameraNs.also { originNs = it })
                val event = H264Evidence.acquired(recordingId, id, accepted.cameraNs, rgbClock, mappedNs, ptsUs,
                    frameNs, image.timestamp, accepted.metadataSensorNs)
                queue { evidence -> evidence.frameEvent(event); evidence.pose(event, trackingState, pose) }
                pending[ptsUs] = Pending(id, mappedNs)
                val queued = encoder.submit(image, ptsUs) {
                    queue { evidence -> evidence.frameEvent(event + ("state" to "submitted")) }
                    metrics.submittedToEncoderFrameCount.incrementAndGet()
                }
                if (!queued) {
                    pending.remove(ptsUs)
                    codecInputDrops++
                    queue { evidence -> evidence.frameEvent(event + mapOf("state" to "dropped", "reason" to "codec_input_backpressure")) }
                    metrics.droppedFrameCount.incrementAndGet()
                    return false
                }
                lastImageNs = image.timestamp
                metrics.lastCapturedRgbTimestampNs = image.timestamp
                metrics.actualVideoWidth = image.width
                metrics.actualVideoHeight = image.height
                metrics.rgbTimestampRange.record(image.timestamp)
                true
            }
        } catch (error: Throwable) {
            fail("H.264 capture failed", error)
            false
        }
    }

    /** Ends the codec stream within its deadline, writes every remaining access unit, then Inventory/Close. */
    fun finish(interruptionReason: String? = null, eosDeadlineMs: Long = H264RgbEncoder.EOS_DEADLINE_MS) {
        this.interruptionReason = interruptionReason
        try {
            if (failure == null) {
                try { encoder.finish(eosDeadlineMs) } catch (error: Throwable) { fail("H.264 end of stream failed", error) }
            }
        } finally {
            encoder.close()
            // Evaluated on the writer thread so a write failure that lands before Close is never missed. A reasoned
            // interruption closes as `aborted` with an explicit reason; any failure wins over it.
            post(always = true) {
                val (outcome, reason) = CaptureOutcomePolicy.closeFor(interruptionReason, failure ?: writer.getWriteFailure())
                writer.closeH264Capture(outcome, reason)
            }
        }
    }

    /** Stops without draining; frames still pending stay unresolved and the writer closes the take as failed/aborted. */
    fun abort() {
        try { encoder.close() } finally { pending.clear() }
    }

    /** Persisted calibration evidence; encoded size is the codec's actual output format, never the request. */
    fun calibrationReport(): Map<String, Any?> {
        val format = encoder.outputFormat
        return calibration.report(format["width"] as? Int, format["height"] as? Int)
    }

    fun terminalStats(): Map<String, Any?> = mapOf(
        "recording_id" to recordingId, "profile" to encoderProfile.name,
        "qualification" to if (encoderProfile.simulation) "simulation_only" else "unqualified",
        "camera_clock" to rgbClock, "camera_clock_source_realtime" to realtimeCameraClock,
        "encoder" to encoder.identity(), "unresolved_encoder_identities" to pending.size,
        "camera_image_unavailable" to cameraImageUnavailable, "pre_acquisition_backpressure_skips" to backpressureSkips,
        "codec_input_drops" to codecInputDrops, "calibration_rejected_frames" to calibrationRejected, "repeated_cpu_images_skipped" to repeatedCpuImages,
        "cpu_image_frame_timestamp_mismatches" to cpuImageFrameMismatches,
        "cpu_image_frame_mismatch_policy" to if (encoderProfile.simulation) "recorded_simulation_only" else "skipped_not_acquired", "clock_waits" to gate.waits, "duplicate_camera_frames" to gate.duplicates,
        "metadata_timestamp_stale" to gate.staleMetadata, "metadata_timestamp_ahead" to gate.aheadMetadata,
        "peak_queued_encoded_bytes" to peakQueuedVideoBytes.get(), "max_queued_encoded_bytes" to MAX_QUEUED_VIDEO_BYTES,
        "peak_queued_writes" to peakQueuedWrites.get(), "max_queued_writes" to MAX_QUEUED_WRITES,
        "first_error" to failure, "interruption_reason" to interruptionReason,
    )

    private fun onAccessUnit(unit: H264AccessUnit) {
        val identity = pending.remove(unit.ptsUs) ?: error("Encoder emitted unknown PTS ${unit.ptsUs}")
        val size = unit.bytes.size.toLong()
        val total = queuedVideoBytes.addAndGet(size)
        if (total > MAX_QUEUED_VIDEO_BYTES) {
            queuedVideoBytes.addAndGet(-size)
            error("Encoded writer byte bound exceeded")
        }
        peakQueuedVideoBytes.accumulateAndGet(total, ::maxOf)
        try {
            queue({ queuedVideoBytes.addAndGet(-size) }) { evidence ->
                evidence.accessUnit(identity.id, identity.captureTimeNs, unit.ptsUs, unit.bytes)
                metrics.encodedVideoFrameCount.incrementAndGet()
            }
        } catch (error: Throwable) {
            queuedVideoBytes.addAndGet(-size)
            throw error
        }
    }

    private fun queue(release: () -> Unit = {}, block: (open.fpvlabs.stera.ar_recorder.data.H264CaptureWriter) -> Unit) {
        post(release) { block(checkNotNull(writer.h264Capture()) { "H.264 evidence writer is not open" }) }
    }

    private fun post(release: () -> Unit = {}, always: Boolean = false, block: () -> Unit) {
        val depth = queuedWrites.incrementAndGet()
        if (depth > MAX_QUEUED_WRITES) {
            queuedWrites.decrementAndGet()
            error("Bounded H.264 writer queue exhausted")
        }
        peakQueuedWrites.accumulateAndGet(depth, ::maxOf)
        val posted = writerHandler.post {
            try {
                if (always || writer.getWriteFailure() == null) block()
            } catch (error: Throwable) {
                writer.recordWriteFailure("H.264 writer failed: ${error.message}", error)
            } finally {
                queuedWrites.decrementAndGet(); release()
            }
        }
        if (!posted) {
            queuedWrites.decrementAndGet(); release()
            error("Writer thread rejected H.264 evidence")
        }
    }

    private fun fail(message: String, error: Throwable) {
        if (failure == null) failure = "$message: ${error.javaClass.simpleName}: ${error.message}"
        if (metrics.firstRgbCaptureError == null) metrics.firstRgbCaptureError = failure
        writer.recordWriteFailure(message, error)
    }

    companion object {
        const val MAX_QUEUED_VIDEO_BYTES = 16L * 1024L * 1024L
        const val MAX_QUEUED_WRITES = 128
        private fun encoderLabel(name: String): String =
            name.replace(Regex("[^A-Za-z0-9._-]"), "_").trimStart('.', '_', '-').take(64).ifEmpty { "unknown" }
    }
}
