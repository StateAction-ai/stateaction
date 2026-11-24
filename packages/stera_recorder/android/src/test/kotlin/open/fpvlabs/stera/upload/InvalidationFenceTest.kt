package open.fpvlabs.stera.upload

import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * SA-57 logout/capture priority fence. These cover the lock-free in-memory fence, the stale-bind refusal and the
 * restart markers on the real GateStore/SessionJar/TransferEngine. The orchestration around them (one runtime
 * mutation lock, bind waiting for the pending durable invalidation, the dedicated priority executor) needs an
 * Android Context and is exercised by the emulator harness, not claimed here.
 */
class InvalidationFenceTest {
    @get:Rule val tmp = TemporaryFolder()
    private val pool = Executors.newCachedThreadPool()

    @After fun stop() { pool.shutdownNow() }

    private class BlockingSync : DirectorySync {
        @Volatile var block = false
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
        override fun sync(dir: File) {
            if (block) {
                entered.countDown()
                release.await(10, TimeUnit.SECONDS)
            }
        }
    }

    private fun rig(size: Long = 250) = Rig(tmp.newFolder(), size)

    @Test fun theFenceChangesTheGateBeforeAnFsyncHeldBindReturns() {
        val f = File(tmp.newFolder(), "gate.json")
        val sync = BlockingSync()
        val gate = GateStore(f, sync)
        gate.bind(OWNER, ORIGIN, 1)
        sync.block = true
        val seq = gate.fenceSeq()
        val held = pool.submit<GateState> { gate.bind(OTHER, ORIGIN, 1, seq) } // the normal queue: stuck in fsync, holds the gate lock
        assertTrue(sync.entered.await(5, TimeUnit.SECONDS))
        // Priority path: lock-free, so it neither waits for the lock nor for the disk.
        val before = gate.read().generation
        val fenced = pool.submit<GateState> { gate.fenceOwner(9); gate.read() }.get(2, TimeUnit.SECONDS)
        assertNull("no owner is visible the instant the fence is set", fenced.ownerId)
        assertTrue(fenced.generation > before)
        assertEquals(9, fenced.invalidationFloor)
        sync.release.countDown()
        held.get(5, TimeUnit.SECONDS)
        // The held bind committed afterwards but can never re-open the gate: only that invalidation's own cleanup does.
        assertNull(gate.read().ownerId)
        gate.unbind(9)
        gate.finishUnbind(1)
        assertNull(gate.read().ownerId)
    }

    @Test fun anOlderQueuedBindCannotInstallAfterTheFence() {
        val f = File(tmp.newFolder(), "gate.json")
        val gate = GateStore(f)
        gate.bind(OWNER, ORIGIN, 1)
        val bytes = f.readBytes()
        val queuedSeq = gate.fenceSeq()
        val seq = gate.fenceOwner()
        assertThrows(SupersededException::class.java) { gate.bind(OTHER, ORIGIN, 2, queuedSeq) }
        assertTrue("a refused bind writes nothing", bytes.contentEquals(f.readBytes()))
        gate.unbind()
        gate.finishUnbind(seq)
        // A bind received after the invalidation (fresh sequence) is a legitimate new login.
        assertEquals(OTHER, gate.bind(OTHER, ORIGIN, 3, gate.fenceSeq()).ownerId)
        assertEquals(OTHER, gate.read().ownerId)
    }

    @Test fun anOlderCleanupNeverClearsANewerInvalidation() {
        val gate = GateStore(File(tmp.newFolder(), "gate.json"))
        gate.bind(OWNER, ORIGIN, 1)
        val a = gate.fenceOwner()
        val b = gate.fenceOwner()
        gate.unbind()
        gate.finishUnbind(a)
        assertTrue(gate.ownerFenced())
        gate.bind(OTHER, ORIGIN, 2, gate.fenceSeq())
        assertNull("the newer invalidation still masks the owner", gate.read().ownerId)
        gate.unbind()
        gate.finishUnbind(b)
        assertFalse(gate.ownerFenced())
    }

    @Test fun noControlRequestOrPutStartsAfterTheFence() {
        val r = rig()
        r.bindOwner()
        val key = r.enqueue()
        val snapshot = java.util.concurrent.atomic.AtomicInteger(-1)
        val copies = java.util.concurrent.atomic.AtomicInteger()
        val secondAtCopy = CountDownLatch(1)
        val fenced = CountDownLatch(1)
        val chunks = ChunkStore(File(r.dir, "fence-test-chunks"), {
            if (copies.incrementAndGet() > 1) {
                secondAtCopy.countDown()
                check(fenced.await(5, TimeUnit.SECONDS)) { "First PUT did not establish the fence" }
            }
            1L shl 40
        }, reserveBytes = 0)
        r.backend.afterPut = {
            check(secondAtCopy.await(5, TimeUnit.SECONDS)) { "Second worker did not reach the chunk copy" }
            r.gate.fenceOwner()
            r.jar.fence()
            snapshot.set(r.backend.calls.size)
            fenced.countDown()
        }
        val out = r.run(key, engine = TransferEngine(r.deps(chunkStore = chunks), TransferStats()))
        // The observed outcome is part of the message so a failure keeps its values.
        assertEquals("outcome=${out.state}/${out.reason} calls=${r.backend.calls}", TaskState.BLOCKED_OWNER, out.state)
        assertTrue(snapshot.get() >= 0)
        assertEquals("nothing is requested after the fence", emptyList<String>(), r.backend.calls.drop(snapshot.get()))
    }

    /**
     * Deterministic boundary: the owner is fenced after every worker's guard at the top of its loop but before any
     * PUT starts (inside the chunk copy, whose free-space probe is the hook). No PUT may reach the provider.
     */
    @Test fun aFenceArrivingDuringTheChunkCopyStartsNoPut() {
        val r = rig()
        r.bindOwner()
        val key = r.enqueue()
        val fenceOnce = Any()
        var fenced = false
        // Created up front so the two workers never race on mkdirs: the only thing under test is the fence.
        File(r.dir, "chunks2").mkdirs()
        val chunks = ChunkStore(File(r.dir, "chunks2"), {
            synchronized(fenceOnce) {
                if (!fenced) { fenced = true; r.gate.fenceOwner(); r.jar.fence() }
            }
            1L shl 40
        }, reserveBytes = 0)
        val engine = TransferEngine(r.deps(chunkStore = chunks), TransferStats())
        val out = r.run(key, engine = engine)
        assertTrue("the hook ran", fenced)
        assertEquals("no PUT may start after the fence: outcome=${out.state}/${out.reason} calls=${r.backend.calls}", emptyList<String>(), r.backend.calls.filter { it.startsWith("PUT") })
        assertEquals("outcome=${out.state}/${out.reason}", TaskState.BLOCKED_OWNER, out.state)
        assertTrue("the interrupted parts are retried, not lost", r.journal.get(key)!!.parts.none { it.state == PartState.LANDED || it.state == PartState.REPORTED })
    }

    @Test fun aLateCookieResponseAfterTheFenceIsDropped() {
        val r = rig()
        r.bindOwner()
        val key = r.enqueue()
        r.backend.duringControl = { path ->
            if (path.contains("sign")) {
                r.backend.responseSetCookies = listOf("__Secure-better-auth.session_token=rotated; Path=/; Secure")
                r.gate.fenceOwner()
                r.jar.fence()
            }
        }
        r.run(key)
        assertEquals("the late Set-Cookie never reached the vault", "tok", r.session.bundle!!.cookies.single().value)
    }

    @Test fun aFencedJarHandsOutNoCookieAndIngestsNoResponse() {
        val r = rig()
        r.bindOwner()
        val lease = r.jar.lease(OWNER, ORIGIN)!!
        r.jar.fence()
        assertNull(r.jar.cookieHeader(lease, "/api/v1/me"))
        assertNull(r.jar.lease(OWNER, ORIGIN))
        assertFalse(r.jar.ingest(lease, listOf("__Secure-better-auth.session_token=late; Path=/; Secure")))
        assertEquals("tok", r.session.bundle!!.cookies.single().value)
        r.jar.clear()
        assertNull(r.session.bundle)
    }

    @Test fun aFailedGateWriteKeepsEffectsBlockedAndARestartDoesNotAdoptTheOldOwner() {
        val f = File(tmp.newFolder(), "gate.json")
        val sync = ToggleSync()
        val gate = GateStore(f, sync)
        gate.bind(OWNER, ORIGIN, 1)
        val seq = gate.fenceOwner(3)
        sync.fail = true
        assertThrows(JournalWriteException::class.java) { gate.unbind(3) }
        assertNull("still fenced in this process", gate.read().ownerId)
        assertTrue(gate.ownerFenced())
        // Process dies here. The rename may or may not have landed; either way the marker survives and wins.
        val reborn = GateStore(f)
        assertTrue(reborn.pendingMarkerOnLoad())
        assertNull("a restart never auto-adopts the old owner", reborn.read().ownerId)
        assertTrue(seq > 0)
    }

    @Test fun anInterruptionBetweenTheGateCommitAndTheRemainingCleanupLeavesTheMarker() {
        val f = File(tmp.newFolder(), "gate.json")
        val gate = GateStore(f)
        gate.bind(OWNER, ORIGIN, 1)
        val seq = gate.fenceOwner(5)
        gate.unbind(5) // gate durable; vault clear / blocking / scheduler cancel never ran
        val reborn = GateStore(f)
        assertTrue("restart sees unfinished cleanup", reborn.pendingMarkerOnLoad())
        assertNull(reborn.read().ownerId)
        assertEquals(5, reborn.read().invalidationFloor)
        reborn.finishUnbind(0) // recovery completed the cleanup
        assertFalse(GateStore(f).pendingMarkerOnLoad())
        assertTrue(seq > 0)
    }

    @Test fun aFailedCapturePauseWriteStaysPausedAndSurvivesRestart() {
        val f = File(tmp.newFolder(), "gate.json")
        val sync = ToggleSync()
        val gate = GateStore(f, sync)
        gate.read()
        val seq = gate.fenceCapture()
        assertTrue(gate.read().policy.capturePaused)
        sync.fail = true
        assertThrows(JournalWriteException::class.java) { gate.setCapturePaused(true, seq) }
        assertTrue(gate.read().policy.capturePaused)
        assertTrue("restart keeps capture paused", GateStore(f).read().policy.capturePaused)
    }

    @Test fun aCaptureReleaseCannotClearANewerPause() {
        val f = File(tmp.newFolder(), "gate.json")
        val gate = GateStore(f)
        val first = gate.fenceCapture()
        gate.setCapturePaused(true, first)
        val releaseReceipt = gate.captureSeq()
        val second = gate.fenceCapture() // a new capture starts while the release is still queued
        gate.setCapturePaused(false, releaseReceipt)
        assertTrue(gate.read().policy.capturePaused)
        assertTrue("marker kept for the newer pause", GateStore(f).read().policy.capturePaused)
        gate.setCapturePaused(true, second)
        gate.setCapturePaused(false, gate.captureSeq())
        assertFalse(gate.read().policy.capturePaused)
        assertFalse(GateStore(f).read().policy.capturePaused)
    }

    @Test fun aRevisionAtOrBelowTheInvalidationFloorIsRecordedAndSurvivesUnbindAndRestart() {
        val f = File(tmp.newFolder(), "gate.json")
        val gate = GateStore(f)
        gate.bind(OWNER, ORIGIN, 4)
        val seq = gate.fenceOwner(8)
        gate.unbind(8)
        gate.finishUnbind(seq)
        assertEquals(8, gate.read().invalidationFloor)
        assertEquals(8, GateStore(f).read().invalidationFloor)
        assertEquals("a later unbind never lowers it", 8, gate.unbind(2).invalidationFloor)
    }

    // ---- receipt / snapshot interleaving (deterministic) -------------------------------------

    @Test fun anInvalidationBetweenTheSnapshotAndTheReceiptCheckRefusesTheOldCall() {
        val receipts = java.util.concurrent.atomic.AtomicLong(0)
        val gateSeq = java.util.concurrent.atomic.AtomicLong(0)
        val atCall = receipts.get()
        // The unbind arrives exactly between the two reads: receipts are bumped first, the gate fenced right after.
        val fence = CallFence(receipts) { gateSeq.get().also { receipts.incrementAndGet(); gateSeq.incrementAndGet() } }
        assertThrows(SupersededException::class.java) { fence.admit(atCall) }
    }

    @Test fun anInvalidationAfterTheCheckLeavesAnOlderSnapshotThatTheGateRefuses() {
        val gate = GateStore(File(tmp.newFolder(), "gate.json"))
        gate.bind(OWNER, ORIGIN, 1)
        val receipts = java.util.concurrent.atomic.AtomicLong(0)
        val fence = CallFence(receipts) { gate.fenceSeq() }
        val snapshot = fence.admit(fence.next())
        receipts.incrementAndGet()
        gate.fenceOwner() // arrives after the receipt check
        assertThrows(SupersededException::class.java) { gate.bind(OTHER, ORIGIN, 2, snapshot) }
    }

    @Test fun aCallThatArrivedBeforeAnEarlierInvalidationNeverPicksUpTheNewSequence() {
        val receipts = java.util.concurrent.atomic.AtomicLong(0)
        val gateSeq = java.util.concurrent.atomic.AtomicLong(0)
        val fence = CallFence(receipts) { gateSeq.get() }
        val atCall = fence.next()
        receipts.incrementAndGet()
        gateSeq.incrementAndGet() // fully applied before the queued call finally runs
        assertThrows(SupersededException::class.java) { fence.admit(atCall) }
    }

    // ---- marker validation and uncertain cleanup ------------------------------------------------

    private fun markerOf(gateFile: File) = File(gateFile.parentFile, gateFile.name + ".fence")

    @Test fun anInvalidMarkerBlocksBothOwnerAndCapture() {
        for (bad in listOf("", "x", "uu", "ucx", "ccc", "UC")) {
            val f = File(tmp.newFolder(), "gate.json")
            val gate = GateStore(f)
            gate.bind(OWNER, ORIGIN, 1)
            markerOf(f).writeText(bad)
            val reborn = GateStore(f).read()
            assertNull("[$bad] owner blocked", reborn.ownerId)
            assertTrue("[$bad] capture blocked", reborn.policy.capturePaused)
        }
        val f = File(tmp.newFolder(), "gate.json")
        GateStore(f).bind(OWNER, ORIGIN, 1)
        markerOf(f).writeText("u")
        val onlyOwner = GateStore(f).read()
        assertNull(onlyOwner.ownerId)
        assertFalse("a valid u marker does not pause capture", onlyOwner.policy.capturePaused)
        markerOf(f).writeBytes(ByteArray(100_000) { 'u'.code.toByte() }) // oversized: bounded read, still fail closed
        assertTrue(GateStore(f).read().policy.capturePaused)
    }

    @Test fun aMarkerThatCannotBeWrittenBeforeTheRenameIsReportedNotAssumedDurable() {
        val f = File(tmp.newFolder(), "gate.json")
        val gate = GateStore(f)
        gate.bind(OWNER, ORIGIN, 1)
        File(f.parentFile, "gate.json.fence.tmp").mkdir() // the marker's temp file cannot be created
        val seq = gate.fenceOwner()
        gate.unbind()
        assertFalse("no durable-marker claim", gate.lastUnbindMarkerDurable)
        assertFalse(markerOf(f).exists())
        // The gate commit itself landed, so a restart is protected by the gate, not by a marker.
        assertNull(GateStore(f).read().ownerId)
        gate.finishUnbind(seq)
    }

    @Test fun withNeitherMarkerNorGateWritableThereIsNoRestartProtectionAndTheCallFails() {
        val f = File(tmp.newFolder(), "gate.json")
        val gate = GateStore(f)
        gate.bind(OWNER, ORIGIN, 1)
        File(f.parentFile, "gate.json.fence.tmp").mkdir()
        File(f.parentFile, "gate.json.tmp").mkdir()
        gate.fenceOwner()
        assertThrows(JournalWriteException::class.java) { gate.unbind() }
        assertFalse(gate.lastUnbindMarkerDurable)
        assertNull("this process stays fenced", gate.read().ownerId)
        // The honest limit: nothing durable exists, so a restart reads the old owner back.
        assertEquals(OWNER, GateStore(f).read().ownerId)
    }

    @Test fun aMarkerThatCannotBeRemovedStaysAndKeepsBindsBlocked() {
        val f = File(tmp.newFolder(), "gate.json")
        val sync = ToggleSync()
        val gate = GateStore(f, sync)
        gate.bind(OWNER, ORIGIN, 1)
        val seq = gate.fenceOwner()
        gate.unbind()
        sync.fail = true // the directory fsync after deleting the marker fails: removal is uncertain
        gate.finishUnbind(seq)
        sync.fail = false
        assertTrue("uncertain removal is not reported as done", gate.ownerFenced())
        assertTrue(GateStore(f).pendingMarkerOnLoad() || !markerOf(f).exists())
        val retry = gate.fenceOwner()
        gate.unbind()
        gate.finishUnbind(retry)
        assertFalse(gate.ownerFenced())
        assertFalse(markerOf(f).exists())
    }

    /** Two workers first-touching a missing scratch directory at once must both get a chunk (mkdirs race). */
    @Test fun concurrentFirstUseOfTheScratchDirectoryNeverFailsAWorker() {
        repeat(20) { round ->
            val r = rig()
            val dir = File(r.dir, "fresh-$round")
            val store = ChunkStore(dir, { 1L shl 40 }, reserveBytes = 0)
            val source = r.source.opener.open("/session", "recording.mcap", r.source.baseIdentity)
            val barrier = java.util.concurrent.CyclicBarrier(2)
            val cancel = CancelToken()
            val jobs = (1..2).map { part ->
                pool.submit<Throwable?> {
                    barrier.await(5, TimeUnit.SECONDS)
                    try {
                        store.extract(source, r.source.baseIdentity, r.plan, part, cancel).close()
                        null
                    } catch (t: Throwable) {
                        t
                    }
                }
            }
            for (j in jobs) assertNull("round $round: ${j.get(10, TimeUnit.SECONDS)}", j.get(10, TimeUnit.SECONDS))
        }
    }
}
