package open.fpvlabs.stera.framing

import android.view.Surface

internal interface FramingCapture {
    fun start(aspectRatio: Double, preview: FramingPreview)
    fun latest(): FramingFrame
    fun stop(onClosed: () -> Unit)
    fun dispose()
}

internal class FramingPreview(
    val surface: Surface,
    val setSize: (Int, Int) -> Unit,
    val appliedRotation: () -> Int,
)

internal data class FramingFrame(
    val status: String = "checking",
    val rotation: Int = 0,
    val previewAspectRatio: Double? = null,
    val cameraId: String? = null,
    val width: Int? = null,
    val height: Int? = null,
    val capturedAt: Long = 0L,
)
