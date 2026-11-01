import org.json.JSONObject
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Contract-language conformance: the portable Kotlin reader (ContractReader) must reproduce the canonical
 * golden result of every case, the declared outcome/error codes, and every encoder-buffer expectation.
 * This does not exercise the native recorder classes; see NativeProtocolReplayTest for that boundary.
 */
class ContractReaderTest {
    private val dir = File(System.getProperty("capture.dir"))
    private val declared = JSONObject(File(dir, "golden/cases.json").readText())
    private val manifest: Map<String, String> = JSONObject(File(dir, "manifest.json").readText()).getJSONObject("files").let { files ->
        files.keySet().associateWith { files.getString(it) }
    }

    @Test
    fun portableReaderReproducesEveryGoldenAndDeclaredRejection() {
        val onDisk = File(dir, "golden").listFiles { f -> f.name.endsWith(".mcap") }!!.map { it.name.removeSuffix(".mcap") }.sorted()
        assertEquals(declared.keySet().sorted(), onDisk, "golden/*.mcap and cases.json must agree")
        for (name in onDisk) {
            val result = ContractReader.check(File(dir, "golden/$name.mcap").readBytes(), manifest)
            assertEquals(File(dir, "golden/expected/$name.json").readText(), ContractReader.canonical(result) + "\n", "canonical result $name")
            val want = declared.getJSONObject(name)
            assertEquals(want.getString("expect"), result["outcome"], "declared outcome $name")
            assertEquals(want.getJSONArray("expected_errors").toList(), result["errors"], "declared error codes $name")
        }
        println("kotlin-contract-reader cases=${onDisk.size}")
        assertTrue(onDisk.size >= 40)
    }

    @Test
    fun encoderBufferSequencesAssembleToDeclaredAccessUnits() {
        val fixture = ContractReader.conv(JSONObject(File(dir, "fixtures/encoder_buffers.json").readText())) as Map<*, *>
        val sources = (fixture["sources"] as Map<*, *>).entries.associate { (k, v) ->
            k as String to checkNotNull(ContractReader.nals(File(dir, v as String).readBytes()))
        }
        val cases = fixture["cases"] as Map<*, *>
        for ((name, raw) in cases) {
            val case = raw as Map<*, *>
            @Suppress("UNCHECKED_CAST")
            val got = ContractReader.assembleEncoderBuffers(case["buffers"] as List<Map<String, Any?>>, sources)
            assertEquals(ContractReader.canonical(case["expect"]), ContractReader.canonical(got), "encoder buffers $name")
        }
        println("kotlin-encoder-buffers cases=${cases.size}")
        assertTrue(cases.size >= 9)
    }
}
