package open.fpvlabs.stera.upload

import org.json.JSONArray
import org.json.JSONObject

/**
 * Frozen transport constants (published `http.upload-plan.v1`, SA-12/SA-20).
 * The server owns every one of them; the native client only validates and
 * never negotiates a different part size, concurrency or buffer bound.
 */
object Limits {
    const val PART_BYTES = 67_108_864L
    const val MAX_PARTS = 10_000
    const val MAX_FILE_BYTES = 107_374_182_400L
    const val MAX_MANIFEST_BYTES = 1_048_576L

    /** At most two provider PUTs in flight. */
    const val MAX_CONCURRENT_PUTS = 2

    /** At most three temporary chunk files on disk (2 in flight + 1 prefetched). */
    const val MAX_TEMP_CHUNKS = 3

    /** Streaming copy/PUT buffer: bounded, never the whole part or file. */
    const val STREAM_BUFFER_BYTES = 128 * 1024

    /** `parts-sign` accepts 1..32 numbers; the engine asks for at most this many. */
    const val SIGN_BATCH = 4

    const val MAX_CONTROL_RESPONSE_BYTES = 512 * 1024
}

/** A refusal with a stable, secret-free [code]. */
class PlanException(val code: String, message: String) : Exception(message)

private val UUID_RE = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
private val SHA_RE = Regex("^[0-9a-f]{64}$")
private val DEC_RE = Regex("^(0|[1-9][0-9]{0,10})$")
private val ROLES = setOf("source_mcap", "recorder_metadata", "calibration", "source_manifest")
private val PLAN_STATES = setOf(
    "reserved", "uploading", "completing", "completed", "verified", "cancelled", "failed", "expired",
)

fun isUuid(value: String): Boolean = UUID_RE.matches(value)
fun isSha256(value: String): Boolean = SHA_RE.matches(value)

/** Parses a contract decimal-string int64 (no sign, no leading zero, <= 11 digits). */
internal fun decimal(value: Any?, what: String): Long {
    if (value !is String || !DEC_RE.matches(value)) throw PlanException("plan_invalid", "$what is not a decimal string")
    return value.toLong()
}

/**
 * `http.upload-plan.v1`, parsed strictly (exact key set). Every field except
 * [state] is immutable for the life of a transport epoch.
 */
data class UploadPlan(
    val fileId: String,
    val recordingId: String,
    val role: String,
    val sizeBytes: Long,
    val sha256: String,
    val transportEpoch: Int,
    val partCount: Int,
    val state: String,
    val transportExpiresAtMs: Long,
    /** Always [Limits.PART_BYTES] in production; only JVM tests build smaller plans through the constructor. */
    val partSizeBytes: Long = Limits.PART_BYTES,
) {
    fun partOffset(partNumber: Int): Long {
        require(partNumber in 1..partCount) { "part out of plan" }
        return (partNumber - 1).toLong() * partSizeBytes
    }

    fun partLength(partNumber: Int): Long =
        minOf(partSizeBytes, sizeBytes - partOffset(partNumber))

    /** Same immutable identity (everything but the live [state]). */
    fun sameTransport(other: UploadPlan): Boolean =
        fileId == other.fileId && recordingId == other.recordingId && role == other.role &&
            sizeBytes == other.sizeBytes && sha256 == other.sha256 &&
            transportEpoch == other.transportEpoch && partCount == other.partCount &&
            partSizeBytes == other.partSizeBytes

    fun toJson(): JSONObject = JSONObject()
        .put("fileId", fileId).put("recordingId", recordingId).put("role", role)
        .put("sizeBytes", sizeBytes.toString()).put("sha256", sha256)
        .put("transportEpoch", transportEpoch).put("partSizeBytes", partSizeBytes.toString())
        .put("partCount", partCount).put("state", state)
        .put("transportExpiresAt", Rfc3339.format(transportExpiresAtMs))

    companion object {
        private val KEYS = setOf(
            "fileId", "recordingId", "role", "sizeBytes", "sha256", "transportEpoch",
            "partSizeBytes", "partCount", "state", "transportExpiresAt",
        )

        fun parse(json: String, partSize: Long = Limits.PART_BYTES): UploadPlan = try {
            fromJson(JSONObject(json), partSize)
        } catch (e: org.json.JSONException) {
            throw PlanException("plan_invalid", "plan is not JSON")
        }

        fun fromJson(o: JSONObject, partSize: Long = Limits.PART_BYTES): UploadPlan {
            val keys = o.keys().asSequence().toSet()
            if (keys != KEYS) throw PlanException("plan_invalid", "plan keys differ from http.upload-plan.v1")
            fun str(k: String): String = o.opt(k) as? String ?: throw PlanException("plan_invalid", "$k not a string")
            val fileId = str("fileId")
            val recordingId = str("recordingId")
            val role = str("role")
            val sha = str("sha256")
            val state = str("state")
            if (!isUuid(fileId) || !isUuid(recordingId)) throw PlanException("plan_invalid", "id is not a UUID")
            if (role !in ROLES) throw PlanException("plan_invalid", "unknown role")
            if (!isSha256(sha)) throw PlanException("plan_invalid", "sha256 malformed")
            if (state !in PLAN_STATES) throw PlanException("plan_invalid", "unknown state")
            val size = decimal(o.opt("sizeBytes"), "sizeBytes")
            if (size < 1 || size > Limits.MAX_FILE_BYTES) throw PlanException("plan_invalid", "size out of range")
            if (role == "source_manifest" && size > Limits.MAX_MANIFEST_BYTES) {
                throw PlanException("plan_invalid", "manifest too large")
            }
            if (str("partSizeBytes") != partSize.toString()) {
                throw PlanException("plan_invalid", "part size is not the frozen 64 MiB")
            }
            val epoch = (o.opt("transportEpoch") as? Int) ?: throw PlanException("plan_invalid", "epoch")
            val count = (o.opt("partCount") as? Int) ?: throw PlanException("plan_invalid", "partCount")
            if (epoch !in 1..1000) throw PlanException("plan_invalid", "epoch out of range")
            val expected = ((size + partSize - 1) / partSize)
            if (count < 1 || count > Limits.MAX_PARTS || count.toLong() != expected) {
                throw PlanException("plan_invalid", "partCount != ceil(size / partSize)")
            }
            val expires = Rfc3339.parse(str("transportExpiresAt"))
                ?: throw PlanException("plan_invalid", "transportExpiresAt malformed")
            return UploadPlan(fileId, recordingId, role, size, sha, epoch, count, state, expires, partSize)
        }
    }
}

/** One server-signed provider PUT. [url] is a bearer capability: never log or persist. */
class SignedPart(
    val partNumber: Int,
    val url: String,
    val headers: Map<String, String>,
    val offsetBytes: Long,
    val lengthBytes: Long,
    val expiresAtMs: Long,
) {
    override fun toString(): String = "SignedPart(part=$partNumber, url=<redacted>)"

    companion object {
        /**
         * Parses `http.parts-signed.v1` and checks every part against the
         * frozen [plan]: number, offset and length must be the plan's, never the
         * server's free choice for an unplanned range.
         */
        fun parseAll(body: JSONObject, plan: UploadPlan, requested: Collection<Int>, allowPlainHttp: Boolean): List<SignedPart> {
            val epoch = body.opt("transportEpoch") as? Int ?: throw PlanException("signed_invalid", "epoch")
            if (epoch != plan.transportEpoch) throw PlanException("epoch_changed", "signed epoch differs")
            val arr: JSONArray = body.optJSONArray("parts") ?: throw PlanException("signed_invalid", "parts")
            if (arr.length() < 1 || arr.length() > 32) throw PlanException("signed_invalid", "part count")
            val out = ArrayList<SignedPart>(arr.length())
            val seen = HashSet<Int>()
            for (i in 0 until arr.length()) {
                val p = arr.optJSONObject(i) ?: throw PlanException("signed_invalid", "part")
                val n = p.opt("partNumber") as? Int ?: throw PlanException("signed_invalid", "partNumber")
                if (n !in requested || !seen.add(n)) throw PlanException("signed_invalid", "unrequested or duplicate part")
                if (p.opt("method") != "PUT") throw PlanException("signed_invalid", "method")
                val url = p.opt("url") as? String ?: throw PlanException("signed_invalid", "url")
                checkProviderUrl(url, allowPlainHttp)
                val offset = decimal(p.opt("offsetBytes"), "offsetBytes")
                val length = decimal(p.opt("lengthBytes"), "lengthBytes")
                if (offset != plan.partOffset(n) || length != plan.partLength(n)) {
                    throw PlanException("signed_invalid", "range differs from the frozen plan")
                }
                val hdr = p.optJSONObject("headers") ?: throw PlanException("signed_invalid", "headers")
                val headers = LinkedHashMap<String, String>()
                for (k in hdr.keys()) {
                    val v = hdr.opt(k) as? String ?: throw PlanException("signed_invalid", "header value")
                    headers[k] = v
                }
                checkProviderHeaders(headers, length)
                val expires = Rfc3339.parse(p.opt("expiresAt") as? String ?: "")
                    ?: throw PlanException("signed_invalid", "expiresAt")
                out += SignedPart(n, url, headers, offset, length, expires)
            }
            return out
        }

        private val FORBIDDEN_HEADERS = setOf("cookie", "authorization", "origin", "x-stateaction-client")

        /** Control credentials must never reach the provider; signed headers are only provider-shaped ones. */
        fun checkProviderHeaders(headers: Map<String, String>, length: Long) {
            for ((k, v) in headers) {
                val lower = k.lowercase()
                if (lower in FORBIDDEN_HEADERS) throw PlanException("signed_invalid", "forbidden signed header")
                if (v.any { it == '\r' || it == '\n' }) throw PlanException("signed_invalid", "header injection")
                if (lower == "content-length" && v != length.toString()) {
                    throw PlanException("signed_invalid", "signed content-length differs from the planned part")
                }
            }
        }

        private val PLAIN_HOST = Regex("^http://([^/?#:@\\[\\]]+|\\[::1\\])(?::[0-9]{1,5})?(?:[/?#].*)?$")

        private fun plainHttpHostIsLoopback(url: String): Boolean {
            val host = PLAIN_HOST.matchEntire(url)?.groupValues?.get(1) ?: return false
            return OriginPolicy.isLoopbackHost(host)
        }

        fun checkProviderUrl(url: String, allowPlainHttp: Boolean) {
            // Cleartext provider URLs exist only for the emulator fixture: loopback/emulator-alias hosts, never a named host.
            val ok = url.startsWith("https://") ||
                (allowPlainHttp && url.startsWith("http://") && plainHttpHostIsLoopback(url))
            if (!ok || url.length > 4096 || url.any { it.code < 0x21 || it.code > 0x7e }) {
                throw PlanException("signed_invalid", "provider URL not acceptable")
            }
        }
    }
}

/** RFC 3339 UTC (`...Z`, up to nanosecond fraction) <-> epoch millis without java.time (minSdk 24). */
object Rfc3339 {
    private val RE = Regex("^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\\.([0-9]{1,9}))?Z$")

    fun parse(value: String): Long? {
        val m = RE.matchEntire(value) ?: return null
        val g = m.groupValues
        val y = g[1].toInt(); val mo = g[2].toInt(); val d = g[3].toInt()
        val h = g[4].toInt(); val mi = g[5].toInt(); val s = g[6].toInt()
        if (mo !in 1..12 || d !in 1..31 || h > 23 || mi > 59 || s > 59) return null
        val millis = if (g[7].isEmpty()) 0L else (g[7] + "00").substring(0, 3).toLong()
        return daysFromCivil(y, mo, d) * 86_400_000L + h * 3_600_000L + mi * 60_000L + s * 1000L + millis
    }

    fun format(epochMs: Long): String {
        val days = Math.floorDiv(epochMs, 86_400_000L)
        val rem = Math.floorMod(epochMs, 86_400_000L)
        val (y, m, d) = civilFromDays(days)
        val h = rem / 3_600_000L; val mi = rem % 3_600_000L / 60_000L
        val s = rem % 60_000L / 1000L; val ms = rem % 1000L
        return "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ".format(y, m, d, h, mi, s, ms)
    }

    // Howard Hinnant's civil-date algorithms.
    private fun daysFromCivil(y0: Int, m: Int, d: Int): Long {
        val y = if (m <= 2) y0 - 1 else y0
        val era = Math.floorDiv(y, 400)
        val yoe = y - era * 400
        val doy = (153 * (m + (if (m > 2) -3 else 9)) + 2) / 5 + d - 1
        val doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era.toLong() * 146097L + doe - 719468L
    }

    private fun civilFromDays(z0: Long): Triple<Int, Int, Int> {
        val z = z0 + 719468L
        val era = Math.floorDiv(z, 146097L)
        val doe = (z - era * 146097L).toInt()
        val yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365
        val y = yoe + era * 400
        val doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
        val mp = (5 * doy + 2) / 153
        val d = doy - (153 * mp + 2) / 5 + 1
        val m = if (mp < 10) mp + 3 else mp - 9
        return Triple((if (m <= 2) y + 1 else y).toInt(), m, d)
    }
}
