package open.fpvlabs.stera.ar_recorder.data

import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import open.fpvlabs.stera.ar_recorder.data.h264.CaptureProtocol

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class MCAPH264Test {
    @get:Rule val temporary = TemporaryFolder()
    private val epoch = 1_800_000_000_000_000_007L
    private fun event(id: Long = 0L): Map<String, Any?> = mapOf(
        "recording_id" to "writer-test", "stream_id" to "rgb", "source_frame_id" to id.toString(), "state" to "acquired",
        "native_timestamp_ns" to "1000000007", "native_clock_id" to "android.camera.sensor_timestamp",
        "mapped_capture_time_ns" to epoch.toString(), "clock_mapping_revision" to "android_elapsed_to_unix_v1",
        "calibration_id" to "rgb_0", "encoder_pts_us" to (id * 33_333).toString(), "encoder_time_base" to CaptureProtocol.TIME_BASE,
        "native_timestamps" to mapOf("image_ns" to "999999999", "sensor_ns" to "1000000007"))
    private fun writer(): MCAPDatasetWriter = MCAPDatasetWriter(RuntimeEnvironment.getApplication(), "fixture", "35").also {
        it.configureH264Capture(mapOf("recording_id" to "writer-test", "encoder" to mapOf("qualification" to "synthetic")))
        it.createSessionDirectory(temporary.newFolder())
        assertTrue(it.initializeWriters())
    }
    private fun idr(): ByteArray = javaClass.classLoader!!.getResourceAsStream("synthetic-one-idr.h264")!!.use { it.readBytes() }
    private fun mcap(writer: MCAPDatasetWriter): File = File(writer.getSessionDirectory()!!).listFiles()!!.single { it.extension == "mcap" }
    private fun buffer(bytes: ByteArray) = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
    private fun string(b: ByteBuffer): String = ByteArray(b.int).also { b.get(it) }.toString(Charsets.UTF_8)
    private fun records(bytes: ByteArray, start: Int = 8, end: Int = bytes.size - 8): List<Pair<Int, ByteArray>> {
        val out = mutableListOf<Pair<Int, ByteArray>>()
        val b = buffer(bytes); b.position(start)
        while (b.position() < end) {
            val op = b.get().toInt(); val size = b.long.toInt()
            val content = ByteArray(size).also { b.get(it) }
            if (op == 6) out.addAll(records(content, 40, content.size)) else out.add(op to content)
        }
        return out
    }

    @Test fun actualWriterEmitsPinnedMixedSchemasAndTerminalVideoSequence() {
        val writer = writer()
        writer.writeH264FrameEvent(event())
        writer.writeIntrinsics(epoch, mapOf("focalLengthX" to 100.0, "focalLengthY" to 100.0,
            "principalPointX" to 32.0, "principalPointY" to 32.0, "imageWidth" to 64, "imageHeight" to 64))
        writer.writeH264FrameEvent(event() + ("state" to "submitted"))
        assertTrue(writer.writeH264AccessUnit(0, epoch, 0, idr()))
        assertTrue(writer.createSpatialDataZip().first)
        writer.finalize() // repeat finalization must preserve success
        assertNull(writer.getWriteFailure())
        assertEquals("closed", writer.getH264CaptureStats()["container_state"])
        val records = records(mcap(writer).readBytes())
        assertEquals("", string(buffer(records.first { it.first == 1 }.second)))
        val schemas = records.filter { it.first == 3 }.map { (_, bytes) ->
            val b = buffer(bytes); b.short; val name = string(b); val encoding = string(b)
            val data = ByteArray(b.int).also { b.get(it) }; Triple(name, encoding, data)
        }
        val video = schemas.first { it.first == "foxglove.CompressedVideo" }
        assertEquals("protobuf", video.second)
        assertEquals("4abbe41b9ab9714bb3e622cc341d23427f1fa2ca24ae6b1f533ce2288a0b3b53",
            MessageDigest.getInstance("SHA-256").digest(video.third).joinToString("") { "%02x".format(it) })
        assertTrue(schemas.any { it.first == "stateaction.capture.FrameEvent.v1" && it.second == "jsonschema" })
        for (schema in schemas.filter { it.second == "ros2msg" }) assertFalse(schema.third.toString(Charsets.UTF_8).contains("/msg/"))
        val channels = records.filter { it.first == 4 }.associate { (_, bytes) ->
            val b = buffer(bytes); val id = b.short.toInt(); b.short; val topic = string(b); id to topic
        }
        val messages = records.filter { it.first == 5 }.map { (_, bytes) ->
            val b = buffer(bytes); val id = b.short.toInt(); val seq = b.int; val log = b.long; b.long
            val payload = ByteArray(b.remaining()).also { b.get(it) }; Triple(channels[id], seq, payload) to log
        }
        val image = messages.single { it.first.first == CaptureProtocol.VIDEO }
        assertEquals(0, image.first.second)
        assertTrue(image.second > 1_000_000_000_000_000_000L)
        val evidence = messages.filter { it.first.first == CaptureProtocol.FRAMES }.map { JSONObject(it.first.third.toString(Charsets.UTF_8)) }
        assertEquals(listOf("acquired", "submitted", "written"), evidence.map { it.getString("state") })
        assertEquals("1000000007", evidence.last().getString("native_timestamp_ns"))
        assertEquals(epoch.toString(), evidence.last().getString("mapped_capture_time_ns"))
        assertEquals(0, evidence.last().getInt("output_sequence"))
        val sensor = messages.filter { it.first.first == CaptureProtocol.SENSORS }.map { JSONObject(it.first.third.toString(Charsets.UTF_8)) }.single()
        assertEquals("0", sensor.getString("association_source_frame_id"))
        assertEquals("1000000007", sensor.getString("native_timestamp_ns"))
    }

    @Test fun unresolvedAcquisitionClosesStructurallyButFailsIntegrity() {
        val writer = writer(); writer.writeH264FrameEvent(event())
        assertFalse(writer.createSpatialDataZip().first)
        assertEquals("closed", writer.getH264CaptureStats()["container_state"])
        assertTrue(writer.getWriteFailure()!!.contains("Unresolved H.264"))
        assertEquals(listOf("0"), writer.getH264CaptureStats()["unresolved_ids"])
        writer.finalize()
    }

    @Test fun jpegCannotSilentlyEnterAnH264Recording() {
        val writer = writer(); writer.writeCompressedRgbFrame(1, byteArrayOf(1))
        assertEquals(0, writer.getRecordingStats()["rgbFrameCount"])
        assertTrue(writer.getWriteFailure()!!.contains("JPEG"))
        writer.finalize()
    }

    @Test fun independentMotionKeepsNativeAxesAndSeparateCounters() {
        val writer = writer()
        fun motion(unit: String) = mapOf<String, Any?>("recording_id" to "writer-test", "event_id" to "0",
            "native_timestamp_ns" to "1000000001", "native_clock_id" to "android.elapsed_realtime", "unit" to unit,
            "x" to 1.0f, "y" to 2.0f, "z" to 3.0f, "accuracy" to 3)
        writer.writeRawMotionEvent("accel", motion("m/s^2")); writer.writeRawMotionEvent("gyro", motion("rad/s"))
        assertEquals(1L, writer.getH264CaptureStats()["raw_accel_count"])
        assertEquals(1L, writer.getH264CaptureStats()["raw_gyro_count"])
        assertEquals(2, writer.getRecordingStats()["imuSampleCount"])
        assertEquals("independent_accel_plus_gyro_events", writer.getRecordingStats()["imuSampleCountSemantics"])
        assertEquals(0, writer.getRecordingStats()["legacyPairedImuSampleCount"])
        writer.finalize()
    }

    @Test fun fixedMessageBoundRejectsOversizedPayloadBeforeBufferGrowth() {
        val writer = MCAPWriter(); val file = temporary.newFile("bound.mcap"); assertTrue(writer.open(file, ""))
        val schema = writer.addSchema("json", "jsonschema", "{}")
        val channel = writer.addChannel("/bounded", "json", schema)
        try { writer.addMessage(channel, 1, 1, ByteArray(16 * 1024 * 1024)); fail("Expected byte-bound rejection") }
        catch (_: IllegalArgumentException) {}
        writer.addMessage(channel, 1, 1, byteArrayOf(123, 125), 7)
        writer.finish()
        assertTrue(file.length() < 1024)
        try { writer.addMessage(channel, 2, 2, byteArrayOf()); fail("Closed writer cannot accept bytes") }
        catch (_: IllegalStateException) {}
    }
}
