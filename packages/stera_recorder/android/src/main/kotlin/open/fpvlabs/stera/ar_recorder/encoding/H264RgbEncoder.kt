package open.fpvlabs.stera.ar_recorder.encoding

import android.graphics.ImageFormat
import android.media.Image
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.media.MediaFormat
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import open.fpvlabs.stera.ar_recorder.data.h264.AnnexB

/** Selected encoder settings. The hardware candidate and the emulator profile are distinct, named profiles. */
data class H264EncoderProfile(
    val name: String,
    val simulation: Boolean,
    val width: Int,
    val height: Int,
    val fps: Int,
    val bitrate: Int,
    val level: Int,
    val levelIdc: Int,
    val levelLabel: String,
) {
    companion object {
        /** Candidate physical profile: 1920x1080, requested 30 fps, Main 4.0, no B frames, 12 Mb/s, 1 s IDR. */
        val HARDWARE = H264EncoderProfile("h264_mcap_v1", false, 1920, 1080, 30, 12_000_000,
            MediaCodecInfo.CodecProfileLevel.AVCLevel4, 40, "4.0")
        /** Emulator-only software AVC profile. Never selected on physical hardware. */
        val SIMULATION = H264EncoderProfile("h264_mcap_simulation_v1", true, 640, 480, 30, 4_000_000,
            MediaCodecInfo.CodecProfileLevel.AVCLevel31, 31, "3.1")
    }
}

/** An explicit preflight refusal: the required profile is unavailable and nothing is lowered silently. */
class H264PreflightException(message: String) : IllegalStateException(message)

/**
 * Bounded synchronous MediaCodec adapter. The caller keeps the ARCore image lease only until [submit] returns.
 * Output buffers are copied once and released immediately; whole access units come from [H264AccessUnitAssembler].
 */
class H264RgbEncoder(val profile: H264EncoderProfile, private val onAccessUnit: (H264AccessUnit) -> Unit) {
    private val codec: MediaCodec
    private val info = MediaCodec.BufferInfo()
    private val assembler = H264AccessUnitAssembler()
    private var sps: ByteArray? = null
    private var pps: ByteArray? = null
    private var outputFormatSeen = false
    private var lastSyncRequestPtsUs: Long? = null
    val codecName: String
    val canonicalName: String
    val hardware: Boolean
    var submitted = 0L; private set
    var output = 0L; private set
    var idrCount = 0L; private set
    var requestedSyncFrames = 0L; private set
    var outputFormat: Map<String, Any?> = emptyMap(); private set
    var inputColorFormat: Int? = null; private set
    var spsProfileIdc: Int? = null; private set
    var spsLevelIdc: Int? = null; private set
    val eosSeen: Boolean get() = assembler.endOfStream

    init {
        if (profile.simulation && !isEmulator()) throw H264PreflightException("The H.264 simulation profile is restricted to verified Android emulators")
        if (!profile.simulation && isEmulator()) throw H264PreflightException("The hardware H.264 profile cannot be qualified on an emulator")
        if (!profile.simulation && Build.VERSION.SDK_INT < 29) throw H264PreflightException("Hardware encoder identity requires Android 10 (API 29) or newer")
        val selected = MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.firstOrNull { supports(it, profile) }
            ?: throw H264PreflightException("No ${if (profile.simulation) "emulator" else "hardware"} flexible-YUV AVC encoder supports " +
                "${profile.width}x${profile.height} Main/${profile.levelLabel} ${profile.fps} fps ${profile.bitrate} b/s; no fallback permitted")
        codecName = selected.name
        canonicalName = if (Build.VERSION.SDK_INT >= 29) selected.canonicalName else selected.name
        hardware = Build.VERSION.SDK_INT >= 29 && selected.isHardwareAccelerated && !selected.isSoftwareOnly
        codec = MediaCodec.createByCodecName(codecName)
        try {
            val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, profile.width, profile.height).apply {
                setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible)
                setInteger(MediaFormat.KEY_BIT_RATE, profile.bitrate)
                setInteger(MediaFormat.KEY_FRAME_RATE, profile.fps)
                setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
                setInteger(MediaFormat.KEY_PROFILE, MediaCodecInfo.CodecProfileLevel.AVCProfileMain)
                setInteger(MediaFormat.KEY_LEVEL, profile.level)
                if (Build.VERSION.SDK_INT >= 29) setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0)
            }
            codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            inputColorFormat = runCatching { codec.inputFormat.getInteger(MediaFormat.KEY_COLOR_FORMAT) }.getOrNull()
            codec.start()
        } catch (error: Throwable) {
            codec.release()
            throw error
        }
    }

    /** Copies one native YUV_420_888 image into codec input; false means codec input backpressure (no wait loop). */
    fun submit(image: Image, ptsUs: Long, onQueued: () -> Unit): Boolean {
        check(!eosSeen) { "Encoder already ended" }
        require(image.format == ImageFormat.YUV_420_888) { "Only native YUV_420_888 input is supported" }
        require(image.width == profile.width && image.height == profile.height) {
            "Native image ${image.width}x${image.height} does not match ${profile.width}x${profile.height}; no resize/crop fallback"
        }
        val crop = image.cropRect
        require(crop.left == 0 && crop.top == 0 && crop.right == profile.width && crop.bottom == profile.height) { "Cropped camera image; no crop fallback" }
        drain()
        val index = codec.dequeueInputBuffer(INPUT_WAIT_US)
        if (index < 0) return false
        val target = checkNotNull(codec.getInputImage(index)) { "Codec has no flexible-YUV input image" }
        copyYuv(image, target)
        // Request sync frames on the true media timeline: VFR/dropped camera frames make nominal frame counts wrong.
        val lastSync = lastSyncRequestPtsUs
        if (lastSync == null || ptsUs - lastSync >= 1_000_000L) {
            codec.setParameters(Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0) })
            lastSyncRequestPtsUs = ptsUs
            requestedSyncFrames++
        }
        codec.queueInputBuffer(index, 0, checkNotNull(codec.getInputBuffer(index)).capacity(), ptsUs, 0)
        submitted++
        onQueued()
        drain()
        return true
    }

    fun drain(waitUs: Long = 0) {
        while (!eosSeen) {
            val index = codec.dequeueOutputBuffer(info, waitUs)
            when {
                index == MediaCodec.INFO_TRY_AGAIN_LATER -> return
                index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> recordOutputFormat(codec.outputFormat)
                index >= 0 -> try {
                    val bytes = if (info.size > 0) {
                        val buffer = checkNotNull(codec.getOutputBuffer(index)).duplicate()
                        buffer.position(info.offset); buffer.limit(info.offset + info.size)
                        ByteArray(info.size).also { buffer.get(it) }
                    } else ByteArray(0)
                    val config = info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0
                    if (config) inspectParameterSets(bytes)
                    val unit = assembler.accept(info.flags, info.presentationTimeUs, bytes)
                    if (unit != null) {
                        inspectParameterSets(unit.bytes.copyOfRange(0, minOf(unit.bytes.size, 512)), tolerateTruncation = true)
                        if (unit.idr) idrCount++
                        output++
                        onAccessUnit(unit)
                    }
                } finally {
                    codec.releaseOutputBuffer(index, false)
                }
            }
        }
    }

    /** Signals end of stream and drains it within a bounded deadline. */
    fun finish(deadlineMs: Long = EOS_DEADLINE_MS) {
        val deadline = SystemClock.elapsedRealtime() + deadlineMs
        var signaled = false
        while (!signaled && SystemClock.elapsedRealtime() < deadline) {
            drain()
            val input = codec.dequeueInputBuffer(INPUT_WAIT_US)
            if (input >= 0) { codec.queueInputBuffer(input, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM); signaled = true }
        }
        check(signaled) { "Encoder end-of-stream input deadline exceeded" }
        while (!eosSeen && SystemClock.elapsedRealtime() < deadline) drain(INPUT_WAIT_US)
        check(eosSeen) { "Encoder end-of-stream output deadline exceeded" }
    }

    fun close() {
        try { codec.stop() } catch (_: IllegalStateException) {} finally { codec.release() }
    }

    fun identity(): Map<String, Any?> = mapOf(
        "codec_name" to codecName, "canonical_name" to canonicalName, "hardware" to hardware,
        "requested" to mapOf("profile" to profile.name, "width" to profile.width, "height" to profile.height, "fps" to profile.fps,
            "bitrate" to profile.bitrate, "avc_profile" to "main", "avc_level" to profile.levelLabel, "b_frames" to 0, "idr_interval_seconds" to 1),
        "input_color_format" to inputColorFormat, "output_format" to outputFormat,
        "sps_profile_idc" to spsProfileIdc, "sps_level_idc" to spsLevelIdc,
        "submitted" to submitted, "access_units" to output, "idr_access_units" to idrCount, "requested_sync_frames" to requestedSyncFrames,
        "config_buffers" to assembler.configBuffers, "partial_buffers" to assembler.partialBuffers, "end_of_stream" to eosSeen,
    )

    private fun recordOutputFormat(format: MediaFormat) {
        check(!outputFormatSeen) { "Unexpected encoder output-format reset during recording" }
        outputFormatSeen = true
        val width = format.getInteger(MediaFormat.KEY_WIDTH)
        val height = format.getInteger(MediaFormat.KEY_HEIGHT)
        check(width == profile.width && height == profile.height) { "Encoder output raster ${width}x$height differs from the request" }
        fun int(key: String): Int? = if (format.containsKey(key)) runCatching { format.getInteger(key) }.getOrNull() else null
        outputFormat = mapOf("width" to width, "height" to height,
            "color_standard" to int(MediaFormat.KEY_COLOR_STANDARD), "color_range" to int(MediaFormat.KEY_COLOR_RANGE),
            "color_transfer" to int(MediaFormat.KEY_COLOR_TRANSFER), "profile" to int(MediaFormat.KEY_PROFILE), "level" to int(MediaFormat.KEY_LEVEL))
        for (key in listOf("csd-0", "csd-1")) format.getByteBuffer(key)?.duplicate()?.let { inspectParameterSets(ByteArray(it.remaining()).also(it::get)) }
    }

    /** Checks the emitted SPS, not the requested MediaFormat hint: Main profile, the requested level, stable sets. */
    private fun inspectParameterSets(bytes: ByteArray, tolerateTruncation: Boolean = false) {
        val nals = try { AnnexB.nals(bytes) } catch (error: IllegalArgumentException) { if (tolerateTruncation) return else throw error }
        for (nal in nals) when (AnnexB.type(nal)) {
            7 -> {
                if (tolerateTruncation && nal.size < 4) continue
                require(nal.size >= 4) { "Truncated SPS" }
                val profileIdc = nal[1].toInt() and 255
                val levelIdc = nal[3].toInt() and 255
                if (!tolerateTruncation || sps == null) {
                    require(profileIdc == 77) { "Emitted SPS profile_idc $profileIdc is not Main (77)" }
                    require(levelIdc == profile.levelIdc) { "Emitted SPS level_idc $levelIdc differs from requested ${profile.levelIdc}" }
                }
                if (sps == null) { sps = nal; spsProfileIdc = profileIdc; spsLevelIdc = levelIdc }
                else if (!tolerateTruncation) require(sps!!.contentEquals(nal)) { "SPS changed during recording" }
            }
            8 -> if (!tolerateTruncation) {
                if (pps == null) pps = nal else require(pps!!.contentEquals(nal)) { "PPS changed during recording" }
            }
        }
    }

    companion object {
        const val INPUT_WAIT_US = 10_000L
        const val EOS_DEADLINE_MS = 10_000L

        fun isEmulator(): Boolean = Build.HARDWARE in setOf("ranchu", "goldfish") ||
            Build.FINGERPRINT.startsWith("generic") || Build.FINGERPRINT.startsWith("google/sdk_gphone") || Build.MODEL.contains("sdk_gphone")

        private fun supports(entry: MediaCodecInfo, profile: H264EncoderProfile): Boolean {
            if (!entry.isEncoder || entry.supportedTypes.none { it.equals(MediaFormat.MIMETYPE_VIDEO_AVC, true) }) return false
            return try {
                val caps = entry.getCapabilitiesForType(MediaFormat.MIMETYPE_VIDEO_AVC)
                val video = checkNotNull(caps.videoCapabilities)
                val hardware = Build.VERSION.SDK_INT >= 29 && entry.isHardwareAccelerated && !entry.isSoftwareOnly
                (profile.simulation || hardware) &&
                    caps.colorFormats.contains(MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible) &&
                    caps.profileLevels.any { it.profile == MediaCodecInfo.CodecProfileLevel.AVCProfileMain && it.level >= profile.level } &&
                    video.areSizeAndRateSupported(profile.width, profile.height, profile.fps.toDouble()) &&
                    video.bitrateRange.contains(profile.bitrate)
            } catch (_: Exception) { false }
        }

        /** Copies YUV planes using both images' actual row and pixel strides; never assumes NV12 or I420. */
        fun copyYuv(source: Image, destination: Image) {
            require(source.planes.size == 3 && destination.planes.size == 3)
            for (plane in 0..2) {
                val w = if (plane == 0) source.width else source.width / 2
                val h = if (plane == 0) source.height else source.height / 2
                val src = source.planes[plane]; val dst = destination.planes[plane]
                val sb = src.buffer.duplicate(); val db = dst.buffer.duplicate()
                val so = sb.position(); val d = db.position()
                if (src.pixelStride == 1 && dst.pixelStride == 1) {
                    val row = ByteArray(w)
                    for (y in 0 until h) {
                        sb.position(so + y * src.rowStride); sb.get(row)
                        db.position(d + y * dst.rowStride); db.put(row)
                    }
                } else for (y in 0 until h) for (x in 0 until w) {
                    db.put(d + y * dst.rowStride + x * dst.pixelStride, sb.get(so + y * src.rowStride + x * src.pixelStride))
                }
            }
        }
    }
}
