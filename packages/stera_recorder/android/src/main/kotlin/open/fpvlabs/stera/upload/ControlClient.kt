package open.fpvlabs.stera.upload

import java.io.IOException
import java.util.Locale
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * Exact-origin rules. Production and Tailscale/Render origins must be HTTPS.
 * Plain HTTP is accepted only when [allowLoopbackCleartext] (an explicit,
 * emulator/test-only manifest switch, false by default) and the host is the
 * loopback or the emulator host alias.
 */
object OriginPolicy {
    private val LOOPBACK = setOf("127.0.0.1", "localhost", "10.0.2.2", "[::1]")

    /** True when [host] (as written in a URL authority, lowercase) is an explicit loopback/emulator-alias host. */
    fun isLoopbackHost(host: String): Boolean = host.lowercase(Locale.ROOT) in LOOPBACK

    fun normalize(raw: String, allowLoopbackCleartext: Boolean): String {
        val m = Regex("^(https?)://([A-Za-z0-9.\\-]+|\\[::1\\])(?::([0-9]{1,5}))?/?$").matchEntire(raw.trim())
            ?: throw PlanException("origin_invalid", "origin must be scheme://host[:port]")
        val scheme = m.groupValues[1]
        val host = m.groupValues[2].lowercase(Locale.ROOT)
        val port = m.groupValues[3]
        if (port.isNotEmpty() && (port.toInt() !in 1..65535)) throw PlanException("origin_invalid", "port")
        if (scheme == "http" && !(allowLoopbackCleartext && host in LOOPBACK)) {
            throw PlanException("origin_cleartext", "plain HTTP is only allowed for explicit emulator loopback")
        }
        val defaultPort = if (scheme == "https") "443" else "80"
        return if (port.isEmpty() || port == defaultPort) "$scheme://$host" else "$scheme://$host:$port"
    }
}

/** Failure categories of the control plane; none carries a URL, cookie or token. */
enum class ControlKind {
    AUTH, FORBIDDEN, NOT_FOUND, CONFLICT, TRANSIENT, PERMANENT, NETWORK,

    /** The stored session is no longer the one this client was bound to (logout, owner/origin switch). */
    STALE_SESSION,
}

class ControlException(val kind: ControlKind, val status: Int, val code: String) :
    Exception("control ${kind.name} status=$status code=$code")

class ReceiptEntry(val partNumber: Int, val etag: String, val sizeBytes: Long)

class MeResult(val userId: String, val activeCollector: Boolean)

/**
 * Identity of the cookie bundle a request was built from. [epoch] changes on
 * every owner/origin replacement and on clear (so an old A request can never
 * touch a newer A-after-B session); [revision] changes on every rotation or
 * refresh of the same session (so a late response never overwrites a newer one).
 */
class SessionLease(val ownerId: String, val origin: String, val epoch: Long, val revision: Long)

/**
 * Session jar for the one configured origin. It holds the same Better Auth
 * cookies the Dart client uses (no custom token), keeps them only in the
 * Keystore-backed [SessionStore], and rejects an older cookie bundle than the
 * one it holds so a stale Dart push can never overwrite a newer native
 * rotation. Reads and `Set-Cookie` ingestion are bound to a [SessionLease].
 */
class SessionJar(private val store: SessionStore, private val clock: Clock) {
    private val lock = Any()
    /** In-memory only: requests never span a process, so it need not survive one. */
    private var epoch = 0L

    /**
     * Set lock-free the instant a logout/owner invalidation is received: no cookie is handed out and no
     * `Set-Cookie` is ingested from then on, even while a slow vault write holds [lock]. Cleared once the
     * durable [clear] (or a newer legitimate [replaceIfNewer]) completes.
     */
    @Volatile private var fenced = false

    fun fence() { fenced = true }

    fun bundle(): SessionBundle? = synchronized(lock) { store.read() }

    enum class Bind { REPLACE, IDENTICAL, STALE, CONFLICT }

    /**
     * How [next] relates to the stored bundle of the same owner+origin: a higher revision replaces; the same
     * revision with identical cookies is an idempotent no-op; a lower revision is stale; the same revision with
     * different cookies is a conflict (never silently overwritten). A different owner/origin always replaces.
     */
    fun assess(next: SessionBundle): Bind = synchronized(lock) {
        val cur = store.read()
        val same = cur != null && cur.ownerId == next.ownerId && cur.origin == next.origin
        when {
            !same || next.revision > cur!!.revision -> Bind.REPLACE
            next.revision < cur.revision -> Bind.STALE
            sameCookies(cur.cookies, next.cookies) -> Bind.IDENTICAL
            else -> Bind.CONFLICT
        }
    }

    private fun sameCookies(a: List<StoredCookie>, b: List<StoredCookie>): Boolean {
        fun key(c: StoredCookie) = listOf(c.name, c.value, c.path, c.secure.toString(), c.expiresAtMs.toString()).joinToString("\u0000")
        return a.map(::key).sorted() == b.map(::key).sorted()
    }

    /** Stores [next] only when it replaces; true when written. */
    fun replaceIfNewer(next: SessionBundle): Boolean = synchronized(lock) {
        if (assess(next) != Bind.REPLACE) return false
        val cur = store.read()
        val sameSession = cur != null && cur.ownerId == next.ownerId && cur.origin == next.origin
        store.write(next)
        if (!sameSession) epoch++
        true
    }

    fun clear() = synchronized(lock) { store.clear(); epoch++; fenced = false }

    /** The lease for the bundle of exactly [ownerId] on [origin], or null when none/another is stored. */
    fun lease(ownerId: String, origin: String): SessionLease? {
        if (fenced) return null
        return leaseLocked(ownerId, origin)
    }

    private fun leaseLocked(ownerId: String, origin: String): SessionLease? = synchronized(lock) {
        val b = store.read() ?: return null
        if (b.ownerId != ownerId || b.origin != origin) return null
        SessionLease(b.ownerId, b.origin, epoch, b.revision)
    }

    /** True when the stored bundle is still the very session [lease] was taken from (any rotation counts as stale). */
    private fun sameEpoch(lease: SessionLease, b: SessionBundle): Boolean =
        b.ownerId == lease.ownerId && b.origin == lease.origin && epoch == lease.epoch

    /** `Cookie` header for a request path, only while [lease] is still the current epoch; else null. */
    fun cookieHeader(lease: SessionLease, path: String): String? {
        if (fenced) return null
        return cookieHeaderLocked(lease, path)
    }

    private fun cookieHeaderLocked(lease: SessionLease, path: String): String? = synchronized(lock) {
        if (fenced) return null
        val b = store.read() ?: return null
        if (!sameEpoch(lease, b)) return null
        val now = clock.nowMs()
        val usable = b.cookies.filter {
            (it.expiresAtMs == null || it.expiresAtMs > now) && path.startsWith(it.path) &&
                (!it.secure || lease.origin.startsWith("https://"))
        }
        if (usable.isEmpty()) null else usable.joinToString("; ") { "${it.name}=${it.value}" }
    }

    /**
     * Applies `Set-Cookie` values from the response to the request made under
     * [lease]. Dropped entirely when the session changed since the request was
     * built (logout, owner/origin switch, A-after-B, or a newer revision).
     * A cookie with a `Domain` attribute is skipped on its own; the rest apply.
     */
    fun ingest(lease: SessionLease, setCookies: List<String>): Boolean {
        if (fenced) return false
        return ingestLocked(lease, setCookies)
    }

    private fun ingestLocked(lease: SessionLease, setCookies: List<String>): Boolean = synchronized(lock) {
        if (fenced) return false
        val b = store.read() ?: return false
        if (!sameEpoch(lease, b) || b.revision != lease.revision || setCookies.isEmpty()) return false
        val jar = LinkedHashMap<String, StoredCookie>()
        for (c in b.cookies) jar[c.name + "|" + c.path] = c
        var changed = false
        val now = clock.nowMs()
        for (raw in setCookies) {
            val parts = raw.split(";").map { it.trim() }
            val pair = parts.firstOrNull() ?: continue
            val eq = pair.indexOf('=')
            if (eq <= 0) continue
            val name = pair.substring(0, eq)
            val value = pair.substring(eq + 1)
            var path = "/"
            var secure = false
            var maxAge: Long? = null
            var hostOnly = true
            for (attr in parts.drop(1)) {
                val k = attr.substringBefore('=').lowercase(Locale.ROOT)
                val v = attr.substringAfter('=', "")
                when (k) {
                    "path" -> path = v.ifEmpty { "/" }
                    "secure" -> secure = true
                    "max-age" -> maxAge = v.toLongOrNull()
                    "domain" -> hostOnly = false // host-only semantics: skip this cookie only
                }
            }
            if (!hostOnly) continue
            if (name.startsWith("__Secure-") && !secure) continue
            if (name.startsWith("__Host-") && (!secure || path != "/")) continue
            val key = "$name|$path"
            if (value.isEmpty() || (maxAge != null && maxAge <= 0)) {
                if (jar.remove(key) != null) changed = true
            } else {
                val exp = maxAge?.let { now + it * 1000 }
                val next = StoredCookie(name, value, path, secure, exp)
                val old = jar[key]
                if (old == null || old.value != value || old.expiresAtMs != exp) changed = true
                jar[key] = next
            }
        }
        if (changed) store.write(SessionBundle(b.ownerId, b.origin, b.revision + 1, jar.values.toList()))
        changed
    }
}

/**
 * Native owner-bound control client. It calls only the five existing upload
 * routes plus `GET /api/v1/me`; it never creates, cancels or restarts a
 * transport, never completes a provider upload, and never holds provider
 * credentials. Cookies go only to the exact configured origin and redirects
 * are never followed (the transport guarantees that).
 */
class ControlClient(
    private val origin: String,
    /** The principal this client acts for; another owner's cookie is never sent for it. */
    private val expectedOwnerId: String,
    private val jar: SessionJar,
    private val transport: HttpTransport,
    private val cancel: CancelToken,
    /** Always the frozen 64 MiB in production; JVM tests use a small part size. */
    private val partSize: Long = Limits.PART_BYTES,
) {
    /** Epoch of the session first used; every later request must still belong to it. */
    private var pinnedEpoch: Long? = null

    /** Same bound session, another cancellation scope (used once, to classify a conflict after our own cancel). */
    fun withCancel(token: CancelToken): ControlClient =
        ControlClient(origin, expectedOwnerId, jar, transport, token, partSize).also { it.pinnedEpoch = pinnedEpoch }

    fun me(): MeResult {
        val data = request("GET", "/api/v1/me", null)
        try {
            val user = data.getJSONObject("user")
            val access = data.getJSONObject("access")
            val roles = access.getJSONArray("roles")
            var collector = false
            for (i in 0 until roles.length()) if (roles.getString(i) == "collector") collector = true
            return MeResult(user.getString("id"), access.getString("status") == "active" && collector)
        } catch (e: JSONException) {
            throw ControlException(ControlKind.PERMANENT, 200, "malformed_me")
        }
    }

    fun getPlan(fileId: String): UploadPlan = plan(request("GET", "/api/v1/uploads/${id(fileId)}", null))

    fun reconcile(fileId: String, epoch: Int): UploadPlan = plan(transition(fileId, "reconcile", epoch))

    fun complete(fileId: String, epoch: Int): UploadPlan = plan(transition(fileId, "complete", epoch))

    /** Signs 1..32 part numbers; the answer is checked against the frozen [plan]. */
    fun sign(plan: UploadPlan, parts: List<Int>, allowPlainHttp: Boolean): List<SignedPart> {
        val body = JSONObject().put("expectedTransportEpoch", plan.transportEpoch)
            .put("partNumbers", JSONArray(parts))
        val data = request("POST", "/api/v1/uploads/${id(plan.fileId)}/parts/sign", body)
        try {
            return SignedPart.parseAll(data, plan, parts, allowPlainHttp)
        } catch (e: PlanException) {
            throw ControlException(ControlKind.PERMANENT, 200, e.code)
        }
    }

    fun receipts(plan: UploadPlan, receipts: List<ReceiptEntry>) {
        val arr = JSONArray()
        for (r in receipts) {
            arr.put(JSONObject().put("partNumber", r.partNumber).put("etag", r.etag).put("sizeBytes", r.sizeBytes.toString()))
        }
        request(
            "PUT", "/api/v1/uploads/${id(plan.fileId)}/parts/receipts",
            JSONObject().put("expectedTransportEpoch", plan.transportEpoch).put("receipts", arr),
        )
    }

    private fun transition(fileId: String, name: String, epoch: Int): JSONObject =
        request("POST", "/api/v1/uploads/${id(fileId)}/$name", JSONObject().put("expectedTransportEpoch", epoch))

    private fun id(fileId: String): String {
        if (!isUuid(fileId)) throw ControlException(ControlKind.PERMANENT, 0, "bad_file_id")
        return fileId
    }

    private fun plan(data: JSONObject): UploadPlan = try {
        UploadPlan.fromJson(data, partSize)
    } catch (e: PlanException) {
        throw ControlException(ControlKind.PERMANENT, 200, e.code)
    }

    private fun request(method: String, path: String, body: JSONObject?): JSONObject {
        cancel.check()
        val headers = LinkedHashMap<String, String>()
        headers["accept"] = "application/json"
        headers["x-stateaction-client"] = "android"
        if (method != "GET") {
            // Better Auth refuses cookie-bearing mutations without the exact backend Origin.
            headers["origin"] = origin
            headers["content-type"] = "application/json"
        }
        val lease = synchronized(this) {
            val l = jar.lease(expectedOwnerId, origin)
            val pin = pinnedEpoch
            if (l == null) {
                if (pin != null || jar.bundle() != null) throw ControlException(ControlKind.STALE_SESSION, 0, "session_changed")
                throw ControlException(ControlKind.AUTH, 0, "session_required")
            }
            if (pin == null) pinnedEpoch = l.epoch else if (pin != l.epoch) throw ControlException(ControlKind.STALE_SESSION, 0, "session_changed")
            l
        }
        jar.cookieHeader(lease, path)?.let { headers["cookie"] = it }
        val resp = try {
            transport.control(method, origin + path, headers, body?.toString()?.toByteArray(Charsets.UTF_8), cancel)
        } catch (e: CancelledException) {
            throw e
        } catch (e: IOException) {
            throw ControlException(ControlKind.NETWORK, 0, "network")
        }
        // Rotated cookies are applied even on failure (a 401 may clear them).
        jar.ingest(lease, resp.setCookies)
        if (resp.body.size > Limits.MAX_CONTROL_RESPONSE_BYTES) throw ControlException(ControlKind.PERMANENT, resp.status, "response_too_large")
        val json = try {
            if (resp.body.isEmpty()) JSONObject() else JSONObject(String(resp.body, Charsets.UTF_8))
        } catch (e: JSONException) {
            JSONObject()
        }
        if (resp.status in 200..299) {
            return json.optJSONObject("data") ?: throw ControlException(ControlKind.PERMANENT, resp.status, "malformed_envelope")
        }
        val err = json.optJSONObject("error")
        val code = err?.optString("code", "")?.takeIf { it.matches(Regex("^[a-z_]{1,40}$")) } ?: "control_failed"
        val retryable = err?.optBoolean("retryable", false) ?: false
        val kind = when {
            resp.status == 401 -> ControlKind.AUTH
            resp.status == 403 -> ControlKind.FORBIDDEN
            resp.status == 404 -> ControlKind.NOT_FOUND
            resp.status == 409 -> ControlKind.CONFLICT
            resp.status == 429 || resp.status >= 500 || retryable -> ControlKind.TRANSIENT
            else -> ControlKind.PERMANENT
        }
        throw ControlException(kind, resp.status, code)
    }
}
