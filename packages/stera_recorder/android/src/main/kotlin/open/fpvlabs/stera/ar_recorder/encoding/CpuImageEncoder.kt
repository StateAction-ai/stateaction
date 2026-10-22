package open.fpvlabs.stera.ar_recorder.encoding

import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import android.media.Image
import com.google.ar.core.Frame
import open.fpvlabs.stera.ar_recorder.geometry.CaptureGeometry
import open.fpvlabs.stera.ar_recorder.geometry.ImagePlanePacking
import java.io.ByteArrayOutputStream

/** Saved RGB uses the calibrated CPU image; display texture UVs are only for the preview. */
class CpuImageEncoder {
    data class EncodedImage(val jpeg: ByteArray, val timestampNs: Long, val width: Int, val height: Int)

    fun encode(frame: Frame, intrinsics: Map<String, Any>, quality: Int, previousRgbTimestampNs: Long? = null,
               onDiagnostics: (Map<String, Any?>) -> Unit = {}): EncodedImage =
        encodeImage(frame.timestamp, frame.androidCameraTimestamp, { frame.acquireCameraImage() },
            intrinsics, quality, previousRgbTimestampNs, onDiagnostics)

    /** The injected acquisition boundary enables a Linux JVM test of the actual Android JPEG path. */
    internal fun encodeImage(frameTimestampNs: Long, androidCameraTimestampNs: Long,
                             acquireImage: () -> Image, intrinsics: Map<String, Any>, quality: Int,
                             previousRgbTimestampNs: Long? = null,
                             onDiagnostics: (Map<String, Any?>) -> Unit = {}): EncodedImage {
        val observed = linkedMapOf<String, Any?>(
            "frame_timestamp_ns" to frameTimestampNs,
            "android_camera_timestamp_ns" to androidCameraTimestampNs,
            "previous_rgb_timestamp_ns" to previousRgbTimestampNs,
            "rgb_frame_association" to "Frame.acquireCameraImage_same_frame",
            "cross_stream_clock_verified" to false,
            "rgb_intrinsics" to intrinsics,
            "stage" to "acquire_image"
        )
        try {
            acquireImage().use { image ->
                observed["stage"] = "read_image_metadata"
                observed["image_class"] = image.javaClass.name
                observed["image_timestamp_ns"] = image.timestamp
                observed["image_width"] = image.width
                observed["image_height"] = image.height
                observed["image_format"] = image.format
                val planes = image.planes
                observed["planes"] = planes.map {
                    mapOf("row_stride" to it.rowStride, "pixel_stride" to it.pixelStride,
                        "buffer_position" to it.buffer.position(), "buffer_remaining" to it.buffer.remaining())
                }
                val crop = image.cropRect
                observed["crop_rect"] = listOf(crop.left, crop.top, crop.right, crop.bottom)
                observed["stage"] = "validate_image_geometry"
                require(image.format == ImageFormat.YUV_420_888 && planes.size == 3) { "Unsupported CPU image format/planes" }
                ImagePlanePacking.requireFullCrop(image.width, image.height, crop.left, crop.top, crop.right, crop.bottom)
                CaptureGeometry.requireRgbContract(image.width, image.height,
                    (intrinsics.getValue("imageWidth") as Number).toInt(),
                    (intrinsics.getValue("imageHeight") as Number).toInt(), image.timestamp,
                    frameTimestampNs, androidCameraTimestampNs, previousRgbTimestampNs)
                observed["stage"] = "pack_yuv_planes"
                val packed = ImagePlanePacking.yuv420ToNv21(image.width, image.height,
                    ImagePlanePacking.Plane(planes[0].buffer, planes[0].rowStride, planes[0].pixelStride),
                    ImagePlanePacking.Plane(planes[1].buffer, planes[1].rowStride, planes[1].pixelStride),
                    ImagePlanePacking.Plane(planes[2].buffer, planes[2].rowStride, planes[2].pixelStride))
                observed["stage"] = "compress_jpeg"
                val output = ByteArrayOutputStream()
                check(YuvImage(packed, ImageFormat.NV21, image.width, image.height, null)
                    .compressToJpeg(Rect(0, 0, image.width, image.height), quality, output)) { "CPU JPEG compression failed" }
                observed["stage"] = "complete"
                return EncodedImage(output.toByteArray(), image.timestamp, image.width, image.height)
            }
        } catch (error: Exception) {
            observed["error_class"] = error.javaClass.name
            observed["error_message"] = error.message
            throw error
        } finally {
            onDiagnostics(observed.toMap())
        }
    }
}
