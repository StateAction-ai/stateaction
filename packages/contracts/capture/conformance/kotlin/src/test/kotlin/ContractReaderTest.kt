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

    // ---------------------------------------------------------------- stateaction.capture.v1.2 (SA-68)
    @Test
    fun v12GoldenCorpusReproducesCanonicalResultsAndFrozenReaderVerdicts() {
        val v12 = File(dir, "golden/v1.2")
        val declared12 = JSONObject(File(v12, "cases.json").readText())
        val onDisk = v12.listFiles { f -> f.name.endsWith(".mcap") }!!.map { it.name.removeSuffix(".mcap") }.sorted()
        assertEquals(declared12.keySet().sorted(), onDisk, "golden/v1.2/*.mcap and cases.json must agree")
        var accepted = 0
        for (name in onDisk) {
            val bytes = File(v12, "$name.mcap").readBytes()
            val want = declared12.getJSONObject(name)
            assertEquals(want.getString("sha256"), ContractReader.sha256(bytes), "golden drift $name")
            val result = ContractReader.check(bytes)
            assertEquals(File(v12, "expected/$name.json").readText(), ContractReader.canonical(result) + "\n", "canonical result $name")
            assertEquals(want.getString("expect"), result["outcome"], "declared outcome $name")
            assertEquals(want.getJSONArray("expected_errors").toList(), result["errors"], "declared error codes $name")
            @Suppress("UNCHECKED_CAST")
            val violations = ((result["facts"] as Map<String, Any?>)["schema_violations"] as List<String>?) ?: emptyList()
            val declaredViolations = want.optJSONArray("expected_violations")?.toList()?.map { it.toString() } ?: emptyList()
            assertEquals(declaredViolations, violations.map { it.replaceFirst(Regex("\\[[0-9]+\\]"), "") }.sorted(), "declared violations $name")
            // max_revision=v1.1 is the frozen reader path: every v1.2 file rejects with the declared verdict.
            val old = ContractReader.check(bytes, maxRevision = "v1.1")
            val oldWant = want.getJSONObject("v1_1_reader")
            assertEquals(oldWant.getString("outcome"), old["outcome"], "v1.1 reader outcome $name")
            assertEquals(oldWant.getJSONArray("errors").toList(), old["errors"], "v1.1 reader errors $name")
            if (result["outcome"] == "accept") accepted++
        }
        println("kotlin-contract-reader-v1.2 cases=${onDisk.size} accepted=$accepted")
        assertEquals(106, onDisk.size)
        assertTrue(accepted > 0)
    }

    @Test
    fun v12MaxRevisionV11ReproducesEveryFrozenGolden() {
        val declared = JSONObject(File(dir, "golden/cases.json").readText())
        val names = File(dir, "golden").listFiles { f -> f.name.endsWith(".mcap") }!!.map { it.name.removeSuffix(".mcap") }.sorted()
        assertEquals(84, names.size)
        for (name in names) {
            val bytes = File(dir, "golden/$name.mcap").readBytes()
            // The default (v1.2-capable) reader and the max_revision=v1.1 reader both reproduce the frozen bytes.
            val a = ContractReader.canonical(ContractReader.check(bytes)) + "\n"
            val b = ContractReader.canonical(ContractReader.check(bytes, maxRevision = "v1.1")) + "\n"
            val expected = File(dir, "golden/expected/$name.json").readText()
            assertEquals(expected, a, "default reader $name")
            assertEquals(expected, b, "max_revision v1.1 reader $name")
            assertEquals(declared.getJSONObject(name).getString("expect"), JSONObject(expected).getString("outcome"))
        }
    }

    @Test
    fun v12StrictSchemaCases() {
        val fixture = StrictJson.parse(File(dir, "fixtures/schema_cases.v1.2.json").readBytes()) as Map<*, *>
        val cases = fixture["cases"] as List<*>
        for (raw in cases) {
            val c = raw as Map<*, *>
            val got: Any = try {
                ContractReader.contractSchema(c["schema"] as String).validate(StrictJson.parse((c["json"] as String).toByteArray(Charsets.UTF_8)))
            } catch (e: StrictJson.MalformedJson) {
                "malformed"
            }
            assertEquals(ContractReader.canonical(c["expect"]), ContractReader.canonical(got), "v1.2 schema case ${c["name"]}")
        }
        println("kotlin-strict-schema-v1.2 cases=${cases.size}")
        assertEquals(59, cases.size)
    }

    private fun varint(v: Long): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        var x = v
        while (x >= 0x80) { out.write(((x and 0x7f) or 0x80).toInt()); x = x ushr 7 }
        out.write(x.toInt())
        return out.toByteArray()
    }

    private fun field(n: Int, payload: ByteArray) = varint((n.toLong() shl 3) or 2) + varint(payload.size.toLong()) + payload
    private fun fixed32(v: Long) = byteArrayOf(v.toByte(), (v shr 8).toByte(), (v shr 16).toByte(), (v shr 24).toByte())

    /** Same recipe as gen_golden_v12.build_raw (fields in canonical order, timestamp 1800000000 s + 7 ns). */
    private fun buildRaw(r: Map<*, *>): ByteArray {
        val frameId = if (r.containsKey("frame_id_len")) "x".repeat((r["frame_id_len"] as Number).toInt()) else "depth_optical_frame"
        val stamp = byteArrayOf(0x08) + varint(1_800_000_000L) + byteArrayOf(0x10) + varint(7)
        val data = ByteArray((r["data_len"] as Number).toInt()) { (r["fill"] as Number).toInt().toByte() }
        return field(1, stamp) + byteArrayOf(0x15) + fixed32((r["width"] as Number).toLong()) +
            byteArrayOf(0x1d) + fixed32((r["height"] as Number).toLong()) + field(4, (r["encoding"] as String).toByteArray()) +
            byteArrayOf(0x2d) + fixed32((r["step"] as Number).toLong()) + field(6, data) + field(7, frameId.toByteArray())
    }

    @Test
    fun v12RawImageCasesIncludingCaps() {
        val fixture = StrictJson.parse(File(dir, "fixtures/raw_image_cases.v1.2.json").readBytes()) as Map<*, *>
        val cases = fixture["cases"] as List<*>
        var ok = 0
        for (raw in cases) {
            val c = raw as Map<*, *>
            val bytes = if (c.containsKey("hex")) (c["hex"] as String).chunked(2).map { it.toInt(16).toByte() }.toByteArray() else buildRaw(c["build"] as Map<*, *>)
            val verdict = try { ContractReader.decodeRawImage(bytes); "ok" } catch (e: ContractReader.Malformed) { "malformed" }
            assertEquals(c["expect"], verdict, "raw image case ${c["name"]}")
            if (verdict == "ok") ok++
        }
        println("kotlin-raw-image cases=${cases.size} ok=$ok")
        assertEquals(27, cases.size)
    }
}
