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
 * Replays the shared golden MCAP files through the production Kotlin protocol classes.
 * Native scope: Annex B access-unit validation, foxglove.CompressedVideo Protobuf bytes, source-ID/PTS ledger.
 * Descriptor/clock/tracking/calibration/close/profile/truncation rules are covered by the Python/TypeScript/Dart
 * runners; the Kotlin native writer does not implement those checks yet (SA-51+), so they are listed in NOT_NATIVE.
 */
class GoldenConformanceTest {
    private val dir = File(System.getProperty("capture.dir"))
    private val cases = JSONObject(File(dir, "golden/cases.json").readText())

    private class Mcap(val profile: String, val topics: Map<Int, String>, val messages: List<Triple<String, Int, ByteArray>>)

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
                2 -> return Mcap(profile, topics, msgs)
            }
            b.position(end)
        }
    }

    private fun video(data: ByteArray): Triple<Long, String, ByteArray> {
        var pos = 0; var captureNs = 0L; var data3 = ByteArray(0); var frame = ""
        fun varint(): Long { var s = 0; var v = 0L; while (true) { val x = data[pos++].toInt() and 255; v = v or ((x and 127).toLong() shl s); if (x < 128) return v; s += 7 } }
        while (pos < data.size) {
            val key = varint().toInt(); val n = varint().toInt(); val chunk = data.copyOfRange(pos, pos + n); pos += n
            when (key shr 3) {
                1 -> { var p = 0; var sec = 0L; var nanos = 0L
                    fun vi(): Long { var s = 0; var v = 0L; while (true) { val x = chunk[p++].toInt() and 255; v = v or ((x and 127).toLong() shl s); if (x < 128) return v; s += 7 } }
                    while (p < chunk.size) { val k = vi().toInt(); val v = vi(); if (k shr 3 == 1) sec = v else nanos = v }
                    captureNs = sec * 1_000_000_000L + nanos }
                2 -> frame = chunk.decodeToString()
                3 -> data3 = chunk
            }
        }
        return Triple(captureNs, frame, data3)
    }

    private fun events(m: Mcap) = m.messages.filter { it.first == "/stateaction/frame_events" }.map { JSONObject(it.third.decodeToString()) }

    private fun jsonMap(o: JSONObject): Map<String, Any?> = o.keySet().associateWith { k ->
        when (val v = o.get(k)) {
            JSONObject.NULL -> null
            is JSONObject -> jsonMap(v)
            is Int -> v
            else -> v
        }
    }

    private val notNative = setOf("descriptor_hash", "ros2_profile", "unequal_clock", "tracking_loss", "calibration_reset",
        "close_count_mismatch", "truncated_mid_record", "truncated_before_footer", "legacy_jpeg")

    @Test
    fun goldenCasesMatchNativeProtocolOutcomes() {
        var checked = 0
        for (name in cases.keySet().sorted()) {
            if (name in notNative) continue
            val m = read(File(dir, "golden/$name.mcap").readBytes())
            assertEquals("", m.profile, name)
            val accept = cases.getJSONObject(name).getString("expect") == "accept"
            val videos = m.messages.filter { it.first == "/camera/rgb/video" }
            val outcome = runCatching {
                val ledger = H264FrameLedger("golden-fixture")
                for (v in videos) {
                    val (ns, frame, au) = video(v.third)
                    assertEquals("camera_optical_frame", frame)
                    AnnexB.validateAccessUnit(au)
                    // Kotlin's native serializer must reproduce the golden Protobuf bytes exactly.
                    assertContentEquals(v.third, VideoWire.compressedVideo(ns, au), "$name seq ${v.second}")
                }
                for (e in events(m)) {
                    val map = jsonMap(e)
                    when (e.getString("state")) {
                        "acquired", "submitted", "dropped" -> ledger.acceptEvent(map)
                        "written" -> ledger.acceptWritten(e.getString("source_frame_id").toLong(), e.getString("encoder_pts_us").toLong())
                    }
                }
                ledger.stats()
            }
            if (accept) {
                val stats = outcome.getOrThrow()
                val expected = JSONObject(File(dir, "golden/expected/$name.json").readText()).getJSONObject("facts").getJSONObject("frame_event_counts")
                assertEquals(expected.getInt("acquired").toLong(), stats["acquired"], name)
                assertEquals(expected.getInt("written").toLong(), stats["written"], name)
                assertEquals(expected.getInt("dropped").toLong(), stats["dropped"], name)
            } else {
                assertTrue(outcome.isFailure, "$name must be rejected by the Kotlin native protocol")
            }
            checked++
        }
        println("kotlin-conformance checked=$checked not_native=${notNative.size}")
        assertTrue(checked >= 9)
    }

    @Test
    fun descriptorHashMatchesManifest() {
        val manifest = JSONObject(File(dir, "manifest.json").readText()).getJSONObject("files")
        val sha = MessageDigest.getInstance("SHA-256").digest(File(dir, "foxglove-compressed-video.desc").readBytes()).joinToString("") { "%02x".format(it) }
        assertEquals(manifest.getString("foxglove-compressed-video.desc"), sha)
        assertEquals(CaptureProtocol.VIDEO, "/camera/rgb/video")
    }
}
