package open.fpvlabs.stera.ar_recorder.encoding

/**
 * Chooses the native camera clock value of one ARCore frame without inventing or reclassifying any clock.
 *
 * - `Frame.timestamp` has an undefined time base: it is retained as evidence only, never used as the camera clock.
 * - `Frame.androidCameraTimestamp` (the accessor) is the Android camera timestamp of the image this Frame
 *   carries. When positive it is the frame's native camera clock.
 * - `ImageMetadata.SENSOR_TIMESTAMP` is the capture result ARCore attached to the Frame. SA-60 observed it one
 *   capture behind the accessor on about 10 of 110 emulator frames. A disagreeing value therefore describes a
 *   different capture: it is excluded from this frame's evidence and counted, instead of aborting the take or
 *   being reported as this image's timestamp. It is used only when the accessor is unavailable.
 * - Missing clocks wait a bounded time, then reject explicitly. A regressing clock rejects; a repeated clock is
 *   the same camera image and is skipped.
 */
class CameraTimestampGate(private val timeoutNs: Long = 5_000_000_000L) {
    enum class MetadataAssociation { MATCHED, STALE, AHEAD, ABSENT, ONLY_SOURCE }

    sealed interface Decision {
        data class Wait(val reason: String) : Decision
        data object Duplicate : Decision
        data class Accept(
            val cameraNs: Long,
            val source: String,
            /** Present only when it is verifiably the same capture as [cameraNs]. */
            val metadataSensorNs: Long?,
            val metadata: MetadataAssociation,
        ) : Decision
        data class Reject(val reason: String) : Decision
    }

    private var firstWaitHostNs: Long? = null
    private var lastAcceptedNs: Long? = null
    var staleMetadata = 0L; private set
    var aheadMetadata = 0L; private set
    var duplicates = 0L; private set
    var waits = 0L; private set

    fun observe(frameNs: Long, accessorNs: Long, hostElapsedNs: Long, metadataSensorNs: Long?): Decision {
        require(hostElapsedNs >= 0)
        val metadata = metadataSensorNs?.takeIf { it > 0 }
        val chosen = when {
            accessorNs > 0 -> accessorNs
            metadata != null -> metadata
            else -> 0L
        }
        if (frameNs <= 0 || chosen <= 0) {
            waits++
            val first = firstWaitHostNs ?: hostElapsedNs.also { firstWaitHostNs = it }
            return if (hostElapsedNs - first >= timeoutNs) Decision.Reject("required_camera_clock_unavailable_timeout")
            else Decision.Wait(if (frameNs <= 0) "arcore_frame_not_ready" else "android_camera_timestamp_unavailable")
        }
        val last = lastAcceptedNs
        if (last != null && chosen < last) return Decision.Reject("android_camera_timestamp_regressed")
        if (last != null && chosen == last) { duplicates++; return Decision.Duplicate }
        firstWaitHostNs = null
        lastAcceptedNs = chosen
        if (accessorNs <= 0) return Decision.Accept(chosen, "frame_metadata_sensor_timestamp", metadata, MetadataAssociation.ONLY_SOURCE)
        val association = when {
            metadata == null -> MetadataAssociation.ABSENT
            metadata == accessorNs -> MetadataAssociation.MATCHED
            metadata < accessorNs -> MetadataAssociation.STALE.also { staleMetadata++ }
            else -> MetadataAssociation.AHEAD.also { aheadMetadata++ }
        }
        return Decision.Accept(chosen, "arcore_android_camera_timestamp",
            metadata.takeIf { association == MetadataAssociation.MATCHED }, association)
    }
}
