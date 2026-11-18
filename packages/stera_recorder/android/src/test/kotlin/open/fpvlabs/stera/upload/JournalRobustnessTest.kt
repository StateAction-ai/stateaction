package open.fpvlabs.stera.upload

import java.io.File
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class JournalRobustnessTest {
    @get:Rule val tmp = TemporaryFolder()

    private fun rigWithRecord(): Triple<Rig, String, ByteArray> {
        val r = Rig(tmp.newFolder(), 250)
        r.bindOwner()
        val key = r.enqueue()
        return Triple(r, key, r.journalFile.readBytes())
    }

    @Test fun anUnknownPartStateOrBadNumberFailsClosedAsCorruptNotARawCrash() {
        for ((from, to) in listOf("\"PENDING\"" to "\"BOGUS\"", "\"dev\":\"1\"" to "\"dev\":\"x1\"")) {
            val (r, key, bytes) = rigWithRecord()
            val text = String(bytes).replace(from, to)
            assertTrue("fixture contains $from", text != String(bytes))
            r.journalFile.writeText(text)
            val j = UploadJournal(r.journalFile, partSizeBytes = PART)
            assertThrows(JournalCorruptException::class.java) { j.get(key) }
            assertThrows(JournalCorruptException::class.java) { j.all() }
        }
    }

    @Test fun aCorruptJournalIsPreservedByteForByteAndNeverOverwritten() {
        val (r, key, _) = rigWithRecord()
        val garbage = "{\"schema\":1,\"tasks\":[{\"broken\":true}]}".toByteArray()
        r.journalFile.writeBytes(garbage)
        val j = UploadJournal(r.journalFile, partSizeBytes = PART)
        assertThrows(JournalCorruptException::class.java) { j.update(key) { it.copy(reason = "x") } }
        assertThrows(JournalCorruptException::class.java) { j.insertIfAbsent(TaskRecordFixtures.record(r)) }
        assertArrayEquals("the corrupt file is evidence and stays untouched", garbage, r.journalFile.readBytes())
        assertTrue(File(r.journalFile.parentFile, r.journalFile.name + ".tmp").exists().not())
    }

    @Test fun aDirectoryFsyncFailureAfterTheRenameNeverLeavesAStaleCache() {
        val (r, key, _) = rigWithRecord()
        val sync = ToggleSync()
        val j = UploadJournal(r.journalFile, sync, PART)
        j.get(key) // warm the cache
        sync.fail = true
        assertThrows(JournalWriteException::class.java) {
            j.update(key) { it.withPart(it.part(1).copy(state = PartState.LANDED, etag = "\"e\"", sizeBytes = PART), 5) }
        }
        sync.fail = false
        // The rename already happened: the disk holds the new record and the cache must show it, not the old one.
        assertEquals("\"e\"", j.get(key)!!.part(1).etag)
        assertEquals("\"e\"", UploadJournal(r.journalFile, partSizeBytes = PART).get(key)!!.part(1).etag)
        // The next update builds on the real state and keeps that ETag.
        j.update(key) { it.copy(reason = "after") }
        assertEquals("\"e\"", UploadJournal(r.journalFile, partSizeBytes = PART).get(key)!!.part(1).etag)
    }

    @Test fun oldJournalsWithoutTheNewFieldsStillLoad() {
        val (r, key, bytes) = rigWithRecord()
        val stripped = String(bytes).replace(Regex(",\"completingAttempts\":[0-9]+"), "").replace(Regex(",\"retryAtMs\":[0-9]+"), "")
        r.journalFile.writeText(stripped)
        val t = UploadJournal(r.journalFile, partSizeBytes = PART).get(key)!!
        assertEquals(0, t.completingAttempts)
        assertEquals(0L, t.retryAtMs)
    }
}

object TaskRecordFixtures {
    fun record(r: Rig): TaskRecord = TaskRecord(
        "other-key", OWNER, ORIGIN, 1, r.plan,
        SourceBinding("/session", "x.mcap", r.plan.sha256, r.source.baseIdentity),
        TaskState.QUEUED, null, (1..r.plan.partCount).map { PartRecord(it) },
        createdAtMs = 1, hardExpiryMs = 2, updatedAtMs = 3,
    )
}
