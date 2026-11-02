package open.fpvlabs.stera.ar_recorder.encoding

import open.fpvlabs.stera.ar_recorder.data.h264.AnnexB
import open.fpvlabs.stera.ar_recorder.data.h264.CaptureProtocol
import java.io.ByteArrayOutputStream

/** A defined assembly reject from the shared `fixtures/encoder_buffers.json` contract. */
class H264AssemblyException(val code: String, message: String) : IllegalStateException("$code: $message")

/** One complete Annex B image access unit, ready for one `/camera/rgb/video` message. */
class H264AccessUnit(val ptsUs: Long, val idr: Boolean, val bytes: ByteArray)

/**
 * Pure assembly of MediaCodec-style output buffers into whole access units.
 *
 * It owns no codec and no Android type, so the JVM tests replay the contract fixture through the exact
 * production code. Rules (packages/contracts/capture/README.md, "Encoder buffer sequences"):
 * a CODEC_CONFIG buffer is stored and is never an image; chunks of one frame share a PTS and complete
 * only on a buffer without PARTIAL_FRAME; the stored configuration is prepended verbatim to an IDR
 * access unit that lacks SPS/PPS; end of stream with a pending partial frame is an incomplete access unit.
 */
class H264AccessUnitAssembler(private val maxAccessUnitBytes: Int = CaptureProtocol.MAX_ACCESS_UNIT) {
    private val partial = ByteArrayOutputStream()
    private var partialPts: Long? = null
    var config: ByteArray? = null; private set
    var configBuffers = 0L; private set
    var partialBuffers = 0L; private set
    var accessUnits = 0L; private set
    var endOfStream = false; private set

    /** Returns the completed access unit, or null for configuration/partial/empty buffers. */
    fun accept(flags: Int, ptsUs: Long, data: ByteArray): H264AccessUnit? {
        if (endOfStream) throw H264AssemblyException("E_AFTER_EOS", "Encoder output after end of stream")
        if (flags and CODEC_CONFIG != 0) {
            if (partialPts != null) fail("E_INCOMPLETE_AU", "Codec configuration interrupted a partial frame")
            if (data.isEmpty()) fail("E_MISSING_PARAMETER_SETS", "Empty codec configuration")
            val types = nalTypes(data)
            if (7 !in types || 8 !in types) fail("E_MISSING_PARAMETER_SETS", "Codec configuration lacks SPS or PPS")
            if (types.any { it == 1 || it == 5 }) fail("E_MULTIPLE_ACCESS_UNITS", "Codec configuration carries image slices")
            config = data.copyOf(); configBuffers++
            return null
        }
        val eos = flags and END_OF_STREAM != 0
        if (data.isEmpty()) {
            if (eos) finishStream()
            return null
        }
        if (ptsUs < 0) fail("E_PTS_INVALID", "Negative encoder PTS")
        val pending = partialPts
        if (pending != null && pending != ptsUs) fail("E_PARTIAL_PTS_MISMATCH", "Partial access unit changed PTS")
        if (partial.size().toLong() + data.size > maxAccessUnitBytes) fail("E_AU_TOO_LARGE", "Access unit exceeds the byte bound")
        partial.write(data)
        if (flags and PARTIAL_FRAME != 0) {
            partialPts = ptsUs; partialBuffers++
            if (eos) fail("E_INCOMPLETE_AU", "End of stream inside a partial frame")
            return null
        }
        var unit = partial.toByteArray()
        partial.reset(); partialPts = null
        val types = nalTypes(unit)
        val firstSlice = types.indexOfFirst { it == 1 || it == 5 }
        val result = if (firstSlice < 0) {
            // In-band configuration without the flag is stored like CODEC_CONFIG; it is never an image.
            if (7 !in types || 8 !in types || types.any { it !in setOf(7, 8, 9, 6) }) fail("E_CONFIG_ONLY", "Non-image encoder output")
            config = unit; configBuffers++
            null
        } else {
            if (5 in types) {
                val before = types.subList(0, firstSlice)
                if (7 !in before || 8 !in before) {
                    val stored = config ?: fail("E_MISSING_PARAMETER_SETS", "IDR without SPS/PPS and no stored codec configuration")
                    if (stored.size.toLong() + unit.size > maxAccessUnitBytes) fail("E_AU_TOO_LARGE", "Access unit exceeds the byte bound")
                    unit = stored + unit
                }
            }
            val idr = classify(unit)
            accessUnits++
            H264AccessUnit(ptsUs, idr, unit)
        }
        if (eos) finishStream()
        return result
    }

    private fun finishStream() {
        if (partialPts != null || partial.size() > 0) fail("E_INCOMPLETE_AU", "End of stream inside a partial frame")
        endOfStream = true
    }

    private fun classify(unit: ByteArray): Boolean = try {
        AnnexB.validateAccessUnit(unit)
    } catch (error: IllegalArgumentException) {
        val message = error.message.orEmpty()
        val code = when {
            "Multiple access units" in message || "Exactly one first slice" in message -> "E_MULTIPLE_ACCESS_UNITS"
            "SPS and PPS" in message -> "E_MISSING_PARAMETER_SETS"
            "B frames" in message -> "E_B_FRAME"
            "byte bound" in message -> "E_AU_TOO_LARGE"
            else -> "E_MALFORMED_AU"
        }
        fail(code, message)
    }

    private fun nalTypes(data: ByteArray): List<Int> = try {
        require(data.size >= 4 && data[0] == 0.toByte() && data[1] == 0.toByte()) { "Annex B start code required" }
        AnnexB.nals(data).map(AnnexB::type)
    } catch (error: IllegalArgumentException) {
        fail("E_MALFORMED_AU", error.message ?: "Malformed Annex B output")
    }

    private fun fail(code: String, message: String): Nothing = throw H264AssemblyException(code, message)

    companion object {
        const val KEY_FRAME = 1
        const val CODEC_CONFIG = 2
        const val END_OF_STREAM = 4
        const val PARTIAL_FRAME = 8
    }
}
