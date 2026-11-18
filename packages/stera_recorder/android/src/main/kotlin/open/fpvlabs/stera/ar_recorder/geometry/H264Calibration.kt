package open.fpvlabs.stera.ar_recorder.geometry

/**
 * Saved-pixel calibration of one H.264 take. The hardware/simulation H.264 path feeds ARCore's CPU image to the
 * codec without crop, resize, rotation or mirroring, so the saved raster is the identity of the *actual* source
 * image. A source image whose size is not the encoder raster, or intrinsics that describe a different raster, is an
 * impossible mapping and is rejected, never relabelled. Requested dimensions are never reported as actual: the
 * encoded size comes from the codec's output format via [report].
 *
 * Single producer-thread use; [report] is called after the producer has stopped.
 */
class H264Calibration(private val encoderWidth: Int, private val encoderHeight: Int) {
    private class Revision(
        val firstFrameIndex: Long,
        val raster: SavedRaster,
        val sourceIntrinsics: Map<String, Any>,
        val intrinsics: Map<String, Any>,
    )

    private val revisions = ArrayList<Revision>()
    private var acceptedFrames = 0L
    private var rejectedFrames = 0L
    private var changes = 0L
    private var overflow = 0L
    /** Previous accepted observation, independent of what was stored, so counters count changes not frames. */
    private var lastObserved: Map<String, Any>? = null
    var firstRejection: String? = null; private set

    /**
     * Validates one frame's source image against the encoder raster and ARCore's intrinsics for it.
     * Returns null when the frame may be encoded, otherwise the (actionable) rejection reason.
     */
    fun observe(frameIndex: Long, sourceWidth: Int, sourceHeight: Int, source: Map<String, Any>?): String? {
        if (source == null) return reject("ARCore camera intrinsics are unavailable for this frame")
        if (sourceWidth != encoderWidth || sourceHeight != encoderHeight) {
            return reject("Source image ${sourceWidth}x$sourceHeight does not map to the ${encoderWidth}x$encoderHeight encoded raster " +
                "(H.264 capture does no crop/resize/rotation)")
        }
        val raster = SavedRaster.identity(sourceWidth, sourceHeight)
        val saved = try { raster.intrinsics(source) } catch (e: IllegalArgumentException) {
            return reject(e.message ?: "Invalid camera intrinsics")
        }
        val previous = lastObserved
        if (previous == null || !sameIntrinsics(previous, saved)) {
            if (previous != null) changes++
            if (revisions.size < MAX_REVISIONS) {
                revisions.add(Revision(frameIndex, raster, source.toMap(), saved))
            } else {
                overflow++
            }
            lastObserved = saved
        }
        acceptedFrames++
        return null
    }

    private fun reject(reason: String): String {
        rejectedFrames++
        if (firstRejection == null) firstRejection = reason
        return reason
    }

    /** `yes`: one verified pinhole calibration describes every accepted frame; otherwise honestly not claimed. */
    val inventoryState: String get() = when {
        revisions.isEmpty() -> if (rejectedFrames > 0) "no" else "unavailable"
        revisions.size == 1 && overflow == 0L && rejectedFrames == 0L -> "yes"
        else -> "unknown"
    }

    fun report(encodedWidth: Int?, encodedHeight: Int?): Map<String, Any?> {
        val first = revisions.firstOrNull()
        return linkedMapOf(
            "state" to inventoryState,
            "model" to "pinhole",
            "distortion" to "not_exposed_by_arcore",
            "source" to "camera.imageIntrinsics_mapped_through_saved_raster",
            "accepted_frames" to acceptedFrames, "rejected_frames" to rejectedFrames,
            "first_rejection" to firstRejection,
            "calibration_changes" to changes, "revisions_not_stored" to overflow,
            "requested_encoder_width" to encoderWidth, "requested_encoder_height" to encoderHeight,
            // From the codec output format after it was emitted; null when no output was observed.
            "encoded_width" to encodedWidth, "encoded_height" to encodedHeight,
            "encoded_dimensions_match_saved_raster" to
                (first != null && encodedWidth == first.raster.savedWidth && encodedHeight == first.raster.savedHeight),
            "revisions" to revisions.map { r ->
                val k = r.intrinsics
                fun d(key: String) = (k.getValue(key) as Number).toDouble()
                linkedMapOf<String, Any?>(
                    "first_source_frame_id" to r.firstFrameIndex,
                    "saved_raster" to r.raster.toMap(),
                    "source_intrinsics" to r.sourceIntrinsics,
                    "intrinsics" to k,
                    "K_3x3_row_major" to listOf(d("focalLengthX"), 0.0, d("principalPointX"), 0.0, d("focalLengthY"), d("principalPointY"), 0.0, 0.0, 1.0),
                    "P_3x4_row_major" to listOf(d("focalLengthX"), 0.0, d("principalPointX"), 0.0, 0.0, d("focalLengthY"), d("principalPointY"), 0.0, 0.0, 0.0, 1.0, 0.0))
            })
    }

    private fun sameIntrinsics(a: Map<String, Any>, b: Map<String, Any>): Boolean =
        listOf("focalLengthX", "focalLengthY", "principalPointX", "principalPointY", "imageWidth", "imageHeight").all {
            Math.abs((a.getValue(it) as Number).toDouble() - (b.getValue(it) as Number).toDouble()) <= 1e-6
        }

    companion object { const val MAX_REVISIONS = 8 }
}
