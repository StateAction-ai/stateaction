package open.fpvlabs.stera.upload

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest
import open.fpvlabs.stera.source_integrity.FdIdentity
import org.json.JSONArray
import org.json.JSONObject

/** Task lifecycle. [wire] is the bridge/Dart value and is part of the persisted schema. */
enum class TaskState(val wire: String) {
    QUEUED("queued"),
    RUNNING("running"),
    WAITING_POLICY("waiting_policy"),
    BACKOFF("backoff"),
    NEEDS_VISIBLE_RESUME("needs_visible_resume"),
    NEEDS_ORCHESTRATOR("needs_orchestrator"),
    BLOCKED_OWNER("blocked_owner"),
    SOURCE_BLOCKED("source_blocked"),
    UPLOADED("uploaded"),
    FAILED("failed");

    val terminal: Boolean get() = this == UPLOADED || this == FAILED
    /** The engine may be started for this state. */
    val runnable: Boolean get() = this == QUEUED || this == RUNNING || this == WAITING_POLICY || this == BACKOFF

    companion object {
        fun fromWire(value: String): TaskState =
            entries.firstOrNull { it.wire == value } ?: throw JournalCorruptException("unknown task state")
    }
}

/**
 * A part is [LANDED] once the provider's ETag is journaled locally, and
 * [REPORTED] once the API accepted that receipt. Only the API's receipt makes a
 * part eligible for a server-built completion.
 */
enum class PartState { PENDING, UPLOADING, LANDED, REPORTED }

data class PartRecord(
    val partNumber: Int,
    val state: PartState = PartState.PENDING,
    val etag: String? = null,
    val sizeBytes: Long = 0,
    val attempts: Int = 0,
    val nextAttemptAtMs: Long = 0,
)

/** Frozen source from the SA-18 sealed manifest; never edited, deleted or adopted by this module. */
data class SourceBinding(
    val root: String,
    val relativePath: String,
    val sha256: String,
    val identity: FdIdentity,
)

data class TaskRecord(
    val taskKey: String,
    val ownerId: String,
    val backendOrigin: String,
    val ownerGeneration: Long,
    val plan: UploadPlan,
    val source: SourceBinding,
    val state: TaskState,
    val reason: String? = null,
    val parts: List<PartRecord>,
    val controlAttempts: Int = 0,
    val controlNextAttemptAtMs: Long = 0,
    /** Set when a PUT/receipt/complete outcome is unknown: the next run reconciles before any repeat. */
    val needsReconcile: Boolean = false,
    val completeSent: Boolean = false,
    val createdAtMs: Long,
    val hardExpiryMs: Long,
    val updatedAtMs: Long,
    /** True while only a visible user action may start the OS job again. */
    val needsVisibleResume: Boolean = false,
    /** Server-`completing` waits, counted apart from control-call failures so a successful call never resets them. */
    val completingAttempts: Int = 0,
    /** Persisted earliest time the next run may act (any BACKOFF reason); 0 = none. Honored across restarts. */
    val retryAtMs: Long = 0,
) {
    val landedCount: Int get() = parts.count { it.state == PartState.LANDED || it.state == PartState.REPORTED }

    fun part(n: Int): PartRecord = parts[n - 1]

    fun withPart(p: PartRecord, nowMs: Long): TaskRecord =
        copy(parts = parts.toMutableList().also { it[p.partNumber - 1] = p }, updatedAtMs = nowMs)

    companion object {
        /** Journal identity: owner + backend + recording + file + transport epoch. */
        fun keyOf(ownerId: String, backend: String, plan: UploadPlan): String {
            val raw = listOf(ownerId, backend, plan.recordingId, plan.fileId, plan.transportEpoch.toString())
                .joinToString("\n")
            return MessageDigest.getInstance("SHA-256").digest(raw.toByteArray(Charsets.UTF_8))
                .joinToString("") { "%02x".format(it) }.substring(0, 32)
        }
    }
}

class JournalCorruptException(message: String) : IOException(message)

/** A durable write failed: its on-disk outcome is unknown, so cached state was discarded and disk is re-read. */
class JournalWriteException(message: String) : IOException(message)

/** Durable file seam: tests use a plain implementation, Android fsyncs the directory too. */
interface DirectorySync {
    fun sync(dir: File)
}

object NoDirectorySync : DirectorySync {
    override fun sync(dir: File) {}
}

/** temp + fsync + rename + directory fsync: a reader sees the old or new file, never a torn one. */
class DurableFile(private val file: File, private val dirSync: DirectorySync) {
    fun write(bytes: ByteArray) {
        val dir = file.parentFile ?: throw IOException("no parent")
        if (!dir.isDirectory && !dir.mkdirs()) throw IOException("cannot create journal directory")
        val tmp = File(dir, file.name + ".tmp")
        FileOutputStream(tmp).use { out ->
            out.write(bytes)
            out.flush()
            out.fd.sync()
        }
        if (!tmp.renameTo(file)) throw IOException("journal rename failed")
        dirSync.sync(dir)
    }

    fun read(): ByteArray? = if (file.exists()) file.readBytes() else null
}

/**
 * Persisted task journal. Every mutation is serialized, written durably, and
 * only then visible; a failed write leaves the previous state in force. It
 * never stores URLs, cookies or tokens.
 */
class UploadJournal(
    file: File,
    dirSync: DirectorySync = NoDirectorySync,
    /** Always the frozen 64 MiB in production; JVM tests pass a small value. */
    private val partSizeBytes: Long = Limits.PART_BYTES,
) {
    private val store = DurableFile(file, dirSync)
    private val lock = Any()
    private var tasks: LinkedHashMap<String, TaskRecord> = LinkedHashMap()
    private var loaded = false

    private fun ensureLoaded() {
        if (loaded) return
        val raw = store.read()
        // A corrupt file stays untouched on disk: every access fails closed and nothing is ever written over it.
        tasks = if (raw != null) decode(String(raw, Charsets.UTF_8), partSizeBytes) else LinkedHashMap()
        loaded = true
    }

    fun all(): List<TaskRecord> = synchronized(lock) { ensureLoaded(); tasks.values.toList() }

    fun get(key: String): TaskRecord? = synchronized(lock) { ensureLoaded(); tasks[key] }

    /** Inserts only when absent; returns the stored record either way. */
    fun insertIfAbsent(record: TaskRecord): TaskRecord = synchronized(lock) {
        ensureLoaded()
        tasks[record.taskKey]?.let { return it }
        persist(LinkedHashMap(tasks).also { it[record.taskKey] = record })
        record
    }

    /** Atomically replaces a record with `fn(current)`; null return keeps it unchanged. */
    fun update(key: String, fn: (TaskRecord) -> TaskRecord?): TaskRecord? = synchronized(lock) {
        ensureLoaded()
        val cur = tasks[key] ?: return null
        val next = fn(cur) ?: return cur
        if (next.taskKey != cur.taskKey || next.ownerId != cur.ownerId || next.backendOrigin != cur.backendOrigin ||
            !next.plan.sameTransport(cur.plan) || next.source != cur.source
        ) throw IllegalStateException("immutable task identity changed")
        if (next == cur) return cur
        persist(LinkedHashMap(tasks).also { it[key] = next })
        next
    }

    private fun persist(next: LinkedHashMap<String, TaskRecord>) {
        try {
            store.write(encode(next).toByteArray(Charsets.UTF_8))
        } catch (e: IOException) {
            invalidate()
            throw JournalWriteException("journal write outcome unknown")
        } catch (e: RuntimeException) {
            invalidate()
            throw JournalWriteException("journal write outcome unknown")
        }
        tasks = next
    }

    /** After a failed write the file may hold either version (e.g. rename done, directory fsync failed): re-read it. */
    private fun invalidate() {
        loaded = false
        tasks = LinkedHashMap()
    }

    companion object {
        const val SCHEMA = 1

        fun encode(tasks: Map<String, TaskRecord>): String {
            val arr = JSONArray()
            for (t in tasks.values) arr.put(encodeTask(t))
            return JSONObject().put("schema", SCHEMA).put("tasks", arr).toString()
        }

        private fun encodeTask(t: TaskRecord): JSONObject {
            val parts = JSONArray()
            for (p in t.parts) {
                // [partNumber, state, etag|null, size, attempts, nextAttemptAtMs]; compact for 1,600-part files.
                parts.put(
                    JSONArray().put(p.partNumber).put(p.state.name).put(p.etag ?: JSONObject.NULL)
                        .put(p.sizeBytes).put(p.attempts).put(p.nextAttemptAtMs),
                )
            }
            return JSONObject()
                .put("taskKey", t.taskKey).put("ownerId", t.ownerId).put("backendOrigin", t.backendOrigin)
                .put("ownerGeneration", t.ownerGeneration).put("plan", t.plan.toJson())
                .put(
                    "source",
                    JSONObject().put("root", t.source.root).put("relativePath", t.source.relativePath)
                        .put("sha256", t.source.sha256)
                        .put(
                            "identity",
                            JSONObject().put("dev", t.source.identity.dev.toString())
                                .put("inode", t.source.identity.inode.toString())
                                .put("size", t.source.identity.size.toString())
                                .put("mtimeNs", t.source.identity.mtimeNs.toString())
                                .put("ctimeNs", t.source.identity.ctimeNs.toString()),
                        ),
                )
                .put("state", t.state.wire).put("reason", t.reason ?: JSONObject.NULL)
                .put("parts", parts).put("controlAttempts", t.controlAttempts)
                .put("controlNextAttemptAtMs", t.controlNextAttemptAtMs)
                .put("needsReconcile", t.needsReconcile).put("completeSent", t.completeSent)
                .put("createdAtMs", t.createdAtMs).put("hardExpiryMs", t.hardExpiryMs)
                .put("updatedAtMs", t.updatedAtMs).put("needsVisibleResume", t.needsVisibleResume)
                .put("completingAttempts", t.completingAttempts).put("retryAtMs", t.retryAtMs)
        }

        fun decode(text: String, partSize: Long = Limits.PART_BYTES): LinkedHashMap<String, TaskRecord> {
            try {
                val root = JSONObject(text)
                if (root.optInt("schema", -1) != SCHEMA) throw JournalCorruptException("journal schema")
                val arr = root.getJSONArray("tasks")
                val out = LinkedHashMap<String, TaskRecord>()
                for (i in 0 until arr.length()) {
                    val t = decodeTask(arr.getJSONObject(i), partSize)
                    out[t.taskKey] = t
                }
                return out
            } catch (e: org.json.JSONException) {
                throw JournalCorruptException("journal is not valid")
            } catch (e: PlanException) {
                throw JournalCorruptException("journal plan invalid")
            } catch (e: JournalCorruptException) {
                throw e
            } catch (e: RuntimeException) {
                // Unknown part state, malformed number, wrong JSON shape: fail closed, never crash raw.
                throw JournalCorruptException("journal is not valid")
            }
        }

        private fun decodeTask(o: JSONObject, partSize: Long): TaskRecord {
            val src = o.getJSONObject("source")
            val id = src.getJSONObject("identity")
            val plan = UploadPlan.fromJson(o.getJSONObject("plan"), partSize)
            val partsArr = o.getJSONArray("parts")
            if (partsArr.length() != plan.partCount) throw JournalCorruptException("journal part count")
            val parts = ArrayList<PartRecord>(partsArr.length())
            for (i in 0 until partsArr.length()) {
                val a = partsArr.getJSONArray(i)
                parts += PartRecord(
                    a.getInt(0), PartState.valueOf(a.getString(1)),
                    if (a.isNull(2)) null else a.getString(2), a.getLong(3), a.getInt(4), a.getLong(5),
                )
                if (parts[i].partNumber != i + 1) throw JournalCorruptException("journal part order")
            }
            return TaskRecord(
                taskKey = o.getString("taskKey"), ownerId = o.getString("ownerId"),
                backendOrigin = o.getString("backendOrigin"), ownerGeneration = o.getLong("ownerGeneration"),
                plan = plan,
                source = SourceBinding(
                    src.getString("root"), src.getString("relativePath"), src.getString("sha256"),
                    FdIdentity(
                        id.getString("dev").toLong(), id.getString("inode").toLong(), id.getString("size").toLong(),
                        id.getString("mtimeNs").toLong(), id.getString("ctimeNs").toLong(),
                    ),
                ),
                state = TaskState.fromWire(o.getString("state")),
                reason = if (o.isNull("reason")) null else o.getString("reason"),
                parts = parts, controlAttempts = o.getInt("controlAttempts"),
                controlNextAttemptAtMs = o.getLong("controlNextAttemptAtMs"),
                needsReconcile = o.getBoolean("needsReconcile"), completeSent = o.getBoolean("completeSent"),
                createdAtMs = o.getLong("createdAtMs"), hardExpiryMs = o.getLong("hardExpiryMs"),
                updatedAtMs = o.getLong("updatedAtMs"), needsVisibleResume = o.getBoolean("needsVisibleResume"),
                completingAttempts = o.optInt("completingAttempts", 0), retryAtMs = o.optLong("retryAtMs", 0),
            )
        }
    }
}
