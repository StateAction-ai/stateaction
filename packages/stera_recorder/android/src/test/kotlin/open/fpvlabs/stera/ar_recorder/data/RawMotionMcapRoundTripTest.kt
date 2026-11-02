package open.fpvlabs.stera.ar_recorder.data

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Handler
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import open.fpvlabs.stera.ar_recorder.coordination.MotionDrainCoordinator
import open.fpvlabs.stera.ar_recorder.coordination.MotionScheduler
import open.fpvlabs.stera.ar_recorder.sensors.ImuCollectorImpl
import open.fpvlabs.stera.ar_recorder.sensors.MOTION_QUEUE_SATURATED
import open.fpvlabs.stera.ar_recorder.sensors.MotionSensorKind
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.mockito.Mockito
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.shadows.SensorEventBuilder

/**
 * Producer → reader round trip through the production collector, drain coordinator and
 * MCAP writer, read back by an independent byte-level MCAP parser in this test.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class RawMotionMcapRoundTripTest {
    @get:Rule val temporary = TemporaryFolder()

    private class ManualScheduler : MotionScheduler {
        val tasks = mutableListOf<Runnable>()
        override fun postDelayed(task: Runnable, delayMs: Long): Boolean { tasks += task; return true }
        override fun remove(task: Runnable) { tasks.removeAll { it === task } }
        fun tick() { val pending = tasks.toList(); tasks.clear(); pending.forEach { it.run() } }
    }

    private data class Rig(val imu: ImuCollectorImpl, val writer: MCAPDatasetWriter, val accel: Sensor, val gyro: Sensor)

    private fun rig(capacity: Int): Rig {
        val context = Mockito.mock(Context::class.java)
        val manager = Mockito.mock(SensorManager::class.java)
        val accel = Mockito.mock(Sensor::class.java)
        val gyro = Mockito.mock(Sensor::class.java)
        Mockito.`when`(context.getSystemService(Context.SENSOR_SERVICE)).thenReturn(manager)
        Mockito.`when`(manager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)).thenReturn(accel)
        Mockito.`when`(manager.getDefaultSensor(Sensor.TYPE_GYROSCOPE)).thenReturn(gyro)
        Mockito.`when`(manager.registerListener(Mockito.any(SensorEventListener::class.java), Mockito.any(Sensor::class.java),
            Mockito.anyInt(), Mockito.anyInt(), Mockito.any(Handler::class.java))).thenReturn(true)
        val imu = ImuCollectorImpl(context, capacity, { 7_000_000_000L }, {})
        val writer = MCAPDatasetWriter(RuntimeEnvironment.getApplication(), "test", "35")
        writer.createSessionDirectory(temporary.newFolder())
        assertTrue(writer.initializeWriters())
        assertTrue(imu.initialize())
        imu.configure(100)
        imu.start()
        return Rig(imu, writer, accel, gyro)
    }

    private fun deliver(rig: Rig, sensor: Sensor, ts: Long, x: Float, y: Float, z: Float) =
        rig.imu.onSensorChanged(SensorEventBuilder.newBuilder().setSensor(sensor).setTimestamp(ts).setAccuracy(3)
            .setValues(floatArrayOf(x, y, z)).build())

    private data class Expected(val kind: MotionSensorKind, val ts: Long, val values: FloatArray)

    @Test fun unequalSchedulesAndDelayedDroppedVideoRoundTripEveryEventExactly() {
        val rig = rig(capacity = 4_096)
        val scheduler = ManualScheduler()
        val drain = MotionDrainCoordinator(rig.imu, rig.writer, maxPerSensorPerTick = 8)
        drain.start(scheduler)
        val expected = mutableListOf<Expected>()
        val accelTimes = (0 until 100).map { 1_000_000_000L + it * 10_000_000L }
        // Gyro at ~197 Hz with deterministic jitter; never aligned with the accelerometer.
        val gyroTimes = (0 until 197).map { 1_000_000_123L + it * 5_076_142L + (it % 7) * 1_311L }
        val timeline = (accelTimes.map { MotionSensorKind.ACCEL to it } + gyroTimes.map { MotionSensorKind.GYRO to it })
            .sortedBy { it.second }
        val pendingVideo = ArrayDeque<Long>()
        var nextVideo = 1_000_000_000L
        var videoIndex = 0
        var writtenVideo = 0
        var nextTick = 1_000_000_000L
        for ((kind, ts) in timeline) {
            val v = floatArrayOf(ts % 1_000 / 1000f, -(ts % 997) / 997f, if (kind == MotionSensorKind.ACCEL) 9.80665f else 0.001f)
            deliver(rig, if (kind == MotionSensorKind.ACCEL) rig.accel else rig.gyro, ts, v[0], v[1], v[2])
            expected += Expected(kind, ts, v)
            while (nextVideo <= ts) {
                // Every third camera frame is dropped; the rest are written 120 ms late.
                if (videoIndex++ % 3 != 2) pendingVideo.addLast(nextVideo)
                nextVideo += 33_333_333L
            }
            while (pendingVideo.isNotEmpty() && pendingVideo.first() + 120_000_000L <= ts) {
                val frameTs = pendingVideo.removeFirst()
                rig.writer.writeCompressedRgbFrame(frameTs, byteArrayOf(1, 2, 3), frameTs)
                writtenVideo++
            }
            if (ts >= nextTick) { scheduler.tick(); nextTick += 20_000_000L }
        }
        rig.imu.stop(); drain.stop(); drain.flushAll()
        assertNull(rig.writer.getWriteFailure())
        assertEquals(100L, rig.imu.writtenCount(MotionSensorKind.ACCEL))
        assertEquals(197L, rig.imu.writtenCount(MotionSensorKind.GYRO))
        val recordingId = rig.writer.getCaptureRecordingId()!!
        rig.writer.finalize()

        val mcap = File(rig.writer.getSessionDirectory()!!).listFiles()!!.single { it.name.endsWith(".mcap") }
        File("build/sa53").mkdirs()
        mcap.copyTo(File("build/sa53/raw_motion_roundtrip.mcap"), overwrite = true)
        val parsed = McapReader.read(mcap.readBytes())
        assertFalse("paired IMU topic must not be written", parsed.topics().contains("/device/imu"))
        assertEquals(writtenVideo, parsed.messages(ROS2SchemaDefinitions.COMPRESSED_RGB_TOPIC).size)
        val contract = File("../../contracts/capture/MotionEvent.schema.json").readBytes()
        for (kind in MotionSensorKind.values()) {
            val channel = parsed.channelByTopic.getValue(kind.topic)
            assertEquals("json", channel.encoding)
            val schema = parsed.schemas.getValue(channel.schemaId)
            assertEquals(MotionEventWire.SCHEMA_NAME, schema.name)
            assertEquals("jsonschema", schema.encoding)
            assertArrayEquals("schema bytes must equal the published SA-50 contract", contract, schema.data)
            val messages = parsed.messages(kind.topic)
            val wanted = expected.filter { it.kind == kind }
            assertEquals(wanted.size, messages.size)
            messages.forEachIndexed { index, message ->
                val json = JSONObject(String(message.data, Charsets.UTF_8))
                assertEquals(recordingId, json.getString("recording_id"))
                assertEquals(index.toString(), json.getString("event_id"))
                assertEquals(wanted[index].ts.toString(), json.getString("native_timestamp_ns"))
                assertEquals(wanted[index].ts, message.logTime)
                assertEquals("android.elapsed_realtime", json.getString("native_clock_id"))
                assertEquals(kind.unit, json.getString("unit"))
                assertTrue(json.isNull("mapped_capture_time_ns"))
                assertEquals("7000000000", json.getString("callback_elapsed_ns"))
                assertEquals("android_device", json.getString("axes"))
                if (kind == MotionSensorKind.ACCEL) assertTrue(json.getBoolean("includes_gravity"))
                else assertTrue(json.isNull("includes_gravity"))
                val values = json.getJSONArray("values")
                assertEquals(3, values.length())
                for (i in 0 until 3) assertEquals(wanted[index].values[i], values.getDouble(i).toFloat())
                assertEquals(setOf("recording_id", "event_id", "native_timestamp_ns", "native_clock_id", "unit",
                    "mapped_capture_time_ns", "callback_elapsed_ns", "accuracy", "values", "axes", "includes_gravity"),
                    json.keys().asSequence().toSet())
            }
        }
    }

    @Test fun writerBackpressureSaturatesOneSensorWithReasonAndExactAccounting() {
        val rig = rig(capacity = 16)
        val reasons = mutableListOf<String>()
        rig.imu.stop(); rig.imu.configure(100) { reasons += it }; rig.imu.start()
        val scheduler = ManualScheduler()
        val drain = MotionDrainCoordinator(rig.imu, rig.writer)
        drain.start(scheduler)
        // The writer is busy with video, so no motion tick runs while 30 accel events arrive.
        repeat(30) { deliver(rig, rig.accel, 2_000_000_000L + it * 10_000_000L, it.toFloat(), 0f, 9.8f) }
        repeat(5) { deliver(rig, rig.gyro, 2_000_000_001L + it * 5_000_000L, 0f, it.toFloat(), 0f) }
        assertEquals(1, reasons.size)
        assertTrue(reasons.single().startsWith(MOTION_QUEUE_SATURATED))
        rig.imu.stop(); drain.stop(); drain.flushAll()
        @Suppress("UNCHECKED_CAST")
        val sensors = rig.imu.motionEvidence()["sensors"] as Map<String, Map<String, Any?>>
        val accel = sensors.getValue("accel")
        assertEquals(30L, accel["delivered"]); assertEquals(16L, accel["written"])
        assertEquals(14L, (accel["dropped"] as Map<*, *>)["queue_full"])
        assertEquals(5L, sensors.getValue("gyro")["written"])
        assertEquals(0L, (sensors.getValue("gyro")["dropped"] as Map<*, *>)["queue_full"])
        assertEquals(reasons.single(), rig.imu.motionEvidence()["saturation_reason"])
        rig.writer.finalize()
        val mcap = File(rig.writer.getSessionDirectory()!!).listFiles()!!.single { it.name.endsWith(".mcap") }
        val accelIds = McapReader.read(mcap.readBytes()).messages(MotionSensorKind.ACCEL.topic)
            .map { JSONObject(String(it.data, Charsets.UTF_8)).getString("event_id").toLong() }
        assertEquals((0L until 16L).toList(), accelIds)
    }

    @Test fun eventsOfferedToAPausedWriterAreCountedAsDiscardedNotSilentlyLost() {
        val rig = rig(capacity = 64)
        val drain = MotionDrainCoordinator(rig.imu, rig.writer)
        deliver(rig, rig.gyro, 10L, 1f, 2f, 3f)
        rig.writer.pauseWriters()
        drain.flushAll()
        @Suppress("UNCHECKED_CAST")
        val gyro = (rig.imu.motionEvidence()["sensors"] as Map<String, Map<String, Any?>>).getValue("gyro")
        assertEquals(1L, (gyro["dropped"] as Map<*, *>)["writer_paused"])
        assertEquals(0L, gyro["written"])
        rig.writer.resumeWriters(); rig.imu.stop(); rig.writer.finalize()
    }
}

/** Minimal independent MCAP reader (uncompressed chunks) used only to verify the producer. */
internal object McapReader {
    class Schema(val name: String, val encoding: String, val data: ByteArray)
    class Channel(val topic: String, val schemaId: Int, val encoding: String)
    class Message(val channelId: Int, val sequence: Long, val logTime: Long, val data: ByteArray)
    class Parsed(val schemas: Map<Int, Schema>, val channels: Map<Int, Channel>, val all: List<Message>) {
        val channelByTopic: Map<String, Channel> = channels.values.associateBy { it.topic }
        fun topics(): Set<String> = channelByTopic.keys
        fun messages(topic: String): List<Message> {
            val id = channels.entries.single { it.value.topic == topic }.key
            return all.filter { it.channelId == id }
        }
    }

    fun read(bytes: ByteArray): Parsed {
        val magic = byteArrayOf(0x89.toByte(), 'M'.code.toByte(), 'C'.code.toByte(), 'A'.code.toByte(), 'P'.code.toByte(),
            '0'.code.toByte(), '\r'.code.toByte(), '\n'.code.toByte())
        require(bytes.copyOfRange(0, 8).contentEquals(magic)) { "Not an MCAP file" }
        val schemas = HashMap<Int, Schema>(); val channels = HashMap<Int, Channel>(); val messages = ArrayList<Message>()
        fun records(buffer: ByteBuffer, inChunk: Boolean) {
            while (buffer.remaining() >= 9) {
                val op = buffer.get().toInt() and 0xff
                val length = buffer.long.toInt()
                val content = ByteBuffer.wrap(ByteArray(length).also { buffer.get(it) }).order(ByteOrder.LITTLE_ENDIAN)
                fun str(): String { val n = content.int; return String(ByteArray(n).also { content.get(it) }, Charsets.UTF_8) }
                when (op) {
                    0x02 -> return // Footer
                    0x03 -> { val id = content.short.toInt() and 0xffff; val name = str(); val enc = str()
                        val n = content.int; schemas.putIfAbsent(id, Schema(name, enc, ByteArray(n).also { content.get(it) })) }
                    0x04 -> { val id = content.short.toInt() and 0xffff; val schema = content.short.toInt() and 0xffff
                        val topic = str(); val enc = str(); channels.putIfAbsent(id, Channel(topic, schema, enc)) }
                    0x05 -> { val channel = content.short.toInt() and 0xffff; val seq = content.int.toLong() and 0xffffffffL
                        val log = content.long; content.long
                        messages += Message(channel, seq, log, ByteArray(content.remaining()).also { content.get(it) }) }
                    0x06 -> if (!inChunk) { content.long; content.long; content.long; content.int
                        require(str().isEmpty()) { "Compressed chunks are not used by this writer" }
                        val n = content.long.toInt()
                        records(ByteBuffer.wrap(ByteArray(n).also { content.get(it) }).order(ByteOrder.LITTLE_ENDIAN), true) }
                    else -> Unit
                }
            }
        }
        records(ByteBuffer.wrap(bytes, 8, bytes.size - 8).slice().order(ByteOrder.LITTLE_ENDIAN), false)
        return Parsed(schemas, channels, messages.sortedWith(compareBy({ it.channelId }, { it.sequence })))
    }
}
