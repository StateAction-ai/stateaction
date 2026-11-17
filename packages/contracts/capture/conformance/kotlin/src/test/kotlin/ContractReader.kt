import org.json.JSONArray
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest

/**
 * Portable Kotlin reader for the stateaction.capture.v1.1 contract (SA-50) and the stateaction.capture.v1.2 revision (SA-68). It is a dependency-free port of
 * conformance/python/capture_conformance.py that parses MCAP, Protobuf, Annex B, CDR and the JSON evidence
 * itself and returns the same canonical result as every other language. It is contract-language conformance
 * only: it does not use, and says nothing about, the native recorder classes (see NativeProtocolReplayTest).
 */
object ContractReader {
    const val VIDEO = "/camera/rgb/video"
    private const val FRAME_ID = "camera_optical_frame"
    private const val POSE_SCHEMA = "geometry_msgs/msg/PoseStamped"
    private const val POSE_SCHEMA_FILE = "geometry_msgs-PoseStamped.ros2msg"
    private val CUSTOM = mapOf(
        "stateaction.capture.Profile.v1" to "Profile.schema.json",
        "stateaction.capture.Clocks.v1" to "Clocks.schema.json",
        "stateaction.capture.Inventory.v1" to "Inventory.schema.json",
        "stateaction.capture.FrameEvent.v1" to "FrameEvent.schema.json",
        "stateaction.capture.MotionEvent.v1" to "MotionEvent.schema.json",
        "stateaction.capture.SensorEvent.v1" to "SensorEvent.schema.json",
        "stateaction.capture.Close.v1" to "Close.schema.json",
    )
    // stateaction.capture.v1.2 (SA-68): selected by the schema record name of /stateaction/capture_profile.
    private const val PROFILE_V2 = "stateaction.capture.Profile.v2"
    private val CUSTOM12 = mapOf(
        PROFILE_V2 to "Profile.v2.schema.json",
        "stateaction.capture.Close.v2" to "Close.v2.schema.json",
        "stateaction.capture.Calibration.v1" to "Calibration.schema.json",
        "stateaction.capture.DepthEvent.v1" to "DepthEvent.schema.json",
        "stateaction.capture.CameraMetadata.v1" to "CameraMetadata.schema.json",
    )
    private val CUSTOM_V12_TABLE = CUSTOM.filterKeys { "Profile" !in it && "Close" !in it } + CUSTOM12
    private const val MANIFEST_V12 = "manifest.v1.2.json"
    private const val RAW_IMAGE_SCHEMA = "foxglove.RawImage"
    private const val RAW_IMAGE_DESC = "foxglove-raw-image.desc"
    private const val JSON_MESSAGE_MAX = 65536
    private const val RAW_DATA_MAX = 16_777_216
    private const val RAW_MESSAGE_MAX = RAW_DATA_MAX + 4096
    private const val RAW_DIM_MAX = 4096L
    private const val DEPTH_FRAME_ID = "depth_optical_frame"
    private const val TOLERANCE = 1e-9
    private val JSON_ENC = listOf("jsonschema", "json")
    private val CHANNELS: Map<String, List<String>> = mapOf(
        "/stateaction/capture_profile" to listOf("stateaction.capture.Profile.v1") + JSON_ENC,
        "/stateaction/clocks" to listOf("stateaction.capture.Clocks.v1") + JSON_ENC,
        "/stateaction/inventory" to listOf("stateaction.capture.Inventory.v1") + JSON_ENC,
        "/stateaction/frame_events" to listOf("stateaction.capture.FrameEvent.v1") + JSON_ENC,
        "/stateaction/imu/accel" to listOf("stateaction.capture.MotionEvent.v1") + JSON_ENC,
        "/stateaction/imu/gyro" to listOf("stateaction.capture.MotionEvent.v1") + JSON_ENC,
        "/stateaction/sensor_events" to listOf("stateaction.capture.SensorEvent.v1") + JSON_ENC,
        "/stateaction/close" to listOf("stateaction.capture.Close.v1") + JSON_ENC,
        VIDEO to listOf("foxglove.CompressedVideo", "protobuf", "protobuf"),
        "/tracking/pose" to listOf(POSE_SCHEMA, "ros2msg", "cdr"),
    )
    private val RAW_ENC = listOf(RAW_IMAGE_SCHEMA, "protobuf", "protobuf")
    // v1.2 table: v1.1 entries unchanged except Profile.v2 / Close.v2, plus the optional new channels.
    private val CHANNELS12: Map<String, List<String>> = CHANNELS + mapOf(
        "/stateaction/capture_profile" to listOf(PROFILE_V2) + JSON_ENC,
        "/stateaction/close" to listOf("stateaction.capture.Close.v2") + JSON_ENC,
        "/stateaction/calibrations" to listOf("stateaction.capture.Calibration.v1") + JSON_ENC,
        "/stateaction/depth_events" to listOf("stateaction.capture.DepthEvent.v1") + JSON_ENC,
        "/stateaction/camera_metadata" to listOf("stateaction.capture.CameraMetadata.v1") + JSON_ENC,
        "/camera/depth_raw/image" to RAW_ENC,
        "/camera/depth_raw/confidence" to RAW_ENC,
        "/camera/depth_dense/image" to RAW_ENC,
    )
    private val DEPTH_IMAGE_TOPICS = listOf("/camera/depth_raw/image", "/camera/depth_raw/confidence", "/camera/depth_dense/image")
    private val IDENTITY_KEYS = listOf(
        "recording_id", "stream_id", "native_timestamp_ns", "native_clock_id", "mapped_capture_time_ns",
        "clock_mapping_revision", "calibration_id", "encoder_pts_us", "encoder_time_base", "native_timestamps",
    )
    private val MAGIC = byteArrayOf(0x89.toByte(), 0x4d, 0x43, 0x41, 0x50, 0x30, 0x0d, 0x0a)
    private val START = byteArrayOf(0, 0, 0, 1)
    private val DECIMAL = Regex("0|[1-9][0-9]*")

    class Truncated : Exception()
    class Malformed : Exception()
    class Unsupported : Exception()
    class CrcMismatch : Exception()
    class DefinitionOrder : Exception()
    class DefinitionConflict : Exception()

    /** Strict UTF-8 (decodeToString would substitute U+FFFD): record strings are truncated, message strings malformed. */
    private fun utf8(b: ByteArray, onError: () -> Exception): String = try {
        Charsets.UTF_8.newDecoder().onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
            .onUnmappableCharacter(java.nio.charset.CodingErrorAction.REPORT).decode(ByteBuffer.wrap(b)).toString()
    } catch (e: java.nio.charset.CharacterCodingException) {
        throw onError()
    }
    private val SINGLETON_TOPICS = listOf("/stateaction/capture_profile", "/stateaction/clocks", "/stateaction/inventory", "/stateaction/close")
    private val schemaCache = HashMap<String, StrictSchema>()
    var captureDir: java.io.File = java.io.File(System.getProperty("capture.dir") ?: "../..")

    /** The reviewed contract schema (never the file's embedded copy, which is only hash-compared). */
    @Suppress("UNCHECKED_CAST")
    fun contractSchema(name: String): StrictSchema = schemaCache.getOrPut(name) {
        StrictSchema(StrictJson.parse(java.io.File(captureDir, (CUSTOM + CUSTOM12).getValue(name)).readBytes()) as Map<String, Any?>)
    }

    fun sha256(b: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }

    // ------------------------------------------------------------------ canonical JSON
    fun conv(x: Any?): Any? = when (x) {
        null, JSONObject.NULL -> null
        is JSONObject -> x.keySet().associateWith { conv(x.get(it)) }
        is JSONArray -> (0 until x.length()).map { conv(x.get(it)) }
        else -> x
    }

    private fun quote(s: String): String = buildString {
        append('"')
        for (c in s) when {
            c == '"' -> append("\\\"")
            c == '\\' -> append("\\\\")
            c == '\n' -> append("\\n")
            c == '\r' -> append("\\r")
            c == '\t' -> append("\\t")
            c == '\b' -> append("\\b")
            c == '\u000c' -> append("\\f")
            c.code < 0x20 -> append("\\u%04x".format(c.code))
            else -> append(c)
        }
        append('"')
    }

    fun canonical(x: Any?): String = when (x) {
        null -> "null"
        is Boolean -> x.toString()
        is Int, is Long, is java.math.BigInteger -> x.toString()
        is String -> quote(x)
        is Map<*, *> -> x.keys.map { it as String }.sorted().joinToString(",", "{", "}") { quote(it) + ":" + canonical(x[it]) }
        is List<*> -> x.joinToString(",", "[", "]") { canonical(it) }
        else -> error("Unsupported value ${x.javaClass}")
    }

    // ------------------------------------------------------------------ MCAP
    class Msg(val channel: Int, val sequence: Long, val logTime: Long, val data: ByteArray, val pos: Int)
    class Schema(val name: String, val encoding: String, val data: ByteArray)
    class Channel(val schemaId: Int, val topic: String, val encoding: String)
    class Mcap(var profile: String? = null) {
        val schemas = HashMap<Int, Schema>()
        val channels = HashMap<Int, Channel>()
        val messages = ArrayList<Msg>()
    }

    private fun str(b: ByteBuffer, limit: Int): String {
        if (b.position() + 4 > limit) throw Truncated()
        val n = b.int
        if (n < 0 || b.position() + n > limit) throw Truncated()
        return utf8(ByteArray(n).also { b.get(it) }) { Truncated() }
    }

    // Supported layout (see capture_conformance.py): Header first; only Schema/Channel/Message records; one
    // DataEnd with a nonzero CRC-32 of every preceding byte; a Footer without summary; the closing magic.
    // Definitions are checked in file order: a Channel's nonzero schema id and a Message's channel id must
    // already be defined (E_DEFINITION_ORDER); a repeated Schema/Channel id must repeat the identical record
    // body and Schema id 0 is reserved (E_DEFINITION_CONFLICT).
    fun readMcap(data: ByteArray): Mcap {
        val out = try {
            readRecords(data)
        } catch (e: java.nio.BufferUnderflowException) {
            throw Truncated()
        } catch (e: IndexOutOfBoundsException) {
            throw Truncated()
        }
        return out
    }

    private fun readRecords(data: ByteArray): Mcap {
        if (data.size < 8 || !data.copyOfRange(0, 8).contentEquals(MAGIC)) throw Truncated()
        val out = Mcap()
        var pos = 8
        var dataEnd = false
        val raw = mapOf(0x03 to HashMap<Int, ByteArray>(), 0x04 to HashMap<Int, ByteArray>()) // id -> exact body
        fun define(op: Int, id: Int, body: ByteArray) {
            val prior = raw.getValue(op)[id]
            if (prior != null && !prior.contentEquals(body)) throw DefinitionConflict()
            raw.getValue(op)[id] = body
        }
        while (true) {
            if (pos == data.size || pos + 9 > data.size) throw Truncated()
            val recordStart = pos
            val op = data[pos].toInt() and 0xff
            val len = ByteBuffer.wrap(data, pos + 1, 8).order(ByteOrder.LITTLE_ENDIAN).long
            val start = pos + 9
            if (len < 0 || len > data.size - start) throw Truncated()
            val body = ByteBuffer.wrap(data, start, len.toInt()).slice().order(ByteOrder.LITTLE_ENDIAN)
            val limit = len.toInt()
            pos = start + len.toInt()
            if ((op == 0x01) != (recordStart == 8)) throw Unsupported()
            if (dataEnd && op != 0x02) throw Unsupported()
            when (op) {
                0x01 -> out.profile = str(body, limit)
                0x03 -> {
                    val id = body.short.toInt() and 0xffff
                    val name = str(body, limit)
                    val enc = str(body, limit)
                    val n = body.int
                    if (n < 0 || body.position() + n > limit) throw Truncated()
                    val schemaData = ByteArray(n).also { body.get(it) }
                    if (id == 0) throw DefinitionConflict()
                    define(op, id, data.copyOfRange(start, start + limit))
                    out.schemas[id] = Schema(name, enc, schemaData)
                }
                0x04 -> {
                    val id = body.short.toInt() and 0xffff
                    val schemaId = body.short.toInt() and 0xffff
                    val topic = str(body, limit)
                    val encoding = str(body, limit)
                    if (schemaId != 0 && schemaId !in out.schemas) throw DefinitionOrder()
                    define(op, id, data.copyOfRange(start, start + limit))
                    out.channels[id] = Channel(schemaId, topic, encoding)
                }
                0x05 -> {
                    val ch = body.short.toInt() and 0xffff
                    val seq = body.int.toLong() and 0xffffffffL
                    val log = body.long
                    body.long
                    if (ch !in out.channels) throw DefinitionOrder()
                    out.messages.add(Msg(ch, seq, log, ByteArray(limit - 22).also { body.get(it) }, out.messages.size))
                }
                0x0f -> {
                    val crc = body.int.toLong() and 0xffffffffL
                    dataEnd = true
                    val actual = java.util.zip.CRC32().also { it.update(data, 0, recordStart) }.value
                    if (crc == 0L || crc != actual) throw CrcMismatch()
                }
                0x02 -> {
                    if (!dataEnd) throw Unsupported()
                    if (body.long != 0L || body.long != 0L || body.int != 0) throw Unsupported()
                    if (pos + 8 != data.size || !data.copyOfRange(pos, data.size).contentEquals(MAGIC)) throw Truncated()
                    return out
                }
                else -> throw Unsupported()
            }
        }
    }

    // ------------------------------------------------------------------ Protobuf CompressedVideo
    class Video(var sec: Long = 0, var nanos: Long = 0, var frameId: String = "", var format: String = "", var data: ByteArray = ByteArray(0))

    private class Cursor(val b: ByteArray) {
        var pos = 0
        /** [unsigned63]: RawImage readers reject any value >= 2^63 (every such value is a defined reject there). */
        fun varint(unsigned63: Boolean = false): Long {
            var shift = 0
            var v = 0L
            while (true) {
                if (pos >= b.size || shift > 63) throw Malformed()
                val x = b[pos++].toInt() and 255
                if (unsigned63 && shift == 63 && (x and 127) != 0) throw Malformed()
                v = v or ((x and 127).toLong() shl shift)
                if (x < 128) return v
                shift += 7
            }
        }
    }

    fun decodeVideo(buf: ByteArray): Video {
        val v = Video()
        val c = Cursor(buf)
        while (c.pos < buf.size) {
            val key = c.varint()
            val field = (key shr 3).toInt()
            val wire = (key and 7).toInt()
            if (wire == 2) {
                val n = c.varint()
                if (n < 0 || c.pos + n > buf.size) throw Malformed()
                val chunk = buf.copyOfRange(c.pos, c.pos + n.toInt())
                c.pos += n.toInt()
                when (field) {
                    1 -> {
                        val inner = Cursor(chunk)
                        while (inner.pos < chunk.size) {
                            val k = inner.varint()
                            val value = inner.varint()
                            if ((k shr 3).toInt() == 1) v.sec = value else v.nanos = value
                        }
                    }
                    2 -> v.frameId = utf8(chunk) { Malformed() }
                    3 -> v.data = chunk
                    4 -> v.format = utf8(chunk) { Malformed() }
                }
            } else if (wire == 0) c.varint() else throw Malformed()
        }
        return v
    }


    // ------------------------------------------------------------------ Protobuf foxglove.RawImage (v1.2)
    class RawImage(val captureNs: java.math.BigInteger, val frameId: String, val encoding: String, val width: Long, val height: Long, val step: Long, val data: ByteArray)

    private fun rawTimestamp(chunk: ByteArray): java.math.BigInteger {
        var sec = 0L
        var nanos = 0L
        val seen = HashSet<Long>()
        val c = Cursor(chunk)
        while (c.pos < chunk.size) {
            val key = c.varint(true)
            val field = key shr 3
            if ((key and 7) != 0L || (field != 1L && field != 2L) || !seen.add(field)) throw Malformed()
            val v = c.varint(true)
            if (field == 1L) sec = v else nanos = v
        }
        if (nanos >= 1_000_000_000L) throw Malformed()
        return java.math.BigInteger.valueOf(sec).multiply(java.math.BigInteger.valueOf(1_000_000_000L)).add(java.math.BigInteger.valueOf(nanos))
    }

    /** Strict decoder: fields 1..7 with exact wire types, no duplicates, lengths checked against the buffer
     *  before slicing, sizes bounded before use. Any varint >= 2^63 is malformed (as in the reference). */
    fun decodeRawImage(buf: ByteArray): RawImage {
        if (buf.size > RAW_MESSAGE_MAX) throw Malformed()
        var capture = java.math.BigInteger.ZERO
        var frameId = ""
        var encoding = ""
        var width = 0L
        var height = 0L
        var step = 0L
        var data = ByteArray(0)
        val seen = HashSet<Long>()
        val c = Cursor(buf)
        while (c.pos < buf.size) {
            val key = c.varint(true)
            val field = key shr 3
            val wire = (key and 7).toInt()
            val expected = when (field) { 1L, 4L, 6L, 7L -> 2; 2L, 3L, 5L -> 5; else -> throw Malformed() }
            if (wire != expected || !seen.add(field)) throw Malformed()
            if (wire == 5) {
                if (buf.size - c.pos < 4) throw Malformed()
                val v = ByteBuffer.wrap(buf, c.pos, 4).order(ByteOrder.LITTLE_ENDIAN).int.toLong() and 0xffffffffL
                c.pos += 4
                when (field) { 2L -> width = v; 3L -> height = v; else -> step = v }
                continue
            }
            val n = c.varint(true)
            if (n > buf.size - c.pos) throw Malformed()
            val chunk = buf.copyOfRange(c.pos, c.pos + n.toInt())
            c.pos += n.toInt()
            when (field) {
                1L -> capture = rawTimestamp(chunk)
                6L -> { if (n > RAW_DATA_MAX) throw Malformed(); data = chunk }
                4L -> encoding = utf8(chunk) { Malformed() }
                else -> frameId = utf8(chunk) { Malformed() }
            }
        }
        if (1L !in seen || width !in 1..RAW_DIM_MAX || height !in 1..RAW_DIM_MAX) throw Malformed()
        return RawImage(capture, frameId, encoding, width, height, step, data)
    }

    // ------------------------------------------------------------------ Annex B
    fun nals(d: ByteArray): List<ByteArray>? {
        val starts = ArrayList<Pair<Int, Int>>()
        var i = 0
        while (i + 2 < d.size) {
            if (d[i].toInt() == 0 && d[i + 1].toInt() == 0 && d[i + 2].toInt() == 1) { starts.add(i to 3); i += 3 }
            else if (d[i].toInt() == 0 && d[i + 1].toInt() == 0 && i + 3 < d.size && d[i + 2].toInt() == 0 && d[i + 3].toInt() == 1) { starts.add(i to 4); i += 4 }
            else i++
        }
        if (starts.isEmpty() || starts[0].first != 0) return null
        return starts.mapIndexed { n, (s, k) -> d.copyOfRange(s + k, if (n + 1 < starts.size) starts[n + 1].first else d.size) }
    }

    private fun sliceHeader(nal: ByteArray): Pair<Int, Int>? {
        val raw = nal.copyOfRange(1, minOf(nal.size, 12))
        val un = ArrayList<Int>()
        var zeros = 0
        for (b in raw) {
            val x = b.toInt() and 255
            if (zeros >= 2 && x == 3) { zeros = 0; continue }
            un.add(x)
            zeros = if (x == 0) zeros + 1 else 0
        }
        val bits = un.joinToString("") { it.toString(2).padStart(8, '0') }
        val vals = ArrayList<Int>()
        var p = 0
        repeat(2) {
            var z = 0
            while (p + z < bits.length && bits[p + z] == '0') z++
            if (p + 2 * z + 1 > bits.length) return null
            vals.add(bits.substring(p + z, p + 2 * z + 1).toInt(2) - 1)
            p += 2 * z + 1
        }
        return vals[0] to vals[1]
    }

    fun classifyAu(d: ByteArray): Pair<List<String>, Boolean> {
        val units = nals(d) ?: return listOf("E_NOT_ANNEXB") to false
        val types = units.map { it[0].toInt() and 31 }
        val slices = units.filter { (it[0].toInt() and 31) in listOf(1, 5) }
        if (slices.isEmpty()) return listOf("E_CONFIG_ONLY") to false
        val errors = ArrayList<String>()
        val headers = slices.map { sliceHeader(it) }
        val firsts = headers.count { it != null && it.first == 0 }
        if (headers.any { it == null } || firsts == 0) errors.add("E_PARTIAL_ACCESS_UNIT")
        else if (firsts > 1) errors.add("E_MULTIPLE_ACCESS_UNITS")
        else if (headers.any { it!!.second % 5 == 1 }) errors.add("E_B_FRAME")
        val idr = 5 in types
        if (idr) {
            val before = types.subList(0, types.indexOfFirst { it == 1 || it == 5 })
            if (7 !in before || 8 !in before) errors.add("E_MISSING_PARAMETER_SETS")
        }
        return errors to idr
    }

    // ------------------------------------------------------------------ CDR
    private fun decodePose(d: ByteArray): Map<String, Any?> {
        if (d.size < 16) throw Malformed()
        val b = ByteBuffer.wrap(d).order(ByteOrder.LITTLE_ENDIAN)
        if (b.getInt(0) != 0x00000100) throw Malformed()
        val n = b.getInt(12)
        val end = 16 + maxOf(n - 1, 0)
        if (n < 0 || end > d.size) throw Malformed()
        return mapOf("sec" to b.getInt(4), "nanosec" to (b.getInt(8).toLong() and 0xffffffffL), "frame_id" to utf8(d.copyOfRange(16, end)) { Malformed() })
    }

    // ------------------------------------------------------------------ checker
    private fun isDecimal(v: Any?) = v is String && DECIMAL.matches(v)
    // Identity comparison uses deep JSON equality (1 == 1.0), exactly like the Python reference.
    private fun same(a: Any?, b: Any?) = StrictSchema.jsonEqual(a, b)

    @Suppress("UNCHECKED_CAST")
    private fun obj(v: Any?): Map<String, Any?>? = v as? Map<String, Any?>

    private fun reject(errors: Set<String>) = mapOf("outcome" to "reject", "errors" to errors.sorted(), "facts" to emptyMap<String, Any?>())

    private fun usesV12(f: Mcap) = f.channels.values.any {
        it.topic == "/stateaction/capture_profile" && f.schemas[it.schemaId]?.name == PROFILE_V2
    }

    private fun loadManifest(name: String): Map<String, String> {
        val files = StrictJson.parse(java.io.File(captureDir, name).readBytes()) as Map<*, *>
        return (files["files"] as Map<*, *>).entries.associate { (k, v) -> k as String to v as String }
    }

    /** [maxRevision] = "v1.1" reproduces a frozen v1.1 reader: every v1.2 file is rejected. */
    fun check(data: ByteArray, explicitManifest: Map<String, String>? = null, maxRevision: String = "v1.2"): Map<String, Any?> {
        val errors = sortedSetOf<String>()
        val f = try {
            readMcap(data)
        } catch (e: Truncated) {
            return reject(setOf("E_TRUNCATED"))
        } catch (e: Unsupported) {
            return reject(setOf("E_UNSUPPORTED_LAYOUT"))
        } catch (e: CrcMismatch) {
            return reject(setOf("E_DATA_CRC"))
        } catch (e: DefinitionOrder) {
            return reject(setOf("E_DEFINITION_ORDER"))
        } catch (e: DefinitionConflict) {
            return reject(setOf("E_DEFINITION_CONFLICT"))
        }
        if (f.profile != "") errors.add("E_PROFILE_NOT_EMPTY")
        val byTopic = java.util.TreeMap<String, MutableList<Msg>>()
        for (m in f.messages) byTopic.getOrPut(f.channels.getValue(m.channel).topic) { ArrayList() }.add(m)
        val names = f.schemas.values.map { it.name }.toSet()
        val facts = LinkedHashMap<String, Any?>()
        facts["channel_counts"] = byTopic.mapValues { it.value.size }
        if ("sensor_msgs/msg/CompressedImage" in names && "foxglove.CompressedVideo" !in names) {
            val img = byTopic["/camera/rgb/image/compressed"] ?: emptyList<Msg>()
            facts["legacy_images"] = img.size
            facts["legacy_log_times_ns"] = img.map { it.logTime.toString() }
            return mapOf("outcome" to "legacy_jpeg", "errors" to listOf("E_LEGACY_JPEG"), "facts" to facts)
        }
        val rev12 = maxRevision != "v1.1" && usesV12(f)
        val channels = if (rev12) CHANNELS12 else CHANNELS
        val custom = if (rev12) CUSTOM_V12_TABLE else CUSTOM
        val manifest = explicitManifest ?: loadManifest(if (rev12) MANIFEST_V12 else "manifest.json")
        // Exact per-channel encodings and reviewed schema identity.
        for (ch in f.channels.values) {
            val schema = f.schemas[ch.schemaId]
            val want = channels[ch.topic]
            if (schema == null || want == null || schema.name != want[0] || schema.encoding != want[1] || ch.encoding != want[2]) errors.add("E_CHANNEL_ENCODING")
            else if (schema.name == POSE_SCHEMA && sha256(schema.data) != manifest[POSE_SCHEMA_FILE]) errors.add("E_CHANNEL_ENCODING")
        }
        val hashes = java.util.TreeMap<String, String>()
        for (s in f.schemas.values) {
            val digest = sha256(s.data)
            hashes[s.name] = digest
            if (s.name == "foxglove.CompressedVideo") {
                if (digest != manifest["foxglove-compressed-video.desc"]) errors.add("E_DESCRIPTOR_HASH")
            } else if (rev12 && s.name == RAW_IMAGE_SCHEMA) {
                if (digest != manifest[RAW_IMAGE_DESC]) errors.add("E_DESCRIPTOR_HASH")
            } else if (s.name in custom) {
                if (digest != manifest[custom.getValue(s.name)]) errors.add("E_SCHEMA_MISMATCH")
            }
        }
        facts["schema_sha256"] = hashes
        // Decode every message once; an undecodable message is a defined reject.
        val raw = java.util.TreeMap<String, List<Any?>>()
        var videos = emptyList<Video>()
        val rawImages = HashMap<String, List<RawImage>>()
        var poses = emptyList<Map<String, Any?>>()
        try {
            for ((topic, msgs) in byTopic) {
                val want = channels[topic] ?: continue
                when (want[2]) {
                    "json" -> {
                        if (rev12 && msgs.any { it.data.size > JSON_MESSAGE_MAX }) throw Malformed()
                        raw[topic] = msgs.map { m -> StrictJson.parse(m.data) }
                    }
                    "protobuf" -> if (topic == VIDEO) videos = msgs.map { decodeVideo(it.data) } else rawImages[topic] = msgs.map { decodeRawImage(it.data) }
                    else -> poses = msgs.map { decodePose(it.data) }
                }
            }
        } catch (e: Malformed) {
            errors.add("E_MALFORMED_MESSAGE"); return reject(errors)
        } catch (e: StrictJson.MalformedJson) {
            errors.add("E_MALFORMED_MESSAGE"); return reject(errors)
        }
        // Strict schema gate: violations are reported exactly and stop evaluation.
        val violations = ArrayList<String>()
        for ((topic, values) in raw) {
            val validator = contractSchema(channels.getValue(topic)[0])
            values.forEachIndexed { i, value -> validator.validate(value).forEach { violations.add("$topic[$i]$it") } }
        }
        if (violations.isNotEmpty()) {
            errors.add("E_SCHEMA_MALFORMED")
            return mapOf("outcome" to "reject", "errors" to errors.toList(), "facts" to mapOf("schema_violations" to violations.sorted()))
        }
        val json = raw.mapValues { (_, v) -> v.map { obj(it)!! } }
        if (SINGLETON_TOPICS.any { (json[it] ?: emptyList()).size != 1 }) errors.add("E_CHANNEL_CARDINALITY")
        if (json.values.flatten().map { it["recording_id"] }.toSet().size > 1) errors.add("E_RECORDING_ID")
        fun js(t: String) = json[t] ?: emptyList()
        val clocks = obj(js("/stateaction/clocks").firstOrNull()?.get("stream_clocks")) ?: emptyMap()
        val knownCalibrations = HashSet<Any?>()
        (js("/stateaction/inventory").firstOrNull()?.get("calibrations") as? List<*>)?.forEach { c -> obj(c)?.let { knownCalibrations.add(it["calibration_id"]) } }
        val frames = js("/stateaction/frame_events")
        val ptsSeen = HashSet<String>()
        val acquired = LinkedHashMap<String, Map<String, Any?>>()
        val written = LinkedHashMap<String, Map<String, Any?>>()
        val state = HashMap<String, String>()
        val submitted = HashSet<String>()
        val dropReasons = java.util.TreeMap<String, Int>()
        val counts = linkedMapOf("acquired" to 0, "submitted" to 0, "written" to 0, "dropped" to 0)
        for (e in frames) {
            val sid = e["source_frame_id"] as String
            val st = e["state"] as String
            // Lifecycle: acquired once, then at most one submit and exactly one terminal outcome;
            // every later event repeats the acquired identity (clock, PTS, calibration, time base).
            if (st == "acquired") {
                if (sid in acquired) errors.add("E_FRAME_IDENTITY")
            } else if (sid !in acquired || state[sid] in listOf("written", "dropped") || (st == "submitted" && sid in submitted)) {
                errors.add("E_FRAME_IDENTITY")
            } else {
                val original = acquired.getValue(sid)
                if (IDENTITY_KEYS.any { !same(e[it], original[it]) }) errors.add("E_FRAME_IDENTITY")
            }
            if ((st == "acquired" || st == "written") && clocks[e["stream_id"]] != e["native_clock_id"]) errors.add("E_CLOCK_MISMATCH")
            if (st == "acquired") {
                if (!ptsSeen.add(e["encoder_pts_us"] as String)) errors.add("E_DUPLICATE_PTS")
                if (e["calibration_id"] !in knownCalibrations) errors.add("E_CALIBRATION_UNKNOWN")
                acquired.putIfAbsent(sid, e)
            }
            if (st == "submitted") submitted.add(sid)
            if (st == "written") written.putIfAbsent(sid, e)
            if (st == "dropped") dropReasons.merge(e["reason"] as String, 1, Int::plus)
            counts[st] = counts.getValue(st) + 1
            if (sid in acquired) state[sid] = st
        }
        facts["frame_event_counts"] = counts
        val video = byTopic[VIDEO] ?: emptyList<Msg>()
        val writtenSeqs = written.values.map { (it["output_sequence"] as Number).toLong() }
        val videoSeqs = video.map { it.sequence }
        if (writtenSeqs.toSet().size != writtenSeqs.size || videoSeqs.toSet().size != videoSeqs.size || writtenSeqs.toSet() != videoSeqs.toSet()) errors.add("E_SEQUENCE")
        val bySeq = written.values.associateBy { (it["output_sequence"] as Number).toLong() }
        val vf = ArrayList<Map<String, Any?>>()
        video.forEachIndexed { i, m ->
            val v = videos[i]
            val (auErrors, idr) = classifyAu(v.data)
            errors.addAll(auErrors)
            if (i == 0 && !idr && auErrors.isEmpty()) errors.add("E_FIRST_NOT_IDR")
            val ts = v.sec * 1_000_000_000L + v.nanos
            val ev = bySeq[m.sequence]
            if (v.frameId != FRAME_ID || v.format != "h264") errors.add("E_VIDEO_FIELDS")
            if (ev != null && (ts.toString() != ev["mapped_capture_time_ns"] || (ev["is_idr"] == true) != idr)) errors.add("E_VIDEO_TIMESTAMP_MISMATCH")
            vf.add(mapOf(
                "sequence" to m.sequence, "capture_time_ns" to ts.toString(), "log_time_ns" to m.logTime.toString(),
                "frame_id" to v.frameId, "format" to v.format, "bytes" to v.data.size, "idr" to idr, "sha256" to sha256(v.data),
                "source_frame_id" to ev?.get("source_frame_id"), "encoder_pts_us" to ev?.get("encoder_pts_us"),
            ))
        }
        facts["video"] = vf
        val motion = LinkedHashMap<String, Any?>()
        for (topic in listOf("/stateaction/imu/accel", "/stateaction/imu/gyro")) {
            val evs = js(topic)
            motion[topic] = evs.map { mapOf("event_id" to it["event_id"], "native_timestamp_ns" to it["native_timestamp_ns"], "mapped_capture_time_ns" to it["mapped_capture_time_ns"]) }
            for (e in evs) if (clocks[topic.substringAfterLast('/')] != e["native_clock_id"]) errors.add("E_CLOCK_MISMATCH")
        }
        facts["motion"] = motion
        val sensors = js("/stateaction/sensor_events")
        val resetAt = HashMap<Any?, Any?>()
        for (e in sensors) {
            if (e["source_kind"] == "arcore_pose" && e["tracking_state"] != "tracking" && e["pose_valid"] == true) errors.add("E_TRACKING_LOSS_UNMARKED")
            if (e["source_kind"] == "calibration_reset") resetAt[e["supersedes_calibration_id"]] = e["association_source_frame_id"]
        }
        val cals = java.util.TreeSet<String>()
        for (e in acquired.values) {
            cals.add(e["calibration_id"] as String)
            val at = resetAt[e["calibration_id"]]
            if (at != null && (e["source_frame_id"] as String).toBigInteger() >= (at as String).toBigInteger()) errors.add("E_CALIBRATION_RESET_UNMARKED")
        }
        facts["sensor_events"] = sensors.map { mapOf("event_id" to it["event_id"], "source_kind" to it["source_kind"], "native_timestamp_ns" to it["native_timestamp_ns"], "tracking_state" to it["tracking_state"]) }
        facts["calibrations_used"] = cals.toList()
        val poseMessages = byTopic["/tracking/pose"] ?: emptyList<Msg>()
        facts["cdr_poses"] = poses.mapIndexed { i, p -> p + ("log_time_ns" to poseMessages[i].logTime.toString()) }
        val close = js("/stateaction/close").lastOrNull()
        var unresolvedCount: Int? = null
        if (close != null) {
            val dropped = state.values.count { it == "dropped" }
            val unresolved = acquired.size - written.size - dropped
            val expect = counts.mapValues { it.value.toString() } + ("unresolved" to unresolved.toString())
            val expectMotion = mapOf("accel" to js("/stateaction/imu/accel").size.toString(), "gyro" to js("/stateaction/imu/gyro").size.toString())
            val expectDrops = dropReasons.map { mapOf("reason" to it.key, "count" to it.value.toString()) }
            val closeDrops = (close["drops"] as List<*>).map { obj(it)!! }.sortedBy { it["reason"] as String }
            if (!same(close["frames"], expect) || close["video_messages"] != video.size.toString() ||
                !same(close["motion_events"], expectMotion) || close["sensor_events"] != sensors.size.toString() ||
                !same(closeDrops, expectDrops)) errors.add("E_COUNT_MISMATCH")
            val outcome = close["outcome"]
            if (outcome == "completed" && unresolved != 0) errors.add("E_OUTCOME_MISMATCH")
            else if (outcome == "failed" && close["failure_reason"] == null) errors.add("E_OUTCOME_MISMATCH")
            facts["close_outcome"] = outcome
            facts["unresolved_frames"] = unresolved
            unresolvedCount = unresolved
        }
        if (rev12) checkV12(errors, facts, byTopic, json, rawImages, acquired, close, unresolvedCount)
        return mapOf("outcome" to if (errors.isEmpty()) "accept" else "reject", "errors" to errors.toList(), "facts" to if (errors.isEmpty()) facts else emptyMap<String, Any?>())
    }

    // ------------------------------------------------------------------ v1.2 rules (SA-68)
    private fun num(x: Any?): Double = (x as Number).toDouble()
    private fun lng(x: Any?): Long = (x as Number).toLong()
    private fun big(x: Any?): java.math.BigInteger = java.math.BigInteger(x as String)
    private fun f32(x: Double) = x.toFloat().toDouble() == x
    private fun closeTo(actual: Double, expected: Double) = Math.abs(actual - expected) <= TOLERANCE * Math.max(1.0, Math.abs(expected))
    private fun nums(x: Any?): List<Double> = (x as List<*>).map { num(it) }

    private fun matmul3(a: List<Double>, b: List<Double>): List<Double> =
        (0 until 3).flatMap { i -> (0 until 3).map { j -> a[3 * i] * b[j] + a[3 * i + 1] * b[3 + j] + a[3 * i + 2] * b[6 + j] } }

    private fun kForm(k: List<Double>) = k[0] > 0 && k[4] > 0 && k[1] == 0.0 && k[3] == 0.0 && k[6] == 0.0 && k[7] == 0.0 && k[8] == 1.0

    /** Saved-raster calibration rules (axis-aligned identity/crop/resize only). */
    private fun calibrationValuesOk(c: Map<String, Any?>, encoder: Map<String, Any?>): Boolean {
        val k = nums(c["K"])
        val src = obj(c["source"])!!
        val t = obj(c["source_to_saved"])!!
        val crop = obj(t["crop"])!!
        val sk = nums(src["K"])
        if (!(kForm(k) && kForm(sk))) return false
        val p = nums(c["P"])
        val wantP = listOf(k[0], k[1], k[2], 0.0, k[3], k[4], k[5], 0.0, k[6], k[7], k[8], 0.0)
        if (p.size != wantP.size) return false
        for (i in p.indices) { val a: Double = p[i]; val b: Double = wantP[i]; if (a != b) return false }
        if (lng(crop["left"]) + lng(crop["width"]) > lng(src["width"]) || lng(crop["top"]) + lng(crop["height"]) > lng(src["height"]) ||
            !same(c["saved_width"], t["scaled_width"]) || !same(c["saved_height"], t["scaled_height"])) return false
        if (src["value_type"] == "float32" && !sk.all { f32(it) }) return false
        val sx = num(t["scaled_width"]) / num(crop["width"])
        val sy = num(t["scaled_height"]) / num(crop["height"])
        val m = listOf(sx, 0.0, (0.5 - num(crop["left"])) * sx - 0.5, 0.0, sy, (0.5 - num(crop["top"])) * sy - 0.5, 0.0, 0.0, 1.0)
        val matrix = nums(t["matrix"])
        if (!matrix.indices.all { closeTo(matrix[it], m[it]) }) return false
        val prod = matmul3(matrix, sk)
        if (!k.indices.all { closeTo(k[it], prod[it]) }) return false
        return !((encoder.containsKey("width") && !same(encoder["width"], c["saved_width"])) ||
            (encoder.containsKey("height") && !same(encoder["height"], c["saved_height"])))
    }

    /** Native plane layout beside the stored (tight) layout. */
    private fun planeOk(p: Map<String, Any?>, sample: Int): Boolean {
        val crop = obj(p["crop"])
        val nw = lng(p["native_width"])
        val nh = lng(p["native_height"])
        if (crop != null && (lng(crop["x"]) + lng(crop["width"]) > nw || lng(crop["y"]) + lng(crop["height"]) > nh)) return false
        val region = if (crop != null) lng(crop["width"]) to lng(crop["height"]) else nw to nh
        return lng(p["stored_width"]) == region.first && lng(p["stored_height"]) == region.second &&
            lng(p["native_pixel_stride_bytes"]) >= sample &&
            lng(p["native_row_stride_bytes"]) >= (nw - 1) * lng(p["native_pixel_stride_bytes"]) + sample
    }

    private fun inventoryEntry(inventory: Map<String, Any?>, sensorId: String, errors: MutableSet<String>): Map<String, Any?>? {
        val entries = ((inventory["sensors"] as? List<*>) ?: emptyList<Any?>()).map { obj(it)!! }.filter { it["sensor_id"] == sensorId }
        if (entries.size > 1) errors.add("E_COUNT_MISMATCH")
        return if (entries.size == 1) entries[0] else null
    }

    private fun inventoryCount(inventory: Map<String, Any?>, sensorId: String, n: Int, errors: MutableSet<String>) {
        val entry = inventoryEntry(inventory, sensorId, errors)
        if (n > 0) {
            if (entry == null || entry["supported"] != "yes" || entry["enabled"] != "yes" || entry["observed"] != "yes" || entry["observed_count"] != n.toString()) errors.add("E_COUNT_MISMATCH")
        } else if (entry != null && (entry["observed"] == "yes" || (entry["observed_count"] != null && entry["observed_count"] != "0"))) {
            errors.add("E_COUNT_MISMATCH")
        }
    }

    private class StreamState {
        val ids = HashSet<String>()
        var lastEpoch = -1L
        var lastTs: java.math.BigInteger? = null
        val pairs = HashSet<Pair<Long, java.math.BigInteger>>()
        var events = 0
        var confidence = 0
    }

    private fun checkV12(
        errors: MutableSet<String>, facts: MutableMap<String, Any?>, byTopic: Map<String, List<Msg>>,
        json: Map<String, List<Map<String, Any?>>>, rawImages: Map<String, List<RawImage>>,
        acquired: Map<String, Map<String, Any?>>, close: Map<String, Any?>?, unresolved: Int?,
    ) {
        fun js(t: String) = json[t] ?: emptyList()
        fun rawMsgs(t: String) = byTopic[t] ?: emptyList()
        val profile = js("/stateaction/capture_profile").firstOrNull() ?: emptyMap()
        val clocksMsg = js("/stateaction/clocks").firstOrNull() ?: emptyMap()
        val clocks = obj(clocksMsg["stream_clocks"]) ?: emptyMap()
        val transport = obj(clocksMsg["recorder_transport"])
        val inventory = js("/stateaction/inventory").firstOrNull() ?: emptyMap()
        val frameEvents = js("/stateaction/frame_events")
        facts["wire_contract_revision"] = "stateaction.capture.v1.2"

        // mesh / point cloud: declaration only
        for (sensorId in listOf("mesh", "point_cloud")) {
            val entry = inventoryEntry(inventory, sensorId, errors)
            if (entry != null && (entry["observed"] == "yes" || entry["enabled"] == "yes" || (entry["observed_count"] != null && entry["observed_count"] != "0"))) errors.add("E_UNSUPPORTED_STREAM")
        }

        // calibrations
        val invCals = ((inventory["calibrations"] as? List<*>) ?: emptyList<Any?>()).map { obj(it)!! }
        val ids = invCals.map { it["calibration_id"] }
        if (ids.toSet().size != ids.size) errors.add("E_CALIBRATION_VALUES")
        val invById = LinkedHashMap<Any?, Map<String, Any?>>()
        for (c in invCals) invById[c["calibration_id"]] = c
        val calMsgs = js("/stateaction/calibrations")
        val calPos = HashMap<Any?, Int>()
        val calFacts = ArrayList<Map<String, Any?>>()
        val frameRaw = rawMsgs("/stateaction/frame_events")
        rawMsgs("/stateaction/calibrations").forEachIndexed { idx, m ->
            val c = calMsgs[idx]
            val cid = c["calibration_id"]
            val inv = invById[cid]
            if (inv == null) { errors.add("E_CALIBRATION_UNKNOWN"); return@forEachIndexed }
            if (cid in calPos || inv["state"] != "yes" || inv["stream_id"] != c["stream_id"]) errors.add("E_CALIBRATION_VALUES")
            calPos.putIfAbsent(cid, m.pos)
            if (!calibrationValuesOk(c, obj(profile["encoder"]) ?: emptyMap())) errors.add("E_CALIBRATION_VALUES")
            val firstIdx = frameEvents.indexOfFirst { it["calibration_id"] == cid }
            val firsts = frameEvents.filter { it["calibration_id"] == cid && it["state"] == "acquired" }
            if (firstIdx < 0 || firsts.isEmpty() || m.pos > frameRaw[firstIdx].pos ||
                c["first_source_frame_id"] != firsts[0]["source_frame_id"] || c["first_native_timestamp_ns"] != firsts[0]["native_timestamp_ns"] ||
                c["native_clock_id"] != firsts[0]["native_clock_id"]) errors.add("E_CALIBRATION_ASSOCIATION")
            calFacts.add(mapOf(
                "calibration_id" to cid, "stream_id" to c["stream_id"], "saved_width" to c["saved_width"],
                "saved_height" to c["saved_height"], "first_source_frame_id" to c["first_source_frame_id"],
            ))
        }
        for (inv in invCals) if (inv["state"] == "yes" && inv["calibration_id"] !in calPos) errors.add("E_CALIBRATION_VALUES")
        facts["calibrations"] = calFacts

        // camera metadata
        val meta = js("/stateaction/camera_metadata")
        val seenMeta = HashSet<Any?>()
        for (e in meta) {
            val frame = acquired[e["source_frame_id"] as String]
            if (frame == null || e["source_frame_id"] in seenMeta || (e["native_timestamp_ns"] != null && e["native_timestamp_ns"] != frame["native_timestamp_ns"])) errors.add("E_CAMERA_METADATA")
            seenMeta.add(e["source_frame_id"])
        }
        inventoryCount(inventory, "camera_metadata", meta.size, errors)
        facts["camera_metadata_count"] = meta.size

        // depth
        val events = js("/stateaction/depth_events")
        val images = DEPTH_IMAGE_TOPICS.associateWith { HashMap<Long, MutableList<RawImage>>() }
        for (t in DEPTH_IMAGE_TOPICS) rawMsgs(t).forEachIndexed { i, m -> images.getValue(t).getOrPut(m.sequence) { ArrayList() }.add(rawImages.getValue(t)[i]) }
        val used = HashSet<Pair<String, Long>>()
        fun take(topic: String, sequence: Long): RawImage? {
            val got = images[topic]?.get(sequence) ?: emptyList<RawImage>()
            if (got.size != 1 || !used.add(topic to sequence)) { errors.add("E_DEPTH_EVIDENCE"); return null }
            return got[0]
        }
        val offset = if (transport != null) big(transport["epoch_anchor_ns"]).subtract(big(transport["native_anchor_ns"])) else java.math.BigInteger.ZERO
        val perStream = java.util.TreeMap<String, StreamState>()
        val depthFacts = ArrayList<Map<String, Any?>>()
        for (e in events) {
            val stream = e["stream_id"] as String
            val st = perStream.getOrPut(stream) { StreamState() }
            st.events++
            if (!st.ids.add(e["event_id"] as String)) errors.add("E_DEPTH_EVIDENCE")
            val ts = big(e["native_timestamp_ns"])
            val epoch = lng(e["clock_epoch"])
            if (clocks[stream] != e["native_clock_id"]) errors.add("E_CLOCK_MISMATCH")
            val basis = e["capture_time_basis"]
            if (transport == null || !same(e["clock_mapping_revision"], transport["revision"])) errors.add("E_CLOCK_MISMATCH")
            else if (basis == "transport_mapping") {
                if (e["native_clock_id"] != transport["clock_id"] || e["receipt_native_timestamp_ns"] != null || big(e["capture_time_ns"]) != ts.add(offset)) errors.add("E_CLOCK_MISMATCH")
            } else if (e["receipt_native_timestamp_ns"] == null || big(e["capture_time_ns"]) != big(e["receipt_native_timestamp_ns"]).add(offset)) errors.add("E_CLOCK_MISMATCH")
            val last = st.lastTs
            val rel = e["timestamp_relation"]
            val valid = if (last == null) rel == "first"
            else if (epoch == st.lastEpoch) (rel == "advanced" && ts > last) || (rel == "repeated" && ts == last)
            else rel == "clock_reset" && epoch > st.lastEpoch
            if (!valid) errors.add("E_DEPTH_CADENCE")
            val prov = e["estimate_provenance"]
            if ((rel == "repeated" && prov == "new_estimate") || (rel != "repeated" && prov == "api_repeat")) errors.add("E_DEPTH_CADENCE")
            st.lastEpoch = epoch
            st.lastTs = ts
            st.pairs.add(epoch to ts)
            val acq = e["acquisition_source_frame_id"]
            val mea = e["measurement_source_frame_id"]
            if (acq != null && !acquired.containsKey(acq as String)) errors.add("E_DEPTH_ASSOCIATION")
            if (mea != null && (!acquired.containsKey(mea as String) || acquired.getValue(mea)["native_clock_id"] != e["native_clock_id"] ||
                    acquired.getValue(mea)["native_timestamp_ns"] != e["native_timestamp_ns"])) errors.add("E_DEPTH_ASSOCIATION")
            val cal = e["calibration_id"]
            if (cal != null && (cal !in invById || invById.getValue(cal)["stream_id"] != stream)) errors.add("E_CALIBRATION_UNKNOWN")
            // image evidence
            val d = obj(e["depth"])!!
            val got = take(d["output_channel"] as String, lng(d["output_sequence"]))
            var sha: String? = null
            if (!planeOk(d, 2)) errors.add("E_DEPTH_EVIDENCE")
            else if (got != null) {
                val ok = got.width == lng(d["stored_width"]) && got.height == lng(d["stored_height"]) && got.encoding == "16UC1" &&
                    got.frameId == DEPTH_FRAME_ID && got.step == lng(d["stored_width"]) * 2 && got.data.size.toLong() == got.step * got.height &&
                    got.captureNs.toString() == e["capture_time_ns"]
                if (!ok) errors.add("E_DEPTH_EVIDENCE")
                sha = sha256(got.data)
            }
            val conf = obj(e["confidence"])!!
            var confSha: String? = null
            var confBytes: Int? = null
            if (conf["state"] == "separate_image") {
                st.confidence++
                val cgot = take(conf["output_channel"] as String, lng(conf["output_sequence"]))
                val sameLayout = listOf("native_width", "native_height", "stored_width", "stored_height", "crop").all { same(conf[it], d[it]) }
                val stamp = obj(conf["native_timestamp"])!!
                if (!planeOk(conf, 1) || !sameLayout) errors.add("E_DEPTH_EVIDENCE")
                if (stamp["state"] == "reported" && stamp["native_clock_id"] != clocks["depth_raw_confidence"]) errors.add("E_CLOCK_MISMATCH")
                if (cgot != null) {
                    val ok = cgot.width == lng(conf["stored_width"]) && cgot.height == lng(conf["stored_height"]) && cgot.encoding == "mono8" &&
                        cgot.frameId == DEPTH_FRAME_ID && cgot.step == lng(conf["stored_width"]) && cgot.data.size.toLong() == cgot.step * cgot.height &&
                        cgot.captureNs.toString() == e["capture_time_ns"]
                    if (!ok) errors.add("E_DEPTH_EVIDENCE")
                    confSha = sha256(cgot.data)
                    confBytes = cgot.data.size
                }
            }
            val separate = conf["state"] == "separate_image"
            val stamp = if (separate) obj(conf["native_timestamp"]) else null
            depthFacts.add(mapOf(
                "stream_id" to stream, "event_id" to e["event_id"], "native_timestamp_ns" to e["native_timestamp_ns"],
                "native_clock_id" to e["native_clock_id"], "clock_epoch" to e["clock_epoch"], "timestamp_relation" to rel,
                "estimate_provenance" to prov, "capture_time_basis" to basis, "capture_time_ns" to e["capture_time_ns"],
                "sequence" to d["output_sequence"], "stored_width" to d["stored_width"], "stored_height" to d["stored_height"],
                "native_width" to d["native_width"], "native_height" to d["native_height"], "cropped" to (d["crop"] != null),
                "depth_bytes" to lng(d["stored_width"]) * lng(d["stored_height"]) * 2, "depth_sha256" to sha,
                "confidence_state" to conf["state"], "confidence_bytes" to confBytes, "confidence_sha256" to confSha,
                "confidence_timestamp_state" to stamp?.get("state"), "confidence_native_timestamp_ns" to stamp?.get("native_timestamp_ns"),
            ))
        }
        for (t in DEPTH_IMAGE_TOPICS) for ((sequence, got) in images.getValue(t)) if (got.size != 1 || (t to sequence) !in used) errors.add("E_DEPTH_EVIDENCE")
        facts["depth"] = depthFacts
        facts["depth_streams"] = perStream.mapValues { mapOf("events" to it.value.events, "distinct_native_timestamps" to it.value.pairs.size) }
        for (stream in listOf("depth_raw", "depth_dense")) inventoryCount(inventory, stream, perStream[stream]?.events ?: 0, errors)

        // Close.v2
        if (close == null) return
        for (stream in listOf("depth_raw", "depth_dense")) {
            val st = perStream[stream]
            val entry = linkedMapOf("events" to (st?.events ?: 0).toString(), "distinct_native_timestamps" to (st?.pairs?.size ?: 0).toString())
            if (stream == "depth_raw") entry["confidence_images"] = (st?.confidence ?: 0).toString()
            val c = obj(obj(close["depth"])!![stream])!!
            if (entry.any { (k, v) -> c[k] != v }) errors.add("E_COUNT_MISMATCH")
            val repeated = events.any { it["stream_id"] == stream && it["timestamp_relation"] == "repeated" }
            if ((c["retention_policy"] == "native_updates_only" && repeated) || (c["retention_policy"] == "all_returned_images" && c["skipped_repeats"] != "0")) errors.add("E_DEPTH_CADENCE")
        }
        if (close["calibrations"] != calMsgs.size.toString() || close["camera_metadata"] != meta.size.toString()) errors.add("E_COUNT_MISMATCH")
        val outcome = close["outcome"]
        val reason = close["stop_reason"]
        val drain = close["encoder_drain"]
        val frames = obj(close["frames"])!!
        val bad = (outcome == "completed" && (drain != "eos_reached" || reason !in listOf("user_requested", "duration_limit"))) ||
            ((reason == "writer_error" || reason == "encoder_error" || drain == "encoder_failed") && outcome != "failed") ||
            (reason in listOf("low_storage_reserve", "thermal_critical", "session_interrupted", "camera_lost", "app_terminating") && outcome != "aborted" && outcome != "failed") ||
            (drain == "deadline_exceeded" && outcome == "completed") ||
            (drain == "not_started" && (frames["written"] != "0" || close["video_messages"] != "0")) ||
            (outcome == "unknown" && reason != "unknown")
        if (bad) errors.add("E_OUTCOME_MISMATCH")
        facts["close_stop_reason"] = reason
        facts["encoder_drain"] = drain
        facts["auto_admissible"] = outcome == "completed" && unresolved == 0 && drain == "eos_reached"
    }

    // ------------------------------------------------------------------ encoder buffer sequences
    /** MediaCodec flag values: CODEC_CONFIG=2, END_OF_STREAM=4, PARTIAL_FRAME=8. */
    private fun bufferData(buf: Map<String, Any?>, sources: Map<String, List<ByteArray>>): ByteArray {
        val range = buf["nals"] as? List<*> ?: return ByteArray(0)
        val first = (range[0] as Number).toInt()
        val last = (range[1] as Number).toInt()
        var data = sources.getValue(buf["source"] as String).subList(first, last).fold(ByteArray(0)) { acc, n -> acc + START + n }
        (buf["bytes"] as? List<*>)?.let { data = data.copyOfRange((it[0] as Number).toInt(), (it[1] as Number).toInt()) }
        return data
    }

    fun assembleEncoderBuffers(buffers: List<Map<String, Any?>>, sources: Map<String, List<ByteArray>>): Map<String, Any?> {
        val errors = sortedSetOf<String>()
        val aus = ArrayList<Map<String, Any?>>()
        var config = ByteArray(0)
        var pending: Pair<String, ByteArray>? = null
        var finished = false
        for (buf in buffers) {
            val flags = (buf["flags"] as Number).toInt()
            val data = bufferData(buf, sources)
            if (flags and 2 != 0) {
                if (pending != null) { errors.add("E_INCOMPLETE_AU"); finished = true; break }
                config = data
                continue
            }
            if (flags and 4 != 0 && data.isEmpty()) {
                if (pending != null) errors.add("E_INCOMPLETE_AU")
                finished = true
                break
            }
            val pts = buf["pts_us"]
            if (!isDecimal(pts)) { errors.add("E_PTS_INVALID"); finished = true; break }
            if (pending != null && pending.first != pts) { errors.add("E_PARTIAL_PTS_MISMATCH"); finished = true; break }
            var acc = (pending?.second ?: ByteArray(0)) + data
            if (flags and 8 != 0) { pending = (pts as String) to acc; continue }
            pending = null
            val units = nals(acc)
            if (units != null && units.any { (it[0].toInt() and 31) == 5 }) {
                val types = units.map { it[0].toInt() and 31 }
                val before = types.subList(0, types.indexOfFirst { it == 1 || it == 5 })
                if ((7 !in before || 8 !in before) && config.isNotEmpty()) acc = config + acc
            }
            val (auErrors, idr) = classifyAu(acc)
            if (auErrors.isNotEmpty()) { errors.addAll(auErrors); finished = true; break }
            aus.add(mapOf("pts_us" to pts, "idr" to idr, "bytes" to acc.size, "sha256" to sha256(acc)))
        }
        if (!finished && pending != null) errors.add("E_INCOMPLETE_AU")
        return if (errors.isNotEmpty()) mapOf("outcome" to "reject", "errors" to errors.toList(), "aus" to emptyList<Any>())
        else mapOf("outcome" to "accept", "errors" to emptyList<String>(), "aus" to aus)
    }
}
