package open.fpvlabs.stera.upload

import java.io.File
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import open.fpvlabs.stera.source_integrity.FdIdentity
import org.json.JSONArray
import org.json.JSONObject

const val OWNER = "owner_a_0123456789"
const val OTHER = "owner_b_0123456789"
const val ORIGIN = "https://api.test"
const val FILE_ID = "11111111-1111-4111-8111-111111111111"
const val REC_ID = "22222222-2222-4222-8222-222222222222"
const val PART = 100L

class FakeClock(var now: Long = 1_800_000_000_000L) : Clock {
    override fun nowMs(): Long = now
    fun advance(ms: Long) { now += ms }
}

class MemorySessionStore(var bundle: SessionBundle? = null) : SessionStore {
    override fun read(): SessionBundle? = bundle
    override fun write(bundle: SessionBundle) { this.bundle = bundle }
    override fun clear() { bundle = null }
}

class FakeEnv(
    @Volatile var snap: EnvSnapshot = EnvSnapshot(networkAvailable = true, unmetered = true, charging = true),
) : EnvProbe {
    override fun snapshot(): EnvSnapshot = snap
}

fun sha(n: Int): String = "%064x".format(n)

fun testPlan(size: Long, epoch: Int = 1, state: String = "uploading", clock: Clock = FakeClock()): UploadPlan {
    val count = ((size + PART - 1) / PART).toInt()
    return UploadPlan(
        FILE_ID, REC_ID, "source_mcap", size, sha(7), epoch, count, state,
        clock.nowMs() + 3 * 24 * 3_600_000L, PART,
    )
}

/** A source whose bytes are in memory; identity changes are scripted through [identity]. */
class FakeSource(val data: ByteArray) {
    val baseIdentity = FdIdentity(1, 42, data.size.toLong(), 1_000_000_001, 2_000_000_002)
    @Volatile var identity: FdIdentity = baseIdentity
    @Volatile var onRead: (Long) -> Unit = {}
    val reads = AtomicInteger(0)

    val opener = object : SourceOpener {
        override fun open(root: String, relativePath: String, expected: FdIdentity): OpenSource {
            if (identity != expected) throw SourceException("changed", "identity differs")
            return object : OpenSource {
                override fun verify(expected: FdIdentity) {
                    if (identity != expected) throw SourceException("changed", "identity differs")
                }
                override fun readAt(offset: Long, buf: ByteArray, len: Int): Int {
                    reads.incrementAndGet()
                    onRead(offset)
                    val n = minOf(len.toLong(), data.size - offset).toInt().coerceAtLeast(0)
                    System.arraycopy(data, offset.toInt(), buf, 0, n)
                    return n
                }
                override fun close() {}
            }
        }
    }
}

/**
 * Stands in for both the API (existing five routes + /me) and the provider.
 * It records every request so tests can assert ordering and what was sent where.
 */
class FakeBackend(
    var plan: UploadPlan,
    private val clock: FakeClock,
    var meUser: String = OWNER,
    var urlTtlMs: Long = 3_600_000L,
) : HttpTransport {
    val calls = CopyOnWriteArrayList<String>()
    val provider = ConcurrentHashMap<Int, ByteArray>()
    val etags = ConcurrentHashMap<Int, String>()
    val receipts = ConcurrentHashMap<Int, String>()
    val putAttempts = ConcurrentHashMap<Int, AtomicInteger>()
    val providerHeaders = CopyOnWriteArrayList<Map<String, String>>()
    val controlHeaders = CopyOnWriteArrayList<Map<String, String>>()
    val signCalls = AtomicInteger(0)
    val completeCalls = AtomicInteger(0)
    private val inFlight = AtomicInteger(0)
    @Volatile var maxInFlight = 0
    @Volatile var serverState = plan.state
    @Volatile var serverEpoch = plan.transportEpoch
    @Volatile var meStatus = 200
    /** Return an HTTP status (or null to throw an IOException) for the n-th attempt of a part; 0 = normal. */
    @Volatile var putScript: (part: Int, attempt: Int) -> Int = { _, _ -> 0 }
    @Volatile var afterPut: (part: Int) -> Unit = {}
    @Volatile var completeLost = false
    @Volatile var putDelayMs = 0L
    /** A control path answered with 503 (retryable) while this returns true; the call is still recorded. */
    @Volatile var controlOutage: (path: String) -> Boolean = { false }
    val outageHits = AtomicInteger(0)
    /** Runs inside the control call, after the client read its cookie and before the response returns. */
    @Volatile var duringControl: (path: String) -> Unit = {}
    /** `Set-Cookie` values attached to every control response. */
    @Volatile var responseSetCookies: List<String> = emptyList()

    private fun envelope(data: JSONObject, status: Int = 200) =
        HttpResponse(status, JSONObject().put("data", data).put("requestId", "33333333-3333-4333-8333-333333333333").toString().toByteArray(), emptyList())

    private fun error(status: Int, code: String, retryable: Boolean = false) = HttpResponse(
        status,
        JSONObject().put("error", JSONObject().put("code", code).put("message", "x").put("retryable", retryable))
            .put("requestId", "33333333-3333-4333-8333-333333333333").toString().toByteArray(),
        emptyList(),
    )

    private fun planJson(): JSONObject = UploadPlan(
        plan.fileId, plan.recordingId, plan.role, plan.sizeBytes, plan.sha256, serverEpoch, plan.partCount,
        serverState, plan.transportExpiresAtMs, plan.partSizeBytes,
    ).toJson()

    override fun control(method: String, url: String, headers: Map<String, String>, body: ByteArray?, cancel: CancelToken): HttpResponse {
        cancel.check()
        val path = url.removePrefix(ORIGIN)
        calls += "$method ${path.replace(FILE_ID, "{f}")}"
        controlHeaders += headers
        duringControl(path)
        if (controlOutage(path)) {
            outageHits.incrementAndGet()
            return error(503, "unavailable", retryable = true)
        }
        val r = controlInner(method, path, body)
        return if (responseSetCookies.isEmpty()) r else HttpResponse(r.status, r.body, responseSetCookies)
    }

    private fun controlInner(method: String, path: String, body: ByteArray?): HttpResponse {
        if (path == "/api/v1/me") {
            if (meStatus != 200) return error(meStatus, "unauthenticated")
            return envelope(
                JSONObject().put("user", JSONObject().put("id", meUser).put("email", "a@b.c").put("name", "n"))
                    .put("access", JSONObject().put("status", "active").put("roles", JSONArray().put("collector")))
                    .put("session", JSONObject().put("expiresAt", "2030-01-01T00:00:00Z")),
            )
        }
        val req = if (body == null) JSONObject() else JSONObject(String(body))
        if (method != "GET") {
            val e = req.optInt("expectedTransportEpoch", -1)
            if (e != serverEpoch) return error(409, "conflict")
        }
        return when {
            method == "GET" && path == "/api/v1/uploads/$FILE_ID" -> envelope(planJson())
            path.endsWith("/parts/sign") -> {
                signCalls.incrementAndGet()
                val arr = req.getJSONArray("partNumbers")
                val parts = JSONArray()
                for (i in 0 until arr.length()) {
                    val n = arr.getInt(i)
                    parts.put(
                        JSONObject().put("partNumber", n).put("method", "PUT")
                            .put("url", "https://s3.test/bucket/key?part=$n&exp=${clock.nowMs() + urlTtlMs}&sig=secret$n")
                            .put("headers", JSONObject().put("content-length", plan.partLength(n).toString()))
                            .put("offsetBytes", plan.partOffset(n).toString())
                            .put("lengthBytes", plan.partLength(n).toString())
                            .put("expiresAt", Rfc3339.format(clock.nowMs() + urlTtlMs)),
                    )
                }
                envelope(JSONObject().put("transportEpoch", serverEpoch).put("parts", parts))
            }
            path.endsWith("/parts/receipts") -> {
                val arr = req.getJSONArray("receipts")
                for (i in 0 until arr.length()) {
                    val r = arr.getJSONObject(i)
                    val n = r.getInt("partNumber")
                    if (etags[n] != r.getString("etag") || r.getString("sizeBytes") != plan.partLength(n).toString()) {
                        return error(409, "conflict")
                    }
                    receipts[n] = r.getString("etag")
                }
                envelope(JSONObject().put("ok", true))
            }
            path.endsWith("/reconcile") -> {
                // The server heals receipts from the provider listing.
                for ((n, tag) in etags) receipts.putIfAbsent(n, tag)
                envelope(planJson())
            }
            path.endsWith("/complete") -> {
                completeCalls.incrementAndGet()
                if (receipts.size != plan.partCount) return error(409, "conflict")
                serverState = "completed"
                if (completeLost) { completeLost = false; throw IOException("response lost after the server completed") }
                envelope(planJson())
            }
            else -> error(404, "not_found")
        }
    }

    override fun putFile(url: String, headers: Map<String, String>, file: File, length: Long, cancel: CancelToken): PutResponse {
        val q = url.substringAfter('?')
        val part = q.split('&').first { it.startsWith("part=") }.removePrefix("part=").toInt()
        val exp = q.split('&').first { it.startsWith("exp=") }.removePrefix("exp=").toLong()
        calls += "PUT part=$part"
        providerHeaders += headers
        val attempt = putAttempts.computeIfAbsent(part) { AtomicInteger(0) }.incrementAndGet()
        val now = inFlight.incrementAndGet()
        synchronized(this) { if (now > maxInFlight) maxInFlight = now }
        try {
            if (putDelayMs > 0) Thread.sleep(putDelayMs)
            cancel.check()
            if (clock.nowMs() > exp) return PutResponse(403, null)
            when (val s = putScript(part, attempt)) {
                0 -> Unit
                -1 -> throw IOException("connection reset")
                else -> return PutResponse(s, null)
            }
            val bytes = file.readBytes()
            check(bytes.size.toLong() == length) { "chunk length differs from the signed length" }
            provider[part] = bytes
            val tag = "\"etag-$part-${bytes.contentHashCode()}\""
            etags[part] = tag
            afterPut(part)
            return PutResponse(200, tag)
        } finally {
            inFlight.decrementAndGet()
        }
    }

    fun assembled(): ByteArray =
        (1..plan.partCount).map { provider[it] ?: ByteArray(0) }.fold(ByteArray(0)) { a, b -> a + b }
}

/** Everything one test needs, over a real temp directory so journal reloads are real. */
class Rig(val dir: File, size: Long, epoch: Int = 1) {
    val clock = FakeClock()
    val data = ByteArray(size.toInt()) { (it * 31 + 7).toByte() }
    val source = FakeSource(data)
    val plan = testPlan(size, epoch, clock = clock)
    val backend = FakeBackend(plan, clock)
    val env = FakeEnv()
    val session = MemorySessionStore()
    val jar = SessionJar(session, clock)
    val gateFile = File(dir, "gate.json")
    val journalFile = File(dir, "journal.json")
    val gate = GateStore(gateFile)
    var journal = UploadJournal(journalFile, partSizeBytes = PART)
    val chunks = ChunkStore(File(dir, "chunks"), { 1L shl 40 }, reserveBytes = 0)
    val stats = TransferStats()
    val progress = CopyOnWriteArrayList<TaskState>()

    fun deps(j: UploadJournal = journal) = EngineDeps(
        journal = j, gate = gate, jar = jar, opener = source.opener, chunks = chunks, env = env, clock = clock,
        random = { 0.0 }, sleep = { ms -> clock.advance(ms); Thread.sleep(1) },
        onProgress = { progress += it.state },
    )

    val engine get() = TransferEngine(deps(), stats)

    fun bindOwner(owner: String = OWNER): GateState {
        session.bundle = SessionBundle(owner, ORIGIN, 1, listOf(StoredCookie("__Secure-better-auth.session_token", "tok", "/", true, null)))
        return gate.bind(owner, ORIGIN, 1)
    }

    fun enqueue(owner: String = OWNER): String {
        val g = gate.read()
        val key = TaskRecord.keyOf(owner, ORIGIN, plan)
        journal.insertIfAbsent(
            TaskRecord(
                key, owner, ORIGIN, g.generation, plan,
                SourceBinding("/session", "recording.mcap", plan.sha256, source.baseIdentity),
                TaskState.QUEUED, null, (1..plan.partCount).map { PartRecord(it) },
                createdAtMs = clock.nowMs(), hardExpiryMs = plan.transportExpiresAtMs, updatedAtMs = clock.nowMs(),
            ),
        )
        return key
    }

    fun run(key: String, cancel: CancelToken = CancelToken(), engine: TransferEngine = this.engine) =
        engine.run(key, backend, cancel)

    /** A new process: reload the journal from disk and build a fresh engine. */
    fun restart(): TransferEngine {
        journal = UploadJournal(journalFile, partSizeBytes = PART)
        return TransferEngine(deps(), TransferStats())
    }
}
