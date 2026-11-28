package open.fpvlabs.stera.ar_recorder.session

import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import kotlin.math.atan

/** Optical field of view from Camera2 characteristics, before stream cropping. */
internal object RearCameraLens {
    fun horizontalFieldOfView(camera: CameraCharacteristics): Double? {
        if (camera.get(CameraCharacteristics.LENS_FACING) != CameraCharacteristics.LENS_FACING_BACK) return null
        val width = camera.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE)?.width ?: return null
        val focal = camera.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)?.singleOrNull() ?: return null
        return horizontalFieldOfView(width, focal)
    }

    fun horizontalFieldOfView(width: Float, focal: Float): Double? =
        if (width.isFinite() && focal.isFinite() && width > 0 && focal > 0) {
            Math.toDegrees(2 * atan(width.toDouble() / (2 * focal)))
        } else null

    fun fieldsOfView(manager: CameraManager, ids: Collection<String>): Map<String, Double> =
        ids.distinct().mapNotNull { id ->
            val fieldOfView = runCatching { horizontalFieldOfView(manager.getCameraCharacteristics(id)) }.getOrNull()
            fieldOfView?.let { id to it }
        }.toMap()

    fun isUltrawide(selected: Double?, default: Double?, widest: Double?): Boolean =
        selected != null && default != null && widest != null &&
            selected >= widest - 1.0 && selected > default + 5.0
}
