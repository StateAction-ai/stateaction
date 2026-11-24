package open.fpvlabs.stera.upload

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * Plain-JVM logic tests over an in-memory API/provider. They prove the state
 * machine, ordering and bounds; they do NOT exercise Android's JobScheduler,
 * Keystore or `Os` (those are emulator-only checks).
 */
class TransferEngineTest {
    @get:Rule val tmp = TemporaryFolder()

    private fun rig(size: Long = 250): Rig = Rig(tmp.newFolder(), size).also { it.bindOwner() }


    @Test fun uploadsEveryPartThenCompletesOnce() {
        val r = rig()
        val key = r.enqueue()
        val out = r.run(key)
        assertEquals(TaskState.UPLOADED, out.state)
        assertTrue(r.data.contentEquals(r.backend.assembled()))
        assertEquals(1, r.backend.completeCalls.get())
        assertTrue("two PUTs at most", r.backend.maxInFlight <= Limits.MAX_CONCURRENT_PUTS)
        assertTrue("three chunks at most", r.chunks.maxLive <= Limits.MAX_TEMP_CHUNKS)
        assertTrue(r.stats.maxConcurrentPuts <= 2)
        val t = r.journal.get(key)!!
        assertTrue(t.parts.all { it.state == PartState.REPORTED && it.etag != null })
    }

    @Test fun controlCallsCarryTheSessionAndOriginButProviderPutsNeverDo() {
        val r = rig()
        r.run(r.enqueue())
        val mutations = r.backend.controlHeaders.filter { it.containsKey("origin") }
        assertTrue(mutations.isNotEmpty())
        assertTrue(mutations.all { it["origin"] == ORIGIN })
        assertTrue(r.backend.controlHeaders.all { it["cookie"] == "__Secure-better-auth.session_token=tok" })
        assertTrue(r.backend.providerHeaders.isNotEmpty())
        val forbidden = setOf("cookie", "authorization", "origin", "x-stateaction-client")
        assertTrue(r.backend.providerHeaders.all { h -> h.keys.none { it.lowercase() in forbidden } })
    }

    @Test fun journalNeverContainsUrlsOrCookies() {
        val r = rig()
        r.run(r.enqueue())
        val text = r.journalFile.readText() + r.gateFile.readText()
        assertFalse(text.contains("s3.test"))
        assertFalse(text.contains("secret"))
        assertFalse(text.contains("session_token"))
        assertFalse(text.contains("Bearer"))
    }

    @Test fun anExpiredSignatureRenewsThroughTheApiAndStillCompletes() {
        val r = rig()
        // The provider rejects the first use of part 1's URL as expired.
        r.backend.putScript = { part, attempt -> if (part == 1 && attempt == 1) 403 else 0 }
        val out = r.run(r.enqueue())
        assertEquals(TaskState.UPLOADED, out.state)
        assertEquals(2, r.backend.putAttempts[1]!!.get())
        assertTrue("a second sign request renewed the URL", r.backend.signCalls.get() >= 2)
    }

    @Test fun aCachedUrlNearExpiryIsRenewedBeforeTheProviderIsTried() {
        val r = rig()
        r.backend.urlTtlMs = 60_000
        // Part 1 lands 40 s later: the cached URLs for the other parts now have < 30 s left.
        r.backend.afterPut = { part -> if (part == 1) r.clock.advance(40_000) }
        val out = r.run(r.enqueue())
        assertEquals(TaskState.UPLOADED, out.state)
        assertTrue("renewed", r.backend.signCalls.get() >= 2)
        assertTrue("no provider call used an expired URL", r.backend.putAttempts.values.all { it.get() == 1 })
    }

    @Test fun anUncertainPutIsReconciledByTheServerBeforeItIsRepeated() {
        val r = rig()
        r.backend.putScript = { part, attempt -> if (part == 2 && attempt == 1) -1 else 0 }
        val out = r.run(r.enqueue())
        assertEquals(TaskState.UPLOADED, out.state)
        val calls = r.backend.calls.toList()
        val first = calls.indexOf("PUT part=2")
        val second = calls.lastIndexOf("PUT part=2")
        assertTrue(second > first)
        assertTrue(
            "reconcile between the failed and the repeated PUT",
            calls.subList(first, second).any { it.endsWith("/reconcile") },
        )
        assertEquals(2, r.backend.putAttempts[2]!!.get())
    }

    @Test fun processDeathResumesFromTheJournalWithoutRepeatingLandedParts() {
        val r = rig()
        val key = r.enqueue()
        val cancel = CancelToken()
        r.backend.afterPut = { part -> if (part == 1) cancel.cancel("system_stop") }
        val first = r.run(key, cancel)
        assertEquals(TaskState.QUEUED, first.state)
        assertEquals("system_stop", first.reason)
        // New process: journal reloaded from disk, brand-new engine.
        val second = r.run(key, engine = r.restart())
        assertEquals(TaskState.UPLOADED, second.state)
        assertEquals("landed part is not sent twice", 1, r.backend.putAttempts[1]!!.get())
        assertTrue(r.data.contentEquals(r.backend.assembled()))
        assertEquals(1, r.backend.completeCalls.get())
    }

    @Test fun logoutMidTransferBlocksTheOldOwnerAndKeepsItsJournal() {
        val r = rig()
        val key = r.enqueue()
        r.backend.afterPut = { r.gate.unbind() }
        val out = r.run(key)
        assertEquals(TaskState.BLOCKED_OWNER, out.state)
        val t = r.journal.get(key)!!
        assertEquals(OWNER, t.ownerId)
        assertTrue(t.parts.any { it.etag != null })
        val puts = r.backend.calls.count { it.startsWith("PUT") }
        // Another account cannot adopt it: a run for the old task touches nothing.
        r.bindOwner(OTHER)
        val before = r.backend.calls.size
        val again = r.run(key)
        assertEquals(TaskState.BLOCKED_OWNER, again.state)
        assertEquals(before, r.backend.calls.size)
        assertTrue(puts <= 2)
        assertFalse(r.journal.get(key)!!.state == TaskState.UPLOADED)
    }

    @Test fun capturePauseAndChargingPolicyStopEveryEffect() {
        val r = rig()
        val key = r.enqueue()
        r.gate.setCapturePaused(true)
        assertEquals("capture_paused", r.run(key).reason)
        r.gate.setCapturePaused(false)
        r.env.snap = EnvSnapshot(networkAvailable = true, unmetered = true, charging = false)
        val out = r.run(key)
        assertEquals(TaskState.WAITING_POLICY, out.state)
        assertEquals("charging_required", out.reason)
        r.env.snap = EnvSnapshot(networkAvailable = true, unmetered = false, charging = true)
        assertEquals("unmetered_required", r.run(key).reason)
        assertTrue("no control or provider call was made", r.backend.calls.isEmpty())
    }

    @Test fun policySurvivesProcessRestart() {
        val r = rig()
        r.gate.setCapturePaused(true)
        r.gate.setPolicy(OWNER, requireUnmetered = false, requireCharging = false)
        val reloaded = GateStore(r.gateFile).read()
        assertTrue(reloaded.policy.capturePaused)
        assertFalse(reloaded.policy.requireUnmetered)
        assertEquals(OWNER, reloaded.ownerId)
    }

    @Test fun completingOrChangedEpochOrTerminalStateBlocksEveryPut() {
        val r = rig()
        val key = r.enqueue()
        r.backend.serverState = "completing"
        val a = r.run(key)
        assertEquals(TaskState.BACKOFF, a.state)
        assertEquals("completing_unknown", a.reason)
        r.backend.serverState = "uploading"
        r.backend.serverEpoch = 2
        r.clock.advance(3_600_000)
        val b = r.run(key)
        assertEquals(TaskState.NEEDS_ORCHESTRATOR, b.state)
        assertEquals("epoch_changed", b.reason)
        assertTrue(r.backend.calls.none { it.startsWith("PUT") })
        val r2 = rig()
        val k2 = r2.enqueue()
        r2.backend.serverState = "cancelled"
        assertEquals("server_state_cancelled", r2.run(k2).reason)
        assertTrue(r2.backend.calls.none { it.startsWith("PUT") })
    }

    @Test fun aSourceThatChangedOrGrewIsRefusedAndNothingIsCompleted() {
        val r = rig()
        val key = r.enqueue()
        r.source.identity = r.source.baseIdentity.copy(size = 300)
        val out = r.run(key)
        assertEquals(TaskState.SOURCE_BLOCKED, out.state)
        assertEquals("changed", out.reason)
        assertTrue(r.backend.calls.none { it.startsWith("PUT") })

        val m = rig()
        val mk = m.enqueue()
        m.source.onRead = { off -> if (off >= PART) m.source.identity = m.source.baseIdentity.copy(mtimeNs = 5) }
        val mid = m.run(mk)
        assertEquals(TaskState.SOURCE_BLOCKED, mid.state)
        assertEquals(0, m.backend.completeCalls.get())
        assertTrue(m.backend.provider.size < 3)
        // A blocked source is not retried by the engine on its own.
        val before = m.backend.calls.size
        assertEquals(TaskState.SOURCE_BLOCKED, m.run(mk).state)
        assertEquals(before, m.backend.calls.size)
    }

    @Test fun theBoundOwnerMustBeTheRealBetterAuthPrincipal() {
        val r = rig()
        r.backend.meUser = OTHER
        val out = r.run(r.enqueue())
        assertEquals(TaskState.BLOCKED_OWNER, out.state)
        assertEquals("principal_mismatch", out.reason)
        assertEquals(listOf("GET /api/v1/me"), r.backend.calls.toList())
    }

    @Test fun anExpiredSessionNeedsAVisibleResumeNotARetryLoop() {
        val r = rig()
        r.backend.meStatus = 401
        val key = r.enqueue()
        val out = r.run(key)
        assertEquals(TaskState.NEEDS_VISIBLE_RESUME, out.state)
        assertEquals("session_required", out.reason)
        assertTrue(r.journal.get(key)!!.needsVisibleResume)
        val calls = r.backend.calls.size
        assertEquals(TaskState.NEEDS_VISIBLE_RESUME, r.run(key).state)
        assertEquals(calls, r.backend.calls.size)
    }

    @Test fun retriesAreCappedThenWaitForAVisibleResume() {
        val r = rig(100)
        r.backend.putScript = { _, _ -> 500 }
        val key = r.enqueue()
        var state = TaskState.QUEUED
        for (i in 0 until 30) {
            state = r.run(key).state
            if (state == TaskState.NEEDS_VISIBLE_RESUME) break
            r.clock.advance(120_000)
        }
        assertEquals(TaskState.NEEDS_VISIBLE_RESUME, state)
        assertEquals("retries_exhausted", r.journal.get(key)!!.reason)
        assertTrue(r.backend.putAttempts[1]!!.get() <= Backoff.MAX_PART_ATTEMPTS)
        assertEquals(0, r.backend.completeCalls.get())
    }

    @Test fun aLostCompleteResponseIsReconciledAndNeverRepeated() {
        val r = rig(100)
        r.backend.completeLost = true
        val key = r.enqueue()
        assertEquals(TaskState.BACKOFF, r.run(key).state)
        r.clock.advance(600_000)
        val out = r.run(key, engine = r.restart())
        assertEquals(TaskState.UPLOADED, out.state)
        assertEquals(1, r.backend.completeCalls.get())
        assertEquals(1, r.backend.putAttempts[1]!!.get())
    }

    @Test fun anOldPlanCannotBeUsedToUploadADifferentFile() {
        val r = rig()
        val key = r.enqueue()
        // The server now reports different immutable content for the same file id.
        r.backend.plan = r.plan.copy(sha256 = sha(9))
        val out = r.run(key)
        assertEquals(TaskState.NEEDS_ORCHESTRATOR, out.state)
        assertEquals("plan_mismatch", out.reason)
        assertTrue(r.backend.calls.none { it.startsWith("PUT") })
        assertNotNull(r.journal.get(key))
    }

    // ---- review follow-ups F1-F5 -----------------------------------------------------------------

    @Test fun aServerStuckInCompletingBacksOffGrowinglyAndEscalatesNotForever() {
        val r = rig(100)
        val key = r.enqueue()
        r.backend.serverState = "completing"
        val delays = ArrayList<Long>()
        var out = r.run(key)
        var runs = 1
        while (out.state == TaskState.BACKOFF && runs < 20) {
            val t = r.journal.get(key)!!
            assertEquals("completing_unknown", out.reason)
            assertTrue("the retry time is journaled", t.retryAtMs > r.clock.now)
            delays += t.retryAtMs - r.clock.now
            // Waking before the window elapses is a no-op: no control request at all.
            val calls = r.backend.calls.size
            assertEquals(TaskState.BACKOFF, r.run(key, engine = r.restart()).state)
            assertEquals("a restart honors the journaled window", calls, r.backend.calls.size)
            r.clock.advance(t.retryAtMs - r.clock.now + 1)
            out = r.run(key, engine = r.restart())
            runs++
        }
        assertEquals(TaskState.NEEDS_ORCHESTRATOR, out.state)
        assertEquals("completing_unresolved", out.reason)
        assertEquals(Backoff.MAX_CONTROL_ATTEMPTS, r.journal.get(key)!!.completingAttempts)
        assertTrue("delays grow: $delays", delays.zipWithNext().all { (a, b) -> b >= a } && delays.last() > delays.first())
        assertTrue(r.backend.calls.none { it.startsWith("PUT") })
    }

    @Test fun aShortReceiptOutageStopsNewPutsAndRecoversWithoutAUserResume() {
        val r = rig(250)
        val key = r.enqueue()
        val outageEnds = r.clock.now + 4_000
        r.backend.controlOutage = { path -> path.endsWith("/parts/receipts") && r.clock.now < outageEnds }
        val out = r.run(key)
        assertEquals(TaskState.UPLOADED, out.state)
        assertTrue("the outage was really hit", r.backend.outageHits.get() >= 1)
        // Concurrent workers may both hit the first outage, but never one failure per part.
        assertTrue("failures counted per window, not per part", r.backend.outageHits.get() <= Limits.MAX_CONCURRENT_PUTS)
        assertTrue("no part was sent twice", r.backend.putAttempts.values.all { it.get() == 1 })
        assertEquals(1, r.backend.completeCalls.get())
    }

    @Test fun aLongReceiptOutageBacksOffWithoutHammeringOrDemandingAUserResume() {
        val r = rig(250)
        val key = r.enqueue()
        r.backend.controlOutage = { path -> path.endsWith("/parts/receipts") }
        val out = r.run(key)
        assertEquals(TaskState.BACKOFF, out.state)
        assertEquals("control_unavailable", out.reason)
        val t = r.journal.get(key)!!
        assertTrue(t.retryAtMs > r.clock.now)
        assertTrue("landed parts are kept for the idempotent report", t.parts.any { it.state == PartState.LANDED })
        assertNull("no new PUT started while receipts could not be reported", r.backend.putAttempts[3])
        // Before the window elapses nothing at all reaches the network.
        val calls = r.backend.calls.size
        assertEquals(TaskState.BACKOFF, r.run(key, engine = r.restart()).state)
        assertEquals(calls, r.backend.calls.size)
        // After the outage, the next wake reports the same ETags and finishes with no re-PUT.
        r.backend.controlOutage = { false }
        r.clock.advance(t.retryAtMs - r.clock.now + 1)
        assertEquals(TaskState.UPLOADED, r.run(key, engine = r.restart()).state)
        assertTrue(r.backend.putAttempts.values.all { it.get() == 1 })
    }

    @Test fun theAttemptIsJournaledBeforeThePutSoProcessDeathConsumesTheBudget() {
        val r = rig(100)
        val key = r.enqueue()
        var seenAttempts = -1
        var seenState: PartState? = null
        r.backend.putScript = { part, _ ->
            val p = r.journal.get(key)!!.part(part)
            seenAttempts = p.attempts
            seenState = p.state
            0
        }
        assertEquals(TaskState.UPLOADED, r.run(key).state)
        assertEquals(1, seenAttempts)
        assertEquals(PartState.UPLOADING, seenState)
    }

    @Test fun aPoisonPartThatKillsTheProcessEveryTimeBacksOffThenStopsAndNeverLoopsFree() {
        val r = rig(100)
        val key = r.enqueue()
        // The process died on the last allowed attempt: the PUT is UPLOADING with its attempt already consumed.
        r.journal.update(key) { it.withPart(it.part(1).copy(state = PartState.UPLOADING, attempts = Backoff.MAX_PART_ATTEMPTS), r.clock.now) }
        val first = r.run(key, engine = r.restart())
        // The dead PUT is reconciled, then backs off instead of re-PUTting instantly.
        assertEquals(TaskState.BACKOFF, first.state)
        assertEquals("retry_scheduled", first.reason)
        assertNull(r.backend.putAttempts[1])
        r.clock.advance(Backoff.MAX_MS * 2)
        val second = r.run(key, engine = r.restart())
        assertEquals(TaskState.NEEDS_VISIBLE_RESUME, second.state)
        assertEquals("retries_exhausted", second.reason)
        assertNull("the poison part was never sent again", r.backend.putAttempts[1])
    }

    @Test fun aDeliberateCancelRefundsTheAttemptButAProcessDeathDoesNot() {
        val r = rig(100)
        val key = r.enqueue()
        val cancel = CancelToken()
        r.backend.putScript = { _, _ -> cancel.cancel("paused"); throw CancelledException() }
        r.run(key, cancel)
        val p = r.journal.get(key)!!.part(1)
        assertEquals("a pause is not a failure", 0, p.attempts)
        assertEquals("the unknown outcome is still reconciled", PartState.UPLOADING, p.state)
    }

    @Test fun aConflictAfterAnEpochChangeIsReportedAsEpochChangedEvenWhenAWorkerCancelledTheRun() {
        val r = rig()
        val key = r.enqueue()
        // Part 1 lands, then the server moves to epoch 2: its receipt (in the worker thread) gets a 409.
        r.backend.afterPut = { part -> if (part == 1) r.backend.serverEpoch = 2 }
        val out = r.run(key)
        assertEquals(TaskState.NEEDS_ORCHESTRATOR, out.state)
        assertEquals("epoch_changed", out.reason)
    }

    @Test fun noClassificationRequestIsMadeAfterAnExternalCancel() {
        val r = rig()
        val key = r.enqueue()
        val cancel = CancelToken()
        r.backend.afterPut = { part ->
            if (part == 1) { r.backend.serverEpoch = 2; cancel.cancel("system_stop") }
        }
        val out = r.run(key, cancel)
        assertEquals("system_stop", out.reason)
        assertEquals("no fresh GET of the plan after the external cancel", 1, r.backend.calls.count { it == "GET /api/v1/uploads/{f}" })
    }

    @Test fun anUnexpectedExceptionSettlesAStableVisiblePromptWithoutLeakingText() {
        val r = rig()
        val key = r.enqueue()
        r.source.onRead = { throw IllegalStateException("boom secret=abc123 https://s3.test/x?sig=zzz") }
        val out = r.run(key)
        assertEquals(TaskState.NEEDS_VISIBLE_RESUME, out.state)
        assertEquals("engine_error", out.reason)
        assertFalse(out.unsettled)
        val t = r.journal.get(key)!!
        assertEquals(TaskState.NEEDS_VISIBLE_RESUME, t.state)
        assertTrue(t.needsVisibleResume)
        assertFalse(r.journalFile.readText().contains("abc123"))
        // It is not retried by the engine on its own.
        val calls = r.backend.calls.size
        assertEquals(TaskState.NEEDS_VISIBLE_RESUME, r.run(key).state)
        assertEquals(calls, r.backend.calls.size)
    }

    @Test fun aJournalDiskFailureFailsClosedWithoutOverwritingAndRecoversFromTheRealDiskState() {
        val r = rig(100)
        val sync = ToggleSync()
        r.journal = UploadJournal(r.journalFile, sync, PART)
        val key = r.enqueue()
        sync.fail = true
        val out = r.run(key)
        assertEquals(TaskState.NEEDS_VISIBLE_RESUME, out.state)
        assertEquals("journal_unavailable", out.reason)
        assertTrue("nothing could be journaled, and the caller is told", out.unsettled)
        assertTrue("no provider effect ran on an unwritable journal", r.backend.calls.none { it.startsWith("PUT") })
        // Disk is writable again: the next read reflects the file on disk (not a stale cache) and the run completes.
        sync.fail = false
        val onDisk = UploadJournal(r.journalFile, partSizeBytes = PART).get(key)!!
        assertEquals(onDisk, r.journal.get(key))
        assertEquals(TaskState.NEEDS_VISIBLE_RESUME, onDisk.state)
        // A user Resume re-arms it and the transfer completes from the real state.
        r.journal.update(key) { it.copy(state = TaskState.QUEUED, reason = null, needsVisibleResume = false) }
        assertEquals(TaskState.UPLOADED, r.run(key).state)
    }
}

class ToggleSync : DirectorySync {
    @Volatile var fail = false
    override fun sync(dir: java.io.File) {
        if (fail) throw java.io.IOException("simulated directory fsync failure")
    }
}
