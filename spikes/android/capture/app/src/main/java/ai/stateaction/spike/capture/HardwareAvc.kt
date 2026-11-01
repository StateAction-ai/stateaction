package ai.stateaction.spike.capture

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.media.MediaFormat
import android.view.Surface
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream

data class EncodedFrame(val ptsUs: Long, val annexB: ByteArray, val idr: Boolean)

class HardwareAvc(private val onFrame: (EncodedFrame) -> Unit) {
    val probe: JSONObject
    private val codec: MediaCodec
    val surface: Surface
    var eos = false; private set
    var observedFormat: String? = null; private set
    var observedSpsProfile: Int? = null; private set
    var observedSpsLevel: Int? = null; private set
    private var sps: ByteArray? = null
    private var pps: ByteArray? = null
    private val partial = ByteArrayOutputStream()
    private var partialPts: Long? = null
    private val info = MediaCodec.BufferInfo()
    init {
        val candidates = JSONArray()
        var selected: MediaCodecInfo? = null
        for (entry in MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos) {
            if (!entry.isEncoder || !entry.supportedTypes.any { it.equals(MediaFormat.MIMETYPE_VIDEO_AVC,true) }) continue
            val item = JSONObject().put("name",entry.name).put("hardware",entry.isHardwareAccelerated).put("software_only",entry.isSoftwareOnly)
            try {
                val caps = entry.getCapabilitiesForType(MediaFormat.MIMETYPE_VIDEO_AVC)
                val video = checkNotNull(caps.videoCapabilities)
                val main4 = caps.profileLevels.any { it.profile == MediaCodecInfo.CodecProfileLevel.AVCProfileMain && it.level >= MediaCodecInfo.CodecProfileLevel.AVCLevel4 }
                val supported = entry.isHardwareAccelerated && !entry.isSoftwareOnly && main4 && video.areSizeAndRateSupported(WIDTH,HEIGHT,FPS.toDouble()) && caps.colorFormats.contains(MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface) && video.bitrateRange.contains(BITRATE)
                item.put("supports_requested_profile",supported).put("main_level4_or_higher",main4)
                if (supported && selected == null) selected=entry
            } catch (e: Exception) { item.put("error",e.toString()) }
            candidates.put(item)
        }
        probe = JSONObject().put("candidates",candidates).put("requested", JSONObject().put("width",WIDTH).put("height",HEIGHT).put("fps",FPS).put("bitrate",BITRATE).put("profile","Main").put("level","4.0").put("b_frames",0).put("idr_interval_seconds",1))
        val chosen = selected ?: throw IllegalStateException("No hardware encoder satisfies candidate profile: $probe")
        probe.put("selected",chosen.name)
        codec = MediaCodec.createByCodecName(chosen.name)
        try {
            val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC,WIDTH,HEIGHT).apply {
                setInteger(MediaFormat.KEY_COLOR_FORMAT,MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
                setInteger(MediaFormat.KEY_BIT_RATE,BITRATE); setInteger(MediaFormat.KEY_FRAME_RATE,FPS)
                setInteger(MediaFormat.KEY_I_FRAME_INTERVAL,1)
                setInteger(MediaFormat.KEY_PROFILE,MediaCodecInfo.CodecProfileLevel.AVCProfileMain)
                setInteger(MediaFormat.KEY_LEVEL,MediaCodecInfo.CodecProfileLevel.AVCLevel4)
                setInteger(MediaFormat.KEY_MAX_B_FRAMES,0)
                setInteger(MediaFormat.KEY_COLOR_STANDARD,MediaFormat.COLOR_STANDARD_BT709)
                setInteger(MediaFormat.KEY_COLOR_TRANSFER,MediaFormat.COLOR_TRANSFER_SDR_VIDEO)
                setInteger(MediaFormat.KEY_COLOR_RANGE,MediaFormat.COLOR_RANGE_LIMITED)
            }
            codec.configure(format,null,null,MediaCodec.CONFIGURE_FLAG_ENCODE)
            surface=codec.createInputSurface(); codec.start()
        } catch (e: Exception) { codec.release(); throw e }
    }
    private fun inspectConfig(bytes: ByteArray) {
        for (n in AnnexB.nals(bytes)) when (AnnexB.type(n)) {
            7 -> {
                require(n.size>=4); observedSpsProfile=n[1].toInt() and 255; observedSpsLevel=n[3].toInt() and 255
                require(observedSpsProfile==77 && observedSpsLevel==40) { "Actual SPS profile/level rejected: $observedSpsProfile/$observedSpsLevel" }
                sps=n
            }
            8 -> pps=n
        }
    }
    fun drain(waitUs: Long = 0) {
        while (true) {
            val index = codec.dequeueOutputBuffer(info,waitUs)
            if (index == MediaCodec.INFO_TRY_AGAIN_LATER) return
            if (index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                val format=codec.outputFormat; observedFormat=format.toString()
                for (key in listOf("csd-0","csd-1")) format.getByteBuffer(key)?.duplicate()?.let { b -> inspectConfig(ByteArray(b.remaining()).also { b.get(it) }) }
                continue
            }
            if (index<0) continue
            try {
                if (info.size>0) {
                    require(info.size<=MAX_AU)
                    val buffer=checkNotNull(codec.getOutputBuffer(index)).duplicate().apply { position(info.offset); limit(info.offset+info.size) }
                    val bytes=ByteArray(info.size); buffer.get(bytes)
                    if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) {
                        require(partial.size()==0) { "Codec config interleaved in partial frame" }; inspectConfig(bytes)
                    } else {
                        val old=partialPts
                        require(old==null || old==info.presentationTimeUs) { "Partial frame PTS changed" }
                        partialPts=info.presentationTimeUs
                        require(partial.size()+bytes.size<=MAX_AU) { "Access unit exceeds bound" }; partial.write(bytes)
                        if (info.flags and MediaCodec.BUFFER_FLAG_PARTIAL_FRAME == 0) {
                            val nals=AnnexB.nals(partial.toByteArray()); partial.reset(); partialPts=null
                            inspectConfig(AnnexB.join(nals))
                            require(nals.none(AnnexB::isBFrame)) { "B frame forbidden" }
                            require(nals.count { AnnexB.type(it)==9 }<=1) { "Multiple access units in output" }
                            if (nals.any { AnnexB.type(it) in listOf(1,5) }) {
                                val idr=nals.any { AnnexB.type(it)==5 }
                                val output=if (idr) {
                                    val body=nals.filter { AnnexB.type(it) !in listOf(7,8) }
                                    AnnexB.join(listOf(checkNotNull(sps) { "IDR missing SPS" },checkNotNull(pps) { "IDR missing PPS" })+body)
                                } else AnnexB.join(nals)
                                require(output.size<=MAX_AU)
                                onFrame(EncodedFrame(info.presentationTimeUs,output,idr))
                            }
                        }
                    }
                }
                if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) {
                    require(partial.size()==0) { "EOS with partial frame" }; eos=true; return
                }
            } finally { codec.releaseOutputBuffer(index,false) }
        }
    }
    fun signalEos() { codec.signalEndOfInputStream() }
    fun close() { try { codec.stop() } finally { codec.release(); surface.release() } }
    companion object {
        const val WIDTH=1920; const val HEIGHT=1080; const val FPS=30; const val BITRATE=12_000_000
        const val MAX_AU=16*1024*1024
    }
}
