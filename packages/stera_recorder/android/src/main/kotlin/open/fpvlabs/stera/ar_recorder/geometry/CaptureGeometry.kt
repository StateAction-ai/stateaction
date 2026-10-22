package open.fpvlabs.stera.ar_recorder.geometry

import kotlin.math.abs

/** Contract for saved pixels. Preview rotation never enters this coordinate chain. */
object CaptureGeometry {
    const val VERSION = "android_arcore_cpu_v2"
    val opticalToCameraQuaternion: DoubleArray get() = doubleArrayOf(1.0, 0.0, 0.0, 0.0)

    fun metadata(): Map<String, Any> = mapOf(
        "version" to VERSION,
        "rgb_source" to "arcore_acquireCameraImage_YUV_420_888",
        "rgb_orientation" to "native_cpu_unrotated",
        "rgb_resize_crop_applied" to false,
        "rgb_intrinsics" to "camera.imageIntrinsics",
        "pose" to "camera.pose_physical_camera_to_world",
        "camera_axes" to "x_right_y_up_z_backward",
        "optical_axes" to "x_right_y_down_z_forward",
        "optical_to_camera_quaternion_xyzw" to opticalToCameraQuaternion.toList(),
        "depth_source" to "arcore_acquireDepthImage16Bits",
        "depth_orientation" to "native_texture_unrotated",
        "depth_intrinsics" to "rgb_pixel_to_depth_pixel_times_rgb_K",
        "depth_mapping" to "frame.transformCoordinates2d_IMAGE_PIXELS_to_TEXTURE_NORMALIZED",
        "timestamp_clock" to "native_clocks_preserved_ARCore_frame_time_base_undefined",
        "rgb_timestamp" to "Image.timestamp_verified_equal_to_Frame.androidCameraTimestamp",
        "rgb_mcap_log_time" to "Frame.timestamp_acquisition_association",
        "rgb_mcap_publish_time" to "Image.timestamp_native_android_camera_clock",
        "cross_stream_clock_verified" to false,
        "depth_timestamp" to "Image.timestamp_not_replaced_with_rgb_timestamp",
        "depth_mcap_log_time" to "Frame.timestamp_acquisition_association",
        "depth_mcap_publish_time" to "Image.timestamp_native",
        "frame_geometry_topic" to "/capture/frame_geometry",
        "distortion_coefficients" to "not_exposed_by_arcore"
    )

    fun requireRgbContract(width: Int, height: Int, calibrationWidth: Int, calibrationHeight: Int,
                           imageTimestampNs: Long, frameTimestampNs: Long, androidCameraTimestampNs: Long) {
        require(width > 0 && height > 0 && width == calibrationWidth && height == calibrationHeight) {
            "CPU image dimensions ${width}x${height} do not match imageIntrinsics ${calibrationWidth}x${calibrationHeight}"
        }
        require(frameTimestampNs > 0 && androidCameraTimestampNs > 0 && imageTimestampNs == androidCameraTimestampNs) {
            "CPU image timestamp $imageTimestampNs does not match Android camera timestamp $androidCameraTimestampNs (ARCore frame $frameTimestampNs)"
        }
    }

    /** Input maps CPU image corners into normalized texture coordinates (ARCore depth domain). */
    fun rgbToDepthMatrix(rgbWidth: Int, rgbHeight: Int, depthWidth: Int, depthHeight: Int,
                         textureCorners: FloatArray): DoubleArray {
        require(rgbWidth > 0 && rgbHeight > 0 && depthWidth > 0 && depthHeight > 0)
        require(textureCorners.size == 8 && textureCorners.all { it.isFinite() })
        val tx = textureCorners[0].toDouble() * depthWidth
        val ty = textureCorners[1].toDouble() * depthHeight
        val a = (textureCorners[2] - textureCorners[0]).toDouble() * depthWidth / rgbWidth
        val b = (textureCorners[4] - textureCorners[0]).toDouble() * depthWidth / rgbHeight
        val c = (textureCorners[3] - textureCorners[1]).toDouble() * depthHeight / rgbWidth
        val d = (textureCorners[5] - textureCorners[1]).toDouble() * depthHeight / rgbHeight
        require(abs(a * rgbWidth + b * rgbHeight + tx - textureCorners[6] * depthWidth) < 0.05 &&
            abs(c * rgbWidth + d * rgbHeight + ty - textureCorners[7] * depthHeight) < 0.05) {
            "Non-affine CPU-to-depth image mapping"
        }
        require(a > 0 && d > 0 && abs(b) < 1e-6 && abs(c) < 1e-6) {
            "Unsupported rotated/reflected CPU-to-depth image mapping"
        }
        return doubleArrayOf(a, b, tx, c, d, ty, 0.0, 0.0, 1.0)
    }

    fun depthIntrinsics(rgb: Map<String, Any>, width: Int, height: Int,
                        mapping: DoubleArray): Map<String, Any> {
        require(mapping.size == 9)
        fun value(key: String) = (rgb.getValue(key) as Number).toDouble()
        return mapOf(
            "focalLengthX" to mapping[0] * value("focalLengthX"),
            "focalLengthY" to mapping[4] * value("focalLengthY"),
            "principalPointX" to mapping[0] * value("principalPointX") + mapping[2],
            "principalPointY" to mapping[4] * value("principalPointY") + mapping[5],
            "imageWidth" to width, "imageHeight" to height
        )
    }
}
