package open.fpvlabs.stera.ar_recorder.data.h264

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer

/** Minimal protobuf wire encoder for the pinned foxglove.CompressedVideo descriptor. */
object VideoWire {
    private fun varint(out: ByteArrayOutputStream, value: Long) {
        var v = value
        while (v and -128L != 0L) { out.write(((v and 127) or 128).toInt()); v = v ushr 7 }
        out.write(v.toInt())
    }
    private fun field(out: ByteArrayOutputStream, number: Int, bytes: ByteArray) {
        varint(out, ((number shl 3) or 2).toLong()); varint(out, bytes.size.toLong()); out.write(bytes)
    }
    fun compressedVideo(epochNs: Long, bytes: ByteArray, frameId: String = "camera_optical_frame"): ByteArray {
        require(epochNs > 0)
        val stamp = ByteArrayOutputStream()
        stamp.write(8); varint(stamp, epochNs / 1_000_000_000L)
        stamp.write(16); varint(stamp, epochNs % 1_000_000_000L)
        return ByteArrayOutputStream().apply {
            field(this, 1, stamp.toByteArray())
            field(this, 2, frameId.toByteArray())
            field(this, 3, bytes)
            field(this, 4, "h264".toByteArray())
        }.toByteArray()
    }
}

object AnnexB {
    private val start = byteArrayOf(0, 0, 0, 1)
    fun nals(bytes: ByteArray): List<ByteArray> {
        val starts = mutableListOf<Pair<Int, Int>>()
        var i = 0
        while (i + 2 < bytes.size) {
            val n = if (bytes[i] == 0.toByte() && bytes[i + 1] == 0.toByte()) {
                if (bytes[i + 2] == 1.toByte()) 3
                else if (i + 3 < bytes.size && bytes[i + 2] == 0.toByte() && bytes[i + 3] == 1.toByte()) 4 else 0
            } else 0
            if (n != 0) { starts.add(i to n); i += n } else i++
        }
        if (starts.isEmpty()) {
            val result = mutableListOf<ByteArray>()
            val b = ByteBuffer.wrap(bytes)
            while (b.hasRemaining()) {
                require(b.remaining() >= 4) { "Incomplete AVCC length" }
                val size = b.int
                require(size > 0 && size <= b.remaining()) { "Invalid AVC length" }
                result.add(ByteArray(size).also { b.get(it) })
            }
            return result
        }
        require(starts.first().first == 0) { "Junk before Annex B packet" }
        return starts.mapIndexed { at, pair ->
            val end = if (at + 1 < starts.size) starts[at + 1].first else bytes.size
            require(end > pair.first + pair.second) { "Empty NAL" }
            bytes.copyOfRange(pair.first + pair.second, end)
        }
    }
    fun join(nals: List<ByteArray>): ByteArray = ByteArrayOutputStream().apply {
        for (nal in nals) { write(start); write(nal) }
    }.toByteArray()
    fun type(nal: ByteArray) = nal.first().toInt() and 31
    /** The encoder assembles partial callbacks; the writer accepts only complete Annex-B image AUs. */
    fun validateAccessUnit(bytes: ByteArray): Boolean {
        require(bytes.size in 1..CaptureProtocol.MAX_ACCESS_UNIT) { "Access unit exceeds byte bound" }
        require(bytes.size >= 4 && bytes[0] == 0.toByte() && bytes[1] == 0.toByte() &&
            (bytes[2] == 1.toByte() || (bytes[2] == 0.toByte() && bytes[3] == 1.toByte()))) { "Annex B access unit required" }
        val nals = nals(bytes)
        require(nals.size <= 4096) { "Access-unit NAL count bound exhausted" }
        require(nals.count { type(it) == 9 } <= 1) { "Multiple access units in video message" }
        val slices = nals.filter { type(it) in listOf(1, 5) }
        require(slices.isNotEmpty()) { "Codec configuration is not a video frame" }
        require(slices.count { sliceHeader(it).first == 0 } == 1) { "Exactly one first slice is required per image access unit" }
        require(slices.none { isBFrame(it) }) { "B frames forbidden" }
        require(slices.map { type(it) }.distinct().size == 1) { "Mixed IDR and predicted slices" }
        val idr = slices.any { type(it) == 5 }
        if (idr) {
            val beforeImage = nals.takeWhile { type(it) !in listOf(1, 5) }
            require(beforeImage.any { type(it) == 7 } && beforeImage.any { type(it) == 8 }) { "IDR must include SPS and PPS before its image slices" }
        }
        return idr
    }
    fun isBFrame(nal: ByteArray): Boolean {
        if (type(nal) !in listOf(1, 5)) return false
        return sliceHeader(nal).second % 5 == 1
    }
    private fun sliceHeader(nal: ByteArray): Pair<Int, Int> {
        // Two bounded Exp-Golomb values need at most 118 bits. Never copy the pixel slice
        // or box every byte merely to inspect its first_mb_in_slice and slice_type.
        val data = ByteArray(16)
        var count = 0
        var zeros = 0
        var index = 1
        while (index < nal.size && count < data.size) {
            val b = nal[index++].toInt() and 255
            if (zeros >= 2 && b == 3) { zeros = 0; continue }
            data[count++] = b.toByte(); zeros = if (b == 0) zeros + 1 else 0
        }
        var bit = 0
        fun readBit(): Int {
            require(bit < count * 8) { "Truncated slice header" }
            val v = (data[bit / 8].toInt() ushr (7 - bit % 8)) and 1; bit++; return v
        }
        fun ue(): Int {
            var count = 0
            while (readBit() == 0) { count++; require(count < 30) }
            var suffix = 0
            repeat(count) { suffix = (suffix shl 1) or readBit() }
            return ((1 shl count) - 1) + suffix
        }
        val firstMb = ue()
        val sliceType = ue()
        require(sliceType <= 9) { "Invalid AVC slice type" }
        return firstMb to sliceType
    }
}

/** Original ns stay in evidence; encoder only accepts integer microseconds. */
class FramePts {
    private var previous = -1L
    fun allocate(captureNs: Long, originNs: Long): Long {
        require(captureNs >= originNs)
        val candidate = (captureNs - originNs) / 1000L
        val pts = maxOf(previous + 1, candidate)
        previous = pts
        return pts
    }
}
