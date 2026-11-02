import org.json.JSONArray
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest

/**
 * Portable Kotlin reader for the stateaction.capture.v1.1 contract (SA-50). It is a dependency-free port of
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
        StrictSchema(StrictJson.parse(java.io.File(captureDir, CUSTOM.getValue(name)).readBytes()) as Map<String, Any?>)
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
        is Int, is Long -> x.toString()
        is String -> quote(x)
        is Map<*, *> -> x.keys.map { it as String }.sorted().joinToString(",", "{", "}") { quote(it) + ":" + canonical(x[it]) }
        is List<*> -> x.joinToString(",", "[", "]") { canonical(it) }
        else -> error("Unsupported value ${x.javaClass}")
    }

    // ------------------------------------------------------------------ MCAP
    class Msg(val channel: Int, val sequence: Long, val logTime: Long, val data: ByteArray)
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
                    out.messages.add(Msg(ch, seq, log, ByteArray(limit - 22).also { body.get(it) }))
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
        fun varint(): Long {
            var shift = 0
            var v = 0L
            while (true) {
                if (pos >= b.size || shift > 63) throw Malformed()
                val x = b[pos++].toInt() and 255
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

    fun check(data: ByteArray, manifest: Map<String, String>): Map<String, Any?> {
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
        // Exact per-channel encodings and reviewed schema identity.
        for (ch in f.channels.values) {
            val schema = f.schemas[ch.schemaId]
            val want = CHANNELS[ch.topic]
            if (schema == null || want == null || schema.name != want[0] || schema.encoding != want[1] || ch.encoding != want[2]) errors.add("E_CHANNEL_ENCODING")
            else if (schema.name == POSE_SCHEMA && sha256(schema.data) != manifest[POSE_SCHEMA_FILE]) errors.add("E_CHANNEL_ENCODING")
        }
        val hashes = java.util.TreeMap<String, String>()
        for (s in f.schemas.values) {
            val digest = sha256(s.data)
            hashes[s.name] = digest
            if (s.name == "foxglove.CompressedVideo") {
                if (digest != manifest["foxglove-compressed-video.desc"]) errors.add("E_DESCRIPTOR_HASH")
            } else if (s.name in CUSTOM) {
                if (digest != manifest[CUSTOM.getValue(s.name)]) errors.add("E_SCHEMA_MISMATCH")
            }
        }
        facts["schema_sha256"] = hashes
        // Decode every message once; an undecodable message is a defined reject.
        val raw = java.util.TreeMap<String, List<Any?>>()
        var videos = emptyList<Video>()
        var poses = emptyList<Map<String, Any?>>()
        try {
            for ((topic, msgs) in byTopic) {
                val want = CHANNELS[topic] ?: continue
                when (want[2]) {
                    "json" -> raw[topic] = msgs.map { m -> StrictJson.parse(m.data) }
                    "protobuf" -> videos = msgs.map { decodeVideo(it.data) }
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
            val validator = contractSchema(CHANNELS.getValue(topic)[0])
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
        }
        return mapOf("outcome" to if (errors.isEmpty()) "accept" else "reject", "errors" to errors.toList(), "facts" to if (errors.isEmpty()) facts else emptyMap<String, Any?>())
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
