import open.fpvlabs.stera.ar_recorder.data.h264.AnnexB
import open.fpvlabs.stera.ar_recorder.data.h264.CaptureProtocol
import open.fpvlabs.stera.ar_recorder.data.h264.H264FrameLedger
import open.fpvlabs.stera.ar_recorder.data.h264.VideoWire
import org.json.JSONObject
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

/**
 * Replays the shared golden MCAP files through the PRODUCTION Android protocol classes (AnnexB, H264FrameLedger,
 * VideoWire). Scope: only the rules those classes enforce today are claimed as native. Every other rule is
 * covered by the portable ContractReader (language conformance) and is reported here as portable-only, never
 * as natively enforced. The recorder does not yet wire these classes (SA-51).
 *
 * Written events go through the real H264FrameLedger.writtenEvent path; the event it produces must equal the
 * golden event, and a divergence is a native rejection. Rejections must carry the expected exception type and
 * message for their declared code: any other exception fails the test.
 */
class NativeProtocolReplayTest {
    private val dir = File(System.getProperty("capture.dir"))
    private val cases = JSONObject(File(dir, "golden/cases.json").readText())

    private class Mcap(val profile: String, val messages: List<Triple<String, Int, ByteArray>>)

    private fun read(bytes: ByteArray): Mcap {
        val b = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        b.position(8)
        var profile = ""
        val topics = HashMap<Int, String>()
        val msgs = ArrayList<Triple<String, Int, ByteArray>>()
        fun str(): String { val n = b.int; return ByteArray(n).also { b.get(it) }.decodeToString() }
        while (true) {
            val op = b.get().toInt(); val len = b.long.toInt(); val end = b.position() + len
            when (op) {
                1 -> profile = str()
                4 -> { val id = b.short.toInt(); b.short; topics[id] = str() }
                5 -> { val ch = b.short.toInt() and 0xffff; val seq = b.int; b.long; b.long
                    msgs.add(Triple(topics.getValue(ch), seq, ByteArray(end - b.position()).also { b.get(it) })) }
                2 -> return Mcap(profile, msgs)
            }
            b.position(end)
        }
    }

    private fun video(data: ByteArray): Triple<Long, String, ByteArray> {
        val v = ContractReader.decodeVideo(data)
        return Triple(v.sec * 1_000_000_000L + v.nanos, v.frameId, v.data)
    }

    private fun jsonMap(o: JSONObject): Map<String, Any?> = o.keySet().associateWith { k ->
        when (val v = o.get(k)) {
            JSONObject.NULL -> null
            is JSONObject -> jsonMap(v)
            else -> v
        }
    }

    /** Rules the production classes enforce today: case -> (declared code, expected exception class, message). */
    private data class Native(val code: String, val type: Class<out Throwable>, val message: Regex)

    private val nativeRejects = mapOf(
        "config_only" to Native("E_CONFIG_ONLY", IllegalArgumentException::class.java, Regex("Codec configuration is not a video frame")),
        "multiple_access_units" to Native("E_MULTIPLE_ACCESS_UNITS", IllegalArgumentException::class.java, Regex("Exactly one first slice|Multiple access units")),
        "missing_config" to Native("E_MISSING_PARAMETER_SETS", IllegalArgumentException::class.java, Regex("IDR must include SPS and PPS")),
        "b_frame" to Native("E_B_FRAME", IllegalArgumentException::class.java, Regex("B frames forbidden")),
        "duplicate_pts" to Native("E_DUPLICATE_PTS", IllegalArgumentException::class.java, Regex("Duplicate/nonmonotonic encoder PTS")),
        "pts_not_integer" to Native("E_SCHEMA_MALFORMED", IllegalArgumentException::class.java, Regex("Invalid encoder_pts_us")),
        "time_base_mismatch" to Native("E_SCHEMA_MALFORMED", IllegalArgumentException::class.java, Regex("time base is not 1/1000000")),
        "written_pts_mismatch" to Native("E_FRAME_IDENTITY", IllegalArgumentException::class.java, Regex("Written PTS differs")),
        "written_capture_time_mismatch" to Native("E_FRAME_IDENTITY", IllegalArgumentException::class.java, Regex("Written capture time differs")),
        "written_calibration_mismatch" to Native("E_FRAME_IDENTITY", IllegalStateException::class.java, Regex("native written event differs from the file")),
        "dropped_identity_mismatch" to Native("E_FRAME_IDENTITY", IllegalArgumentException::class.java, Regex("Changed frame identity: native_clock_id")),
    )

    /** Replay one golden through the production classes; returns ledger stats when everything is accepted. */
    private fun replay(name: String): Map<String, Any> {
        val m = read(File(dir, "golden/$name.mcap").readBytes())
        assertEquals("", m.profile, name)
        val ledger = H264FrameLedger("0b6f5e1c-3d2a-4c8e-9f1a-5e2d7c4b3a19")
        for (v in m.messages.filter { it.first == "/camera/rgb/video" }) {
            val (ns, frame, au) = video(v.third)
            assertEquals("camera_optical_frame", frame)
            AnnexB.validateAccessUnit(au)
            // Kotlin's native serializer must reproduce the golden Protobuf bytes exactly.
            assertContentEquals(v.third, VideoWire.compressedVideo(ns, au), "$name seq ${v.second}")
        }
        for (msg in m.messages.filter { it.first == "/stateaction/frame_events" }) {
            val e = JSONObject(msg.third.decodeToString())
            val map = jsonMap(e)
            when (e.getString("state")) {
                "acquired", "submitted", "dropped" -> ledger.acceptEvent(map)
                "written" -> {
                    val id = e.getString("source_frame_id").toLong()
                    val pts = e.getString("encoder_pts_us").toLong()
                    // Real native path: the ledger builds the written event; it must match the file.
                    val produced = ledger.writtenEvent(id, e.getString("mapped_capture_time_ns").toLong(), pts, e.getInt("output_sequence"), e.getBoolean("is_idr"))
                    check(produced == map) { "native written event differs from the file" }
                    ledger.acceptWritten(id, pts)
                }
            }
        }
        return ledger.stats()
    }

    @Test
    fun goldenCasesMatchNativeProtocolOutcomes() {
        var accepted = 0
        var rejected = 0
        val portableOnly = ArrayList<String>()
        for (name in cases.keys().asSequence().toList().sorted()) {
            val entry = cases.getJSONObject(name)
            val declaredCodes = entry.getJSONArray("expected_errors").toList().map { it.toString() }
            if (entry.getString("expect") == "accept") {
                val stats = replay(name)
                val facts = JSONObject(File(dir, "golden/expected/$name.json").readText()).getJSONObject("facts")
                val counts = facts.getJSONObject("frame_event_counts")
                assertEquals(counts.getInt("acquired").toLong(), stats["acquired"], name)
                assertEquals(counts.getInt("submitted").toLong(), stats["submitted"], name)
                assertEquals(counts.getInt("written").toLong(), stats["written"], name)
                assertEquals(counts.getInt("dropped").toLong(), stats["dropped"], name)
                assertEquals(facts.getInt("unresolved_frames"), stats["unresolved"], name)
                accepted++
                continue
            }
            val native = nativeRejects[name]
            if (native == null) { portableOnly.add(name); continue }
            assertTrue(native.code in declaredCodes, "$name declares ${native.code}")
            val failure = runCatching { replay(name) }.exceptionOrNull() ?: error("$name must be rejected by the native protocol")
            assertEquals(native.type, failure.javaClass, "$name exception type: ${failure.message}")
            assertTrue(native.message.containsMatchIn(failure.message ?: ""), "$name native message '${failure.message}' must match ${native.message}")
            rejected++
        }
        // Not natively enforced yet (SA-51+); proven by the portable reader only, never claimed here.
        println("kotlin-native accepted=$accepted rejected=$rejected portable_only=${portableOnly.size}")
        assertEquals(nativeRejects.size, rejected)
        assertTrue(accepted >= 5)
    }

    @Test
    fun nativeProfileBuilderOutputSatisfiesStrictProfileSchema() {
        // The production CaptureProtocol.profile() serialization must pass the strict contract schema, for the
        // device profile and the simulation profile. It does not itself enforce UUID recording IDs (SA-51 gap):
        // the schema is what rejects a textual recording ID.
        ContractReader.captureDir = dir
        val schema = ContractReader.contractSchema("stateaction.capture.Profile.v1")
        val uuid = "0b6f5e1c-3d2a-4c8e-9f1a-5e2d7c4b3a19"
        fun violations(input: Map<String, Any?>) =
            schema.validate(StrictJson.parse(CaptureProtocol.json(CaptureProtocol.profile(input)).toByteArray()))
        assertEquals(emptyList(), violations(mapOf("recording_id" to uuid)))
        assertEquals(emptyList(), violations(mapOf("recording_id" to uuid, "rgb_profile" to CaptureProtocol.EMULATOR_PROFILE,
            "qualification" to "simulation_only", "mapped_timeline_semantics" to "simulation_transport_only")))
        assertEquals(listOf("/recording_id:pattern"), violations(mapOf("recording_id" to "golden-fixture")))
        assertEquals(listOf(":additionalProperties"), violations(mapOf("recording_id" to uuid, "camera_id" to "0")))
        println("kotlin-native-profile strict-schema checks=4")
    }

    @Test
    fun descriptorHashMatchesManifest() {
        val manifest = JSONObject(File(dir, "manifest.json").readText()).getJSONObject("files")
        val sha = MessageDigest.getInstance("SHA-256").digest(File(dir, "foxglove-compressed-video.desc").readBytes()).joinToString("") { "%02x".format(it) }
        assertEquals(manifest.getString("foxglove-compressed-video.desc"), sha)
        assertEquals(CaptureProtocol.VIDEO, "/camera/rgb/video")
    }
}
