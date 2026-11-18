package open.fpvlabs.stera.upload

import java.io.File
import java.io.IOException
import open.fpvlabs.stera.source_integrity.FdIdentity

interface Clock {
    fun nowMs(): Long
}

object SystemClock : Clock {
    override fun nowMs(): Long = System.currentTimeMillis()
}

/** Cooperative cancellation shared by the engine, connections and chunk copies. */
class CancelToken {
    @Volatile var cancelled: Boolean = false
        private set

    /** First reason wins: `owner_changed`, `policy:<why>`, `paused`, `system_stop`, `user_cancel`. */
    @Volatile var reason: String = "cancelled"
        private set
    private val hooks = java.util.concurrent.CopyOnWriteArrayList<() -> Unit>()

    @Synchronized
    fun cancel(why: String = "cancelled") {
        if (!cancelled) reason = why
        cancelled = true
        for (h in hooks) runCatching(h)
    }

    /** Registers a hook (e.g. disconnect an HTTP connection); runs at once if already cancelled. */
    fun onCancel(hook: () -> Unit): () -> Unit {
        hooks += hook
        if (cancelled) runCatching(hook)
        return { hooks -= hook }
    }

    fun check() {
        if (cancelled) throw CancelledException()
    }
}

class CancelledException : IOException("cancelled")

/** Network/IO failure with no HTTP status (timeout, reset, DNS). Always retryable and uncertain. */
class NetworkIoException(message: String) : IOException(message)

class HttpResponse(val status: Int, val body: ByteArray, val setCookies: List<String>)

class PutResponse(val status: Int, val etag: String?)

/**
 * HTTP seam. One implementation per OS job: it uses that job's selected
 * `Network` for control and provider connections. Redirects are never
 * followed. `control` carries the session cookie header the caller built for
 * the exact configured origin; `putFile` never receives cookies.
 */
interface HttpTransport {
    @Throws(IOException::class)
    fun control(method: String, url: String, headers: Map<String, String>, body: ByteArray?, cancel: CancelToken): HttpResponse

    /** PUT [length] bytes of [file] to a signed [url], streaming with [Limits.STREAM_BUFFER_BYTES]. */
    @Throws(IOException::class)
    fun putFile(url: String, headers: Map<String, String>, file: File, length: Long, cancel: CancelToken): PutResponse
}

interface EnvProbe {
    fun snapshot(): EnvSnapshot
}

/** Why a confined source cannot be read (stable wire codes, aligned with the SA-18 hasher). */
class SourceException(val code: String, message: String) : Exception(message)

/** An opened, descriptor-bound source. Reads are positional so two parts never share an offset. */
interface OpenSource : AutoCloseable {
    /** Re-`fstat` the descriptor and re-check its path binding; throws [SourceException] on any change. */
    fun verify(expected: FdIdentity)

    /** Positional read; returns 0 at EOF. */
    fun readAt(offset: Long, buf: ByteArray, len: Int): Int
}

interface SourceOpener {
    /** Opens `root/relativePath` confined (SA-18 rules) and verifies it equals [expected]. */
    @Throws(SourceException::class)
    fun open(root: String, relativePath: String, expected: FdIdentity): OpenSource
}

/** Persisted session cookies (Keystore-backed on Android). Never logged. */
class StoredCookie(
    val name: String,
    val value: String,
    val path: String,
    val secure: Boolean,
    val expiresAtMs: Long?,
) {
    override fun toString(): String = "StoredCookie($name, value=<redacted>)"
}

class SessionBundle(
    val ownerId: String,
    val origin: String,
    val revision: Long,
    val cookies: List<StoredCookie>,
)

interface SessionStore {
    fun read(): SessionBundle?
    fun write(bundle: SessionBundle)
    fun clear()
}
