package ai.stateaction.spike.capture

/**
 * Optional Android-camera timestamp availability is independent of Frame readiness.
 * Never substitute Frame.timestamp, Image.timestamp or callback time as elapsedRealtime.
 * Required mapped-clock capture can wait a finite time, then reject explicitly.
 */
class CameraTimestampGate(private val timeoutNs: Long = 5_000_000_000L) {
    sealed interface Decision {
        data class Wait(val reason: String): Decision
        data object Duplicate: Decision
        data class Accept(val cameraNs: Long, val source: String = "arcore_android_camera_timestamp"): Decision
        data class Reject(val reason: String): Decision
    }
    private var firstWaitHostNs: Long?=null
    private var lastAcceptedNs: Long?=null
    fun observe(frameNs: Long, androidCameraNs: Long, hostElapsedNs: Long, metadataSensorNs: Long? = null): Decision {
        require(hostElapsedNs>=0)
        if (androidCameraNs>0L && metadataSensorNs!=null && metadataSensorNs>0L && androidCameraNs!=metadataSensorNs) {
            return Decision.Reject("camera_metadata_timestamp_disagreement")
        }
        val cameraNs=metadataSensorNs?.takeIf { it>0 } ?: androidCameraNs
        val source=if (metadataSensorNs!=null && metadataSensorNs>0) "frame_metadata_sensor_timestamp" else "arcore_android_camera_timestamp"
        if (frameNs<=0 || cameraNs<=0) {
            val first=firstWaitHostNs ?: hostElapsedNs.also { firstWaitHostNs=it }
            return if (hostElapsedNs-first>=timeoutNs) Decision.Reject("required_camera_clock_unavailable_timeout")
            else Decision.Wait(if (frameNs<=0) "arcore_frame_not_ready" else "android_camera_timestamp_unavailable")
        }
        val last=lastAcceptedNs
        if (last!=null && cameraNs<last) return Decision.Reject("android_camera_timestamp_regressed")
        if (last!=null && cameraNs==last) return Decision.Duplicate
        firstWaitHostNs=null; lastAcceptedNs=cameraNs
        return Decision.Accept(cameraNs,source)
    }
}
