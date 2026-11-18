package open.fpvlabs.stera.upload

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeArgsTest {
    private fun enqueueArgs(): MutableMap<String, Any?> = mutableMapOf(
        "schemaVersion" to 1, "ownerId" to OWNER, "ownerGeneration" to "3", "planJson" to "{}",
        "source" to mutableMapOf(
            "root" to "/data/session", "relativePath" to "recording.mcap", "sha256" to sha(1),
            "identity" to mutableMapOf("dev" to "64768", "inode" to "99", "size" to "250", "mtimeNs" to "1793573830123456789", "ctimeNs" to "1793573830123456790"),
        ),
    )

    private fun bad(block: () -> Unit) { assertThrows(BridgeArgs.Invalid::class.java, block) }

    @Test fun requiresSchemaVersionOneAndAMap() {
        bad { BridgeArgs.root(null) }
        bad { BridgeArgs.root(mapOf("schemaVersion" to 2)) }
        bad { BridgeArgs.root(mapOf("schemaVersion" to "1")) }
        BridgeArgs.root(mapOf("schemaVersion" to 1))
        BridgeArgs.root(mapOf("schemaVersion" to 1L))
    }

    @Test fun parsesInt64IdentityAsDecimalStrings() {
        val req = BridgeArgs.enqueue(BridgeArgs.root(enqueueArgs()))
        assertEquals(1793573830123456789L, req.source.identity.mtimeNs)
        assertEquals(3L, req.ownerGeneration)
        assertEquals(OWNER, req.ownerId)
    }

    @Test fun rejectsMalformedAndOversizedFields() {
        fun mutate(f: MutableMap<String, Any?>.() -> Unit) = bad { BridgeArgs.enqueue(BridgeArgs.root(enqueueArgs().apply(f))) }
        mutate { put("ownerId", "has space") }
        mutate { put("ownerGeneration", 3) }
        mutate { put("ownerGeneration", "03") }
        mutate { put("planJson", "x".repeat(BridgeArgs.MAX_PLAN_JSON + 1)) }
        mutate { (get("source") as MutableMap<String, Any?>)["sha256"] = "zz" }
        mutate { ((get("source") as MutableMap<String, Any?>)["identity"] as MutableMap<String, Any?>)["size"] = "99999999999999999999" }
        mutate { ((get("source") as MutableMap<String, Any?>)["identity"] as MutableMap<String, Any?>)["inode"] = -1 }
    }

    @Test fun validatesCookies() {
        val ok = mapOf("name" to "__Secure-better-auth.session_token", "value" to "abc%2Bdef", "path" to "/", "secure" to true)
        assertEquals(1, BridgeArgs.cookies(mapOf("cookies" to listOf(ok))).size)
        bad { BridgeArgs.cookies(mapOf("cookies" to listOf(ok + ("value" to "a;b")))) }
        bad { BridgeArgs.cookies(mapOf("cookies" to listOf(ok + ("name" to "bad name")))) }
        bad { BridgeArgs.cookies(mapOf("cookies" to listOf(ok + ("path" to "x")))) }
        bad { BridgeArgs.cookies(mapOf("cookies" to List(BridgeArgs.MAX_COOKIES + 1) { ok })) }
        bad { BridgeArgs.cookies(mapOf("cookies" to "no")) }
    }

    @Test fun snapshotNeverCarriesUrlsCookiesOrPaths() {
        val plan = testPlan(250)
        val t = TaskRecord(
            "k", OWNER, ORIGIN, 1, plan,
            SourceBinding("/data/private/root", "rec.mcap", plan.sha256, open.fpvlabs.stera.source_integrity.FdIdentity(1, 2, 250, 3, 4)),
            TaskState.BACKOFF, "retry_scheduled", (1..3).map { PartRecord(it, nextAttemptAtMs = if (it == 2) 55 else 0) },
            createdAtMs = 1, hardExpiryMs = 2, updatedAtMs = 3,
        )
        val s = BridgeArgs.snapshot(t)
        assertEquals("backoff", s["state"])
        assertEquals("55", s["nextAttemptAtMs"])
        val text = s.toString()
        assertTrue(!text.contains("/data/private") && !text.contains("http"))
        assertNull(BridgeArgs.snapshot(t.copy(parts = t.parts.map { it.copy(nextAttemptAtMs = 0) }))["nextAttemptAtMs"])
    }
}
