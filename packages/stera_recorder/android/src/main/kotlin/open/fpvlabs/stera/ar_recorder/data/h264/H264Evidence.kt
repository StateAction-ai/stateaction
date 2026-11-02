package open.fpvlabs.stera.ar_recorder.data.h264

/** Pure builders for the strict v1.1 evidence messages, so their exact shapes are JVM-tested. */
object H264Evidence {
    const val CAMERA_CLOCK = "android.camera.sensor_timestamp"
    /** Emulator-only: host elapsed-realtime receipt time, used only when the camera clock source is not REALTIME. */
    const val SIMULATION_RECEIPT_CLOCK = "android.elapsed_realtime_receipt"
    const val MAPPING_REVISION = "android_elapsed_to_unix_v1"
    /** SensorEvent clock of SA-53's independent raw motion (`MOTION_NATIVE_CLOCK_ID`). */
    const val MOTION_CLOCK = "android.elapsed_realtime"
    /** One declared RGB calibration. Its values are not stored by this profile revision (SA-54 owns saved calibration). */
    const val RGB_CALIBRATION = "rgb_arcore_image_intrinsics"

    /** Fixed elapsed-realtime to Unix anchor, bracketed by two elapsed readings around one wall-clock reading. */
    class Anchor(beforeElapsedNs: Long, val epochNs: Long, afterElapsedNs: Long) {
        init { require(afterElapsedNs >= beforeElapsedNs && epochNs > 0) }
        val elapsedNs: Long = beforeElapsedNs + (afterElapsedNs - beforeElapsedNs) / 2
        /** Wall-clock millisecond resolution plus the bracket width; not a measured sensor synchronization. */
        val uncertaintyNs: Long = 1_000_000L + (afterElapsedNs - beforeElapsedNs)
        fun map(elapsedNs: Long): Long = Math.addExact(epochNs, Math.subtractExact(elapsedNs, this.elapsedNs))
    }

    fun clocks(recordingId: String, anchor: Anchor, rgbClock: String, verifiedRealtime: Boolean): Map<String, Any?> = mapOf(
        "recording_id" to recordingId,
        "recorder_transport" to mapOf(
            "clock_id" to "android.elapsed_realtime", "target_clock_id" to "unix",
            "native_anchor_ns" to anchor.elapsedNs.toString(), "epoch_anchor_ns" to anchor.epochNs.toString(),
            "method" to "fixed_host_anchor", "revision" to MAPPING_REVISION,
            "status" to if (verifiedRealtime) "same_domain" else "unverified",
            "uncertainty_ns" to anchor.uncertaintyNs.toString(), "synchronization_accuracy" to "unverified"),
        "stream_clocks" to mapOf("rgb" to rgbClock, "pose" to rgbClock, "accel" to MOTION_CLOCK, "gyro" to MOTION_CLOCK),
    )

    fun acquired(
        recordingId: String, sourceFrameId: Long, nativeNs: Long, nativeClock: String, mappedNs: Long, ptsUs: Long,
        arcoreFrameNs: Long, arcoreImageNs: Long, metadataSensorNs: Long?,
    ): Map<String, Any?> {
        require(nativeNs > 0 && mappedNs > 0 && ptsUs >= 0 && arcoreImageNs > 0)
        val native = linkedMapOf<String, Any?>("arcore_image_timestamp_ns" to arcoreImageNs.toString())
        if (arcoreFrameNs > 0) native["arcore_frame_timestamp_ns"] = arcoreFrameNs.toString()
        if (metadataSensorNs != null && metadataSensorNs > 0) native["metadata_sensor_timestamp_ns"] = metadataSensorNs.toString()
        return mapOf(
            "recording_id" to recordingId, "stream_id" to "rgb", "source_frame_id" to sourceFrameId.toString(), "state" to "acquired",
            "native_timestamp_ns" to nativeNs.toString(), "native_clock_id" to nativeClock,
            "mapped_capture_time_ns" to mappedNs.toString(), "clock_mapping_revision" to MAPPING_REVISION,
            "calibration_id" to RGB_CALIBRATION, "encoder_pts_us" to ptsUs.toString(),
            "encoder_time_base" to CaptureProtocol.TIME_BASE, "native_timestamps" to native,
        )
    }

    data class SensorPlan(
        val rgbClock: String,
        val imuRequested: Boolean,
        val accelSupported: Boolean,
        val gyroSupported: Boolean,
        val depthRequested: Boolean,
        val depthSupported: Boolean,
    )

    /** Inventory: RGB and independent raw motion with observed counts; depth is explicitly not recorded by this revision. */
    fun inventory(plan: SensorPlan, acquiredFrames: Long, accelEvents: Long = 0, gyroEvents: Long = 0): Pair<List<Map<String, Any?>>, List<Map<String, Any?>>> {
        fun yn(value: Boolean) = if (value) "yes" else "no"
        fun absent(id: String, kind: String, requested: Boolean, supported: Boolean, reason: String) = mapOf(
            "sensor_id" to id, "kind" to kind, "requested" to yn(requested), "supported" to yn(supported),
            "enabled" to "no", "observed" to "no", "observed_count" to null, "native_clock_id" to null,
            "unavailable_reason" to when { !requested -> null; !supported -> "device_reports_unsupported"; else -> reason })
        // SA-53 always requests both raw motion sensors for a take; an unsupported sensor is explicit.
        fun motion(id: String, supported: Boolean, count: Long) = mapOf(
            "sensor_id" to id, "kind" to "imu", "requested" to "yes", "supported" to yn(supported), "enabled" to yn(supported),
            "observed" to yn(count > 0), "observed_count" to if (supported) count.toString() else null,
            "native_clock_id" to if (supported) MOTION_CLOCK else null,
            "unavailable_reason" to if (supported) null else "device_reports_unsupported")
        val sensors = listOf(
            mapOf("sensor_id" to "rgb", "kind" to "camera", "requested" to "yes", "supported" to "yes", "enabled" to "yes",
                "observed" to yn(acquiredFrames > 0), "observed_count" to acquiredFrames.toString(),
                "native_clock_id" to plan.rgbClock, "unavailable_reason" to null),
            motion("accel", plan.accelSupported, accelEvents),
            motion("gyro", plan.gyroSupported, gyroEvents),
            absent("depth", "depth", plan.depthRequested, plan.depthSupported, "depth_not_in_profile_revision"),
        )
        val calibrations = listOf(mapOf("calibration_id" to RGB_CALIBRATION, "stream_id" to "rgb", "state" to "unknown", "model" to "pinhole"))
        return sensors to calibrations
    }
}
