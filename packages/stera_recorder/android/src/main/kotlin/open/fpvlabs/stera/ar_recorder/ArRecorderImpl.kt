package open.fpvlabs.stera.ar_recorder

import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.SurfaceTexture
import android.media.MediaExtractor
import android.media.MediaFormat
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.SystemClock
import open.fpvlabs.stera.ar_recorder.coordination.H264RecordingController
import open.fpvlabs.stera.ar_recorder.coordination.FrameProcessingCoordinator
import open.fpvlabs.stera.ar_recorder.coordination.MetadataAssembler
import open.fpvlabs.stera.ar_recorder.coordination.PerformanceOptimizer
import open.fpvlabs.stera.ar_recorder.coordination.RecordingFinalizationCoordinator
import open.fpvlabs.stera.ar_recorder.coordination.RecordingFrameOrchestrator
import open.fpvlabs.stera.ar_recorder.coordination.RecordingHealthMonitor
import open.fpvlabs.stera.ar_recorder.coordination.RecordingLifecycleCoordinator
import open.fpvlabs.stera.ar_recorder.coordination.RecordingMetricsState
import open.fpvlabs.stera.ar_recorder.coordination.RecordingStateManager
import open.fpvlabs.stera.ar_recorder.coordination.RecordingActivityGate
import open.fpvlabs.stera.ar_recorder.coordination.RuntimeHealthManager
import open.fpvlabs.stera.ar_recorder.coordination.VideoEncodingCoordinator
import open.fpvlabs.stera.ar_recorder.data.DatasetWriter
import open.fpvlabs.stera.ar_recorder.data.DatasetWriterImpl
import open.fpvlabs.stera.ar_recorder.data.MCAPDatasetWriter
import open.fpvlabs.stera.ar_recorder.data.StorageManager
import open.fpvlabs.stera.ar_recorder.finalization.CaptureOutcomePolicy
import open.fpvlabs.stera.ar_recorder.finalization.CaptureResourceGuard
import open.fpvlabs.stera.ar_recorder.finalization.FinalizationBudget
import open.fpvlabs.stera.ar_recorder.finalization.FinalizationJournal
import open.fpvlabs.stera.ar_recorder.finalization.FinalizationPhase
import open.fpvlabs.stera.ar_recorder.finalization.FinalizationTimeout
import open.fpvlabs.stera.ar_recorder.finalization.RecoveryScanner
import open.fpvlabs.stera.ar_recorder.data.StorageManagerImpl
import open.fpvlabs.stera.ar_recorder.encoding.EglManager
import open.fpvlabs.stera.ar_recorder.encoding.EglManagerImpl
import open.fpvlabs.stera.ar_recorder.encoding.FrameSampler
import open.fpvlabs.stera.ar_recorder.encoding.FrameSamplerImpl
import open.fpvlabs.stera.ar_recorder.encoding.VideoEncoder
import open.fpvlabs.stera.ar_recorder.encoding.VideoEncoderImpl
import open.fpvlabs.stera.ar_recorder.metrics.PerformanceMonitor
import open.fpvlabs.stera.ar_recorder.metrics.PerformanceMonitorImpl
import open.fpvlabs.stera.ar_recorder.metrics.RecordingMetricsCollector
import open.fpvlabs.stera.ar_recorder.metrics.RecordingMetricsCollectorImpl
import open.fpvlabs.stera.ar_recorder.sensors.ImuCollector
import open.fpvlabs.stera.ar_recorder.sensors.ImuCollectorImpl
import open.fpvlabs.stera.ar_recorder.sensors.DEFAULT_MOTION_RATE_HZ
import open.fpvlabs.stera.ar_recorder.coordination.MotionCaptureController
import open.fpvlabs.stera.ar_recorder.coordination.MotionDrainCoordinator
import open.fpvlabs.stera.ar_recorder.coordination.MotionScheduler
import open.fpvlabs.stera.ar_recorder.session.ArFrameProcessor
import open.fpvlabs.stera.ar_recorder.session.ArFrameProcessorImpl
import open.fpvlabs.stera.ar_recorder.session.ArSessionManager
import open.fpvlabs.stera.ar_recorder.session.ArSessionManagerImpl
import open.fpvlabs.stera.ar_recorder.session.FrameProcessingPipeline
import open.fpvlabs.stera.ar_recorder.session.SessionLifecycleManager
import com.google.ar.core.ArCoreApk
import com.google.ar.core.Frame
import io.flutter.view.TextureRegistry
import java.io.File
import java.nio.ByteBuffer
import java.util.Date
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Main implementation of ArRecorder.
 * Orchestrates ARCore session, video encoding, IMU collection, and data writing.
 *
 * Delegates per-frame processing to [RecordingFrameOrchestrator],
 * runtime health monitoring to [RuntimeHealthManager],
 * metadata assembly to [MetadataAssembler],
 * and all mutable recording counters live in [RecordingMetricsState].
 */
class ArRecorderImpl(
    private val context: Context,
    private val textureRegistry: TextureRegistry,
    datasetWriterOverride: DatasetWriter? = null
) : ArRecorder {

    private companion object {
        private const val RESOURCE_POLL_MS = 1_000L
        private const val SIZE_WARNING_THRESHOLD_BYTES = 2L * 1024L * 1024L * 1024L
        private const val VIDEO_FPS_FIXED = 15
        private const val VIDEO_BITRATE_30 = 10_000_000
        private const val VIDEO_BITRATE_1080P = 15_000_000
        private const val VIDEO_BITRATE_FALLBACK = 8_000_000
        private const val VIDEO_IFRAME_INTERVAL_SECONDS = 1
        private const val STORAGE_SAFETY_FACTOR = 0.8
        private const val STORAGE_PROJECTION_DURATION_SECONDS = 600L
        private const val DEPTH_BYTES_PER_SECOND_ESTIMATE = 2_500_000L
        private const val POINTCLOUD_BYTES_PER_SECOND_ESTIMATE = 250_000L
        private const val CSV_LOG_BYTES_PER_SECOND_ESTIMATE = 150_000L
        private const val POINTCLOUD_POOL_CAPACITY = 20
        private const val DEPTH_POOL_CAPACITY = 24

        /** Feature flag: when true, spatial data is written as MCAP; when false, uses legacy CSV+ZIP. */
        const val USE_MCAP_FORMAT = true
    }

    private val mainHandler = Handler(Looper.getMainLooper())

    // ── Core sub-components ──────────────────────────────────────────────
    private val sessionManager: ArSessionManager = ArSessionManagerImpl(context)
    private val eglManager: EglManager = EglManagerImpl()
    private val frameProcessor: ArFrameProcessor = ArFrameProcessorImpl()
    private val imuCollector: ImuCollector = ImuCollectorImpl(context)
    private val datasetWriter: DatasetWriter = datasetWriterOverride ?: if (USE_MCAP_FORMAT) {
        MCAPDatasetWriter(
            context,
            Build.MODEL,
            "${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})"
        )
    } else {
        DatasetWriterImpl(
            context,
            Build.MODEL,
            "${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})"
        )
    }
    private val storageManager: StorageManager = StorageManagerImpl(
        safetyFactor = STORAGE_SAFETY_FACTOR,
        videoBitrateBitsPerSecond = VIDEO_BITRATE_1080P.toLong(),
        depthBytesPerSecondEstimate = DEPTH_BYTES_PER_SECOND_ESTIMATE,
        pointCloudBytesPerSecondEstimate = POINTCLOUD_BYTES_PER_SECOND_ESTIMATE,
        csvLogBytesPerSecondEstimate = CSV_LOG_BYTES_PER_SECOND_ESTIMATE
    )
    private val frameSampler: FrameSampler = FrameSamplerImpl(VIDEO_FPS_FIXED)
    private val metricsCollector: RecordingMetricsCollector = RecordingMetricsCollectorImpl()
    private val performanceMonitor: PerformanceMonitor = PerformanceMonitorImpl()
    private val videoEncoderManager: VideoEncoder = VideoEncoderImpl(
        logSystem = { message -> datasetWriter.logSystem(message) },
        recordError = { message, throwable -> recordError(message, throwable) },
        onEncodedSample = { metrics.encodedVideoFrameCount.incrementAndGet() }
    )
    private val videoEncodingCoordinator = VideoEncodingCoordinator(
        videoEncoder = videoEncoderManager,
        eglManager = eglManager,
        logSystem = { message -> datasetWriter.logSystem(message) },
        recordError = { message, throwable -> recordError(message, throwable) },
        onEncodedSampleSubmitted = { metrics.submittedToEncoderFrameCount.incrementAndGet() }
    )
    private val frameProcessingCoordinator = FrameProcessingCoordinator(
        frameSampler = frameSampler
    )
    private val recordingHealthMonitor = RecordingHealthMonitor(context)
    private val recordingLifecycleCoordinator = RecordingLifecycleCoordinator()
    private val recordingFinalizationCoordinator = RecordingFinalizationCoordinator()
    private val performanceOptimizer = PerformanceOptimizer()
    private val recordingStateManager = RecordingStateManager()
    private val frameProcessingPipeline = FrameProcessingPipeline()
    private val sessionLifecycleManager = SessionLifecycleManager()

    // ── Extracted state/orchestration classes ─────────────────────────────
    private val metrics = RecordingMetricsState()
    private val healthManager = RuntimeHealthManager(
        metrics = metrics,
        healthMonitor = recordingHealthMonitor,
        performanceOptimizer = performanceOptimizer,
        videoEncodingCoordinator = videoEncodingCoordinator,
        frameProcessingCoordinator = frameProcessingCoordinator,
        frameProcessor = frameProcessor,
        eglManager = eglManager,
        performanceMonitor = performanceMonitor,
        datasetWriter = datasetWriter,
        recordError = { message, throwable -> recordError(message, throwable) }
    )
    private val metadataAssembler = MetadataAssembler(metricsCollector)
    private val motionDrain = MotionDrainCoordinator(imuCollector, datasetWriter) { written ->
        written.forEach { metrics.imuTimestampRange.record(it.nativeTimestampNs) }
    }
    private val motionCapture = MotionCaptureController(
        collector = imuCollector,
        writer = datasetWriter,
        drain = motionDrain,
        postToMain = { mainHandler.post(it) },
        postToWriter = { task -> writerHandler?.post(task) == true },
        haltCapture = {
            metrics.totalErrorsEncountered++
            if (currentState == ArRecordingState.RECORDING) isRecording.withProducerPaused { isPaused.set(true) }
        },
        log = { android.util.Log.e("SteraCapture", it) },
    )
    private val frameOrchestrator = RecordingFrameOrchestrator(
        metrics = metrics,
        healthManager = healthManager,
        frameProcessingPipeline = frameProcessingPipeline,
        frameProcessingCoordinator = frameProcessingCoordinator,
        frameProcessor = frameProcessor,
        frameSampler = frameSampler,
        datasetWriter = datasetWriter,
        sessionManager = sessionManager,
        recordError = { message, throwable -> recordError(message, throwable) }
    )

    // ── Thread management ────────────────────────────────────────────────
    private var frameThread: HandlerThread? = null
    private var frameHandler: Handler? = null
    private var writerThread: HandlerThread? = null
    private var writerHandler: Handler? = null

    // ── Core state ───────────────────────────────────────────────────────
    @Volatile
    private var currentState = ArRecordingState.UNINITIALIZED
    private val isRecording = RecordingActivityGate()
    @Volatile
    private var isPaused = AtomicBoolean(false)
    @Volatile
    private var shouldStopFrameLoop = AtomicBoolean(false)
    @Volatile
    private var releaseInProgress = AtomicBoolean(false)

    // ── Flutter preview ──────────────────────────────────────────────────
    private var flutterTexture: TextureRegistry.SurfaceTextureEntry? = null
    private var previewSurfaceTexture: SurfaceTexture? = null
    private var targetRgbLandscapeWidth: Int = 1280
    private var targetRgbLandscapeHeight: Int = 720
    private var previewWidth: Int = 1280
    private var previewHeight: Int = 720
    private var isPreviewBufferSizeSet = false
    private var previewResolutionDerived: Boolean = false

    // ── Camera / resolution ──────────────────────────────────────────────
    private var sensorWidth: Int = 1920
    private var sensorHeight: Int = 1080
    private var cameraResolution: String = "1920x1080"
    private var recordingResolution: String = "1280x720"
    private var isLowQualityMode: Boolean = false
    private var lowQualityReason: String? = null
    private val upscaleApplied: Boolean = false

    // ── Timing ───────────────────────────────────────────────────────────
    private var activeRecordingConfig = RecordingConfig()
    private var sessionConfig = RecordingConfig()
    private var h264TerminalStats: Map<String, Any?> = emptyMap()
    private val failureStopPosted = AtomicBoolean(false)

    // ── SA-56 bounded finalization state ───────────────────────────────
    private var journal: FinalizationJournal? = null
    @Volatile private var pendingStopReason: String? = null
    /** Set when a stop could not prove its writer/threads are quiet; no new take until the session is disposed. */
    @Volatile private var finalizationUncertain = false
    private var lastResourcePollMs = 0L
    @Volatile var lastRecoveryReport: RecoveryScanner.Report? = null; private set
    /** Test seams: simulated storage/thermal and a fault hook after each journaled phase (never set in production). */
    @Volatile var resourceProbeOverride: (() -> Pair<Long, Int?>)? = null
    @Volatile var phaseFaultHook: ((FinalizationPhase) -> Unit)? = null
    private var recordingStartTime: Long = 0
    private var pauseStartedAtMs: Long = 0
    private var totalPausedDurationMs: Long = 0
    private var lastTrackingState: String = "STOPPED"
    private var lastErrorMessage: String? = null

    // ── Video file reference ─────────────────────────────────────────────
    private var currentVideoFile: java.io.File? = null

    // ── Direct buffers for ARCore UV coordinate transformation ───────────
    private val uvCoordsInBuffer: java.nio.FloatBuffer = java.nio.ByteBuffer.allocateDirect(8 * 4)
        .order(java.nio.ByteOrder.nativeOrder())
        .asFloatBuffer()
        .apply {
            put(floatArrayOf(0.0f, 0.0f, 1.0f, 0.0f, 0.0f, 1.0f, 1.0f, 1.0f))
            flip()
        }
    private val uvCoordsOutBuffer: java.nio.FloatBuffer = java.nio.ByteBuffer.allocateDirect(8 * 4)
        .order(java.nio.ByteOrder.nativeOrder())
        .asFloatBuffer()
    private val transformedUvs: FloatArray = FloatArray(8)

    // ═════════════════════════════════════════════════════════════════════
    //  Session Lifecycle
    // ═════════════════════════════════════════════════════════════════════

    override fun initializeSession(arguments: Any?): Map<String, Any?> {
        return try {
            if (currentState == ArRecordingState.INITIALIZING) {
                return createErrorResult("Already initializing")
            }
            if (currentState == ArRecordingState.READY) {
                return createSuccessResult(
                    depthSupported = sessionManager.isDepthSupported,
                    textureId = flutterTexture?.id()
                )
            }

            sessionConfig = RecordingConfig.fromMap(arguments)
            applyRgbTargets(sessionConfig)
            sessionManager.configureCameraTarget(sessionConfig.rgbLandscapeWidth, sessionConfig.rgbLandscapeHeight, sessionConfig.isH264)

            currentState = ArRecordingState.INITIALIZING
            println("📷 ArRecorderImpl: Initializing session...")

            flutterTexture = textureRegistry.createSurfaceTexture()
            val textureId = flutterTexture?.id()
            previewSurfaceTexture = flutterTexture?.surfaceTexture()

            if (!eglManager.initialize()) {
                currentState = ArRecordingState.ERROR
                return createErrorResult("Failed to initialize EGL context")
            }
            previewSurfaceTexture?.let { eglManager.setupPreviewSurface(it) }

            if (!imuCollector.initialize()) {
                println("⚠️ IMU collector initialization failed, continuing without IMU")
            }

            sessionManager.checkAvailability { availability ->
                if (availability.isSupported) {
                    (context as? Activity)?.let { activity ->
                        createSessionOnMainThread(activity)
                    } ?: run {
                        currentState = ArRecordingState.ERROR
                        println("❌ Context is not an Activity")
                    }
                } else {
                    currentState = ArRecordingState.ERROR
                    println("❌ ARCore not supported on this device: $availability")
                }
            }

            createSuccessResult(
                depthSupported = sessionManager.isDepthSupported,
                textureId = textureId,
                state = ArRecordingState.INITIALIZING.name
            )
        } catch (e: Exception) {
            currentState = ArRecordingState.ERROR
            println("❌ Failed to initialize session: ${e.message}")
            recordError("Failed to initialize session", e)
            e.printStackTrace()
            createErrorResult(e.message ?: "Unknown error")
        }
    }

    private fun createSessionOnMainThread(activity: Activity) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            performSessionCreation(activity)
            return
        }

        val latch = CountDownLatch(1)
        var failure: Exception? = null
        mainHandler.post {
            try {
                performSessionCreation(activity)
            } catch (e: Exception) {
                failure = e
            } finally {
                latch.countDown()
            }
        }
        latch.await()
        failure?.let { throw it }
    }

    /**
     * Session creation touches Activity-owned ARCore resources, so it stays on the main thread
     * even though recording work later moves onto the frame and writer threads.
     */
    private fun performSessionCreation(activity: Activity) {
        try {
            previewWidth = targetRgbLandscapeWidth
            previewHeight = targetRgbLandscapeHeight
            println("📱 Preview dimensions initial: ${previewWidth}x${previewHeight} (landscape)")

            sessionManager.createSession(activity)
            sessionManager.resume()
            eglManager.makeCurrent()
            eglManager.makeNothingCurrent()

            startFrameLoop()
            println("✅ Session initialization complete")
        } catch (e: Exception) {
            currentState = ArRecordingState.ERROR
            println("❌ Failed to create session: ${e.message}")
            recordError("Failed to create ARCore session", e)
            e.printStackTrace()
            throw e
        }
    }

    private fun startFrameLoop() {
        val handles = sessionLifecycleManager.startThreads { runFrameLoop() }
        frameThread = handles.frameThread
        frameHandler = handles.frameHandler
        writerThread = handles.writerThread
        writerHandler = handles.writerHandler
        healthManager.writerHandler = handles.writerHandler
        shouldStopFrameLoop.set(false)
    }

    // ═════════════════════════════════════════════════════════════════════
    //  Frame Loop
    // ═════════════════════════════════════════════════════════════════════

    private fun runFrameLoop() {
        val session = sessionManager.session
        if (session == null) {
            println("❌ No ARCore session available")
            return
        }

        try {
            eglManager.makeCurrent()
            session.setCameraTextureName(eglManager.cameraTextureId)

            val cameraConfig = session.cameraConfig
            val imageSize = cameraConfig.imageSize
            sensorWidth = imageSize.width
            sensorHeight = imageSize.height
            applyResolutionPolicyFromCameraConfig()
            println("📷 Camera sensor dimensions: ${sensorWidth}x${sensorHeight}")
            println("📱 Preview dimensions: ${previewWidth}x${previewHeight}")
            println("🎥 Recording dimensions: ${metrics.configuredVideoWidth}x${metrics.configuredVideoHeight}")
            if (isLowQualityMode) {
                println("⚠️ Low quality mode enabled: $lowQualityReason")
            }

            while (!shouldStopFrameLoop.get()) {
                val displayRotation = (context as? Activity)?.windowManager?.defaultDisplay?.rotation ?: 0
                session.setDisplayGeometry(displayRotation, previewWidth, previewHeight)

                val frame = session.update()
                val camera = frame.camera

                val loopStartNs = SystemClock.elapsedRealtimeNanos()

                val isReady = sessionManager.updateTrackingState(camera.trackingState)
                val newTrackingState = sessionManager.getTrackingStateString(camera.trackingState)
                if (newTrackingState != lastTrackingState) {
                    datasetWriter.logTrackingStateTransition(lastTrackingState, newTrackingState, frame.timestamp)
                    if (lastTrackingState == ArTrackingState.TRACKING.name && newTrackingState != ArTrackingState.TRACKING.name) {
                        metrics.trackingLossEvents++
                    }
                    lastTrackingState = newTrackingState
                }

                if ((isReady || (sessionConfig.isH264 && frame.timestamp > 0L)) && currentState == ArRecordingState.INITIALIZING) {
                    currentState = ArRecordingState.READY
                    println("✅ ARCore session ready for recording")
                }

                renderFrame(frame, camera)

                isRecording.withActiveRecording {
                    frameOrchestrator.processFrame(
                        frame = frame,
                        camera = camera,
                        isPaused = isPaused.get(),
                        writerHandler = writerHandler,
                        recordingStartTime = recordingStartTime,
                        estimateProjectionBytes = { elapsedMs -> estimateDatasetSizeProjectionBytes(elapsedMs) }
                    )
                }

                if (isRecording.get() && datasetWriter.getWriteFailure() != null && failureStopPosted.compareAndSet(false, true)) {
                    // Post only after releasing the producer gate. stopRecording waits for the
                    // producer, drains EOS and writer work, and preserves failed-session diagnostics.
                    mainHandler.post { if (isRecording.get()) stopRecording() }
                }
                if (isRecording.get() && !failureStopPosted.get()) pollCaptureResources()
                val loopDurationNs = SystemClock.elapsedRealtimeNanos() - loopStartNs
                metrics.renderLoopIterations++
                metrics.renderLoopTotalNs += loopDurationNs
            }
        } catch (e: Exception) {
            if (shouldStopFrameLoop.get() || releaseInProgress.get()) {
                return
            }
            println("❌ Frame loop error: ${e.message}")
            val message = "Frame loop failed: ${e.message}"
            datasetWriter.recordWriteFailure(message, e)
            recordError("Frame loop error", e)
            e.printStackTrace()
            // Keep RECORDING/PAUSED stoppable until the owner thread drains it. Publishing
            // ERROR here used to strand the encoder and IMU because canStop(ERROR) is false.
            lastErrorMessage = message
            failureStopPosted.set(true)
            mainHandler.post {
                if (isRecording.get()) stopRecording()
                // session.update has failed and this loop exited; release it so a later
                // initializeSession creates a fresh session rather than reusing dead state.
                disposeSession()
                currentState = ArRecordingState.ERROR
                lastErrorMessage = message
            }
        }
    }

    private fun renderFrame(frame: Frame, camera: com.google.ar.core.Camera) {
        try {
            uvCoordsInBuffer.rewind()
            uvCoordsOutBuffer.rewind()
            frame.transformDisplayUvCoords(uvCoordsInBuffer, uvCoordsOutBuffer)
            uvCoordsOutBuffer.rewind()
            uvCoordsOutBuffer.get(transformedUvs)

            previewSurfaceTexture?.let {
                if (!isPreviewBufferSizeSet) {
                    it.setDefaultBufferSize(previewWidth, previewHeight)
                    isPreviewBufferSizeSet = true
                }
                eglManager.renderCameraToPreview(previewWidth, previewHeight, transformedUvs)
            }
        } catch (e: Exception) {
            println("⚠️ Preview render error: ${e.message}")
            recordError("Preview render error", e)
            e.printStackTrace()
        }
    }

    // ═════════════════════════════════════════════════════════════════════
    //  Recording Lifecycle
    // ═════════════════════════════════════════════════════════════════════

    override fun startRecording(arguments: Any?): Map<String, Any?> {
        return try {
            if (finalizationUncertain) {
                return createErrorResult("A previous stop did not prove the writer was quiet; dispose the session before recording again")
            }
            if (!recordingStateManager.canStart(currentState)) {
                return createErrorResult("Session not ready. Current state: ${currentState.name}")
            }
            val recordingConfig = RecordingConfig.fromMap(arguments)
            if (!recordingConfig.isH264 && !sessionManager.isSessionReady) {
                return createErrorResult("Tracking not stable. Wait for TRACKING state.")
            }

            activeRecordingConfig = recordingConfig
            failureStopPosted.set(false)
            applyRgbTargets(recordingConfig)
            // H.264 camera raster is checked by the preflight below with an explicit error code.
            if (!recordingConfig.isH264) sessionManager.configureCameraTarget(recordingConfig.rgbLandscapeWidth, recordingConfig.rgbLandscapeHeight, false)

            println("📷 ArRecorderImpl: Starting recording...")
            currentState = ArRecordingState.RECORDING

            val storagePrecheck = verifyStorageHeadroomForLongRecording()
            if (!storagePrecheck.first) {
                currentState = ArRecordingState.READY
                return createErrorResult(storagePrecheck.second ?: "Insufficient storage headroom")
            }

            // H.264 preflight runs before any file exists: unsupported encoder, camera raster/clock or an
            // emulator/hardware profile mismatch is an explicit start error, never a lowered-quality fallback.
            h264TerminalStats = emptyMap()
            val h264Controller = if (recordingConfig.isH264) try {
                val camera = checkNotNull(sessionManager.session) { "AR session unavailable" }.cameraConfig
                if (camera.imageSize.width != recordingConfig.rgbLandscapeWidth || camera.imageSize.height != recordingConfig.rgbLandscapeHeight) {
                    throw open.fpvlabs.stera.ar_recorder.encoding.H264PreflightException(
                        "Camera CPU image ${camera.imageSize.width}x${camera.imageSize.height} is not the required ${recordingConfig.rgbLandscapeWidth}x${recordingConfig.rgbLandscapeHeight}")
                }
                H264RecordingController(context, recordingConfig.recordingId ?: java.util.UUID.randomUUID().toString(),
                    if (recordingConfig.h264SimulationMode) open.fpvlabs.stera.ar_recorder.encoding.H264EncoderProfile.SIMULATION
                    else open.fpvlabs.stera.ar_recorder.encoding.H264EncoderProfile.HARDWARE,
                    camera.cameraId, recordingConfig.recordImu, recordingConfig.recordDepth, sessionManager.isDepthSupported,
                    datasetWriter, checkNotNull(writerHandler) { "Writer thread unavailable" }, metrics)
            } catch (e: Exception) {
                currentState = ArRecordingState.READY
                recordError("H.264 preflight failed", e)
                return createErrorResult("H.264 preflight failed: ${e.message}") + mapOf("errorCode" to "H264_PREFLIGHT")
            } else null

            val sessionBaseDir = File(context.getExternalFilesDir(null), "ar_sessions")
            // No recording is active here, so any earlier session whose finalization never became durable is
            // quarantined (marker only; originals untouched, nothing deleted, nothing admitted).
            lastRecoveryReport = try {
                RecoveryScanner.scan(sessionBaseDir, { SystemClock.elapsedRealtime() }, { System.currentTimeMillis() })
            } catch (error: Throwable) { recordError("Recovery scan failed", error); null }
            pendingStopReason = null
            journal = null
            val sessionDir = datasetWriter.createSessionDirectory(sessionBaseDir)
                ?: run { h264Controller?.abort(); currentState = ArRecordingState.READY; return createErrorResult("Failed to create output directory") }
            try {
                journal = FinalizationJournal.begin(sessionDir, h264Controller?.recordingId ?: sessionDir.name)
            } catch (error: Throwable) {
                // Without a durable journal the take could not be recovered; refuse it before any evidence exists.
                h264Controller?.abort()
                try { sessionDir.delete() } catch (_: Throwable) {}
                currentState = ArRecordingState.READY
                recordError("Recovery journal could not be created", error)
                return createErrorResult("Recovery journal could not be created: ${error.message}")
            }

            // Reset all metrics and health state
            val encodeBitrate =
                if (recordingConfig.rgbVideoHeight >= 1080) VIDEO_BITRATE_1080P else VIDEO_BITRATE_30
            metrics.reset(
                defaultVideoWidth = targetRgbLandscapeWidth,
                defaultVideoHeight = targetRgbLandscapeHeight,
                sensorWidth = sensorWidth,
                sensorHeight = sensorHeight,
                defaultBitrate = encodeBitrate,
                defaultFps = VIDEO_FPS_FIXED
            )
            healthManager.reset()
            cameraResolution = "${sensorWidth}x${sensorHeight}"
            recordingResolution = "${metrics.configuredVideoWidth}x${metrics.configuredVideoHeight}"
            isLowQualityMode = false
            lowQualityReason = null

            frameProcessor.prepareForRecording(
                pointCloudPoolCapacity = if (recordingConfig.isH264) { if (recordingConfig.recordPointCloud) 4 else 0 } else POINTCLOUD_POOL_CAPACITY,
                depthPoolCapacity = if (recordingConfig.isH264) { if (recordingConfig.recordDepth && sessionManager.isDepthSupported) 4 else 0 } else DEPTH_POOL_CAPACITY
            )
            recordingStartTime = System.currentTimeMillis()
            pauseStartedAtMs = 0L
            totalPausedDurationMs = 0L
            frameSampler.reset()
            if (!previewResolutionDerived) {
                applyResolutionPolicyFromCameraConfig()
            }

            frameOrchestrator.h264Controller = h264Controller
            datasetWriter.configureH264Capture(h264Controller?.setup)
            if (h264Controller != null) {
                metrics.configuredVideoWidth = recordingConfig.rgbLandscapeWidth
                metrics.configuredVideoHeight = recordingConfig.rgbLandscapeHeight
                metrics.targetVideoBitrate = h264Controller.encoderProfile.bitrate
            }
            if (!datasetWriter.initializeWriters()) {
                throw IllegalStateException("Failed to initialize writers")
            }

            val arcoreVersion = resolveArCoreVersion()
            datasetWriter.logSystem("Session start time: ${Date(recordingStartTime)}")
            datasetWriter.logSystem("Storage path: ${sessionDir.absolutePath}")
            datasetWriter.logSystem("Device model: ${Build.MODEL}")
            datasetWriter.logSystem("Android version: ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
            datasetWriter.logSystem("ARCore version: $arcoreVersion")
            datasetWriter.logSystem("Depth supported: ${sessionManager.isDepthSupported}")
            datasetWriter.logSystem("Camera resolution: $cameraResolution")
            datasetWriter.logSystem("Selected camera config: ${sessionManager.selectedCameraResolution}")
            datasetWriter.logSystem("Focus mode: ${sessionManager.selectedFocusMode}")
            datasetWriter.logSystem("Preview resolution: ${previewWidth}x${previewHeight}")
            datasetWriter.logSystem("Recording resolution: $recordingResolution")
            datasetWriter.logSystem("Low quality mode: $isLowQualityMode (${lowQualityReason ?: "none"})")
            datasetWriter.logSystem(
                "Sensor sampling: independent accelerometer and gyroscope, ${DEFAULT_MOTION_RATE_HZ} Hz requested each " +
                    "(samplingPeriodUs=${1_000_000 / DEFAULT_MOTION_RATE_HZ}, maxReportLatencyUs=0); original SensorEvent timestamps"
            )
            datasetWriter.logSystem("Pool capacities: depth=$DEPTH_POOL_CAPACITY pointcloud=$POINTCLOUD_POOL_CAPACITY")

            metrics.targetEncodeFps = if (recordingConfig.isH264) 30 else VIDEO_FPS_FIXED
            metrics.encodeFrameIntervalNs = 1_000_000_000L / metrics.targetEncodeFps
            metrics.dynamicEncoderMode = if (recordingConfig.isH264) "native_h264_to_mcap" else "jpeg_to_mcap"

            frameSampler.configure(metrics.targetEncodeFps)

            datasetWriter.logSystem(
                if (recordingConfig.isH264) "H264 capture mode: width=${metrics.configuredVideoWidth} height=${metrics.configuredVideoHeight} fps=${metrics.targetEncodeFps} topic=/camera/rgb/video recording_id=${h264Controller?.recordingId}"
                else "JPEG capture mode: width=${metrics.configuredVideoWidth} height=${metrics.configuredVideoHeight} fps=${metrics.targetEncodeFps} topic=/camera/rgb/compressed"
            )

            motionCapture.start(motionScheduler(), DEFAULT_MOTION_RATE_HZ)
            isRecording.set(true)
            isPaused.set(false)

            println("✅ Recording started: $sessionDir")

            createSuccessResult(
                state = ArRecordingState.RECORDING.name,
                outputDirectory = sessionDir.absolutePath,
                isLowQualityMode = isLowQualityMode,
                lowQualityReason = lowQualityReason,
                cameraResolution = cameraResolution,
                recordingResolution = recordingResolution
            ) + mapOf("recordingId" to h264Controller?.recordingId, "rgbCodec" to recordingConfig.rgbCodec)
        } catch (e: Exception) {
            isRecording.set(false)
            var cleanupSucceeded = true
            try { motionCapture.stopCollection() } catch (_: Throwable) { cleanupSucceeded = false }
            try { frameOrchestrator.h264Controller?.abort() } catch (_: Throwable) { cleanupSucceeded = false }
            frameOrchestrator.h264Controller = null
            // The partial container closes as an explicit failed take, never as an unexplained abort.
            datasetWriter.recordWriteFailure("Recording start failed", e)
            try { drainWriterQueue(tail = { datasetWriter.finalize() }) } catch (_: Throwable) { cleanupSucceeded = false }
            frameProcessor.releaseRecordingBuffers()
            currentState = if (cleanupSucceeded) ArRecordingState.READY else ArRecordingState.ERROR
            recordError("Failed to start recording", e)
            createErrorResult("Failed to start recording: ${e.message}")
        }
    }

    override fun pauseRecording(): Map<String, Any?> {
        return try {
            if (!recordingStateManager.canPause(currentState)) {
                return createErrorResult("Not recording. Current state: ${currentState.name}")
            }
            val pauseResult = recordingLifecycleCoordinator.pauseRecording(System.currentTimeMillis())
            isRecording.withProducerPaused { isPaused.set(pauseResult.isPaused) }
            pauseStartedAtMs = pauseResult.pauseStartedAtMs
            currentState = pauseResult.nextState
            // Admitted motion is written before the writers pause; nothing is discarded.
            val flushMotion = motionCapture.pause()
            drainWriterQueue {
                flushMotion()
                datasetWriter.pauseWriters()
            }
            createSuccessResult(
                state = ArRecordingState.PAUSED.name,
                outputDirectory = datasetWriter.getSessionDirectory(),
                isLowQualityMode = isLowQualityMode,
                lowQualityReason = lowQualityReason,
                cameraResolution = cameraResolution,
                recordingResolution = recordingResolution
            )
        } catch (e: Exception) {
            createErrorResult("Failed to pause recording: ${e.message}")
        }
    }

    override fun resumeRecording(): Map<String, Any?> {
        return try {
            if (!recordingStateManager.canResume(currentState)) {
                return createErrorResult("Not paused. Current state: ${currentState.name}")
            }
            motionCapture.stopReason?.let { return createErrorResult("Capture stopped: $it. Stop to save diagnostics.") }
            val resumeResult = recordingLifecycleCoordinator.resumeRecording(
                nowMs = System.currentTimeMillis(),
                pauseStartedAtMs = pauseStartedAtMs,
                totalPausedDurationMs = totalPausedDurationMs
            )
            totalPausedDurationMs = resumeResult.totalPausedDurationMs
            pauseStartedAtMs = resumeResult.pauseStartedAtMs
            datasetWriter.resumeWriters()
            motionCapture.resume(motionScheduler())?.let { return createErrorResult("Capture stopped: $it") }
            isRecording.withProducerPaused { isPaused.set(resumeResult.isPaused) }
            currentState = resumeResult.nextState
            createSuccessResult(
                state = ArRecordingState.RECORDING.name,
                outputDirectory = datasetWriter.getSessionDirectory(),
                isLowQualityMode = isLowQualityMode,
                lowQualityReason = lowQualityReason,
                cameraResolution = cameraResolution,
                recordingResolution = recordingResolution
            )
        } catch (e: Exception) {
            createErrorResult("Failed to resume recording: ${e.message}")
        }
    }

    override fun cancelRecording(): Map<String, Any?> {
        return try {
            if (!recordingStateManager.canCancel(currentState)) {
                return createErrorResult("Not recording. Current state: ${currentState.name}")
            }
            val cancelResult = recordingLifecycleCoordinator.cancelRecording()
            currentState = cancelResult.nextState
            isRecording.set(cancelResult.isRecording)
            isPaused.set(cancelResult.isPaused)
            pauseStartedAtMs = cancelResult.pauseStartedAtMs
            totalPausedDurationMs = cancelResult.totalPausedDurationMs

            motionCapture.stopCollection()
            frameOrchestrator.h264Controller?.abort(); frameOrchestrator.h264Controller = null
            abortVideoEncoder()
            drainWriterQueue()
            frameProcessor.releaseRecordingBuffers()
            val deleted = datasetWriter.deleteSessionDirectory()
            if (!deleted) {
                currentState = ArRecordingState.ERROR
                return createErrorResult("Failed to discard recording files")
            }

            currentState = ArRecordingState.READY
            mapOf(
                "success" to true,
                "state" to ArRecordingState.READY.name,
                "cancelled" to true,
                "outputDirectory" to null,
                "previewWidth" to previewWidth,
                "previewHeight" to previewHeight,
                "error" to null
            )
        } catch (e: Exception) {
            currentState = ArRecordingState.ERROR
            createErrorResult("Failed to cancel recording: ${e.message}")
        }
    }

    /** Samples storage and heat at most once a second and requests a reasoned controlled stop; never degrades quality. */
    private fun pollCaptureResources() {
        val now = SystemClock.elapsedRealtime()
        if (now - lastResourcePollMs < RESOURCE_POLL_MS) return
        lastResourcePollMs = now
        val (free, thermal) = resourceProbeOverride?.invoke() ?: run {
            val dir = datasetWriter.getSessionDirectory()?.let(::File) ?: return
            val status = if (Build.VERSION.SDK_INT >= 29) {
                (context.getSystemService(Context.POWER_SERVICE) as? android.os.PowerManager)?.currentThermalStatus
            } else null
            dir.usableSpace to status
        }
        val decision = CaptureResourceGuard.evaluate(free, thermal)
        if (decision is CaptureResourceGuard.Decision.Stop && failureStopPosted.compareAndSet(false, true)) {
            pendingStopReason = decision.reason
            datasetWriter.logSystem("Controlled stop requested: ${decision.reason} (${decision.detail})")
            mainHandler.post { if (isRecording.get()) stopRecording() }
        }
    }

    private fun drainWriterQueue(timeoutMs: Long = 30_000L, tail: () -> Unit = {}) {
        val handler = checkNotNull(writerHandler) { "Writer thread unavailable; refusing concurrent finalization" }
        check(Looper.myLooper() != handler.looper) { "Cannot drain writer from its own thread" }
        val latch = CountDownLatch(1)
        var failure: Throwable? = null
        check(handler.post {
            try { tail() } catch (error: Throwable) { failure = error } finally { latch.countDown() }
        }) { "Writer queue rejected the finalization barrier" }
        if (!latch.await(timeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS)) {
            finalizationUncertain = true
            throw IllegalStateException("Writer drain timed out; recording not finalized")
        }
        failure?.let { throw IllegalStateException("Writer finalization barrier failed", it) }
    }

    override fun stopRecording(): Map<String, Any?> {
        return try {
            if (!recordingStateManager.canStop(currentState)) {
                return createErrorResult("Not recording. Current state: ${currentState.name}")
            }

            println("📷 ArRecorderImpl: Stopping recording...")
            currentState = ArRecordingState.STOPPING
            val budget = FinalizationBudget(nowMs = { SystemClock.elapsedRealtime() })
            val stopReason = pendingStopReason
            journal?.advance(FinalizationPhase.STOPPING, stopReason = stopReason)
            phaseFaultHook?.invoke(FinalizationPhase.STOPPING)

            isRecording.set(false)
            if (isPaused.get()) {
                val pausedSince = pauseStartedAtMs
                if (pausedSince > 0L) {
                    totalPausedDurationMs += (System.currentTimeMillis() - pausedSince).coerceAtLeast(0L)
                }
            }
            isPaused.set(false)
            pauseStartedAtMs = 0L

            motionCapture.stopCollection()

            // Compute core stats
            val coreStats = recordingFinalizationCoordinator.computeCoreStats(
                nowMs = System.currentTimeMillis(),
                recordingStartTimeMs = recordingStartTime,
                totalPausedDurationMs = totalPausedDurationMs,
                arcoreFrameCount = metrics.arcoreFrameCount.get(),
                encodedVideoFrameCount = metrics.encodedVideoFrameCount.get(),
                depthFrameCount = metrics.depthFrameCount.get(),
                pointCloudFrameCount = metrics.pointCloudFrameCount.get(),
                imuSampleCount = 0,
                videoFileSizeBytes = null
            )

            val resolutionFallback = metrics.actualVideoWidth != 0 && metrics.actualVideoHeight != 0 &&
                (metrics.actualVideoWidth != metrics.configuredVideoWidth || metrics.actualVideoHeight != metrics.configuredVideoHeight)
            if (resolutionFallback) {
                datasetWriter.logSystem(
                    "FALLBACK: encoder produced ${metrics.actualVideoWidth}x${metrics.actualVideoHeight} instead of ${metrics.configuredVideoWidth}x${metrics.configuredVideoHeight}"
                )
            }

            val encoderQueueDepth = metrics.encoderQueueDepth()
            if (encoderQueueDepth > metrics.maxEncoderQueueDepth) {
                metrics.maxEncoderQueueDepth = encoderQueueDepth
            }

            // isRecording.set(false) above waits for the in-flight producer. No new
            // frame can enqueue after this barrier; tail IMU must also use the writer queue.
            drainWriterQueue(budget.phaseTimeoutMs("writer_barrier", FinalizationBudget.WRITER_BARRIER_CAP_MS)) {
                datasetWriter.resumeWriters()
                // Stop uncertainty and motion saturation are sticky capture failures.
                motionCapture.finishOnWriter()
            }

            // H.264: drain the codec to end of stream and write Inventory/Close only after every admitted motion
            // event is written, so the Close counts and outcome cover the whole take.
            val h264 = frameOrchestrator.h264Controller
            journal?.advance(FinalizationPhase.DRAINING_ENCODER)
            phaseFaultHook?.invoke(FinalizationPhase.DRAINING_ENCODER)
            if (h264 != null) {
                try { h264.finish(stopReason, budget.phaseTimeoutMs("encoder_eos", FinalizationBudget.ENCODER_EOS_CAP_MS)) }
                catch (error: FinalizationTimeout) { throw error }
                catch (error: Throwable) { datasetWriter.recordWriteFailure("H.264 end of stream failed: ${error.message}", error) }
                frameOrchestrator.h264Controller = null
                drainWriterQueue(budget.phaseTimeoutMs("close_barrier", FinalizationBudget.WRITER_BARRIER_CAP_MS))
                h264TerminalStats = h264.terminalStats() + mapOf("evidence" to datasetWriter.h264Capture()?.stats())
            }

            datasetWriter.captureFreeStorageAfterSnapshot()

            val stats = datasetWriter.getRecordingStats()
            val totalBytesWritten = (stats["totalBytesWritten"] as? Long) ?: 0L
            val imuSampleCount = (stats["imuSampleCount"] as? Int ?: 0)
            val appVersion = resolveAppVersion()
            val appBuild = resolveAppBuild()

            // Assemble metadata via MetadataAssembler
            val finalizationResult = metadataAssembler.assemble(
                MetadataAssembler.FinalizationInput(
                    metrics = metrics,
                    health = healthManager,
                    coreStats = coreStats,
                    sessionManager = sessionManager,
                    frameProcessor = frameProcessor,
                    imuCollector = imuCollector,
                    datasetWriter = datasetWriter,
                    eglManager = eglManager,
                    recordingResolution = recordingResolution,
                    cameraResolution = cameraResolution,
                    previewWidth = previewWidth,
                    previewHeight = previewHeight,
                    isLowQualityMode = isLowQualityMode,
                    lowQualityReason = lowQualityReason,
                    upscaleApplied = upscaleApplied,
                    arcoreVersion = resolveArCoreVersion(),
                    appVersion = appVersion,
                    appBuild = appBuild,
                    imuSampleCount = imuSampleCount,
                    totalBytesWritten = totalBytesWritten,
                    estimatedDatasetSizeBytes = estimateDatasetSizeProjectionBytes(coreStats.durationMs),
                    sizeWarningThresholdBytes = SIZE_WARNING_THRESHOLD_BYTES,
                    recordingStartTime = recordingStartTime
                )
            )

            if (activeRecordingConfig.isH264) {
                finalizationResult.metadata["rgb_codec"] = "h264"
                finalizationResult.metadata["recording_id"] = h264TerminalStats["recording_id"]
                finalizationResult.metadata["raw_imu"] = "independent_accel_gyro_motion_events"
                finalizationResult.metadata["encoder_mode"] = "native_camera_cadence_no_tracking_gate"
                finalizationResult.metadata["sampling_strategy"] = "all_unique_arcore_camera_frames"
                finalizationResult.metadata["rgb_sampling_strategy"] = "all_unique_arcore_camera_frames"
                finalizationResult.metadata["sampling_strategy_detail"] = "backpressure_and_unavailable_camera_images_reported_separately"
                finalizationResult.metadata["rgb_intentional_downsample"] = false
                finalizationResult.metadata["video_profile"] = if (activeRecordingConfig.h264SimulationMode) "simulation_640x480_30fps" else "candidate_1920x1080_30fps"
                finalizationResult.metadata["capture_geometry"] = open.fpvlabs.stera.ar_recorder.geometry.CaptureGeometry.metadata() + mapOf(
                    "rgb_source" to "arcore_acquireCameraImage_YUV_420_888_to_MediaCodec_input_Image",
                    "rgb_mcap_log_time" to "mapped_capture_time", "rgb_mcap_publish_time" to "mapped_capture_time",
                    "rgb_capture_time" to "foxglove_CompressedVideo_timestamp_with_clock_provenance",
                    "depth" to "not_recorded_by_profile_revision", "cross_stream_clock_verified" to false)
                finalizationResult.metadata["h264_terminal"] = h264TerminalStats
                finalizationResult.metadata["qualification"] = if (activeRecordingConfig.h264SimulationMode) "simulation_only" else "unqualified"
            }
            // Provisional sidecar: conservative until the container is proven closed and the final sidecar is read back.
            finalizationResult.metadata["container_state"] = "closing"
            finalizationResult.metadata["capture_outcome"] = "unresolved"
            finalizationResult.metadata["recovery_state"] = "quarantined"
            finalizationResult.metadata["finalization_complete"] = false
            datasetWriter.writeMetadata(finalizationResult.metadata)

            // Log session end info
            datasetWriter.logSystem("Session end time: ${Date()}")
            datasetWriter.logSystem("Errors encountered: ${metrics.totalErrorsEncountered}")
            datasetWriter.logSystem("Tracking loss events: ${metrics.trackingLossEvents}")
            datasetWriter.logSystem("Free storage before: ${datasetWriter.getFreeStorageBeforeBytes()} bytes")
            datasetWriter.logSystem("Free storage after: ${datasetWriter.getFreeStorageAfterBytes()} bytes")
            datasetWriter.logSystem("Total bytes written: $totalBytesWritten bytes")
            if (totalBytesWritten > SIZE_WARNING_THRESHOLD_BYTES) {
                datasetWriter.logSystem(
                    "WARN: session size exceeded threshold. bytes=$totalBytesWritten threshold=$SIZE_WARNING_THRESHOLD_BYTES"
                )
            }

            val durationSeconds = coreStats.durationSeconds
            val imuFps = if (durationSeconds > 0.0) imuSampleCount.toDouble() / durationSeconds else 0.0

            val sessionSummary = recordingFinalizationCoordinator.buildSessionSummary(
                durationSeconds = durationSeconds,
                arcoreFps = coreStats.arcoreFps,
                encodedVideoFps = coreStats.encodedVideoFps,
                depthFps = coreStats.depthFps,
                imuFps = imuFps,
                cameraResolution = cameraResolution,
                recordingResolution = recordingResolution,
                isLowQualityMode = isLowQualityMode,
                lowQualityReason = lowQualityReason,
                maxEncoderQueueDepth = metrics.maxEncoderQueueDepth,
                encoderBackpressureDetected = metrics.encoderBackpressureDetected
            )
            datasetWriter.writeSessionSummary(sessionSummary)

            journal?.advance(FinalizationPhase.CLOSING_CONTAINER)
            phaseFaultHook?.invoke(FinalizationPhase.CLOSING_CONTAINER)
            val (zipSuccess, zipPath, zipError) = datasetWriter.createSpatialDataZip()

            datasetWriter.finalize()
            if (!zipSuccess) {
                datasetWriter.recordWriteFailure("Session finalization failed: ${zipError ?: "unknown error"}")
                println("⚠️ Failed to create spatial_data.zip: $zipError")
            } else {
                println("✅ spatial_data.zip created: $zipPath")
            }

            val outputDir = datasetWriter.getSessionDirectory()

            val writtenRgbFrames = (stats["rgbFrameCount"] as? Int) ?: metrics.encodedVideoFrameCount.get()
            var captureFailure = metrics.captureFailureReason(writtenRgbFrames, datasetWriter.getWriteFailure())
            val sessionFile = outputDir?.let(::File)
            val mcapFile = sessionFile?.listFiles { f -> f.name.endsWith(".mcap") }?.firstOrNull()
            val containerState = if (mcapFile != null) CaptureOutcomePolicy.containerState(zipSuccess, mcapFile) else CaptureOutcomePolicy.UNCLOSED
            val evidence = h264TerminalStats["evidence"] as? Map<*, *>
            val captureOutcome = if (activeRecordingConfig.isH264) {
                CaptureOutcomePolicy.captureOutcome(evidence?.get("close_outcome") as? String, stopReason,
                    (evidence?.get("unresolved") as? Number)?.toLong() ?: 0L, datasetWriter.getWriteFailure())
            } else if (captureFailure == null) "completed" else "failed"
            val recoveryState = CaptureOutcomePolicy.recoveryState(containerState, captureOutcome)
            val finalizationToken = java.util.UUID.randomUUID().toString()
            finalizationResult.metadata["capture_result_valid"] = captureFailure == null
            finalizationResult.metadata["first_writer_error"] = datasetWriter.getWriteFailure()
            finalizationResult.metadata["finalization_complete"] = containerState == CaptureOutcomePolicy.CLOSED && datasetWriter.getWriteFailure() == null
            finalizationResult.metadata["container_state"] = containerState
            finalizationResult.metadata["capture_outcome"] = captureOutcome
            finalizationResult.metadata["recovery_state"] = recoveryState
            finalizationResult.metadata["interruption_reason"] = stopReason
            // Closed bytes are not upload admission: the recorder does not evaluate hashes, manifests or ownership.
            finalizationResult.metadata["upload_admission"] = "not_evaluated_by_recorder"
            finalizationResult.metadata["finalization_token"] = finalizationToken
            journal?.advance(FinalizationPhase.FINALIZING_METADATA, containerState = containerState, captureOutcome = captureOutcome)
            phaseFaultHook?.invoke(FinalizationPhase.FINALIZING_METADATA)
            datasetWriter.writeMetadata(finalizationResult.metadata)
            captureFailure = metrics.captureFailureReason(writtenRgbFrames, datasetWriter.getWriteFailure())
            // FINALIZED only after the final sidecar is read back from disk and the container is proven closed.
            val sidecarDurable = sessionFile?.let { File(it, "metadata.json").takeIf(File::isFile)?.readText()?.contains(finalizationToken) } == true
            val durablyFinal = sidecarDurable && containerState == CaptureOutcomePolicy.CLOSED
            // The quarantine marker is durable before the journal can say FINALIZED, so a crash in between still leaves a signal.
            if (sessionFile != null && (!durablyFinal || recoveryState == "quarantined")) {
                try {
                    RecoveryScanner.quarantine(sessionFile, if (!durablyFinal) "finalization_incomplete:container=$containerState,sidecar=$sidecarDurable" else "capture_outcome_$captureOutcome", System.currentTimeMillis())
                } catch (error: Throwable) { recordError("Could not write recovery marker", error) }
            }
            if (durablyFinal) journal?.advance(FinalizationPhase.FINALIZED)
            frameProcessor.releaseRecordingBuffers()
            // Publish READY only after the final sidecar is durably persisted. Pollers may
            // immediately start a new recording once this state becomes observable.
            lastErrorMessage = captureFailure
            currentState = ArRecordingState.READY
            if (captureFailure != null) {
                return createErrorResult(captureFailure) + mapOf(
                    "recordingStopped" to true,
                    "containerState" to containerState,
                    "captureOutcome" to captureOutcome,
                    "recoveryState" to recoveryState,
                    "interruptionReason" to stopReason,
                    "diagnosticsDirectory" to outputDir,
                    "framesRecorded" to 0,
                    "durationSeconds" to durationSeconds
                )
            }
            println("✅ Recording stopped: $outputDir")

            mapOf(
                "success" to true,
                "state" to ArRecordingState.READY.name,
                "depthSupported" to sessionManager.isDepthSupported,
                "outputDirectory" to outputDir,
                "sessionPath" to outputDir,
                "durationSeconds" to durationSeconds,
                "framesRecorded" to writtenRgbFrames,
                "imuSamples" to (stats["imuSampleCount"] ?: 0),
                "galleryUri" to null,
                "isLowQualityMode" to isLowQualityMode,
                "lowQualityReason" to lowQualityReason,
                "cameraResolution" to cameraResolution,
                "recordingResolution" to recordingResolution,
                "previewWidth" to previewWidth,
                "previewHeight" to previewHeight,
                "upscaleApplied" to upscaleApplied,
                "recordingId" to h264TerminalStats["recording_id"],
                "rgbCodec" to activeRecordingConfig.rgbCodec,
                "containerState" to containerState,
                "captureOutcome" to captureOutcome,
                "recoveryState" to recoveryState,
                "interruptionReason" to stopReason,
                "error" to null
            )
        } catch (e: Exception) {
            currentState = ArRecordingState.ERROR
            if (e is FinalizationTimeout) finalizationUncertain = true
            try { frameOrchestrator.h264Controller?.abort() } catch (_: Throwable) {}
            frameOrchestrator.h264Controller = null
            // Whatever phase the journal reached stays non-final; also drop a durable quarantine marker beside it.
            try { datasetWriter.getSessionDirectory()?.let { RecoveryScanner.quarantine(File(it), "stop_exception:${e.javaClass.simpleName}", System.currentTimeMillis()) } } catch (_: Throwable) {}
            println("❌ Failed to stop recording: ${e.message}")
            recordError("Failed to stop recording", e)
            e.printStackTrace()
            createErrorResult(e.message ?: "Unknown error")
        }
    }

    override fun getRecordingState(): Map<String, Any?> {
        val duration = if (isRecording.get()) {
            val activePausedMs = if (isPaused.get() && pauseStartedAtMs > 0L) {
                (System.currentTimeMillis() - pauseStartedAtMs).coerceAtLeast(0L)
            } else 0L
            (System.currentTimeMillis() - recordingStartTime - totalPausedDurationMs - activePausedMs).coerceAtLeast(0L)
        } else null

        return mapOf(
            "state" to currentState.name,
            "trackingState" to lastTrackingState,
            "isRecording" to isRecording.get(),
            "isPaused" to isPaused.get(),
            "depthSupported" to sessionManager.isDepthSupported,
            "recordingDuration" to duration,
            "frameCount" to if (isRecording.get() || currentState == ArRecordingState.PAUSED) metrics.frameCount else null,
            "textureId" to flutterTexture?.id(),
            "cameraResolution" to cameraResolution,
            "recordingResolution" to recordingResolution,
            "previewWidth" to previewWidth,
            "previewHeight" to previewHeight,
            "isLowQualityMode" to isLowQualityMode,
            "lowQualityReason" to lowQualityReason,
            "upscaleApplied" to upscaleApplied,
            "error" to lastErrorMessage,
            "captureStopReason" to motionCapture.stopReason
        )
    }

    private fun motionScheduler(): MotionScheduler {
        val handler = checkNotNull(writerHandler) { "Writer thread unavailable for raw motion" }
        return object : MotionScheduler {
            override fun postDelayed(task: Runnable, delayMs: Long) = handler.postDelayed(task, delayMs)
            override fun remove(task: Runnable) = handler.removeCallbacks(task)
        }
    }

    override fun checkArAvailability(): Map<String, Any?> {
        val availability = ArCoreApk.getInstance().checkAvailability(context)
        return mapOf("supported" to availability.isSupported)
    }

    override fun disposeSession() {
        println("📷 ArRecorderImpl: Disposing session...")

        releaseInProgress.set(true)
        if (isRecording.get()) {
            stopRecording()
        }

        currentState = ArRecordingState.DISPOSED
        shouldStopFrameLoop.set(true)

        motionCapture.stopCollection()
        val threadsQuiet = sessionLifecycleManager.stopThreads(frameThread, writerThread)
        if (!threadsQuiet) {
            // A thread outlived its bounded join: its files and codecs may still be in use, so nothing is released
            // out from under it and no new take may start in this process.
            finalizationUncertain = true
            currentState = ArRecordingState.ERROR
            releaseInProgress.set(false)
            println("❌ Recorder threads did not stop within their bound; session left uncertain")
            return
        }
        frameThread = null
        frameHandler = null
        writerThread = null
        writerHandler = null
        frameProcessor.releaseRecordingBuffers()

        imuCollector.release()
        datasetWriter.release()
        sessionManager.release()
        eglManager.release()

        sessionLifecycleManager.releaseFlutterPreviewTexture(flutterTexture) {
            previewSurfaceTexture = it
        }
        flutterTexture = null
        isPreviewBufferSizeSet = false
        currentVideoFile = null
        releaseInProgress.set(false)
        finalizationUncertain = false // both threads joined within their bound: nothing can still write

        println("✅ Session disposed")
    }

    // ═════════════════════════════════════════════════════════════════════
    //  Video Encoder Wrappers
    // ═════════════════════════════════════════════════════════════════════

    private fun applyResolutionPolicyFromCameraConfig() {
        val result = sessionLifecycleManager.applyResolutionPolicyFromCameraConfig(
            sensorWidth = sensorWidth,
            sensorHeight = sensorHeight,
            videoWidth = targetRgbLandscapeWidth,
            videoHeight = targetRgbLandscapeHeight
        )
        metrics.configuredVideoWidth = result.configuredVideoWidth
        metrics.configuredVideoHeight = result.configuredVideoHeight
        previewWidth = result.previewWidth
        previewHeight = result.previewHeight
        cameraResolution = result.cameraResolution
        recordingResolution = result.recordingResolution
        isLowQualityMode = result.isLowQualityMode
        lowQualityReason = result.lowQualityReason
        previewResolutionDerived = result.previewResolutionDerived
        isPreviewBufferSizeSet = false
    }

    private fun setupVideoEncoder(outputFile: File): Boolean {
        val result = videoEncodingCoordinator.setupVideoEncoder(
            outputFile = outputFile,
            configuredVideoWidth = metrics.configuredVideoWidth,
            configuredVideoHeight = metrics.configuredVideoHeight,
            targetEncodeFps = metrics.targetEncodeFps,
            targetVideoBitrate = metrics.targetVideoBitrate,
            fallbackBitrate = VIDEO_BITRATE_FALLBACK,
            iFrameIntervalSeconds = VIDEO_IFRAME_INTERVAL_SECONDS
        )
        if (!result.success) return false
        metrics.activeVideoBitrate = result.activeVideoBitrate
        metrics.targetVideoBitrate = result.targetVideoBitrate
        metrics.actualVideoWidth = result.actualVideoWidth
        metrics.actualVideoHeight = result.actualVideoHeight
        metrics.encoderSurfaceReady = result.encoderSurfaceReady

        // Propagate encoder fallback: fps, resolution, and frame interval
        if (result.chosenFps != metrics.targetEncodeFps) {
            metrics.targetEncodeFps = result.chosenFps
            metrics.encodeFrameIntervalNs = 1_000_000_000L / result.chosenFps
        }
        if (result.chosenWidth != metrics.configuredVideoWidth || result.chosenHeight != metrics.configuredVideoHeight) {
            metrics.configuredVideoWidth = result.chosenWidth
            metrics.configuredVideoHeight = result.chosenHeight
            recordingResolution = "${result.chosenWidth}x${result.chosenHeight}"
            isLowQualityMode = true
            lowQualityReason = "encoder_fallback_resolution"
        } else if (result.chosenFps != VIDEO_FPS_FIXED) {
            isLowQualityMode = true
            lowQualityReason = "encoder_fallback_fps"
        }
        return true
    }

    private fun finalizeVideoEncoder() {
        val result = videoEncodingCoordinator.finalizeVideoEncoder(
            configuredVideoWidth = metrics.configuredVideoWidth,
            configuredVideoHeight = metrics.configuredVideoHeight,
            targetEncodeFps = metrics.targetEncodeFps
        )
        metrics.actualVideoWidth = result.actualVideoWidth
        metrics.actualVideoHeight = result.actualVideoHeight
    }

    private fun releaseVideoEncoder() {
        videoEncodingCoordinator.releaseVideoEncoder()
        metrics.encoderSurfaceReady = false
    }

    private fun abortVideoEncoder() {
        releaseVideoEncoder()
        metrics.actualVideoWidth = 0
        metrics.actualVideoHeight = 0
        currentVideoFile = null
    }

    // ═════════════════════════════════════════════════════════════════════
    //  Utilities
    // ═════════════════════════════════════════════════════════════════════

    private fun recordError(message: String, throwable: Throwable? = null) {
        metrics.totalErrorsEncountered++
        android.util.Log.e("SteraCapture", message, throwable)
        datasetWriter.logError(message, throwable)
    }

    private fun resolveArCoreVersion(): String {
        return try {
            val packageName = "com.google.ar.core"
            val packageInfo = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                context.packageManager.getPackageInfo(packageName, PackageManager.PackageInfoFlags.of(0))
            } else {
                @Suppress("DEPRECATION")
                context.packageManager.getPackageInfo(packageName, 0)
            }
            packageInfo.versionName ?: "unknown"
        } catch (_: Exception) {
            "unknown"
        }
    }

    private fun resolveAppVersion(): String {
        return try {
            val packageInfo = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                context.packageManager.getPackageInfo(
                    context.packageName,
                    PackageManager.PackageInfoFlags.of(0)
                )
            } else {
                @Suppress("DEPRECATION")
                context.packageManager.getPackageInfo(context.packageName, 0)
            }
            packageInfo.versionName ?: "unknown"
        } catch (_: Exception) {
            "unknown"
        }
    }

    private fun resolveAppBuild(): String {
        return try {
            val packageInfo = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                context.packageManager.getPackageInfo(
                    context.packageName,
                    PackageManager.PackageInfoFlags.of(0)
                )
            } else {
                @Suppress("DEPRECATION")
                context.packageManager.getPackageInfo(context.packageName, 0)
            }
            packageInfo.longVersionCode.toString()
        } catch (_: Exception) {
            "unknown"
        }
    }

    private fun estimateDatasetSizeProjectionBytes(durationMs: Long): Long {
        val elapsedMs = durationMs.coerceAtLeast(1L)
        val stats = datasetWriter.getRecordingStats()
        val bytesWritten = (stats["totalBytesWritten"] as? Long ?: 0L).coerceAtLeast(0L)
        val bytesPerMs = bytesWritten.toDouble() / elapsedMs.toDouble()
        val projectedForOneMinute = bytesPerMs * 60_000.0
        return projectedForOneMinute.toLong()
    }

    private fun applyRgbTargets(cfg: RecordingConfig) {
        targetRgbLandscapeWidth = cfg.rgbLandscapeWidth
        targetRgbLandscapeHeight = cfg.rgbLandscapeHeight
        previewWidth = cfg.rgbLandscapeWidth
        previewHeight = cfg.rgbLandscapeHeight
        isPreviewBufferSizeSet = false
    }

    private fun verifyStorageHeadroomForLongRecording(): Pair<Boolean, String?> {
        val baseDir = File(context.getExternalFilesDir(null), "ar_sessions")
        baseDir.mkdirs()
        val estimatedBytes = storageManager.estimateDatasetSize(
            durationSeconds = STORAGE_PROJECTION_DURATION_SECONDS,
            includeDepth = sessionManager.isDepthSupported
        )
        val result = storageManager.verifyHeadroom(
            baseDir = baseDir,
            durationSeconds = STORAGE_PROJECTION_DURATION_SECONDS,
            includeDepth = sessionManager.isDepthSupported
        )
        if (!result.first) {
            println("❌ ${result.second}")
            return result
        }
        val availableBytes = baseDir.usableSpace
        val thresholdBytes = (availableBytes.toDouble() * STORAGE_SAFETY_FACTOR).toLong()
        println(
            "✅ Storage precheck passed. estimated=${estimatedBytes} available=${availableBytes} threshold80=${thresholdBytes}"
        )
        return Pair(true, null)
    }

    private fun createSuccessResult(
        state: String = ArRecordingState.READY.name,
        depthSupported: Boolean = sessionManager.isDepthSupported,
        textureId: Long? = null,
        outputDirectory: String? = null,
        galleryUri: String? = null,
        isLowQualityMode: Boolean = false,
        lowQualityReason: String? = null,
        cameraResolution: String? = null,
        recordingResolution: String? = null,
        upscaleApplied: Boolean = false
    ): Map<String, Any?> {
        lastErrorMessage = null
        return mapOf(
            "success" to true,
            "state" to state,
            "depthSupported" to depthSupported,
            "textureId" to textureId,
            "outputDirectory" to outputDirectory,
            "galleryUri" to galleryUri,
            "isLowQualityMode" to isLowQualityMode,
            "lowQualityReason" to lowQualityReason,
            "cameraResolution" to cameraResolution,
            "recordingResolution" to recordingResolution,
            "previewWidth" to previewWidth,
            "previewHeight" to previewHeight,
            "upscaleApplied" to upscaleApplied,
            "error" to null
        )
    }

    private fun createErrorResult(errorMessage: String): Map<String, Any?> {
        lastErrorMessage = errorMessage
        return mapOf(
            "success" to false,
            "state" to currentState.name,
            "depthSupported" to sessionManager.isDepthSupported,
            "textureId" to flutterTexture?.id(),
            "outputDirectory" to null,
            "isLowQualityMode" to isLowQualityMode,
            "lowQualityReason" to lowQualityReason,
            "cameraResolution" to cameraResolution,
            "recordingResolution" to recordingResolution,
            "previewWidth" to previewWidth,
            "previewHeight" to previewHeight,
            "upscaleApplied" to upscaleApplied,
            "error" to errorMessage
        )
    }
}
