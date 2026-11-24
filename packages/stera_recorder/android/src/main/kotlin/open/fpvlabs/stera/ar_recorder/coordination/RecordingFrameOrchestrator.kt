package open.fpvlabs.stera.ar_recorder.coordination

import android.os.Handler
import android.os.SystemClock
import open.fpvlabs.stera.ar_recorder.data.DatasetWriter
import open.fpvlabs.stera.ar_recorder.encoding.CpuImageEncoder
import open.fpvlabs.stera.ar_recorder.RecordingConfig
import open.fpvlabs.stera.ar_recorder.geometry.CaptureGeometry
import open.fpvlabs.stera.ar_recorder.geometry.SavedRaster
import com.google.ar.core.Coordinates2d
import open.fpvlabs.stera.ar_recorder.encoding.FrameSampler
import open.fpvlabs.stera.ar_recorder.session.ArFrameProcessor
import open.fpvlabs.stera.ar_recorder.session.ArSessionManager
import open.fpvlabs.stera.ar_recorder.session.FrameProcessingPipeline
import com.google.ar.core.Frame

/**
 * Orchestrates per-frame recording logic that was previously inline in
 * [ArRecorderImpl.processRecordingFrame].
 *
 * Each call to [processFrame] handles:
 * - ARCore cadence estimation
 * - Tracking transition evaluation
 * - Intrinsics extraction (first frame)
 * - Encoder backpressure gate
 * - RGB video encoding
 * - Pose extraction and writing
 * - Point cloud extraction and writing
 * - Depth extraction and writing
 * - Frame log row writing
 * Raw IMU is drained independently by [MotionDrainCoordinator], never per frame.
 * - Post-frame health checks and maintenance
 */
class RecordingFrameOrchestrator(
    private val metrics: RecordingMetricsState,
    private val healthManager: RuntimeHealthManager,
    private val frameProcessingPipeline: FrameProcessingPipeline,
    private val frameProcessingCoordinator: FrameProcessingCoordinator,
    private val frameProcessor: ArFrameProcessor,
    private val frameSampler: FrameSampler,
    private val datasetWriter: DatasetWriter,
    private val sessionManager: ArSessionManager,
    private val recordError: (String, Throwable?) -> Unit,
    private val cpuImageEncoder: CpuImageEncoder = CpuImageEncoder()
) {
    var h264Controller: H264RecordingController? = null

    /** Saved channel selection for the current recording; set by the recorder before frames flow. */
    @Volatile var channels: RecordingConfig = RecordingConfig()

    private data class CapturedDepth(val timestampNs: Long, val width: Int, val height: Int,
                                     val intrinsics: Map<String, Any>, val mapping: DoubleArray)

    companion object {
        private const val JPEG_QUALITY = 80
    }

    /**
     * Processes a single recording frame. Called from the frame loop for every
     * ARCore frame while recording is active.
     *
     * @param frame the ARCore frame
     * @param camera the AR camera
     * @param isPaused whether recording is paused
     * @param writerHandler handler for async write operations (nullable)
     * @param recordingStartTime recording start timestamp in millis
     * @param estimateProjectionBytes function to estimate projected dataset bytes
     */
    fun processFrame(
        frame: Frame,
        camera: com.google.ar.core.Camera,
        isPaused: Boolean,
        writerHandler: Handler?,
        recordingStartTime: Long,
        estimateProjectionBytes: (Long) -> Long
    ) {
        if (!frameProcessingPipeline.shouldProcess(isPaused, frame)) {
            return
        }

        val timestamp = frame.timestamp
        if (!metrics.observeArcoreFrame(timestamp)) return
        val globalFrameIndex = metrics.globalArFrameIndex
        updateArcoreCadenceEstimate(timestamp)

        val trackingState = frameProcessor.extractTrackingState(camera)
        val trackingTransition = frameProcessingPipeline.evaluateTrackingTransition(
            timestampNs = timestamp,
            camera = camera,
            trackingPausedAtNs = metrics.trackingPausedAtNs,
            trackingPauseCount = metrics.trackingPauseCount,
            trackingPauseTotalOffsetNs = metrics.trackingPauseTotalOffsetNs,
            wasTrackingInPreviousFrame = metrics.wasTrackingInPreviousFrame,
            depthCadenceResetCount = metrics.depthCadenceResetCount,
            // RGB keeps its own cadence through tracking loss, so the schedule is never shifted by it.
            onTrackingPauseOffset = { }
        )
        metrics.trackingPausedAtNs = trackingTransition.trackingPausedAtNs
        metrics.trackingPauseCount = trackingTransition.trackingPauseCount
        metrics.trackingPauseTotalOffsetNs = trackingTransition.trackingPauseTotalOffsetNs
        metrics.wasTrackingInPreviousFrame = trackingTransition.wasTrackingInPreviousFrame
        metrics.depthCadenceResetCount = trackingTransition.depthCadenceResetCount
        val isTracking = metrics.wasTrackingInPreviousFrame

        var depthAvailable = false
        var pointCloudAvailable = false
        var encoded = false
        var rgbImage: CpuImageEncoder.EncodedImage? = null
        var rgbCaptureDiagnostics: Map<String, Any?>? = null
        var rgbIntrinsics: Map<String, Any>? = null
        var capturedDepth: CapturedDepth? = null

        val activeH264 = h264Controller
        if (activeH264 != null) {
            // RGB follows the native camera cadence even while AR tracking is paused or lost; tracking state is
            // written as explicit per-frame pose evidence instead of gating capture.
            // Saved-pixel calibration follows the exact encoded raster; unavailable intrinsics are an explicit state.
            val sourceIntrinsics = runCatching { frameProcessor.extractIntrinsics(camera) }.getOrNull()
            val poseSnapshot = if (isTracking) frameProcessor.extractPose(camera) else null
            val poseState = when {
                trackingState == "TRACKING" && poseSnapshot != null -> "tracking"
                trackingState == "PAUSED" -> "paused"
                trackingState == "STOPPED" -> "lost"
                trackingState == "TRACKING" -> "lost"
                else -> "unknown"
            }
            if (activeH264.capture(frame, poseState, poseSnapshot, sourceIntrinsics) && poseSnapshot != null) {
                metrics.poseFrameCount.incrementAndGet(); metrics.poseTimestampRange.record(timestamp)
            }
            metrics.frameCount++
            return
        }

        // Tracking loss invalidates the estimated pose, never the required RGB: a pose is exported only
        // from a TRACKING camera and is otherwise absent, with the ARCore failure reason recorded.
        val pose = if (isTracking) frameProcessor.extractPose(camera) else null
        val trackingFailureReason = if (isTracking) null else runCatching { camera.trackingFailureReason.name }.getOrDefault("UNKNOWN")
        val shouldSample = frameSampler.shouldEncodeFrame(timestamp)

        if (!shouldSample) {
            metrics.rgbSamplingSkippedCount++
        }
        var savedRaster: SavedRaster? = null
        var sourceCalibration: Map<String, Any>? = null

        if (shouldSample) {
            metrics.rgbEncodeAttemptCount++
            rgbImage = try {
                // Intrinsics are read per frame so a frame without them is rejected, not saved uncalibrated.
                val sourceIntrinsics = frameProcessor.extractIntrinsics(camera).also { sourceCalibration = it }
                cpuImageEncoder.encode(frame, sourceIntrinsics, JPEG_QUALITY, metrics.lastCapturedRgbTimestampNs) { rgbCaptureDiagnostics = it }
            } catch (error: Exception) {
                if (metrics.firstRgbCaptureError == null) {
                    metrics.firstRgbCaptureError = "${error.javaClass.simpleName}: ${error.message}"
                }
                recordError("CPU RGB capture rejected: ${error.message}", error)
                null
            }
            val image = rgbImage
            // Calibration describes the pixels actually saved (identity for the CPU path), not the preview.
            val raster = image?.let { SavedRaster.identity(it.width, it.height) }
            val intrinsics = if (raster != null) {
                try { raster.intrinsics(checkNotNull(sourceCalibration)) } catch (error: Exception) {
                    if (metrics.firstRgbCaptureError == null) {
                        metrics.firstRgbCaptureError = "${error.javaClass.simpleName}: ${error.message}"
                    }
                    recordError("Saved-raster calibration rejected: ${error.message}", error); null
                }
            } else null
            savedRaster = raster
            val submitted = image != null && intrinsics != null && writerHandler != null && writerHandler.post {
                datasetWriter.writeIntrinsics(image.timestampNs, intrinsics)
                if (pose != null) datasetWriter.writePoseRow(timestamp, pose, trackingState)
                datasetWriter.writeCompressedRgbFrame(image.timestampNs, image.jpeg, associationTimestampNs = timestamp)
            }
            if (submitted && image != null) {
                metrics.lastCapturedRgbTimestampNs = image.timestampNs
                rgbIntrinsics = intrinsics
                metrics.actualVideoWidth = image.width
                metrics.actualVideoHeight = image.height
                if (pose != null) {
                    metrics.poseFrameCount.incrementAndGet()
                    metrics.poseTimestampRange.record(timestamp)
                }
                if (isTracking && channels.recordPointCloud) {
                    pointCloudAvailable = processPointCloud(frame, timestamp, globalFrameIndex, writerHandler)
                }
                if (channels.recordDepth) {
                    capturedDepth = processDepth(frame, timestamp, globalFrameIndex, isTracking, intrinsics!!, writerHandler)
                }
                depthAvailable = capturedDepth != null
                encoded = true
                metrics.rgbTimestampRange.record(image.timestampNs)
                metrics.addTimestampWithCap(metrics.rgbFrameTimestamps, image.timestampNs)
                metrics.rgbEncodedFrameIndices.add(globalFrameIndex)
                metrics.encodedVideoFrameCount.incrementAndGet()
                metrics.submittedToEncoderFrameCount.incrementAndGet()
            } else {
                if (image != null && intrinsics != null) {
                    datasetWriter.recordWriteFailure("Writer queue rejected RGB capture")
                    if (metrics.firstRgbCaptureError == null) metrics.firstRgbCaptureError = "Writer queue rejected RGB capture"
                }
                metrics.rgbEncoderFailureCount++
                metrics.rgbEncoderFailureFrameIndices.add(globalFrameIndex)
                metrics.droppedFrameCount.incrementAndGet()
            }
        }

        // Snapshot values now: queued writer callbacks must not read a later frame's mutable state.
        val frameInfo = linkedMapOf<String, Any?>(
            "capture_geometry_version" to CaptureGeometry.VERSION,
            "frame_timestamp_ns" to timestamp,
            "android_camera_timestamp_ns" to frame.androidCameraTimestamp,
            "rgb_frame_association" to "Frame.acquireCameraImage_same_frame",
            "rgb_timestamp_clock" to "ARCore_Image_timestamp_source_specific",
            "frame_timestamp_clock" to "ARCore_Frame_timestamp_timebase_undefined",
            "android_camera_timestamp_clock" to "Frame.getAndroidCameraTimestamp",
            "cross_stream_clock_verified" to false,
            "rgb_capture_diagnostics" to rgbCaptureDiagnostics,
            "rgb_timestamp_ns" to if (encoded) rgbImage?.timestampNs else null,
            "depth_timestamp_ns" to capturedDepth?.timestampNs,
            "tracking_state" to trackingState,
            "pose_valid" to (pose != null && encoded),
            "tracking_failure_reason" to trackingFailureReason,
            "pose_exported" to (pose != null && encoded),
            "saved_raster" to if (encoded) savedRaster?.toMap() else null,
            "calibration_source" to "camera.imageIntrinsics_mapped_through_saved_raster",
            "rgb_encoded" to encoded,
            "depth_available" to depthAvailable,
            "rgb_width" to if (encoded) rgbImage?.width else null,
            "rgb_height" to if (encoded) rgbImage?.height else null,
            "depth_width" to capturedDepth?.width,
            "depth_height" to capturedDepth?.height,
            "rgb_intrinsics" to rgbIntrinsics,
            "depth_intrinsics" to capturedDepth?.intrinsics,
            "rgb_pixel_to_depth_pixel" to capturedDepth?.mapping?.toList()
        )
        if (writerHandler == null || !writerHandler.post { datasetWriter.writeCaptureFrameInfo(timestamp, frameInfo) }) {
            datasetWriter.recordWriteFailure("Writer queue rejected frame geometry")
        }

        // Write frame log
        val frameIndex = metrics.frameCount
        writerHandler?.post {
            datasetWriter.writeFrameLogRow(
                frameIndex = frameIndex,
                globalArFrameIndex = globalFrameIndex,
                arcoreTimestampNs = timestamp,
                trackingState = trackingState,
                encoded = encoded,
                depthAvailable = depthAvailable,
                pointCloudAvailable = pointCloudAvailable
            )
        } ?: datasetWriter.writeFrameLogRow(
            frameIndex = frameIndex,
            globalArFrameIndex = globalFrameIndex,
            arcoreTimestampNs = timestamp,
            trackingState = trackingState,
            encoded = encoded,
            depthAvailable = depthAvailable,
            pointCloudAvailable = pointCloudAvailable
        )

        writerHandler?.post {
            // Write device metrics per-frame (~15Hz) using cached values
            healthManager.writeDeviceMetricsForFrame(timestamp)
            datasetWriter.flushRealtimeData(timestamp)
        }

        // Refresh device metrics cache (~every 500ms) on the frame processing thread
        healthManager.maybeRefreshDeviceMetricsCache()

        healthManager.verifyResourceReleaseParity()
        healthManager.maybeSampleRuntimeHealth()
        healthManager.maybeRunPeriodicMaintenance()
        syncSamplerStats()
        healthManager.maybeLogSizeProjection(recordingStartTime, estimateProjectionBytes)

        metrics.frameCount++
    }

    // ── Internal helpers ─────────────────────────────────────────────────

    private fun processPointCloud(
        frame: Frame,
        timestamp: Long,
        globalFrameIndex: Int,
        writerHandler: Handler?
    ): Boolean {
        val pointCloudPoolAvailable = frameProcessor.getPointCloudPoolAvailableCount()
        if (pointCloudPoolAvailable == 0) {
            metrics.pointCloudSoftSkipCount++
            metrics.pointcloudDroppedFrameIndices.add(globalFrameIndex)
            return false
        } else {
            val pointCloudData = frameProcessor.extractPointCloudFrame(frame, timestamp)
            if (pointCloudData == null) {
                metrics.pointcloudDroppedFrameIndices.add(globalFrameIndex)
                return false
            }
            if (writerHandler == null || !writerHandler.post {
                datasetWriter.writePointCloud(timestamp, pointCloudData)
            }) {
                pointCloudData.release()
                metrics.pointcloudDroppedFrameIndices.add(globalFrameIndex)
                return false
            }
            metrics.pointCloudTimestampRange.record(timestamp)
            metrics.pointcloudFrameIndices.add(globalFrameIndex)
            metrics.pointCloudFrameCount.incrementAndGet()
            return true
        }
    }

    private fun processDepth(
        frame: Frame,
        timestamp: Long,
        globalFrameIndex: Int,
        isTracking: Boolean,
        rgbIntrinsics: Map<String, Any>,
        writerHandler: Handler?
    ): CapturedDepth? {
        if (!sessionManager.isDepthSupported) return null

        if (!isTracking) {
            metrics.trackingPauseDepthSkipCount++
            metrics.depthDroppedFrameIndices.add(globalFrameIndex)
            return null
        }

        metrics.addTimestampWithCap(metrics.depthAssociationCandidateRgbTimestamps, timestamp)
        metrics.depthAttemptCount++
        val depthStartNs = SystemClock.elapsedRealtimeNanos()
        val depthFrame = frameProcessor.extractDepthImage(frame)
        val depthLatencyNs = SystemClock.elapsedRealtimeNanos() - depthStartNs
        metrics.depthAcquisitionSamples++
        metrics.depthAcquisitionTotalLatencyNs += depthLatencyNs
        if (depthLatencyNs > metrics.depthAcquisitionMaxLatencyNs) {
            metrics.depthAcquisitionMaxLatencyNs = depthLatencyNs
        }

        if (depthFrame == null) {
            metrics.skippedDepthFrameCount.incrementAndGet()
            metrics.depthDroppedFrameIndices.add(globalFrameIndex)
            return null
        }
        val captured = try {
            val rgbWidth = (rgbIntrinsics.getValue("imageWidth") as Number).toInt()
            val rgbHeight = (rgbIntrinsics.getValue("imageHeight") as Number).toInt()
            val corners = floatArrayOf(0f, 0f, rgbWidth.toFloat(), 0f, 0f, rgbHeight.toFloat(),
                rgbWidth.toFloat(), rgbHeight.toFloat())
            val textureCorners = FloatArray(8)
            frame.transformCoordinates2d(Coordinates2d.IMAGE_PIXELS, corners,
                Coordinates2d.TEXTURE_NORMALIZED, textureCorners)
            val mapping = CaptureGeometry.rgbToDepthMatrix(rgbWidth, rgbHeight,
                depthFrame.width, depthFrame.height, textureCorners)
            val intrinsics = CaptureGeometry.depthIntrinsics(rgbIntrinsics, depthFrame.width, depthFrame.height, mapping)
            CapturedDepth(depthFrame.timestampNs, depthFrame.width, depthFrame.height, intrinsics, mapping)
        } catch (error: Exception) {
            depthFrame.release()
            metrics.skippedDepthFrameCount.incrementAndGet()
            metrics.depthDroppedFrameIndices.add(globalFrameIndex)
            recordError("Depth calibration rejected: ${error.message}", error)
            return null
        }
        if (writerHandler == null || !writerHandler.post {
            datasetWriter.writeDepthIntrinsics(captured.timestampNs, captured.intrinsics)
            if (!datasetWriter.writeDepthFrame(timestamp = captured.timestampNs, frameData = depthFrame, associationTimestampNs = timestamp)) {
                metrics.skippedDepthFrameCount.incrementAndGet()
            }
        }) {
            depthFrame.release()
            return null
        }
        metrics.depthSuccessCount++
        metrics.depthFrameIndices.add(globalFrameIndex)
        metrics.depthTimestampRange.record(captured.timestampNs)
        metrics.addTimestampWithCap(metrics.depthFrameTimestamps, captured.timestampNs)
        metrics.depthFrameCount.incrementAndGet()
        return captured
    }

    private fun syncSamplerStats() {
        val stats = frameProcessingCoordinator.syncSamplerStats()
        if (stats.totalExpectedFrameCount != 0L) {
            metrics.totalExpectedFrameCount = stats.totalExpectedFrameCount
        }
        if (stats.deterministicFrameIndex != 0L) {
            metrics.deterministicFrameIndex = stats.deterministicFrameIndex
        }
        if (stats.sessionStartTimestampNs != Long.MIN_VALUE) {
            metrics.sessionStartTimestampNs = stats.sessionStartTimestampNs
        }
    }

    private fun updateArcoreCadenceEstimate(arcoreTimestampNs: Long) {
        val stats = frameProcessingCoordinator.updateArcoreCadenceEstimate(
            arcoreTimestampNs = arcoreTimestampNs,
            lastArcoreTimestampNsForEstimate = metrics.lastArcoreTimestampNsForEstimate,
            arcoreCadenceSamples = metrics.arcoreCadenceSamples,
            arcoreCadenceMeanIntervalNs = metrics.arcoreCadenceMeanIntervalNs,
            arcoreCadenceM2IntervalNs = metrics.arcoreCadenceM2IntervalNs
        )
        metrics.arcoreCadenceSamples = stats.samples
        metrics.arcoreCadenceMeanIntervalNs = stats.meanIntervalNs
        metrics.arcoreCadenceM2IntervalNs = stats.m2IntervalNs
        metrics.lastArcoreTimestampNsForEstimate = stats.lastArcoreTimestampNsForEstimate
    }
}
