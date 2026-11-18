package open.fpvlabs.stera.upload

import java.io.IOException
import java.util.concurrent.ExecutionException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.Future
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import open.fpvlabs.stera.source_integrity.FdIdentity

class EngineDeps(
    val journal: UploadJournal,
    val gate: GateStore,
    val jar: SessionJar,
    val opener: SourceOpener,
    val chunks: ChunkStore,
    val env: EnvProbe,
    val clock: Clock = SystemClock,
    val random: () -> Double = { Math.random() },
    /** Emulator/test-only: allow `http://` provider URLs together with a cleartext loopback origin. */
    val allowCleartextProvider: Boolean = false,
    val sleep: (Long) -> Unit = { Thread.sleep(it) },
    val onProgress: (TaskRecord) -> Unit = {},
)

/**
 * [unsettled] is true only when an unexpected failure (including an unknown
 * journal write) prevented the verdict from being journaled: the caller must
 * stop looping, show a visible prompt and never overwrite the journal blindly.
 */
class RunOutcome(val state: TaskState, val reason: String?, val retryAtMs: Long?, val unsettled: Boolean = false)

/** Observed bounds, for evidence: never above 2 PUTs / 3 chunks. */
class TransferStats {
    val puts = AtomicInteger(0)
    /** Cached signed URLs discarded because they were (nearly) expired: genuine expiry-driven renewals. */
    val expiryRenewals = AtomicInteger(0)
    /** Provider 403 (expired/rejected signature) answers that forced a renewal. */
    val rejectedRenewals = AtomicInteger(0)
    private val inFlight = AtomicInteger(0)
    @Volatile var maxConcurrentPuts = 0
        private set

    fun enterPut() {
        puts.incrementAndGet()
        val now = inFlight.incrementAndGet()
        synchronized(this) { if (now > maxConcurrentPuts) maxConcurrentPuts = now }
    }

    fun exitPut() {
        inFlight.decrementAndGet()
    }
}

/** Internal control flow; carries no secret. */
private class Stop(val state: TaskState, val reason: String, val retryAtMs: Long? = null) :
    RuntimeException(reason, null, false, false)

private class ConflictStop(val code: String) : RuntimeException(code, null, false, false)

/**
 * One native transfer run for one task. It is driven only by the frozen
 * server plan journaled at enqueue: it never decides part sizes, keys, epochs
 * or completion lists, and it never runs a provider effect unless the
 * persisted current-owner gate, policy and server transport state all allow it
 * at that moment.
 */
class TransferEngine(private val deps: EngineDeps, val stats: TransferStats = TransferStats()) {

    fun run(taskKey: String, transport: HttpTransport, cancel: CancelToken): RunOutcome =
        Run(taskKey, transport, cancel).execute()

    private inner class Run(val key: String, val transport: HttpTransport, val cancel: CancelToken) {
        private val first: TaskRecord = deps.journal.get(key) ?: throw IllegalArgumentException("unknown task")
        private val gen: Long
        private var client: ControlClient? = null
        private val signedCache = HashMap<Int, SignedPart>()
        private val renewals = java.util.concurrent.ConcurrentHashMap<Int, Int>()

        init {
            gen = deps.gate.read().generation
        }

        fun cur(): TaskRecord = deps.journal.get(key)!!

        fun execute(): RunOutcome {
            val start = cur()
            if (start.state.terminal || start.state == TaskState.NEEDS_ORCHESTRATOR ||
                start.state == TaskState.SOURCE_BLOCKED || start.needsVisibleResume
            ) return RunOutcome(start.state, start.reason, null)
            // A task whose owner is not the bound one never touches the network or the source.
            val g0 = deps.gate.read()
            if (g0.ownerId != start.ownerId || g0.backendOrigin != start.backendOrigin) {
                return settle(TaskState.BLOCKED_OWNER, "owner_not_bound", null)
            }
            try {
                deps.journal.update(key) {
                    it.copy(state = TaskState.RUNNING, reason = null, needsVisibleResume = false, updatedAtMs = deps.clock.nowMs())
                }
                body()
                return finish()
            } catch (s: Stop) {
                return settle(s.state, s.reason, s.retryAtMs)
            } catch (c: CancelledException) {
                return settle(mapCancel(cancel.reason), cancel.reason, null)
            } catch (e: ConflictStop) {
                return settle(TaskState.NEEDS_ORCHESTRATOR, classifyConflict(e), null)
            } catch (e: Exception) {
                // Disk full, a closed source, a decode problem...: a stable code only, never exception text.
                return engineError(if (e is JournalWriteException || e is JournalCorruptException) "journal_unavailable" else "engine_error")
            }
        }

        /**
         * Settles a visible prompt. If even that cannot be journaled (the journal is what failed) nothing is
         * written: the cache was invalidated, so a later read sees the real disk state, and the caller is told.
         */
        private fun engineError(reason: String): RunOutcome {
            return try {
                settle(TaskState.NEEDS_VISIBLE_RESUME, reason, null)
            } catch (x: Exception) {
                RunOutcome(TaskState.NEEDS_VISIBLE_RESUME, reason, null, unsettled = true)
            }
        }

        /**
         * A 409 usually means a stale epoch; ask the server (best effort) instead of guessing. The failing
         * worker cancelled the shared token itself, so the check runs on a fresh one, but only while the run
         * was not cancelled for an external reason and the owner/policy gate still allows an effect: no
         * control request is ever made after a logout, owner switch, pause or system stop.
         */
        private fun classifyConflict(e: ConflictStop): String {
            try {
                val c = client
                val external = cancel.cancelled && cancel.reason != INTERNAL_FAILURE
                val g = deps.gate.read()
                val allowed = c != null && !external && g.generation == gen && g.ownerId == first.ownerId &&
                    g.backendOrigin == first.backendOrigin && g.policy.blockReason(deps.env.snapshot()) == null &&
                    deps.clock.nowMs() <= first.hardExpiryMs
                if (allowed) {
                    val plan = c!!.withCancel(CancelToken()).getPlan(first.plan.fileId)
                    if (plan.transportEpoch != first.plan.transportEpoch) return "epoch_changed"
                }
            } catch (x: Exception) {
                // fall through to the generic conflict
            }
            return "conflict_" + e.code
        }

        private fun mapCancel(reason: String): TaskState = when {
            reason == "owner_changed" -> TaskState.BLOCKED_OWNER
            reason.startsWith("policy:") -> TaskState.WAITING_POLICY
            else -> TaskState.QUEUED
        }

        private fun finish(): RunOutcome {
            val t = cur()
            return RunOutcome(t.state, t.reason, null)
        }

        private fun settle(state: TaskState, reason: String, retryAt: Long?): RunOutcome {
            val visible = state == TaskState.NEEDS_VISIBLE_RESUME || (state == TaskState.QUEUED && reason == "paused")
            val now = deps.clock.nowMs()
            val updated = deps.journal.update(key) {
                // A terminal verdict reached concurrently (UPLOADED) is never overwritten.
                if (it.state.terminal) null
                else it.copy(state = state, reason = reason, needsVisibleResume = visible, updatedAtMs = now,
                    // Every BACKOFF reason keeps its retry time, so a restart cannot act before it.
                    retryAtMs = if (state == TaskState.BACKOFF) (retryAt ?: 0) else 0,
                    // Anything in flight at stop time has an unknown outcome: reconcile before repeating it.
                    needsReconcile = it.needsReconcile || it.parts.any { p -> p.state == PartState.UPLOADING })
            }
            if (updated != null) deps.onProgress(updated)
            return RunOutcome(state, reason, retryAt)
        }

        // ---- effect guard ------------------------------------------------------------------

        /** Re-read before every control call, PUT start and chunk: owner generation, policy, expiry. */
        fun guard() {
            cancel.check()
            val g = deps.gate.read()
            if (g.generation != gen || g.ownerId != first.ownerId || g.backendOrigin != first.backendOrigin) {
                cancel.cancel("owner_changed")
                throw Stop(TaskState.BLOCKED_OWNER, "owner_changed")
            }
            val why = g.policy.blockReason(deps.env.snapshot())
            if (why != null) {
                cancel.cancel("policy:$why")
                throw Stop(TaskState.WAITING_POLICY, why)
            }
            if (deps.clock.nowMs() > first.hardExpiryMs) throw Stop(TaskState.NEEDS_ORCHESTRATOR, "transport_expired")
        }

        // ---- control plane -------------------------------------------------------------------

        private fun <T> ctl(block: (ControlClient) -> T): T {
            guard()
            // An open control backoff window is honored: no request is made before it elapses.
            val window = cur().controlNextAttemptAtMs
            if (window > deps.clock.nowMs()) throw Stop(TaskState.BACKOFF, "control_unavailable", window)
            val c = client ?: throw IllegalStateException("client not ready")
            try {
                val out = block(c)
                if (cur().controlAttempts != 0) deps.journal.update(key) { it.copy(controlAttempts = 0, controlNextAttemptAtMs = 0) }
                return out
            } catch (e: ControlException) {
                throw mapControl(e)
            }
        }

        private fun mapControl(e: ControlException): RuntimeException = when (e.kind) {
            ControlKind.AUTH -> Stop(TaskState.NEEDS_VISIBLE_RESUME, "session_required")
            ControlKind.FORBIDDEN -> Stop(TaskState.BLOCKED_OWNER, "forbidden")
            ControlKind.NOT_FOUND -> Stop(TaskState.NEEDS_ORCHESTRATOR, "upload_not_found")
            ControlKind.CONFLICT -> ConflictStop(e.code)
            ControlKind.PERMANENT -> Stop(TaskState.NEEDS_ORCHESTRATOR, "control_" + e.code)
            ControlKind.TRANSIENT, ControlKind.NETWORK -> transientStop()
            // The credential no longer belongs to this run (logout/owner switch): drop it, retain the task.
            ControlKind.STALE_SESSION -> Stop(TaskState.BLOCKED_OWNER, "owner_changed")
        }

        private fun transientStop(): Stop {
            val t = cur()
            // A failure inside an already-open backoff window (a concurrent worker) is the same outage, not a new attempt.
            if (t.controlNextAttemptAtMs > deps.clock.nowMs()) return Stop(TaskState.BACKOFF, "control_unavailable", t.controlNextAttemptAtMs)
            val attempts = t.controlAttempts + 1
            if (attempts >= Backoff.MAX_CONTROL_ATTEMPTS) {
                deps.journal.update(key) { it.copy(controlAttempts = attempts) }
                return Stop(TaskState.NEEDS_VISIBLE_RESUME, "control_retries_exhausted")
            }
            val at = deps.clock.nowMs() + Backoff.delayMs(attempts, deps.random())
            deps.journal.update(key) { it.copy(controlAttempts = attempts, controlNextAttemptAtMs = at) }
            return Stop(TaskState.BACKOFF, "control_unavailable", at)
        }

        // ---- the run ---------------------------------------------------------------------------

        private fun body() {
            guard()
            val start = cur()
            val now = deps.clock.nowMs()
            if (start.controlNextAttemptAtMs > now) throw Stop(TaskState.BACKOFF, "control_unavailable", start.controlNextAttemptAtMs)
            // Every other BACKOFF reason (completing, reserved, unreported) is honored across restarts too.
            if (start.retryAtMs > now) throw Stop(TaskState.BACKOFF, first.reason ?: "backoff", start.retryAtMs)
            val origin = first.backendOrigin
            client = ControlClient(origin, first.ownerId, deps.jar, transport, cancel, first.plan.partSizeBytes)

            // The frozen owner must be the actual Better Auth principal, verified server-side before any effect.
            val me = ctl { it.me() }
            if (me.userId != first.ownerId || !me.activeCollector) throw Stop(TaskState.BLOCKED_OWNER, "principal_mismatch")

            deps.chunks.sweep() // one run at a time: leftovers are from a dead process
            val source = try {
                deps.opener.open(first.source.root, first.source.relativePath, first.source.identity)
            } catch (e: SourceException) {
                throw Stop(TaskState.SOURCE_BLOCKED, e.code)
            }
            source.use { src ->
                val live = serverPlan()
                val plan = settleState(live) ?: return // already uploaded
                reconcileIfUncertain(plan)
                reportLanded()
                uploadParts(src, first.source.identity)
                reportLanded()
                complete()
            }
        }

        /** Fetches the live plan and requires the frozen transport identity. */
        private fun serverPlan(): UploadPlan {
            val plan = ctl { it.getPlan(first.plan.fileId) }
            if (!plan.sameTransport(first.plan)) {
                throw Stop(
                    TaskState.NEEDS_ORCHESTRATOR,
                    if (plan.transportEpoch != first.plan.transportEpoch) "epoch_changed" else "plan_mismatch",
                )
            }
            return plan
        }

        /** Returns the plan when uploading may proceed, null when the file is already complete. */
        private fun settleState(plan0: UploadPlan): UploadPlan? {
            var plan = plan0
            if (plan.state == "reserved") {
                // Provider initialization is the server's; ask it to reconcile, never to create.
                plan = checkSame(ctl { it.reconcile(first.plan.fileId, first.plan.transportEpoch) })
            }
            return when (plan.state) {
                "uploading" -> plan
                "completed", "verified" -> { markUploaded(); null }
                "completing" -> settleCompleting()
                "reserved" -> throw Stop(TaskState.BACKOFF, "transport_reserved", deps.clock.nowMs() + Backoff.delayMs(1, deps.random()))
                else -> throw Stop(TaskState.NEEDS_ORCHESTRATOR, "server_state_" + plan.state)
            }
        }

        private fun checkSame(plan: UploadPlan): UploadPlan {
            if (!plan.sameTransport(first.plan)) {
                throw Stop(
                    TaskState.NEEDS_ORCHESTRATOR,
                    if (plan.transportEpoch != first.plan.transportEpoch) "epoch_changed" else "plan_mismatch",
                )
            }
            return plan
        }

        /** `completing` is only ever settled by the server's reconcile; no PUT may run meanwhile. */
        private fun settleCompleting(): UploadPlan? {
            val plan = checkSame(ctl { it.reconcile(first.plan.fileId, first.plan.transportEpoch) })
            return when (plan.state) {
                "completed", "verified" -> { markUploaded(); null }
                "completing" -> throw completingWait()
                "uploading" -> {
                    if (cur().completingAttempts != 0) deps.journal.update(key) { it.copy(completingAttempts = 0, retryAtMs = 0) }
                    plan
                }
                else -> throw Stop(TaskState.NEEDS_ORCHESTRATOR, "server_state_" + plan.state)
            }
        }

        /**
         * The server is still `completing`. Waits are counted apart from control-call results (a successful
         * reconcile must not reset them), grow exponentially, persist their retry time and end in
         * `completing_unresolved` after the cap.
         */
        private fun completingWait(): Stop {
            val attempts = cur().completingAttempts + 1
            if (attempts >= Backoff.MAX_CONTROL_ATTEMPTS) {
                deps.journal.update(key) { it.copy(completingAttempts = attempts, retryAtMs = 0) }
                return Stop(TaskState.NEEDS_ORCHESTRATOR, "completing_unresolved")
            }
            val at = deps.clock.nowMs() + Backoff.delayMs(attempts, deps.random())
            deps.journal.update(key) { it.copy(completingAttempts = attempts, retryAtMs = at) }
            return Stop(TaskState.BACKOFF, "completing_unknown", at)
        }

        /**
         * Before any repeat of a possibly-landed part: the server reconciles the
         * provider's truth, and the plan must still be `uploading` at the same
         * epoch. In-flight leftovers from a dead process count as uncertain.
         */
        private fun reconcileIfUncertain(plan: UploadPlan) {
            val t = cur()
            if (!t.needsReconcile && t.parts.none { it.state == PartState.UPLOADING }) return
            val after = checkSame(ctl { it.reconcile(first.plan.fileId, first.plan.transportEpoch) })
            when (after.state) {
                "uploading" -> Unit
                "completed", "verified" -> { markUploaded(); throw Stop(TaskState.UPLOADED, "already_complete") }
                "completing" -> {
                    if (settleCompleting() == null) throw Stop(TaskState.UPLOADED, "already_complete")
                }
                else -> throw Stop(TaskState.NEEDS_ORCHESTRATOR, "server_state_" + after.state)
            }
            deps.journal.update(key) { r ->
                r.copy(
                    needsReconcile = false,
                    // An interrupted PUT already consumed its attempt when it started; it also backs off before a repeat.
                    parts = r.parts.map { p ->
                        if (p.state == PartState.UPLOADING) {
                            p.copy(
                                state = PartState.PENDING,
                                nextAttemptAtMs = if (p.attempts > 0) deps.clock.nowMs() + Backoff.delayMs(p.attempts, deps.random()) else p.nextAttemptAtMs,
                            )
                        } else p
                    },
                    updatedAtMs = deps.clock.nowMs(),
                )
            }
        }

        private fun markUploaded() {
            val now = deps.clock.nowMs()
            val updated = deps.journal.update(key) {
                it.copy(
                    state = TaskState.UPLOADED, reason = null, needsReconcile = false, needsVisibleResume = false,
                    parts = it.parts.map { p -> if (p.etag != null) p.copy(state = PartState.REPORTED) else p },
                    updatedAtMs = now,
                )
            }
            deps.chunks.sweep()
            if (updated != null) deps.onProgress(updated)
        }

        /** Idempotently reports receipts the API has not yet acknowledged (<= 32 per request). */
        private fun reportLanded() {
            while (true) {
                val t = cur()
                val batch = t.parts.filter { it.state == PartState.LANDED && it.etag != null }.take(32)
                if (batch.isEmpty()) return
                val entries = batch.map { ReceiptEntry(it.partNumber, it.etag!!, it.sizeBytes) }
                ctl { it.receipts(first.plan, entries) }
                deps.journal.update(key) { r ->
                    val ids = batch.map { b -> b.partNumber }.toSet()
                    r.copy(
                        parts = r.parts.map { p -> if (p.partNumber in ids && p.state == PartState.LANDED) p.copy(state = PartState.REPORTED) else p },
                        updatedAtMs = deps.clock.nowMs(),
                    )
                }
                deps.onProgress(cur())
            }
        }

        // ---- part uploads ------------------------------------------------------------------

        private fun uploadParts(source: OpenSource, identity: FdIdentity) {
            val pool: ExecutorService = Executors.newFixedThreadPool(Limits.MAX_CONCURRENT_PUTS)
            val running = HashMap<Int, Future<*>>()
            var failure: Throwable? = null
            try {
                while (true) {
                    // Harvest finished work; the first failure stops everything.
                    val iter = running.entries.iterator()
                    while (iter.hasNext()) {
                        val e = iter.next()
                        if (e.value.isDone) {
                            iter.remove()
                            try { e.value.get() } catch (x: ExecutionException) { if (failure == null) failure = x.cause ?: x }
                        }
                    }
                    if (failure != null) break
                    try { guard() } catch (s: Stop) { failure = s; break } catch (c: CancelledException) { failure = c; break }

                    val t = cur()
                    val now0 = deps.clock.nowMs()
                    // A control outage opened a backoff window: start no new PUT until it elapses (receipts could not be reported).
                    val hold = t.controlNextAttemptAtMs
                    if (hold > now0) {
                        if (running.isEmpty() && hold - now0 > SHORT_WAIT_MS) { failure = Stop(TaskState.BACKOFF, "control_unavailable", hold); break }
                        deps.sleep(if (running.isEmpty()) minOf(hold - now0, 1000L) else POLL_MS)
                        continue
                    }
                    if (running.isEmpty() && t.parts.any { it.state == PartState.LANDED }) {
                        // The window elapsed: flush unreported receipts before anything else.
                        try { reportLanded() } catch (s: Stop) { failure = s; break }
                        continue
                    }
                    val pending = t.parts.filter { it.state == PartState.PENDING }
                    if (pending.isEmpty() && running.isEmpty()) break

                    if ((t.needsReconcile) && running.isEmpty()) {
                        try { reconcileIfUncertain(first.plan) } catch (s: Stop) { failure = s; break }
                        continue
                    }
                    if (!t.needsReconcile) {
                        val now = deps.clock.nowMs()
                        for (p in pending) {
                            if (running.size >= Limits.MAX_CONCURRENT_PUTS) break
                            if (running.containsKey(p.partNumber) || p.nextAttemptAtMs > now) continue
                            running[p.partNumber] = pool.submit(Runnable { uploadOne(p.partNumber, source, identity) })
                        }
                    }
                    if (running.isEmpty() && pending.isNotEmpty()) {
                        // Everything left is backing off.
                        val next = pending.minOf { it.nextAttemptAtMs }
                        val wait = next - deps.clock.nowMs()
                        if (wait > SHORT_WAIT_MS) { failure = Stop(TaskState.BACKOFF, "retry_scheduled", next); break }
                        if (wait > 0) deps.sleep(minOf(wait, 1000L))
                    } else {
                        deps.sleep(POLL_MS)
                    }
                }
            } finally {
                val f = failure
                if (f != null) {
                    // Stop in-flight PUTs promptly; their parts stay UPLOADING (unknown) and are reconciled next run.
                    if (!cancel.cancelled) cancel.cancel(if (f is Stop) reasonOf(f) else INTERNAL_FAILURE)
                }
                pool.shutdown()
                if (!pool.awaitTermination(15, TimeUnit.SECONDS)) pool.shutdownNow()
            }
            val f = failure
            if (f != null) throw f
        }

        private fun reasonOf(s: Stop): String = when (s.state) {
            TaskState.BLOCKED_OWNER -> "owner_changed"
            TaskState.WAITING_POLICY -> "policy:" + s.reason
            else -> s.reason
        }

        private fun uploadOne(partNumber: Int, source: OpenSource, identity: FdIdentity) {
            var renewalsUsed = renewals.getOrDefault(partNumber, 0)
            while (true) {
                guard()
                val signed = signedFor(partNumber)
                // The attempt is consumed durably BEFORE the effect: a process death mid-PUT cannot loop for free.
                var exhausted = false
                deps.journal.update(key) { r ->
                    val p = r.part(partNumber)
                    if (p.attempts >= Backoff.MAX_PART_ATTEMPTS) { exhausted = true; null }
                    else r.withPart(p.copy(state = PartState.UPLOADING, attempts = p.attempts + 1), deps.clock.nowMs())
                }
                if (exhausted) throw Stop(TaskState.NEEDS_VISIBLE_RESUME, "retries_exhausted")
                val chunk = try {
                    deps.chunks.extract(source, identity, first.plan, partNumber, cancel)
                } catch (e: SourceException) {
                    // low storage waits; any source difference blocks the task and uploads nothing more.
                    revertToPending(partNumber)
                    if (e.code == "low_storage") throw Stop(TaskState.WAITING_POLICY, "low_storage")
                    throw Stop(TaskState.SOURCE_BLOCKED, e.code)
                } catch (e: CancelledException) {
                    revertToPending(partNumber)
                    throw e
                }
                val resp: PutResponse? = chunk.use { c ->
                    stats.enterPut()
                    try {
                        transport.putFile(signed.url, signed.headers, c.file, c.length, cancel)
                    } catch (e: CancelledException) {
                        // Our own deliberate stop is not a failure: refund the attempt. The part stays UPLOADING (unknown).
                        refundAttempt(partNumber)
                        throw e
                    } catch (e: IOException) {
                        null
                    } finally {
                        stats.exitPut()
                    }
                }
                val status = resp?.status ?: -1
                when {
                    resp != null && status in 200..299 && !resp.etag.isNullOrEmpty() -> {
                        recordLanded(partNumber, resp.etag!!)
                        return
                    }
                    resp != null && status == 403 -> {
                        // Expired/rejected signature: pause for an authenticated renewal, never reuse the URL.
                        synchronized(signedCache) { signedCache.remove(partNumber) }
                        stats.rejectedRenewals.incrementAndGet()
                        renewalsUsed++
                        renewals[partNumber] = renewalsUsed
                        if (renewalsUsed > Backoff.MAX_RENEWALS_PER_PART) {
                            failAttempt(partNumber)
                            return
                        }
                        revertToPending(partNumber)
                        continue
                    }
                    resp != null && status in 400..499 && status != 408 && status != 429 ->
                        throw Stop(TaskState.NEEDS_ORCHESTRATOR, "provider_rejected_$status")
                    else -> {
                        // Timeout, reset, 5xx, 429 or a 2xx without an ETag: the outcome is unknown.
                        failAttempt(partNumber)
                        return
                    }
                }
            }
        }

        private fun signedFor(partNumber: Int): SignedPart {
            synchronized(signedCache) {
                val now = deps.clock.nowMs()
                val hit = signedCache[partNumber]
                if (hit != null && hit.expiresAtMs - URL_SKEW_MS > now) return hit
                if (hit != null) stats.expiryRenewals.incrementAndGet()
                signedCache.remove(partNumber)
                val want = cur().parts.filter { it.state == PartState.PENDING || it.partNumber == partNumber }
                    .map { it.partNumber }.filter { it != partNumber && !signedCache.containsKey(it) }
                    .take(Limits.SIGN_BATCH - 1)
                val numbers = listOf(partNumber) + want
                val signed = ctl { it.sign(first.plan, numbers, deps.allowCleartextProvider) }
                for (s in signed) signedCache[s.partNumber] = s
                return signedCache[partNumber] ?: throw Stop(TaskState.NEEDS_ORCHESTRATOR, "control_signed_missing")
            }
        }

        /** No PUT happened (or its renewal is retried at once): back to PENDING and give the attempt back. */
        private fun revertToPending(partNumber: Int) {
            deps.journal.update(key) { r ->
                val p = r.part(partNumber)
                if (p.state == PartState.UPLOADING) r.withPart(p.copy(state = PartState.PENDING, attempts = maxOf(0, p.attempts - 1)), deps.clock.nowMs()) else null
            }
        }

        private fun refundAttempt(partNumber: Int) {
            try {
                deps.journal.update(key) { r ->
                    val p = r.part(partNumber)
                    if (p.state == PartState.UPLOADING && p.attempts > 0) r.withPart(p.copy(attempts = p.attempts - 1), deps.clock.nowMs()) else null
                }
            } catch (e: IOException) {
                // Keeping the attempt consumed is the safe side.
            }
        }

        private fun recordLanded(partNumber: Int, etag: String) {
            val len = first.plan.partLength(partNumber)
            val updated = deps.journal.update(key) { r ->
                r.withPart(r.part(partNumber).copy(state = PartState.LANDED, etag = etag, sizeBytes = len, attempts = 0, nextAttemptAtMs = 0), deps.clock.nowMs())
            }
            if (updated != null) deps.onProgress(updated)
            // Report immediately; a failure here leaves the part LANDED for the idempotent batch report.
            try {
                ctl { it.receipts(first.plan, listOf(ReceiptEntry(partNumber, etag, len))) }
                deps.journal.update(key) { r ->
                    val p = r.part(partNumber)
                    if (p.state == PartState.LANDED) r.withPart(p.copy(state = PartState.REPORTED), deps.clock.nowMs()) else null
                }
                deps.onProgress(cur())
            } catch (s: Stop) {
                // (A receipt outage is not a PUT failure: the part stays LANDED, no new PUT starts until the
                // persisted window elapses, and the scheduler loop then flushes the receipts.)
                if (s.state == TaskState.BACKOFF) return
                throw s
            }
        }

        /** The attempt was consumed when the PUT started; this schedules the repeat (after reconcile) with backoff. */
        private fun failAttempt(partNumber: Int) {
            var exhausted = false
            deps.journal.update(key) { r ->
                val p = r.part(partNumber)
                val attempts = maxOf(1, p.attempts)
                exhausted = attempts >= Backoff.MAX_PART_ATTEMPTS
                r.withPart(
                    p.copy(state = PartState.PENDING, attempts = attempts,
                        nextAttemptAtMs = deps.clock.nowMs() + Backoff.delayMs(attempts, deps.random())),
                    deps.clock.nowMs(),
                ).copy(needsReconcile = true)
            }
            if (exhausted) throw Stop(TaskState.NEEDS_VISIBLE_RESUME, "retries_exhausted")
        }

        private fun complete() {
            val t = cur()
            if (t.parts.any { it.state != PartState.REPORTED }) throw Stop(TaskState.BACKOFF, "parts_unreported", deps.clock.nowMs() + Backoff.delayMs(1, deps.random()))
            // Persist intent first: after a crash the next run reconciles before anything else.
            deps.journal.update(key) { it.copy(completeSent = true, needsReconcile = true, updatedAtMs = deps.clock.nowMs()) }
            val plan = try {
                ctl { it.complete(first.plan.fileId, first.plan.transportEpoch) }
            } catch (c: ConflictStop) {
                throw Stop(TaskState.NEEDS_ORCHESTRATOR, "complete_conflict_" + c.code)
            }
            checkSame(plan)
            when (plan.state) {
                "completed", "verified" -> markUploaded()
                "completing" -> throw completingWait()
                else -> throw Stop(TaskState.NEEDS_ORCHESTRATOR, "complete_refused_" + plan.state)
            }
        }
    }

    companion object {
        const val INTERNAL_FAILURE = "internal_failure"
        const val POLL_MS = 50L
        const val SHORT_WAIT_MS = 30_000L
        const val URL_SKEW_MS = 30_000L
    }
}
