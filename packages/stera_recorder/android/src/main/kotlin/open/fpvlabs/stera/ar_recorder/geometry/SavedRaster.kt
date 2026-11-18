package open.fpvlabs.stera.ar_recorder.geometry

/**
 * Describes how the pixels that are actually written to disk relate to the raster ARCore
 * calibrated (`camera.imageIntrinsics`). Calibration follows the *saved* raster, never the preview.
 *
 * Operation order is fixed and recorded: crop (in source pixels) -> resize to the crop's scaled size
 * -> rotate clockwise -> mirror horizontally (in the rotated frame). Intrinsics, and the pixel map,
 * are derived from exactly this chain so they cannot drift from what the encoder produced.
 *
 * Pixel convention: pixel centres sit at integer coordinates (OpenCV style). ARCore does not
 * document its convention, so the convention is recorded with every calibration rather than
 * claimed verified. For the identity transform used by the CPU JPEG path the convention is moot.
 */
data class SavedRaster(
    val sourceWidth: Int,
    val sourceHeight: Int,
    val cropLeft: Int = 0,
    val cropTop: Int = 0,
    val cropWidth: Int = sourceWidth,
    val cropHeight: Int = sourceHeight,
    /** Size of the cropped region after resizing, before rotation. */
    val scaledWidth: Int = cropWidth,
    val scaledHeight: Int = cropHeight,
    val rotationCwDegrees: Int = 0,
    val mirrorHorizontal: Boolean = false
) {
    init {
        require(sourceWidth > 0 && sourceHeight > 0) { "Source raster must be positive: ${sourceWidth}x$sourceHeight" }
        require(cropWidth > 0 && cropHeight > 0 && cropLeft >= 0 && cropTop >= 0 &&
            cropLeft + cropWidth <= sourceWidth && cropTop + cropHeight <= sourceHeight) {
            "Crop [$cropLeft,$cropTop ${cropWidth}x$cropHeight] is outside source ${sourceWidth}x$sourceHeight"
        }
        require(scaledWidth > 0 && scaledHeight > 0) { "Scaled raster must be positive: ${scaledWidth}x$scaledHeight" }
        require(rotationCwDegrees in setOf(0, 90, 180, 270)) { "Unsupported rotation $rotationCwDegrees" }
    }

    private val quarterTurn: Boolean get() = rotationCwDegrees == 90 || rotationCwDegrees == 270
    val savedWidth: Int get() = if (quarterTurn) scaledHeight else scaledWidth
    val savedHeight: Int get() = if (quarterTurn) scaledWidth else scaledHeight
    val isIdentity: Boolean get() = cropLeft == 0 && cropTop == 0 && cropWidth == sourceWidth &&
        cropHeight == sourceHeight && scaledWidth == cropWidth && scaledHeight == cropHeight &&
        rotationCwDegrees == 0 && !mirrorHorizontal

    /** Row-major 3x3 homogeneous map from source pixel coordinates to saved pixel coordinates. */
    fun sourceToSaved(): DoubleArray {
        val sx = scaledWidth.toDouble() / cropWidth
        val sy = scaledHeight.toDouble() / cropHeight
        // crop + centre-preserving resize: u1 = (u - cropLeft + .5) * sx - .5
        var m = doubleArrayOf(sx, 0.0, (0.5 - cropLeft) * sx - 0.5,
            0.0, sy, (0.5 - cropTop) * sy - 0.5, 0.0, 0.0, 1.0)
        val w = scaledWidth.toDouble(); val h = scaledHeight.toDouble()
        m = multiply(when (rotationCwDegrees) {
            90 -> doubleArrayOf(0.0, -1.0, h - 1, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0)
            180 -> doubleArrayOf(-1.0, 0.0, w - 1, 0.0, -1.0, h - 1, 0.0, 0.0, 1.0)
            270 -> doubleArrayOf(0.0, 1.0, 0.0, -1.0, 0.0, w - 1, 0.0, 0.0, 1.0)
            else -> doubleArrayOf(1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)
        }, m)
        if (mirrorHorizontal) {
            m = multiply(doubleArrayOf(-1.0, 0.0, savedWidth - 1.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0), m)
        }
        return m
    }

    fun mapPoint(u: Double, v: Double): DoubleArray {
        val m = sourceToSaved()
        return doubleArrayOf(m[0] * u + m[1] * v + m[2], m[3] * u + m[4] * v + m[5])
    }

    /**
     * Canonical pinhole intrinsics of the saved raster, `K' = M * K` (ARCore exposes no distortion).
     * Supported ONLY for axis-aligned identity/crop/resize (no rotation, no mirror): a rotation or mirror
     * changes the camera basis/pose convention, which a bare focal/principal-point map cannot express, so those
     * are refused here. [sourceToSaved] and [mapPoint] remain general pixel-transform helpers only.
     */
    fun intrinsics(source: Map<String, Any>): Map<String, Any> {
        fun num(key: String) = (source[key] as? Number)?.toDouble()
            ?: throw IllegalArgumentException("Calibration is missing $key")
        require(rotationCwDegrees == 0 && !mirrorHorizontal) {
            "Canonical intrinsics support only identity/crop/resize; rotation/mirror need an explicit basis change"
        }
        val w = num("imageWidth").toInt(); val h = num("imageHeight").toInt()
        require(w == sourceWidth && h == sourceHeight) {
            "Calibration ${w}x$h does not describe the ${sourceWidth}x$sourceHeight source raster"
        }
        val fx = num("focalLengthX"); val fy = num("focalLengthY")
        require(fx.isFinite() && fy.isFinite() && fx > 0 && fy > 0) { "Non-positive focal length" }
        val cx = num("principalPointX"); val cy = num("principalPointY")
        require(cx.isFinite() && cy.isFinite()) { "Non-finite principal point" }
        val m = sourceToSaved()
        val pp = mapPoint(cx, cy)
        // Without rotation/mirror each saved axis is scaled by exactly its own source axis.
        val fxSaved = m[0] * fx
        val fySaved = m[4] * fy
        return linkedMapOf(
            "focalLengthX" to fxSaved, "focalLengthY" to fySaved,
            "principalPointX" to pp[0], "principalPointY" to pp[1],
            "imageWidth" to savedWidth, "imageHeight" to savedHeight
        )
    }

    /** Evidence stored with each frame/calibration revision. */
    fun toMap(): Map<String, Any> = linkedMapOf(
        "source_width" to sourceWidth, "source_height" to sourceHeight,
        "crop_left" to cropLeft, "crop_top" to cropTop, "crop_width" to cropWidth, "crop_height" to cropHeight,
        "scaled_width" to scaledWidth, "scaled_height" to scaledHeight,
        "rotation_cw_degrees" to rotationCwDegrees, "mirror_horizontal" to mirrorHorizontal,
        "saved_width" to savedWidth, "saved_height" to savedHeight,
        "operation_order" to "crop,resize,rotate_cw,mirror_horizontal",
        "pixel_center_convention" to "integer_centers_assumed_not_verified_against_arcore",
        "source_to_saved_3x3_row_major" to sourceToSaved().toList(),
        "is_identity" to isIdentity
    )

    companion object {
        /** The CPU path saves ARCore's unrotated, uncropped, unscaled YUV raster. */
        fun identity(width: Int, height: Int) = SavedRaster(width, height)

        private fun multiply(a: DoubleArray, b: DoubleArray) = DoubleArray(9) { i ->
            val r = i / 3; val c = i % 3
            a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]
        }
    }
}
