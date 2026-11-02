package open.fpvlabs.stera.ar_recorder.encoding

import open.fpvlabs.stera.ar_recorder.data.h264.AnnexB
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.ByteArrayOutputStream
import java.io.File
import java.security.MessageDigest

/** Replays the shared `fixtures/encoder_buffers.json` contract through the production assembler. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [33])
class H264AccessUnitAssemblerContractTest {
    private val start = byteArrayOf(0, 0, 0, 1)

    private fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    private fun data(buffer: JSONObject, sources: Map<String, List<ByteArray>>): ByteArray {
        val range = buffer.optJSONArray("nals") ?: return ByteArray(0)
        val out = ByteArrayOutputStream()
        for (nal in sources.getValue(buffer.getString("source")).subList(range.getInt(0), range.getInt(1))) { out.write(start); out.write(nal) }
        var bytes = out.toByteArray()
        buffer.optJSONArray("bytes")?.let { bytes = bytes.copyOfRange(it.getInt(0), it.getInt(1)) }
        return bytes
    }

    private fun replay(buffers: JSONArray, sources: Map<String, List<ByteArray>>): Map<String, Any> {
        val assembler = H264AccessUnitAssembler()
        val units = mutableListOf<Map<String, Any>>()
        try {
            for (i in 0 until buffers.length()) {
                val buffer = buffers.getJSONObject(i)
                val pts = buffer.getString("pts_us").let { text ->
                    if (!Regex("0|[1-9][0-9]*").matches(text)) throw H264AssemblyException("E_PTS_INVALID", "non-integer fixture PTS $text")
                    text.toLong()
                }
                assembler.accept(buffer.getInt("flags"), pts, data(buffer, sources))?.let {
                    units.add(mapOf("pts_us" to it.ptsUs.toString(), "idr" to it.idr, "bytes" to it.bytes.size, "sha256" to sha256(it.bytes)))
                }
            }
            if (!assembler.endOfStream) assembler.accept(H264AccessUnitAssembler.END_OF_STREAM, 0, ByteArray(0))
        } catch (error: H264AssemblyException) {
            return mapOf("outcome" to "reject", "errors" to listOf(error.code), "aus" to emptyList<Any>())
        }
        return mapOf("outcome" to "accept", "errors" to emptyList<String>(), "aus" to units)
    }

    private fun expected(expect: JSONObject): Map<String, Any> = mapOf(
        "outcome" to expect.getString("outcome"),
        "errors" to (0 until expect.getJSONArray("errors").length()).map { expect.getJSONArray("errors").getString(it) },
        "aus" to (0 until expect.getJSONArray("aus").length()).map { i ->
            val au = expect.getJSONArray("aus").getJSONObject(i)
            mapOf("pts_us" to au.getString("pts_us"), "idr" to au.getBoolean("idr"), "bytes" to au.getInt("bytes"), "sha256" to au.getString("sha256"))
        })

    @Test fun everyContractBufferSequenceAssemblesToTheDeclaredAccessUnitsOrReject() {
        val dir = ContractFixtures.captureDir
        val fixture = JSONObject(File(dir, "fixtures/encoder_buffers.json").readText())
        val sourceNames = fixture.getJSONObject("sources")
        val sources = sourceNames.keys().asSequence().associateWith { AnnexB.nals(File(dir, sourceNames.getString(it)).readBytes()) }
        val cases = fixture.getJSONObject("cases")
        var count = 0
        for (name in cases.keys()) {
            val case = cases.getJSONObject(name)
            assertEquals("encoder buffers $name", expected(case.getJSONObject("expect")), replay(case.getJSONArray("buffers"), sources))
            count++
        }
        assertTrue("fixture shrank", count >= 9)
    }

    @Test fun boundsAndOrderingAreEnforcedBeyondTheFixture() {
        val sources = AnnexB.nals(File(ContractFixtures.captureDir, "golden/source/baseline-5.h264").readBytes())
        fun join(from: Int, to: Int) = ByteArrayOutputStream().apply { for (n in sources.subList(from, to)) { write(start); write(n) } }.toByteArray()
        val small = H264AccessUnitAssembler(maxAccessUnitBytes = 64)
        small.accept(H264AccessUnitAssembler.CODEC_CONFIG, 0, join(0, 2))
        assertEquals("E_AU_TOO_LARGE", assertThrows(H264AssemblyException::class.java) { small.accept(1, 0, join(2, 4)) }.code)
        val ended = H264AccessUnitAssembler()
        ended.accept(H264AccessUnitAssembler.END_OF_STREAM, 0, ByteArray(0))
        assertEquals("E_AFTER_EOS", assertThrows(H264AssemblyException::class.java) { ended.accept(0, 1, join(4, 5)) }.code)
        val config = H264AccessUnitAssembler()
        assertEquals("E_MISSING_PARAMETER_SETS", assertThrows(H264AssemblyException::class.java) { config.accept(H264AccessUnitAssembler.CODEC_CONFIG, 0, join(0, 1)) }.code)
    }
}
