package open.fpvlabs.stera.framing

import android.app.Activity
import android.view.Surface
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel
import io.flutter.view.TextureRegistry
import java.util.concurrent.atomic.AtomicInteger

internal class FramingMethodChannelHandler(
    private val activity: Activity,
    messenger: BinaryMessenger,
    private val textures: TextureRegistry,
) {
    private val channel = MethodChannel(messenger, "capture_framing")
    private var capture: FramingCapture? = null
    private var stopping = false
    private var entry: TextureRegistry.SurfaceTextureEntry? = null
    private var surface: Surface? = null

    init {
        channel.setMethodCallHandler { call, result ->
            when (call.method) {
                "start" -> if (stopping || entry != null) {
                    result.error("ALREADY_ACTIVE", "Camera is closing", null)
                } else {
                    val active = capture ?: FramingCaptureImpl(activity).also { capture = it }
                    val texture = textures.createSurfaceTexture()
                    val surfaceTexture = texture.surfaceTexture()
                    val target = Surface(surfaceTexture)
                    val appliedRotation = AtomicInteger()
                    val transform = FloatArray(16)
                    // Sample the transform Flutter just latched. Some Camera2 HALs
                    // supply crop only, while others include the sensor rotation.
                    texture.setOnFrameConsumedListener {
                        surfaceTexture.getTransformMatrix(transform)
                        appliedRotation.set(surfaceTextureRotation(transform))
                    }
                    entry = texture
                    surface = target
                    active.start(
                        call.argument<Double>("aspectRatio") ?: (16.0 / 9.0),
                        FramingPreview(target, surfaceTexture::setDefaultBufferSize, appliedRotation::get),
                    )
                    result.success(texture.id())
                }
                "latest" -> result.success(capture?.latest()?.let { frame ->
                    mapOf("status" to frame.status, "rotation" to frame.rotation,
                        "cameraId" to frame.cameraId, "width" to frame.width, "height" to frame.height,
                        "previewAspectRatio" to frame.previewAspectRatio)
                })
                "stop" -> {
                    val active = capture
                    if (active == null) {
                        result.success(null)
                    } else if (stopping) {
                        result.error("ALREADY_ACTIVE", "Camera is closing", null)
                    } else {
                        stopping = true
                        active.stop {
                            activity.runOnUiThread {
                                releasePreview()
                                stopping = false
                                result.success(null)
                            }
                        }
                    }
                }
                else -> result.notImplemented()
            }
        }
    }

    private fun releasePreview() {
        surface?.release()
        surface = null
        entry?.release()
        entry = null
    }

    fun dispose() {
        channel.setMethodCallHandler(null)
        val active = capture
        capture = null
        if (active == null) {
            releasePreview()
        } else {
            active.stop {
                activity.runOnUiThread { releasePreview() }
                active.dispose()
            }
        }
    }
}
