package open.fpvlabs.stera.upload

import android.content.Context
import android.content.pm.PackageManager
import android.net.Network
import java.io.File
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.locks.ReentrantLock
import open.fpvlabs.stera.source_integrity.FdIdentity

/**
 * Build-time switches, read from the merged manifest. Both default to false in
 * the plugin manifest: nothing is enabled by default, and public Start never
 * turns on native transfer. A test/host overlay flips them explicitly.
 */
object NativeUploadFeature {
    const val ENABLED_KEY = "ai.stateaction.native_upload.enabled"
    const val CLEARTEXT_KEY = "ai.stateaction.native_upload.allow_cleartext_loopback"

    private fun flag(context: Context, key: String): Boolean = try {
        @Suppress("DEPRECATION")
        val info = context.packageManager.getApplicationInfo(context.packageName, PackageManager.GET_META_DATA)
        info.metaData?.getBoolean(key, false) ?: false
    } catch (e: Exception) {
        false
    }

    fun enabled(context: Context): Boolean = flag(context, ENABLED_KEY)
    fun allowCleartextLoopback(context: Context): Boolean = flag(context, CLEARTEXT_KEY)
}

class EnqueueRequest(
    val ownerId: String,
    val ownerGeneration: Long,
    val planJson: String,
    val source: SourceBinding,
)

/** Result of an operation the bridge reports verbatim (stable codes, no secrets). */
class OpResult(val ok: Boolean, val code: String?, val task: TaskRecord? = null, val value: Long = 0)

/**
 * Process-wide native transfer state: journal, owner gate, Keystore-bound
 * session, the one run lock (one source at a time) and the active run's
 * cancellation. It is the only thing the bridge, the UIDT job and the
 * WorkManager worker talk to, so Dart never sits on the control path.
 */
class UploadRuntime private constructor(private val context: Context) {
    private val dir = File(context.noBackupFilesDir, "native_upload")
    private val dirSync = AndroidDirectorySync()
    val journal = UploadJournal(File(dir, "journal.v1.json"), dirSync)
    val gate = GateStore(File(dir, "gate.v1.json"), dirSync)
    private val sessionStore: SessionStore = KeystoreSessionStore(dir, dirSync)
    val jar = SessionJar(sessionStore, SystemClock)
    private val chunks = ChunkStore(File(dir, "chunks"), { dir.apply { mkdirs() }.usableSpace })

    @Volatile private var jobNetwork: Network? = null
    private val env = AndroidEnvProbe(context) { jobNetwork }
    val allowCleartext = NativeUploadFeature.allowCleartextLoopback(context)
    val notifications = UploadNotifications(context)

    private val opener: SourceOpener by lazy { ConfinedSourceOpener(AndroidPositionalFdOps()) }
    private val delegateOpener = object : SourceOpener {
        override fun open(root: String, relativePath: String, expected: FdIdentity): OpenSource =
            try {
                opener.open(root, relativePath, expected)
            } catch (e: open.fpvlabs.stera.source_integrity.SourceHashException) {
                throw SourceException(e.code, e.message ?: e.code)
            }
    }

    val engine = TransferEngine(
        EngineDeps(
            journal = journal, gate = gate, jar = jar, opener = delegateOpener, chunks = chunks, env = env,
            allowCleartextProvider = allowCleartext,
            onProgress = { notifications.progress(it) },
        ),
    )

    private val runLock = ReentrantLock()
    /** Serializes durable owner mutations (bind, enqueue, unbind cleanup); never held by the immediate fence. */
    private val mutation = ReentrantLock()
    private val invalidationDone = mutation.newCondition()
    private val pendingInvalidations = AtomicInteger(0)
    @Volatile private var startupRecovery = false

    init {
        if (gate.pendingMarkerOnLoad()) {
            // Fail closed from the first instruction: no cookie, no owner, no effect until recovery completes.
            startupRecovery = true
            pendingInvalidations.incrementAndGet()
            jar.fence()
        }
    }
    @Volatile private var active: CancelToken? = null

    val enabled: Boolean get() = NativeUploadFeature.enabled(context)

    // ---- owner binding -------------------------------------------------------------------

    /**
     * Binds the current owner and its Better Auth cookies. A cookie bundle
     * older than the stored one for the same owner is refused so stale Dart
     * state cannot overwrite a newer native rotation.
     */
    fun bindOwner(
        ownerId: String, origin: String, revision: Long, cookies: List<StoredCookie>,
        expectedFenceSeq: Long = gate.fenceSeq(),
    ): OpResult {
        val normalized = OriginPolicy.normalize(origin, allowCleartext)
        val next = SessionBundle(ownerId, normalized, revision, cookies)
        mutation.lock()
        try {
            // A logout/owner invalidation received earlier finishes its durable cleanup first; this bind never races it.
            if (!awaitInvalidations() || gate.ownerFenced()) return OpResult(false, "invalidation_pending", null, gate.read().generation)
            // A revision the last logout / sign-in start declared dead is a stale queued push.
            if (revision <= gate.read().invalidationFloor) return OpResult(false, "stale_session_revision", null, gate.read().generation)
            // Refused before anything changes: a stale or conflicting push never touches the gate or the vault.
            val verdict = jar.assess(next)
            if (verdict == SessionJar.Bind.STALE) return OpResult(false, "stale_session_revision", null, gate.read().generation)
            if (verdict == SessionJar.Bind.CONFLICT) return OpResult(false, "session_conflict", null, gate.read().generation)
            val before = gate.read()
            val changed = before.ownerId != ownerId || before.backendOrigin != normalized
            if (expectedFenceSeq != gate.fenceSeq()) return OpResult(false, "superseded", null, before.generation)
            // Invalidate any older in-flight effect first, then install the new credentials.
            if (changed) active?.cancel("owner_changed")
            val state = try {
                gate.bind(ownerId, normalized, revision, expectedFenceSeq)
            } catch (e: SupersededException) {
                return OpResult(false, "superseded", null, before.generation)
            }
            if (changed) blockOtherOwners(ownerId, "owner_changed")
            jar.replaceIfNewer(next) // IDENTICAL is an accepted no-op
            return OpResult(true, null, null, state.generation)
        } finally {
            mutation.unlock()
        }
    }

    /** Non-terminal work of any owner other than [current] is blocked and retained, never adopted. */
    private fun blockOtherOwners(current: String?, reason: String) {
        val now = System.currentTimeMillis()
        for (t in journal.all()) {
            if (t.state.terminal || t.ownerId == current || t.state == TaskState.BLOCKED_OWNER) continue
            journal.update(t.taskKey) {
                it.copy(
                    state = TaskState.BLOCKED_OWNER, reason = reason, updatedAtMs = now,
                    needsReconcile = it.needsReconcile || it.parts.any { p -> p.state == PartState.UPLOADING },
                )
            }
        }
    }

    /**
     * STEP 1 of logout (immediate, in memory, never blocks on disk or the normal queue): the owner gate reads
     * as unbound, older binds/rotations are stale, the jar hands out no cookie and ingests none, and the
     * active run and any in-flight control request are cancelled. Call on the platform thread at receipt.
     */
    fun invalidateOwnerNow(fenceRevision: Long = 0): Long {
        pendingInvalidations.incrementAndGet()
        val seq = gate.fenceOwner(fenceRevision)
        jar.fence()
        active?.cancel("owner_changed")
        cancelControl("owner_changed")
        return seq
    }

    /**
     * STEP 2 (durable; may be slow): restart marker, gate, vault, blocking of retained work and the OS job. The
     * overlay and marker are released only after ALL of them are recorded; any failure leaves the fence (and the
     * marker, if it was written) in place, so effects stay blocked and a restart does not adopt the old owner.
     * Always follows [invalidateOwnerNow]; the reply to Dart is sent after this returns (it throws on failure).
     */
    fun completeUnbind(seq: Long, fenceRevision: Long = 0) {
        mutation.lock()
        try {
            try {
                cleanupAfterUnbind(seq, fenceRevision)
            } finally {
                pendingInvalidations.decrementAndGet()
                invalidationDone.signalAll()
            }
        } finally {
            mutation.unlock()
        }
    }

    private fun cleanupAfterUnbind(seq: Long, fenceRevision: Long) {
        gate.unbind(fenceRevision)
        jar.clear()
        // Every owner's non-terminal work is blocked (retained under its owner) until that owner binds again.
        blockOtherOwners(null, "owner_unbound")
        UploadScheduler.cancel(context)
        gate.finishUnbind(seq)
    }

    /** Both steps, for non-bridge callers and tests. */
    fun unbindOwner(fenceRevision: Long = 0) {
        completeUnbind(invalidateOwnerNow(fenceRevision), fenceRevision)
    }

    /** A restart found an unfinished invalidation marker: cleanup runs before any bind or effect (mutation lock held). */
    private fun recoverStartupLocked() {
        if (!startupRecovery) return
        cleanupAfterUnbind(0, 0)
        startupRecovery = false
        pendingInvalidations.decrementAndGet()
        invalidationDone.signalAll()
    }

    /** Idempotent; the bridge queues it on the priority executor at attach. A failure leaves everything fenced. */
    fun recoverIfPending() {
        if (!startupRecovery) return
        mutation.lock()
        try {
            recoverStartupLocked()
        } finally {
            mutation.unlock()
        }
    }

    /** Waits (bounded) for queued durable invalidations; the mutation lock must be held. */
    private fun awaitInvalidations(): Boolean {
        recoverStartupLocked()
        var nanos = TimeUnit.SECONDS.toNanos(15)
        while (pendingInvalidations.get() > 0) {
            if (nanos <= 0) return false
            nanos = invalidationDone.awaitNanos(nanos)
        }
        return true
    }

    private val inflightControl: MutableSet<CancelToken> = java.util.concurrent.ConcurrentHashMap.newKeySet()

    /** Runs a control request under a token that an owner invalidation cancels at once. */
    fun <T> withControlToken(block: (CancelToken) -> T): T {
        val t = CancelToken()
        inflightControl.add(t)
        try {
            if (gate.ownerFenced()) t.cancel("owner_changed")
            return block(t)
        } finally {
            inflightControl.remove(t)
        }
    }

    private fun cancelControl(reason: String) {
        for (t in inflightControl) t.cancel(reason)
    }

    // ---- policy ------------------------------------------------------------------------------

    /** Owner-scoped; throws [PolicyRejectedException] unless [ownerId] is the bound, unfenced owner. */
    fun setPolicy(ownerId: String, unmetered: Boolean, charging: Boolean, expectedGeneration: Long? = null, expectedFenceSeq: Long = gate.fenceSeq()): GateState =
        gate.setPolicy(ownerId, unmetered, charging, expectedGeneration, expectedFenceSeq)

    /** Capture pause step 1: immediate, in memory. Returns the sequence to pass to [completeCapturePaused]. */
    fun pauseCaptureNow(): Long {
        val seq = gate.fenceCapture()
        active?.cancel("policy:capture_paused")
        return seq
    }

    fun completeCapturePaused(seq: Long) {
        // The scheduler cancel is attempted even if the durable write throws (the overlay stays set either way).
        try {
            gate.setCapturePaused(true, seq)
        } finally {
            UploadScheduler.cancel(context)
        }
    }

    /** [receiptSeq] is the capture sequence observed when the release call arrived; a newer pause wins. */
    fun releaseCapture(receiptSeq: Long) {
        gate.setCapturePaused(false, receiptSeq)
    }

    fun captureSeq(): Long = gate.captureSeq()

    fun setCapturePaused(paused: Boolean) {
        if (paused) completeCapturePaused(pauseCaptureNow()) else releaseCapture(gate.captureSeq())
    }

    // ---- tasks ---------------------------------------------------------------------------------

    fun enqueue(req: EnqueueRequest, expectedFenceSeq: Long = gate.fenceSeq()): OpResult {
        mutation.lock()
        try {
            if (pendingInvalidations.get() > 0 || gate.ownerFenced() || expectedFenceSeq != gate.fenceSeq()) return OpResult(false, "owner_changed")
            return enqueueLocked(req)
        } finally {
            mutation.unlock()
        }
    }

    private fun enqueueLocked(req: EnqueueRequest): OpResult {
        val g = gate.read()
        if (g.ownerId == null || g.ownerId != req.ownerId) return OpResult(false, "owner_not_bound")
        if (g.generation != req.ownerGeneration) return OpResult(false, "stale_owner_generation")
        val origin = g.backendOrigin ?: return OpResult(false, "owner_not_bound")
        val plan = try {
            UploadPlan.parse(req.planJson)
        } catch (e: PlanException) {
            return OpResult(false, e.code)
        }
        if (plan.state != "reserved" && plan.state != "uploading") return OpResult(false, "plan_state_" + plan.state)
        if (plan.sha256 != req.source.sha256 || plan.sizeBytes != req.source.identity.size) return OpResult(false, "plan_source_mismatch")
        if (!isSha256(req.source.sha256)) return OpResult(false, "source_invalid")
        val now = System.currentTimeMillis()
        val hardExpiry = minOf(plan.transportExpiresAtMs, now + Backoff.HARD_LIFETIME_MS)
        if (hardExpiry <= now) return OpResult(false, "plan_expired")
        // The frozen identity must still hold right now (fail early, not at 3 a.m.).
        try {
            delegateOpener.open(req.source.root, req.source.relativePath, req.source.identity).close()
        } catch (e: SourceException) {
            return OpResult(false, "source_" + e.code)
        }
        val key = TaskRecord.keyOf(req.ownerId, origin, plan)
        val record = TaskRecord(
            taskKey = key, ownerId = req.ownerId, backendOrigin = origin, ownerGeneration = req.ownerGeneration,
            plan = plan, source = req.source, state = TaskState.QUEUED,
            parts = (1..plan.partCount).map { PartRecord(it) },
            createdAtMs = now, hardExpiryMs = hardExpiry, updatedAtMs = now,
        )
        val stored = journal.insertIfAbsent(record)
        // A higher epoch of the same file retires earlier local attempts (kept, never deleted).
        for (t in journal.all()) {
            if (t.ownerId == req.ownerId && t.plan.fileId == plan.fileId && t.plan.transportEpoch < plan.transportEpoch && !t.state.terminal) {
                journal.update(t.taskKey) { it.copy(state = TaskState.FAILED, reason = "superseded_by_epoch", updatedAtMs = now) }
            }
        }
        return OpResult(true, null, stored)
    }

    fun tasksFor(ownerId: String): List<TaskRecord> = journal.all().filter { it.ownerId == ownerId }

    /** Visible-only: re-arms eligible tasks of the current owner (explicit user retry). Returns how many. */
    fun prepareResume(taskKey: String?): Int {
        val g = gate.read()
        val owner = g.ownerId ?: return 0
        var n = 0
        val now = System.currentTimeMillis()
        for (t in journal.all()) {
            if (t.ownerId != owner || t.backendOrigin != g.backendOrigin) continue
            if (taskKey != null && t.taskKey != taskKey) continue
            val rearm = t.state == TaskState.QUEUED || t.state == TaskState.WAITING_POLICY || t.state == TaskState.BACKOFF ||
                t.state == TaskState.NEEDS_VISIBLE_RESUME || t.state == TaskState.RUNNING ||
                (t.state == TaskState.BLOCKED_OWNER && (t.reason == "owner_unbound" || t.reason == "owner_changed" || t.reason == "owner_not_bound"))
            if (!rearm) continue
            journal.update(t.taskKey) {
                it.copy(
                    state = TaskState.QUEUED, reason = null, needsVisibleResume = false, controlAttempts = 0,
                    controlNextAttemptAtMs = 0, completingAttempts = 0, retryAtMs = 0, updatedAtMs = now,
                    parts = it.parts.map { p -> if (p.state == PartState.PENDING) p.copy(attempts = 0, nextAttemptAtMs = 0) else p },
                )
            }
            n++
        }
        return n
    }

    /** A start that the OS refused (or a background start we must not attempt): durable visible-Resume. */
    fun markNeedsVisibleResume(reason: String) {
        val g = gate.read()
        val now = System.currentTimeMillis()
        for (t in journal.all()) {
            if (t.ownerId != g.ownerId || !t.state.runnable) continue
            journal.update(t.taskKey) {
                it.copy(state = TaskState.NEEDS_VISIBLE_RESUME, reason = reason, needsVisibleResume = true, updatedAtMs = now)
            }
        }
        notifications.needsResume()
    }

    fun pause(taskKey: String?) {
        val now = System.currentTimeMillis()
        active?.cancel("paused")
        val g = gate.read()
        for (t in journal.all()) {
            if (t.ownerId != g.ownerId || !t.state.runnable) continue
            if (taskKey != null && t.taskKey != taskKey) continue
            journal.update(t.taskKey) {
                it.copy(state = TaskState.QUEUED, reason = "paused", needsVisibleResume = true, updatedAtMs = now)
            }
        }
        UploadScheduler.cancel(context)
    }

    /** Local-only abandon: the server file and the source are untouched. */
    fun cancel(taskKey: String): Boolean {
        val g = gate.read()
        val t = journal.get(taskKey) ?: return false
        if (t.ownerId != g.ownerId || t.state.terminal) return false
        active?.cancel("user_cancel")
        journal.update(taskKey) { it.copy(state = TaskState.FAILED, reason = "user_cancelled", updatedAtMs = System.currentTimeMillis()) }
        return true
    }

    /** Next runnable task of the bound owner, FIFO. */
    fun nextRunnable(): TaskRecord? {
        val g = gate.read()
        val owner = g.ownerId ?: return null
        return journal.all()
            .filter { it.ownerId == owner && it.backendOrigin == g.backendOrigin && it.state.runnable && !it.needsVisibleResume }
            .minByOrNull { it.createdAtMs }
    }

    fun hasRunnable(): Boolean = nextRunnable() != null

    /**
     * An unexpected failure ended a run: leave a durable visible prompt rather than a silent RUNNING task.
     * When the journal itself is what failed its write outcome is unknown, so nothing is written over it:
     * only the user prompt is shown (the cache was invalidated and the next read re-reads the disk).
     */
    fun failSafe(reason: String) {
        if (reason != "journal_unavailable") {
            try {
                val g = gate.read()
                val now = System.currentTimeMillis()
                for (t in journal.all()) {
                    if (t.ownerId != g.ownerId || t.state.terminal) continue
                    if (t.state != TaskState.RUNNING) continue
                    journal.update(t.taskKey) {
                        it.copy(state = TaskState.NEEDS_VISIBLE_RESUME, reason = reason, needsVisibleResume = true, updatedAtMs = now)
                    }
                }
            } catch (e: Exception) {
                // Journal unusable: the prompt below is all that is safe.
            }
        }
        notifications.needsResume()
    }

    /** Runs one task to its next stopping point; null when nothing is eligible or another run is active. */
    fun runNext(network: Network?, transport: HttpTransport, cancel: CancelToken): RunOutcome? {
        if (!enabled) return null
        if (!runLock.tryLock()) return null
        try {
            val next = nextRunnable() ?: return null
            jobNetwork = network
            active = cancel
            return engine.run(next.taskKey, transport, cancel)
        } finally {
            active = null
            jobNetwork = null
            runLock.unlock()
        }
    }

    /** Whether another run currently holds the single run lock (one source at a time). */
    fun isRunBusy(): Boolean = runLock.isLocked

    fun stopActive(reason: String) {
        active?.cancel(reason)
    }

    companion object {
        @Volatile private var instance: UploadRuntime? = null

        /** The already-built singleton or null; touches no disk. A running transfer can only exist when this is non-null. */
        fun peek(): UploadRuntime? = instance

        fun get(context: Context): UploadRuntime =
            instance ?: synchronized(this) {
                instance ?: UploadRuntime(context.applicationContext).also { instance = it }
            }
    }
}
