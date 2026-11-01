package open.fpvlabs.stera.ar_recorder.encoding

import android.media.Image
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.media.MediaFormat
import android.os.Bundle
import android.os.Build
import android.os.SystemClock
import java.io.ByteArrayOutputStream

/** Bounded synchronous adapter: caller retains the one ARCore image lease until submit returns. */
class H264RgbEncoder(val simulation: Boolean, private val onFrame: (Long, ByteArray) -> Unit) {
    val width = if (simulation) 640 else 1920
    val height = if (simulation) 480 else 1080
    val fps = 30
    val bitrate = if (simulation) 4_000_000 else 12_000_000
    private val level = if (simulation) MediaCodecInfo.CodecProfileLevel.AVCLevel31 else MediaCodecInfo.CodecProfileLevel.AVCLevel4
    private val codec: MediaCodec
    private val info = MediaCodec.BufferInfo()
    private var sps: ByteArray? = null
    private var pps: ByteArray? = null
    private val partial = ByteArrayOutputStream()
    private var partialPts: Long? = null
    private var outputFormatSeen = false
    var eosSeen = false; private set
    var submitted = 0L; private set
    var output = 0L; private set
    var actualFormat: String? = null; private set
    private var lastSyncRequestPtsUs: Long? = null
    var requestedSyncFrames = 0L; private set
    val codecName: String
    val hardware: Boolean

    init {
        require(!simulation || isEmulator()) { "H.264 simulation mode is restricted to verified emulators" }
        val selected = MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.firstOrNull { entry ->
            if (!entry.isEncoder || !entry.supportedTypes.any { it.equals(MediaFormat.MIMETYPE_VIDEO_AVC, true) }) false
            else try {
                val caps = entry.getCapabilitiesForType(MediaFormat.MIMETYPE_VIDEO_AVC)
                val video = checkNotNull(caps.videoCapabilities)
                val hw = if (Build.VERSION.SDK_INT >= 29) entry.isHardwareAccelerated && !entry.isSoftwareOnly else false
                (simulation || hw) && caps.colorFormats.contains(MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible) &&
                    caps.profileLevels.any { it.profile == MediaCodecInfo.CodecProfileLevel.AVCProfileMain && it.level >= level } &&
                    video.areSizeAndRateSupported(width, height, fps.toDouble()) &&
                    video.bitrateRange.contains(bitrate)
            } catch (_: Exception) { false }
        } ?: error("No ${if (simulation) "emulator" else "hardware"} flexible-YUV encoder supports ${width}x${height} Main/${if (simulation) "3.1" else "4.0"} 30fps; no fallback permitted")
        codecName = selected.name
        hardware = Build.VERSION.SDK_INT >= 29 && selected.isHardwareAccelerated && !selected.isSoftwareOnly
        codec = MediaCodec.createByCodecName(codecName)
        try {
            val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height).apply {
                setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible)
                setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
                setInteger(MediaFormat.KEY_FRAME_RATE, fps)
                setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
                setInteger(MediaFormat.KEY_PROFILE, MediaCodecInfo.CodecProfileLevel.AVCProfileMain)
                setInteger(MediaFormat.KEY_LEVEL, level)
                if (Build.VERSION.SDK_INT >= 29) setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0)
            }
            codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            codec.start()
        } catch (error: Throwable) { codec.release(); throw error }
    }

    fun submit(image: Image, ptsUs: Long, onQueued: () -> Unit = {}): Boolean {
        check(!eosSeen)
        require(image.format == android.graphics.ImageFormat.YUV_420_888) { "Only native YUV_420_888 input is supported" }
        require(image.width == width && image.height == height) { "Native image ${image.width}x${image.height} does not match requested ${width}x${height}; no resize/crop fallback" }
        require(image.cropRect.left == 0 && image.cropRect.top == 0 && image.cropRect.right == width && image.cropRect.bottom == height)
        drain()
        val index = codec.dequeueInputBuffer(10_000)
        if (index < 0) return false
        // Input Image exposes the selected codec's actual row/pixel strides. Never assume NV12/I420.
        val target = checkNotNull(codec.getInputImage(index)) { "Codec has no flexible-YUV input image" }
        copyYuv(image, target)
        // Some codecs implement I_FRAME_INTERVAL as a nominal input-frame count. The camera
        // can be VFR or drop frames, so request an actual sync frame on its true media timeline.
        val lastSync = lastSyncRequestPtsUs
        if (lastSync == null || ptsUs - lastSync >= 1_000_000L) {
            codec.setParameters(Bundle().apply { putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0) })
            lastSyncRequestPtsUs = ptsUs; requestedSyncFrames++
        }
        val buffer = checkNotNull(codec.getInputBuffer(index))
        codec.queueInputBuffer(index, 0, buffer.capacity(), ptsUs, 0)
        submitted++
        onQueued()
        drain()
        return true
    }

    private fun inspectConfig(bytes: ByteArray) {
        for (nal in AnnexB.nals(bytes)) when (AnnexB.type(nal)) {
            7 -> {
                require(nal.size >= 4 && (nal[1].toInt() and 255) == 77 && (nal[3].toInt() and 255) == if (simulation) 31 else 40) { "Actual SPS profile/level differs from requested Main profile" }
                require(sps == null || sps!!.contentEquals(nal)) { "Unexpected SPS change during recording" }
                sps = nal
            }
            8 -> {
                require(pps == null || pps!!.contentEquals(nal)) { "Unexpected PPS change during recording" }
                pps = nal
            }
        }
    }

    fun drain(waitUs: Long = 0) {
        while (true) {
            val index = codec.dequeueOutputBuffer(info, waitUs)
            when (index) {
                MediaCodec.INFO_TRY_AGAIN_LATER -> return
                MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                    check(!outputFormatSeen) { "Unexpected codec output-format reset during recording" }
                    outputFormatSeen = true
                    val format = codec.outputFormat
                    actualFormat = format.toString()
                    require(format.getInteger(MediaFormat.KEY_WIDTH) == width && format.getInteger(MediaFormat.KEY_HEIGHT) == height)
                    for (key in listOf("csd-0", "csd-1")) format.getByteBuffer(key)?.duplicate()?.let { b -> inspectConfig(ByteArray(b.remaining()).also { b.get(it) }) }
                }
                else -> if (index >= 0) try {
                    if (info.size > 0) {
                        require(info.size <= MAX_ACCESS_UNIT_BYTES)
                        val b = checkNotNull(codec.getOutputBuffer(index)).duplicate().apply { position(info.offset); limit(info.offset + info.size) }
                        val bytes = ByteArray(info.size).also { b.get(it) }
                        if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) inspectConfig(bytes)
                        else {
                            require(partialPts == null || partialPts == info.presentationTimeUs) { "Partial access unit changed PTS" }
                            partialPts = info.presentationTimeUs
                            require(partial.size() + bytes.size <= MAX_ACCESS_UNIT_BYTES)
                            partial.write(bytes)
                            if (info.flags and MediaCodec.BUFFER_FLAG_PARTIAL_FRAME == 0) {
                                val nals = AnnexB.nals(partial.toByteArray()); partial.reset(); partialPts = null
                                inspectConfig(AnnexB.join(nals))
                                require(nals.none(AnnexB::isBFrame)) { "B frames are forbidden" }
                                require(nals.count { AnnexB.type(it) == 9 } <= 1) { "Multiple access units in output" }
                                if (nals.any { AnnexB.type(it) in listOf(1, 5) }) {
                                    val idr = nals.any { AnnexB.type(it) == 5 }
                                    val complete = if (idr) AnnexB.join(listOf(checkNotNull(sps), checkNotNull(pps)) + nals.filter { AnnexB.type(it) !in listOf(7, 8) }) else AnnexB.join(nals)
                                    require(complete.size <= MAX_ACCESS_UNIT_BYTES)
                                    onFrame(info.presentationTimeUs, complete); output++
                                }
                            }
                        }
                    }
                    if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) {
                        check(partial.size() == 0); eosSeen = true; return
                    }
                } finally { codec.releaseOutputBuffer(index, false) }
            }
        }
    }

    fun finish() {
        val deadline = SystemClock.elapsedRealtime() + 10_000
        var signaled = false
        while (!signaled && SystemClock.elapsedRealtime() < deadline) {
            drain()
            val input = codec.dequeueInputBuffer(10_000)
            if (input >= 0) { codec.queueInputBuffer(input, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM); signaled = true }
        }
        check(signaled) { "Encoder EOS input timeout" }
        while (!eosSeen && SystemClock.elapsedRealtime() < deadline) drain(10_000)
        check(eosSeen) { "Encoder EOS output timeout" }
        check(submitted == output) { "Encoder frame reconciliation failed: submitted=$submitted encoded=$output" }
    }

    fun close() { try { codec.stop() } finally { codec.release() } }

    companion object {
        const val MAX_ACCESS_UNIT_BYTES = 16 * 1024 * 1024 - 4096
        fun isEmulator(): Boolean = Build.FINGERPRINT.startsWith("generic") || Build.FINGERPRINT.startsWith("google/sdk_gphone") || Build.MODEL.contains("sdk_gphone") || Build.HARDWARE in listOf("ranchu", "goldfish")
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
