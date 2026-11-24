package open.fpvlabs.stera.upload

import java.io.File
import java.io.IOException
import org.json.JSONException
import org.json.JSONObject

/** Native transfer policy; persisted so it holds across process death and reboot. */
data class TransferPolicy(
    val requireUnmetered: Boolean = true,
    val requireCharging: Boolean = true,
    /** Capture (recording) is in progress or paused-for-capture: no transfer effect may run. */
    val capturePaused: Boolean = false,
)

/** What the device can do right now (the engine re-checks it before every effect). */
data class EnvSnapshot(
    val networkAvailable: Boolean,
    val unmetered: Boolean,
    val charging: Boolean,
    val wifi: Boolean = unmetered,
)

/** Why the policy blocks an effect, or null. Reasons are stable wire strings. */
fun TransferPolicy.blockReason(env: EnvSnapshot): String? = when {
    capturePaused -> "capture_paused"
    !env.networkAvailable -> "no_network"
    requireUnmetered && (!env.wifi || !env.unmetered) -> "unmetered_required"
    requireCharging && !env.charging -> "charging_required"
    else -> null
}

/**
 * The persisted current-owner gate. [generation] increases on every owner or
 * origin change and on unbind, so any effect that captured an older value is
 * stale. [sessionRevision] is monotonic: a cookie bundle with a lower
 * revision never replaces a newer one.
 */
data class GateState(
    val ownerId: String? = null,
    val backendOrigin: String? = null,
    val generation: Long = 0,
    val sessionRevision: Long = 0,
    val policy: TransferPolicy = TransferPolicy(),
    /**
     * The owner the persisted relaxed [policy] flags belong to. The flags are honoured only while this equals the
     * currently bound [ownerId]; otherwise (unbound, fenced, another owner, legacy file without it) the effective
     * policy is the restrictive default. Never set for a different owner than the one bound when it was written.
     */
    val policyOwner: String? = null,
    /**
     * Highest Dart session revision that a logout/sign-in start declared dead. Persisted, never lowered, not reset
     * by unbind: a bind whose revision is <= this is a stale queued push and is refused.
     */
    val invalidationFloor: Long = 0,
)

class GateStore(private val file: File, private val dirSync: DirectorySync = NoDirectorySync) {
    private val store = DurableFile(file, dirSync)
    private val lock = Any()
    private var state: GateState? = null

    /** Last durably committed state, readable without the (fsync-holding) lock. */
    @Volatile private var published: GateState? = null

    // ---- immediate in-memory fence (lock-free; never blocks on the lock or on disk) -----------
    // Owner overlay is active iff ownerFence > ownerCleared; capture overlay iff captureFence > captureCleared.
    // All four are monotonic (CAS max), so an older completion can never clear a newer invalidation.
    private val ownerFence = java.util.concurrent.atomic.AtomicLong(0)
    private val ownerCleared = java.util.concurrent.atomic.AtomicLong(0)
    private val captureFence = java.util.concurrent.atomic.AtomicLong(0)
    private val captureCleared = java.util.concurrent.atomic.AtomicLong(0)
    private val floorMem = java.util.concurrent.atomic.AtomicLong(0)

    /** Write-ahead markers (`u` owner, `c` capture): survive a failed gate write; a restart never auto-adopts / reopens. */
    private val markerFile = File(file.parentFile, file.name + ".fence")

    fun fenceSeq(): Long = ownerFence.get()
    fun captureSeq(): Long = captureFence.get()

    /** True while an owner invalidation is received but not yet fully durable/cleaned (or failed). */
    fun ownerFenced(): Boolean = ownerFence.get() > ownerCleared.get() || loadedMarkerHas('u')

    private fun atomicMax(a: java.util.concurrent.atomic.AtomicLong, v: Long) {
        while (true) {
            val c = a.get()
            if (v <= c || a.compareAndSet(c, v)) return
        }
    }

    /** Invalidates the bound owner right now: reads see no owner, older binds are stale. Returns this invalidation's sequence. */
    fun fenceOwner(fenceRevision: Long = 0): Long {
        atomicMax(floorMem, fenceRevision)
        return ownerFence.incrementAndGet()
    }

    /** Capture started: reads see capturePaused=true right now. Returns this pause's sequence. */
    fun fenceCapture(): Long = captureFence.incrementAndGet()

    /** Marks invalidation [seq] (and older) fully cleaned up. A newer invalidation stays fenced. */
    fun ownerCleaned(seq: Long) {
        atomicMax(ownerCleared, seq)
    }

    @Volatile private var markers = ""

    private fun loadedMarkerHas(ch: Char): Boolean = markers.contains(ch)

    /**
     * Reads the marker with a tight bound. Valid content is a non-empty, duplicate-free subset of `u`/`c` (at most
     * two bytes). Anything else that exists on disk (empty, unknown byte, duplicate, oversized, unreadable) blocks
     * both the owner and capture.
     */
    private fun readMarkerFromDisk(): String {
        if (!markerFile.exists()) return ""
        return try {
            val bytes = java.io.FileInputStream(markerFile).use { it.readNBytes(MARKER_MAX + 1) }
            val text = String(bytes, Charsets.ISO_8859_1)
            val valid = text.isNotEmpty() && text.length <= MARKER_MAX && text.all { it == 'u' || it == 'c' } && text.toSet().size == text.length
            if (valid) text else "uc"
        } catch (e: IOException) {
            "uc" // unreadable marker: fail closed
        }
    }

    /** Whether the owner-invalidation marker of the last [unbind] reached the disk (bytes+fsync+rename+dir fsync). */
    @Volatile var lastUnbindMarkerDurable = false
        private set

    /** Bytes + fsync + rename + directory fsync must all complete before the marker counts; false otherwise. */
    private fun writeMarker(chars: String): Boolean = try {
        DurableFile(markerFile, dirSync).write(chars.toByteArray(Charsets.ISO_8859_1))
        markers = chars
        true
    } catch (e: IOException) {
        false
    }

    private fun addMarker(ch: Char): Boolean = writeMarker(markers.replace(ch.toString(), "") + ch)

    /** Removes [ch] from the marker. The in-memory marker only changes when the disk change is certain. */
    private fun dropMarker(ch: Char): Boolean {
        val left = markers.replace(ch.toString(), "")
        return try {
            if (left.isEmpty()) {
                if (markerFile.exists() && !markerFile.delete()) return false
                dirSync.sync(markerFile.parentFile!!)
                markers = ""
                true
            } else {
                writeMarker(left)
            }
        } catch (e: IOException) {
            false // uncertain: the marker is retained in memory and a restart re-validates the disk
        }
    }

    private fun overlay(s: GateState): GateState {
        var out = s
        val floor = maxOf(out.invalidationFloor, floorMem.get())
        if (floor != out.invalidationFloor) out = out.copy(invalidationFloor = floor)
        if (ownerFence.get() > ownerCleared.get()) {
            out = out.copy(ownerId = null, backendOrigin = null, generation = out.generation + 1, sessionRevision = 0)
        }
        if (captureFence.get() > captureCleared.get()) out = out.copy(policy = out.policy.copy(capturePaused = true))
        // Relaxed flags are owner-scoped: anything but an exact match with the (unfenced) bound owner is restrictive.
        if (out.ownerId == null || out.policyOwner != out.ownerId) {
            out = out.copy(policy = out.policy.copy(requireUnmetered = true, requireCharging = true))
        }
        return out
    }

    private fun current(): GateState {
        state?.let { return it }
        val raw = store.read()
        var loaded = if (raw == null) GateState() else decode(String(raw, Charsets.UTF_8))
        // A surviving marker means an invalidation never became durable/cleaned: stay unbound / capture-paused.
        markers = readMarkerFromDisk()
        if (markers.contains('u')) loaded = loaded.copy(ownerId = null, backendOrigin = null, generation = loaded.generation + 1, sessionRevision = 0)
        if (markers.contains('c')) loaded = loaded.copy(policy = loaded.policy.copy(capturePaused = true))
        state = loaded
        published = loaded
        return loaded
    }

    /** True when a restart found a marker whose cleanup never finished (forces the runtime into recovery). */
    fun pendingMarkerOnLoad(): Boolean = synchronized(lock) { current(); markers.contains('u') }

    /** Never blocks behind a durable write once loaded; always includes the in-memory fences. */
    fun read(): GateState {
        val p = published ?: synchronized(lock) { current() }
        return overlay(p)
    }

    private fun commit(next: GateState): GateState {
        try {
            store.write(encode(next).toByteArray(Charsets.UTF_8))
        } catch (e: IOException) {
            state = null // outcome unknown: the next read re-reads the disk
            throw JournalWriteException("gate write outcome unknown")
        }
        state = next
        published = next
        return next
    }

    /**
     * Binds the current owner. The same owner/origin keeps its generation (so a cookie refresh does not abort a
     * running transfer); anything else starts a new generation, which makes every older in-flight effect stale.
     * [expectedFenceSeq] was captured when the request arrived: an invalidation received since makes it stale.
     * A bind never clears an invalidation overlay or marker: only that invalidation's own cleanup does.
     */
    fun bind(ownerId: String, origin: String, sessionRevision: Long, expectedFenceSeq: Long = ownerFence.get()): GateState = synchronized(lock) {
        if (expectedFenceSeq != ownerFence.get()) throw SupersededException()
        val cur = current()
        val same = cur.ownerId == ownerId && cur.backendOrigin == origin
        commit(
            cur.copy(
                ownerId = ownerId, backendOrigin = origin,
                generation = if (same) cur.generation else cur.generation + 1,
                sessionRevision = if (same) maxOf(cur.sessionRevision, sessionRevision) else sessionRevision,
                // A new owner/origin never inherits the previous owner's relaxed choice.
                policy = if (same) cur.policy else cur.policy.copy(requireUnmetered = true, requireCharging = true),
                policyOwner = if (same) cur.policyOwner else null,
            ),
        )
    }

    /**
     * Durable half of an owner invalidation: restart marker first (bytes+fsync+dir fsync), then the gate. The
     * marker is deliberately NOT cleared here; [finishUnbind] clears it after vault/scheduler cleanup too.
     * Before the marker is durable, restart protection is not claimed (the in-memory fence still holds).
     */
    fun unbind(fenceRevision: Long = 0): GateState = synchronized(lock) {
        lastUnbindMarkerDurable = addMarker('u')
        val cur = current()
        commit(
            cur.copy(
                ownerId = null, backendOrigin = null, generation = cur.generation + 1, sessionRevision = 0,
                policy = cur.policy.copy(requireUnmetered = true, requireCharging = true), policyOwner = null,
                invalidationFloor = maxOf(cur.invalidationFloor, fenceRevision, floorMem.get()),
            ),
        )
    }

    /** Called after gate, vault and scheduler cleanup are all recorded: clears the overlay and, if nothing newer arrived, the marker. */
    fun finishUnbind(seq: Long) = synchronized(lock) {
        ownerCleaned(seq)
        if (ownerFence.get() == seq) dropMarker('u')
    }

    /**
     * Owner-scoped transfer policy. Accepted only while [expectedOwner] is the currently bound, unfenced owner (and
     * [expectedGeneration], when given, is still the gate generation); anything else throws [PolicyRejectedException]
     * and changes nothing, so a stale or queued call can never alter another owner's (or a signed-out) policy.
     * Returns the effective (overlaid) state.
     */
    fun setPolicy(
        expectedOwner: String,
        requireUnmetered: Boolean,
        requireCharging: Boolean,
        expectedGeneration: Long? = null,
        expectedFenceSeq: Long = ownerFence.get(),
    ): GateState = synchronized(lock) {
        if (expectedFenceSeq != ownerFence.get() || ownerFenced()) throw PolicyRejectedException("owner_changed")
        val cur = current()
        if (cur.ownerId != expectedOwner) throw PolicyRejectedException("owner_changed")
        if (expectedGeneration != null && expectedGeneration != cur.generation) throw PolicyRejectedException("owner_changed")
        commit(
            cur.copy(
                policy = cur.policy.copy(requireUnmetered = requireUnmetered, requireCharging = requireCharging),
                policyOwner = expectedOwner,
            ),
        )
        overlay(published!!)
    }

    /**
     * Durable capture pause/release. A pause writes its marker first and keeps the overlay on failure. A release
     * only clears the overlay and marker up to [capturedSeq]: a pause that arrived while it ran stays in force.
     */
    fun setCapturePaused(paused: Boolean, capturedSeq: Long = captureFence.get()): GateState = synchronized(lock) {
        if (paused) addMarker('c')
        val cur = current()
        val committed = commit(cur.copy(policy = cur.policy.copy(capturePaused = paused)))
        if (!paused) {
            atomicMax(captureCleared, capturedSeq)
            if (captureFence.get() == capturedSeq) dropMarker('c')
        }
        committed
    }

    /** Records a newer cookie revision after a native rotation; never lowers it. */
    fun bumpRevision(): GateState = synchronized(lock) {
        val cur = current()
        commit(cur.copy(sessionRevision = cur.sessionRevision + 1))
    }

    companion object {
        private const val MARKER_MAX = 2

        fun encode(s: GateState): String = JSONObject()
            .put("schema", 1).put("ownerId", s.ownerId ?: JSONObject.NULL)
            .put("backendOrigin", s.backendOrigin ?: JSONObject.NULL)
            .put("generation", s.generation).put("sessionRevision", s.sessionRevision)
            .put("requireUnmetered", s.policy.requireUnmetered).put("requireCharging", s.policy.requireCharging)
            .put("capturePaused", s.policy.capturePaused).put("invalidationFloor", s.invalidationFloor)
            .put("policyOwner", s.policyOwner ?: JSONObject.NULL).toString()

        fun decode(text: String): GateState = try {
            val o = JSONObject(text)
            if (o.getInt("schema") != 1) throw IOException("gate schema")
            GateState(
                ownerId = if (o.isNull("ownerId")) null else o.getString("ownerId"),
                backendOrigin = if (o.isNull("backendOrigin")) null else o.getString("backendOrigin"),
                generation = o.getLong("generation"), sessionRevision = o.getLong("sessionRevision"),
                policy = TransferPolicy(o.getBoolean("requireUnmetered"), o.getBoolean("requireCharging"), o.getBoolean("capturePaused")),
                invalidationFloor = o.optLong("invalidationFloor", 0),
                // Absent in a legacy file: unbound policy, so the restrictive default applies.
                policyOwner = if (!o.has("policyOwner") || o.isNull("policyOwner")) null else o.getString("policyOwner"),
            )
        } catch (e: JSONException) {
            // Fail closed: an unreadable gate means nothing may transfer. Callers surface this as blocked.
            throw JournalCorruptException("gate is not valid")
        }
    }
}

/** Bounded retry/backoff; every cap is a hard stop, never an unbounded loop. */
object Backoff {
    const val BASE_MS = 5_000L
    const val MAX_MS = 300_000L
    const val MAX_PART_ATTEMPTS = 8
    const val MAX_CONTROL_ATTEMPTS = 8

    /** Signed-URL renewals allowed per part in one run before the run yields. */
    const val MAX_RENEWALS_PER_PART = 4

    /** A task never outlives this, whatever the plan says (the provider aborts incomplete uploads after 7 days). */
    const val HARD_LIFETIME_MS = 6L * 24 * 3_600_000

    /** [attempt] is 1-based; [jitter] in [0,1) widens the delay by at most 25%. */
    fun delayMs(attempt: Int, jitter: Double): Long {
        val exp = BASE_MS shl (minOf(attempt, 7) - 1).coerceAtLeast(0)
        val capped = minOf(exp, MAX_MS)
        return capped + (capped * 0.25 * jitter).toLong()
    }
}

/** A normal operation raced an owner invalidation that arrived after it; it must not install anything. */
class SupersededException : RuntimeException("superseded by owner invalidation")

/** A policy write named an owner/generation that is no longer the bound one; nothing was changed. */
class PolicyRejectedException(val code: String) : RuntimeException("policy write rejected: $code")
