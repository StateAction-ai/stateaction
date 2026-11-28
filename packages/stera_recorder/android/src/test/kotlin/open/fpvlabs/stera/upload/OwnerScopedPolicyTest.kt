package open.fpvlabs.stera.upload

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/** SA-23: the relaxed transfer policy is persisted and honoured only for the exact bound, unfenced owner. */
class OwnerScopedPolicyTest {
    @get:Rule val tmp = TemporaryFolder()

    private fun gate(): Pair<GateStore, File> {
        val f = File(tmp.newFolder(), "gate.json")
        return GateStore(f) to f
    }

    @Test fun defaultsAreRestrictive() {
        val (g, _) = gate()
        g.bind(OWNER, ORIGIN, 1)
        val p = g.read().policy
        assertTrue(p.requireUnmetered); assertTrue(p.requireCharging)
    }

    @Test fun relaxedPolicyAppliesToTheBoundOwnerAndSurvivesRestart() {
        val (g, f) = gate()
        g.bind(OWNER, ORIGIN, 1)
        val out = g.setPolicy(OWNER, false, false)
        assertFalse(out.policy.requireUnmetered); assertFalse(out.policy.requireCharging)
        val reborn = GateStore(f).read()
        assertFalse(reborn.policy.requireUnmetered)
        assertEquals(OWNER, reborn.policyOwner)
    }

    @Test fun rebindOfTheSameOwnerKeepsItButAnotherOwnerNeverInherits() {
        val (g, _) = gate()
        g.bind(OWNER, ORIGIN, 1)
        g.setPolicy(OWNER, false, true)
        g.bind(OWNER, ORIGIN, 2) // cookie refresh
        assertFalse(g.read().policy.requireUnmetered)
        g.bind(OTHER, ORIGIN, 1)
        val p = g.read().policy
        assertTrue(p.requireUnmetered); assertTrue(p.requireCharging)
        g.bind(OWNER, ORIGIN, 1) // A-B-A: A's native copy was dropped when B bound; Dart re-applies A's choice
        assertTrue(g.read().policy.requireUnmetered)
    }

    @Test fun wrongOrStaleOwnerOrGenerationIsRejectedAndChangesNothing() {
        val (g, f) = gate()
        val gen = g.bind(OWNER, ORIGIN, 1).generation
        assertEquals("owner_changed", assertThrows(PolicyRejectedException::class.java) { g.setPolicy(OTHER, false, false) }.code)
        assertThrows(PolicyRejectedException::class.java) { g.setPolicy(OWNER, false, false, gen + 1) }
        assertTrue(g.read().policy.requireUnmetered)
        assertTrue(GateStore(f).read().policy.requireUnmetered)
        g.unbind()
        assertThrows(PolicyRejectedException::class.java) { g.setPolicy(OWNER, false, false, gen) }
    }

    @Test fun aFencedOwnerIsRestrictiveAtOnceAndRejectsLateWrites() {
        val (g, _) = gate()
        g.bind(OWNER, ORIGIN, 1)
        g.setPolicy(OWNER, false, false)
        val seq = g.fenceOwner()
        val p = g.read().policy
        assertTrue("fenced: restrictive before any durable cleanup", p.requireUnmetered && p.requireCharging)
        assertThrows(PolicyRejectedException::class.java) { g.setPolicy(OWNER, false, false) }
        g.unbind(); g.finishUnbind(seq)
        assertThrows(PolicyRejectedException::class.java) { g.setPolicy(OWNER, false, false) }
        g.bind(OTHER, ORIGIN, 5)
        assertTrue(g.read().policy.requireUnmetered)
    }

    @Test fun aWriteWithAPreFenceSnapshotIsRefused() {
        val (g, _) = gate()
        g.bind(OWNER, ORIGIN, 1)
        val snapshot = g.fenceSeq()
        g.fenceOwner(); g.finishUnbind(g.fenceSeq())
        g.bind(OWNER, ORIGIN, 9)
        assertThrows(PolicyRejectedException::class.java) { g.setPolicy(OWNER, false, false, null, snapshot) }
        assertTrue(g.read().policy.requireUnmetered)
    }

    @Test fun legacyOrUnownedPersistedRelaxedFlagsFailClosed() {
        val (g, f) = gate()
        g.bind(OWNER, ORIGIN, 1)
        // A file written by the old global setPolicy: relaxed flags, no policyOwner key.
        val legacy = GateStore.encode(g.read().copy(policy = TransferPolicy(false, false, false)))
            .replace(Regex(",\"policyOwner\":[^,}]*"), "")
        f.writeText(legacy)
        val reborn = GateStore(f).read()
        assertEquals(OWNER, reborn.ownerId)
        assertTrue(reborn.policy.requireUnmetered); assertTrue(reborn.policy.requireCharging)
        // The flags belong to a different owner than the bound one.
        f.writeText(GateStore.encode(reborn.copy(policy = TransferPolicy(false, false, false), policyOwner = OTHER)))
        assertTrue(GateStore(f).read().policy.requireUnmetered)
    }

    @Test fun restrictiveEffectivePolicyBlocksTheEngineAndCapturePauseStaysGlobal() {
        val (g, _) = gate()
        g.bind(OWNER, ORIGIN, 1)
        g.setPolicy(OWNER, false, false)
        g.setCapturePaused(true)
        val env = EnvSnapshot(networkAvailable = true, unmetered = false, charging = false)
        assertEquals("capture_paused", g.read().policy.blockReason(env))
        g.setCapturePaused(false)
        assertEquals(null, g.read().policy.blockReason(env))
        g.fenceOwner()
        assertEquals("unmetered_required", g.read().policy.blockReason(env))
    }

    private fun rig(): Rig = Rig(tmp.newFolder(), 250).also { it.bindOwner() }

    @Test fun theEngineRunsRelaxedOnlyForTheOwnerWhoRelaxedIt() {
        val r = rig()
        val key = r.enqueue()
        r.env.snap = EnvSnapshot(networkAvailable = true, unmetered = false, charging = false)
        // Default policy: metered + not charging waits.
        assertEquals(TaskState.WAITING_POLICY, r.run(key).state)
        r.gate.setPolicy(OWNER, requireUnmetered = false, requireCharging = false)
        assertEquals(TaskState.UPLOADED, r.run(key).state)
    }

    @Test fun anotherOwnerBindingDropsTheRelaxedPolicyBeforeAnyEffect() {
        val r = rig()
        val key = r.enqueue()
        r.gate.setPolicy(OWNER, requireUnmetered = false, requireCharging = false)
        r.env.snap = EnvSnapshot(networkAvailable = true, unmetered = false, charging = false)
        r.bindOwner(OTHER)
        val before = r.backend.calls.size
        // The first owner's queued work is blocked, and the new owner starts restrictive.
        assertEquals(TaskState.BLOCKED_OWNER, r.run(key).state)
        assertEquals(before, r.backend.calls.size)
        assertTrue(r.gate.read().policy.requireUnmetered)
        assertEquals("unmetered_required", r.gate.read().policy.blockReason(r.env.snap))
    }

    @Test fun aFenceStopsAnInFlightRelaxedUploadAndStatusReportsRestrictive() {
        val r = rig()
        val key = r.enqueue()
        r.gate.setPolicy(OWNER, requireUnmetered = false, requireCharging = false)
        r.env.snap = EnvSnapshot(networkAvailable = true, unmetered = false, charging = false)
        var fenced = false
        r.backend.afterPut = { if (!fenced) { fenced = true; r.gate.fenceOwner(); r.jar.fence() } }
        assertEquals(TaskState.BLOCKED_OWNER, r.run(key).state)
        val view = statusView(r.gate.read(), OWNER) { emptyList() }
        @Suppress("UNCHECKED_CAST")
        val policy = view["policy"] as Map<String, Any?>
        assertEquals(true, policy["requireUnmetered"])
        assertEquals(true, policy["requireCharging"])
        assertEquals(null, view["boundOwnerId"])
    }
}
