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
            // Declared schema violations (without message index) must match exactly.
            @Suppress("UNCHECKED_CAST")
            val violations = ((result["facts"] as Map<String, Any?>)["schema_violations"] as List<String>?) ?: emptyList()
            val declaredViolations = want.optJSONArray("expected_violations")?.toList()?.map { it.toString() } ?: emptyList()
            assertEquals(declaredViolations, violations.map { it.replaceFirst(Regex("\\[[0-9]+\\]"), "") }.sorted(), "declared violations $name")
        }
        println("kotlin-contract-reader cases=${onDisk.size}")
        assertTrue(onDisk.size >= 70)
    }

    @Test
    fun strictSchemaCasesAndFailClosedLoading() {
        val fixture = StrictJson.parse(File(dir, "fixtures/schema_cases.json").readBytes()) as Map<*, *>
        val cases = fixture["cases"] as List<*>
        for (raw in cases) {
            val c = raw as Map<*, *>
            val text = c["json"] as String
            val bytes = if (text == "__INVALID_UTF8__") byteArrayOf(0xff.toByte(), 0xfe.toByte()) else text.toByteArray(Charsets.UTF_8)
            val got: Any = try {
                ContractReader.contractSchema("stateaction.capture.${c["schema"]}.v1").validate(StrictJson.parse(bytes))
            } catch (e: StrictJson.MalformedJson) {
                "malformed"
            }
            assertEquals(ContractReader.canonical(c["expect"]), ContractReader.canonical(got), "schema case ${c["name"]}")
        }
        val unsupported = fixture["unsupported_schemas"] as List<*>
        for (raw in unsupported) {
            val u = raw as Map<*, *>
            @Suppress("UNCHECKED_CAST")
            val failure = runCatching { StrictSchema(u["schema"] as Map<String, Any?>) }.exceptionOrNull()
            assertTrue(failure is SchemaUnsupported, "unsupported schema ${u["name"]} must fail closed, got $failure")
        }
        println("kotlin-strict-schema cases=${cases.size} unsupported=${unsupported.size}")
        assertTrue(cases.size >= 30)
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
