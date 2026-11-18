package open.fpvlabs.stera.upload

import open.fpvlabs.stera.source_integrity.FdIdentity

/**
 * Strict, bounded parsing for the `ai.stateaction/native_upload` MethodChannel.
 * The channel is an app-internal, versioned (schemaVersion 1) typed control,
 * not a new HTTP contract; the wire HTTP plans stay the frozen published
 * schemas and are passed through as raw JSON text.
 */
object BridgeArgs {
    const val SCHEMA_VERSION = 1
    const val MAX_STRING = 512
    const val MAX_PLAN_JSON = 4096
    const val MAX_COOKIES = 16
    const val MAX_COOKIE_VALUE = 4096

    class Invalid(message: String) : Exception(message)

    private val COOKIE_NAME = Regex("^[A-Za-z0-9_.\\-]{1,128}$")
    private val COOKIE_VALUE = Regex("^[\\x21-\\x3a\\x3c-\\x7e]{0,4096}$")
    private val OWNER_ID = Regex("^[A-Za-z0-9_\\-]{1,128}$")

    fun root(args: Any?): Map<*, *> {
        val m = args as? Map<*, *> ?: throw Invalid("arguments must be a map")
        val v = m["schemaVersion"]
        if (!(v is Int && v == SCHEMA_VERSION) && !(v is Long && v == SCHEMA_VERSION.toLong())) throw Invalid("schemaVersion must be 1")
        return m
    }

    fun str(m: Map<*, *>, key: String, max: Int = MAX_STRING): String {
        val v = m[key] as? String ?: throw Invalid("$key must be a string")
        if (v.isEmpty() || v.length > max) throw Invalid("$key length out of range")
        return v
    }

    fun optStr(m: Map<*, *>, key: String, max: Int = MAX_STRING): String? {
        if (!m.containsKey(key) || m[key] == null) return null
        return str(m, key, max)
    }

    fun bool(m: Map<*, *>, key: String): Boolean = m[key] as? Boolean ?: throw Invalid("$key must be a bool")

    /** Contract-style decimal string (no sign, no leading zero), up to int64. */
    fun dec(m: Map<*, *>, key: String): Long {
        val s = str(m, key, 19)
        if (!Regex("^(0|[1-9][0-9]{0,18})$").matches(s)) throw Invalid("$key must be a decimal string")
        return s.toLongOrNull() ?: throw Invalid("$key exceeds int64")
    }

    fun ownerId(m: Map<*, *>): String {
        val id = str(m, "ownerId", 128)
        if (!OWNER_ID.matches(id)) throw Invalid("ownerId is not an opaque id")
        return id
    }

    fun cookies(m: Map<*, *>): List<StoredCookie> {
        val list = m["cookies"] as? List<*> ?: throw Invalid("cookies must be a list")
        if (list.size > MAX_COOKIES) throw Invalid("too many cookies")
        return list.map { raw ->
            val c = raw as? Map<*, *> ?: throw Invalid("cookie must be a map")
            val name = str(c, "name", 128)
            val value = c["value"] as? String ?: throw Invalid("cookie value")
            val path = str(c, "path", 256)
            if (!COOKIE_NAME.matches(name) || !COOKIE_VALUE.matches(value) || !path.startsWith("/")) throw Invalid("cookie malformed")
            val exp = c["expiresAtMs"]
            val expires = when (exp) {
                null -> null
                is Int -> exp.toLong()
                is Long -> exp
                else -> throw Invalid("expiresAtMs")
            }
            StoredCookie(name, value, path, c["secure"] == true, expires)
        }
    }

    fun enqueue(m: Map<*, *>): EnqueueRequest {
        val plan = str(m, "planJson", MAX_PLAN_JSON)
        val src = m["source"] as? Map<*, *> ?: throw Invalid("source must be a map")
        val id = src["identity"] as? Map<*, *> ?: throw Invalid("identity must be a map")
        val root = str(src, "root", 1024)
        val rel = str(src, "relativePath", 1024)
        val sha = str(src, "sha256", 64)
        if (!isSha256(sha)) throw Invalid("sha256 malformed")
        val identity = FdIdentity(dec(id, "dev"), dec(id, "inode"), dec(id, "size"), dec(id, "mtimeNs"), dec(id, "ctimeNs"))
        return EnqueueRequest(ownerId(m), dec(m, "ownerGeneration"), plan, SourceBinding(root, rel, sha, identity))
    }

    fun snapshot(t: TaskRecord): Map<String, Any?> {
        val next = (t.parts.filter { it.state == PartState.PENDING && it.nextAttemptAtMs > 0 }.map { it.nextAttemptAtMs } +
            listOf(t.controlNextAttemptAtMs, t.retryAtMs).filter { it > 0 }).minOrNull()
        return mapOf(
            "taskKey" to t.taskKey,
            "ownerId" to t.ownerId,
            "fileId" to t.plan.fileId,
            "recordingId" to t.plan.recordingId,
            "role" to t.plan.role,
            "transportEpoch" to t.plan.transportEpoch,
            "partCount" to t.plan.partCount,
            "landedParts" to t.landedCount,
            "sizeBytes" to t.plan.sizeBytes.toString(),
            "state" to t.state.wire,
            "reason" to t.reason,
            "needsVisibleResume" to t.needsVisibleResume,
            "nextAttemptAtMs" to next?.toString(),
            "updatedAtMs" to t.updatedAtMs.toString(),
        )
    }
}
