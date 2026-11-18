package open.fpvlabs.stera.upload

import java.io.File
import open.fpvlabs.stera.source_integrity.FdIdentity
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class PlanAndJournalTest {
    @get:Rule val tmp = TemporaryFolder()

    private fun planJson(size: String = "134230073", count: Int = 3, extra: JSONObject.() -> Unit = {}): String =
        JSONObject()
            .put("fileId", FILE_ID).put("recordingId", REC_ID).put("role", "source_mcap")
            .put("sizeBytes", size).put("sha256", sha(3)).put("transportEpoch", 1)
            .put("partSizeBytes", "67108864").put("partCount", count).put("state", "uploading")
            .put("transportExpiresAt", "2030-01-01T00:00:00Z").apply(extra).toString()

    private fun refused(json: String): String =
        assertThrows(PlanException::class.java) { UploadPlan.parse(json) }.code

    @Test fun parsesTheFrozenPlanAndComputesPartRanges() {
        val p = UploadPlan.parse(planJson())
        assertEquals(3, p.partCount)
        assertEquals(0L, p.partOffset(1))
        assertEquals(67_108_864L, p.partOffset(2))
        assertEquals(67_108_864L, p.partLength(2))
        assertEquals(134_230_073L - 2 * 67_108_864L, p.partLength(3))
    }

    @Test fun refusesAnythingTheServerDidNotFreeze() {
        assertEquals("plan_invalid", refused(planJson(count = 2)))
        assertEquals("plan_invalid", refused(planJson { put("partSizeBytes", "33554432") }))
        assertEquals("plan_invalid", refused(planJson { put("extra", 1) }))
        assertEquals("plan_invalid", refused(planJson { put("sizeBytes", 134230073L) }))
        assertEquals("plan_invalid", refused(planJson { put("sizeBytes", "0") }))
        assertEquals("plan_invalid", refused(planJson { put("sizeBytes", "107374182401"); put("partCount", 1600) }))
        assertEquals("plan_invalid", refused(planJson { put("role", "anything") }))
        assertEquals("plan_invalid", refused(planJson { put("transportEpoch", 0) }))
        assertEquals("plan_invalid", refused(planJson { put("fileId", "not-a-uuid") }))
        assertEquals("plan_invalid", refused(planJson { put("sha256", "ABC") }))
        assertEquals("plan_invalid", refused("not json"))
        assertEquals("plan_invalid", refused(planJson { put("transportExpiresAt", "tomorrow") }))
    }

    @Test fun signedPartsMustMatchTheFrozenPlan() {
        val p = testPlan(250)
        fun body(offset: String = "100", length: String = "100", url: String = "https://s3.test/x?sig=1", hdr: JSONObject = JSONObject()) =
            JSONObject().put("transportEpoch", 1).put(
                "parts",
                org.json.JSONArray().put(
                    JSONObject().put("partNumber", 2).put("method", "PUT").put("url", url).put("headers", hdr)
                        .put("offsetBytes", offset).put("lengthBytes", length).put("expiresAt", "2030-01-01T00:00:00Z"),
                ),
            )
        assertEquals(1, SignedPart.parseAll(body(), p, listOf(2), false).size)
        fun code(b: JSONObject, allowHttp: Boolean = false) =
            assertThrows(PlanException::class.java) { SignedPart.parseAll(b, p, listOf(2), allowHttp) }.code
        assertEquals("signed_invalid", code(body(offset = "0")))
        assertEquals("signed_invalid", code(body(length = "99")))
        assertEquals("signed_invalid", code(body(url = "http://s3.test/x?sig=1")))
        assertEquals("signed_invalid", code(body(hdr = JSONObject().put("Cookie", "a=b"))))
        assertEquals("signed_invalid", code(body(hdr = JSONObject().put("content-length", "5"))))
        assertEquals(1, SignedPart.parseAll(body(url = "http://10.0.2.2:9/x?sig=1"), p, listOf(2), true).size)
        val unrequested = assertThrows(PlanException::class.java) { SignedPart.parseAll(body(), p, listOf(1), false) }
        assertEquals("signed_invalid", unrequested.code)
        assertFalse(SignedPart(2, "https://s3.test/secret", emptyMap(), 0, 1, 0).toString().contains("secret"))
    }

    @Test fun rfc3339RoundTripsWithoutJavaTime() {
        val ms = Rfc3339.parse("2026-11-02T08:28:45.123Z")!!
        assertEquals("2026-11-02T08:28:45.123Z", Rfc3339.format(ms))
        assertEquals(0L, Rfc3339.parse("1970-01-01T00:00:00Z"))
        assertNull(Rfc3339.parse("2026-13-01T00:00:00Z"))
    }

    private fun record(plan: UploadPlan, state: TaskState = TaskState.QUEUED) = TaskRecord(
        TaskRecord.keyOf(OWNER, ORIGIN, plan), OWNER, ORIGIN, 1, plan,
        SourceBinding("/s", "a.mcap", plan.sha256, FdIdentity(1, 2, plan.sizeBytes, 3, 4)), state,
        null, (1..plan.partCount).map { PartRecord(it) }, createdAtMs = 1, hardExpiryMs = 2, updatedAtMs = 3,
    )

    @Test fun journalIsDurableAcrossReloadAndKeepsIdentityImmutable() {
        val f = File(tmp.newFolder(), "journal.json")
        val plan = testPlan(250)
        val j = UploadJournal(f, partSizeBytes = PART)
        val rec = record(plan)
        j.insertIfAbsent(rec)
        j.update(rec.taskKey) { it.withPart(it.part(2).copy(state = PartState.LANDED, etag = "\"e\"", sizeBytes = 100), 9) }
        val reloaded = UploadJournal(f, partSizeBytes = PART).get(rec.taskKey)!!
        assertEquals("\"e\"", reloaded.part(2).etag)
        assertEquals(PartState.LANDED, reloaded.part(2).state)
        assertEquals(OWNER, reloaded.ownerId)
        assertThrows(IllegalStateException::class.java) {
            j.update(rec.taskKey) { it.copy(source = it.source.copy(sha256 = sha(99))) }
        }
        assertThrows(IllegalStateException::class.java) {
            j.update(rec.taskKey) { it.copy(plan = it.plan.copy(transportEpoch = 2)) }
        }
        assertFalse("no temp file left", File(f.path + ".tmp").exists())
    }

    @Test fun twoOwnersGetDifferentTaskKeys() {
        val plan = testPlan(250)
        assertTrue(TaskRecord.keyOf(OWNER, ORIGIN, plan) != TaskRecord.keyOf(OTHER, ORIGIN, plan))
        assertTrue(TaskRecord.keyOf(OWNER, ORIGIN, plan) != TaskRecord.keyOf(OWNER, ORIGIN, plan.copy(transportEpoch = 2)))
    }

    @Test fun aCorruptJournalFailsClosedAndIsNotOverwritten() {
        val f = File(tmp.newFolder(), "journal.json")
        f.writeText("{ broken")
        val j = UploadJournal(f, partSizeBytes = PART)
        assertThrows(JournalCorruptException::class.java) { j.all() }
        assertEquals("{ broken", f.readText())
    }

    @Test fun gateRebindKeepsGenerationButOwnerChangeAndUnbindBumpIt() {
        val g = GateStore(File(tmp.newFolder(), "gate.json"))
        val a = g.bind(OWNER, ORIGIN, 1)
        assertEquals(a.generation, g.bind(OWNER, ORIGIN, 2).generation)
        assertEquals(2L, g.read().sessionRevision)
        val b = g.bind(OTHER, ORIGIN, 1)
        assertTrue(b.generation > a.generation)
        val c = g.unbind()
        assertTrue(c.generation > b.generation)
        assertNull(c.ownerId)
        assertTrue(g.bind(OWNER, ORIGIN, 1).generation > c.generation)
    }

    @Test fun backoffIsBoundedAndPolicyReasonsAreStable() {
        assertEquals(5_000L, Backoff.delayMs(1, 0.0))
        assertEquals(10_000L, Backoff.delayMs(2, 0.0))
        assertEquals(300_000L, Backoff.delayMs(40, 0.0))
        assertTrue(Backoff.delayMs(40, 0.999) <= 375_000L)
        val ok = EnvSnapshot(true, true, true)
        assertNull(TransferPolicy().blockReason(ok))
        assertEquals("capture_paused", TransferPolicy(capturePaused = true).blockReason(ok))
        assertEquals("no_network", TransferPolicy().blockReason(ok.copy(networkAvailable = false)))
        assertEquals("unmetered_required", TransferPolicy().blockReason(ok.copy(unmetered = false)))
        assertEquals("charging_required", TransferPolicy().blockReason(ok.copy(charging = false)))
        assertNull(TransferPolicy(false, false).blockReason(ok.copy(unmetered = false, charging = false)))
    }
}
