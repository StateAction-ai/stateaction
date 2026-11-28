package open.fpvlabs.stera.framing

import android.annotation.SuppressLint
import android.app.Activity
import android.content.pm.ApplicationInfo
import android.graphics.Bitmap
import android.graphics.ImageFormat
import android.graphics.SurfaceTexture
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.hardware.camera2.TotalCaptureResult
import android.media.Image
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Log
import android.util.Size
import android.view.Surface
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.core.Delegate
import com.google.mediapipe.tasks.vision.core.ImageProcessingOptions
import com.google.mediapipe.tasks.vision.handlandmarker.HandLandmarker
import open.fpvlabs.stera.ar_recorder.geometry.ImagePlanePacking
import java.util.concurrent.Executors
import kotlin.math.abs
import kotlin.math.atan

/** Camera2 renders into the preview surface. Only small copies enter CPU inference. */
internal class FramingCaptureImpl(private val activity: Activity) : FramingCapture {
    private val thread = HandlerThread("FramingCamera").apply { start() }
    private val worker = Handler(thread.looper)
    private val analyser = Executors.newSingleThreadExecutor()
    private val analysisGate = FramingAnalysisGate()
    private var opening = false
    private var device: CameraDevice? = null
    private var reader: ImageReader? = null
    private var landmarker: HandLandmarker? = null // Owned by the analysis executor.
    @Volatile private var sensorOrientation = 0
    private var release: (() -> Unit)? = null
    private var running = false
    @Volatile private var preview: FramingPreview? = null
    private var metrics: FramingMetrics? = null
    @Volatile private var frame = FramingFrame()

    @SuppressLint("MissingPermission")
    override fun start(aspectRatio: Double, preview: FramingPreview) {
        worker.post {
            if (running || opening || device != null || release != null) return@post
            running = true
            frame = FramingFrame()
            this.preview = preview
            try {
                val manager = activity.getSystemService(CameraManager::class.java)
                val rear = manager.cameraIdList.map { it to manager.getCameraCharacteristics(it) }
                    .filter { (_, meta) -> meta[CameraCharacteristics.LENS_FACING] == CameraCharacteristics.LENS_FACING_BACK }
                val (id, info) = checkNotNull(rear.maxByOrNull { (_, meta) ->
                    val width = meta[CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE]?.width
                    val focal = meta[CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS]?.singleOrNull()
                    if (width != null && focal != null && focal > 0) atan(width.toDouble() / (2 * focal)) else 0.0
                }) { "No rear camera" }
                sensorOrientation = info[CameraCharacteristics.SENSOR_ORIENTATION] ?: 0
                val streams = checkNotNull(info[CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP])
                val previewSizes = streams.getOutputSizes(SurfaceTexture::class.java).orEmpty()
                    .filter { it.width <= 1920 && it.height <= 1080 }
                    .sortedWith(compareBy<Size> { abs(streamAspectRatio(it) - aspectRatio) }
                        .thenBy { abs(it.width - 1280) })
                val analysisSizes = streams.getOutputSizes(ImageFormat.YUV_420_888).orEmpty()
                    .filter { it.width <= 640 && it.height <= 480 }
                    .sortedBy { abs(it.width - 320) }
                val pair = previewSizes.firstNotNullOfOrNull { previewSize ->
                    analysisSizes.firstOrNull { abs(streamAspectRatio(it) - streamAspectRatio(previewSize)) < 0.01 }
                        ?.let { analysisSize -> previewSize to analysisSize }
                }
                val previewSize = pair?.first ?: previewSizes.first()
                val analysisSize = pair?.second
                preview.setSize(previewSize.width, previewSize.height)
                val session = FramingMetrics(previewSize, analysisSize)
                metrics = session
                frame = FramingFrame(
                    status = if (analysisSize == null) "unavailable" else "checking",
                    cameraId = id, width = previewSize.width, height = previewSize.height,
                )
                if (analysisSize != null) {
                    reader = ImageReader.newInstance(analysisSize.width, analysisSize.height, ImageFormat.YUV_420_888, 2).apply {
                        setOnImageAvailableListener({ source ->
                            if (running && source === reader) source.acquireLatestImage()?.use { scheduleAnalysis(it, session) }
                        }, worker)
                    }
                }
                opening = true
                manager.openCamera(id, cameraState, worker)
            } catch (error: Exception) {
                opening = false
                fail(error)
            }
        }
    }

    private fun streamAspectRatio(size: Size): Double = size.width.toDouble() / size.height

    private val cameraState = object : CameraDevice.StateCallback() {
        override fun onOpened(camera: CameraDevice) {
            opening = false
            device = camera
            val output = preview?.surface
            val sessionMetrics = metrics
            if (!running || output == null || sessionMetrics == null) {
                camera.close()
                return
            }
            try {
                val outputs = listOfNotNull(output, reader?.surface)
                @Suppress("DEPRECATION")
                camera.createCaptureSession(outputs, object : CameraCaptureSession.StateCallback() {
                    override fun onConfigured(session: CameraCaptureSession) {
                        if (!running || metrics !== sessionMetrics) {
                            session.close()
                            return
                        }
                        try {
                            val request = camera.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW)
                                .apply { outputs.forEach(::addTarget) }.build()
                            session.setRepeatingRequest(request, object : CameraCaptureSession.CaptureCallback() {
                                override fun onCaptureCompleted(session: CameraCaptureSession, request: CaptureRequest, result: TotalCaptureResult) {
                                    sessionMetrics.previewFrame(SystemClock.elapsedRealtimeNanos())
                                }
                            }, worker)
                        } catch (error: Exception) {
                            fail(error)
                        }
                    }
                    override fun onConfigureFailed(session: CameraCaptureSession) {
                        if (metrics === sessionMetrics) fail()
                    }
                }, worker)
            } catch (error: Exception) {
                fail(error)
            }
        }

        override fun onDisconnected(camera: CameraDevice) = cameraLost(camera)
        override fun onError(camera: CameraDevice, error: Int) = cameraLost(camera)
        override fun onClosed(camera: CameraDevice) {
            if (device === camera) device = null
            finishStopIfClosed()
        }
    }

    private fun cameraLost(camera: CameraDevice) {
        opening = false
        device = camera
        fail()
    }

    private fun fail(error: Exception? = null) {
        if (error != null) Log.w("SA139Framing", "Could not start framing", error)
        frame = frame.copy(status = "unavailable")
        closeCamera()
    }

    private fun closeCamera() {
        running = false
        device?.close()
        reader?.close()
        reader = null
        preview = null
        val ended = metrics
        metrics = null
        if (ended != null && (activity.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            Log.i("SA139Framing", ended.report())
        }
        finishStopIfClosed()
    }

    private fun finishStopIfClosed() {
        if (opening || device != null) return
        val closed = release
        release = null
        closed?.invoke()
    }

    override fun stop(onClosed: () -> Unit) {
        worker.post {
            val previous = release
            release = { previous?.invoke(); onClosed() }
            closeCamera()
        }
    }

    override fun dispose() = stop {
        analyser.execute { landmarker?.close() }
        analyser.shutdown()
        thread.quitSafely()
    }

    override fun latest(): FramingFrame {
        val latest = frame
        val stale = latest.capturedAt > 0L && SystemClock.elapsedRealtime() - latest.capturedAt > 1500L
        val display = displayRotation()
        val rawRotation = (sensorOrientation - display + 360) % 360
        val appliedRotation = preview?.appliedRotation?.invoke() ?: 0
        val previewRotation = (rawRotation - appliedRotation + 360) % 360
        val ratio = if (latest.width == null || latest.height == null) null else {
            if (rawRotation % 180 == 0) latest.width.toDouble() / latest.height
            else latest.height.toDouble() / latest.width
        }
        return latest.copy(
            status = if (stale) "unavailable" else latest.status,
            rotation = previewRotation,
            previewAspectRatio = ratio,
        )
    }

    @Suppress("DEPRECATION")
    private fun displayRotation(): Int = when (activity.windowManager.defaultDisplay.rotation) {
        Surface.ROTATION_90 -> 90
        Surface.ROTATION_180 -> 180
        Surface.ROTATION_270 -> 270
        else -> 0
    }

    private fun scheduleAnalysis(image: Image, session: FramingMetrics) {
        val capturedAt = SystemClock.elapsedRealtime()
        if (!analysisGate.tryAcquire(capturedAt)) {
            session.analysisDropped++
            return
        }
        val copyBegin = SystemClock.elapsedRealtimeNanos()
        val width = image.width
        val height = image.height
        val pixels = try {
            val crop = image.cropRect
            ImagePlanePacking.requireFullCrop(width, height, crop.left, crop.top, crop.right, crop.bottom)
            val planes = image.planes.map { ImagePlanePacking.Plane(it.buffer, it.rowStride, it.pixelStride) }
            ImagePlanePacking.yuv420ToNv21(width, height, planes[0], planes[1], planes[2])
        } catch (_: Exception) {
            session.copyFailures++
            frame = frame.copy(status = "unavailable", capturedAt = capturedAt)
            analysisGate.release()
            return
        }
        session.analysisCopied(SystemClock.elapsedRealtimeNanos() - copyBegin)
        val rotation = (sensorOrientation - displayRotation() + 360) % 360
        analyser.execute {
            val begin = SystemClock.elapsedRealtimeNanos()
            var analysisError: String? = null
            try {
                val status = if (bothHandsVisible(pixels, width, height, rotation)) "visible" else "not_visible"
                worker.post {
                    if (running && metrics === session) frame = frame.copy(status = status, capturedAt = capturedAt)
                }
            } catch (error: Exception) {
                analysisError = error.javaClass.simpleName
                worker.post { if (metrics === session) frame = frame.copy(status = "unavailable", capturedAt = capturedAt) }
            } catch (error: LinkageError) {
                analysisError = error.javaClass.simpleName
                worker.post { if (metrics === session) frame = frame.copy(status = "unavailable", capturedAt = capturedAt) }
            } finally {
                session.analysisFinished(SystemClock.elapsedRealtimeNanos() - begin, analysisError)
                analysisGate.release()
            }
        }
    }

    private fun bothHandsVisible(pixels: ByteArray, width: Int, height: Int, rotation: Int): Boolean {
        val checker = landmarker ?: HandLandmarker.createFromOptions(
            activity,
            HandLandmarker.HandLandmarkerOptions.builder()
                .setBaseOptions(BaseOptions.builder().setDelegate(Delegate.CPU)
                    .setModelAssetPath("hand_landmarker.task").build())
                .setNumHands(2).setMinHandDetectionConfidence(0.5f)
                .setMinHandPresenceConfidence(0.5f).build()
        ).also { landmarker = it }
        val bitmap = Bitmap.createBitmap(nv21ToArgb(pixels, width, height), width, height, Bitmap.Config.ARGB_8888)
        try {
            val input = BitmapImageBuilder(bitmap).build()
            try {
                val options = ImageProcessingOptions.builder().setRotationDegrees(rotation).build()
                val hands = checker.detect(input, options).landmarks()
                return hands.size == 2 && hands.all { landmarks ->
                    landmarks.size == 21 && landmarks.all { point ->
                        point.x() in 0.02f..0.98f && point.y() in 0.02f..0.98f
                    }
                }
            } finally {
                input.close()
            }
        } finally {
            bitmap.recycle()
        }
    }
}

internal fun nv21ToArgb(pixels: ByteArray, width: Int, height: Int): IntArray {
    val lumaSize = width * height
    val rgb = IntArray(lumaSize)
    for (row in 0 until height) {
        for (column in 0 until width) {
            val i = row * width + column
            val uv = lumaSize + (row / 2) * width + (column and 1.inv())
            val y = 298 * ((pixels[i].toInt() and 255) - 16).coerceAtLeast(0)
            val v = (pixels[uv].toInt() and 255) - 128
            val u = (pixels[uv + 1].toInt() and 255) - 128
            val r = ((y + 409 * v + 128) shr 8).coerceIn(0, 255)
            val g = ((y - 100 * u - 208 * v + 128) shr 8).coerceIn(0, 255)
            val b = ((y + 516 * u + 128) shr 8).coerceIn(0, 255)
            rgb[i] = (255 shl 24) or (r shl 16) or (g shl 8) or b
        }
    }
    return rgb
}
