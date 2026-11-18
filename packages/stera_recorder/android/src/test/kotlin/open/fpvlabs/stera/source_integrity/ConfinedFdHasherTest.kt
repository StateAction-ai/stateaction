package open.fpvlabs.stera.source_integrity

import java.security.MessageDigest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * JVM logic tests over a scripted [FdOps]. These do NOT exercise Android's
 * `Os`; the real descriptor path is `ConfinedFdHasherInstrumentedTest`.
 */
class ConfinedFdHasherTest {
    private class FakeOps(var content: ByteArray) : FdOps {
        val id = FdIdentity(1, 42, content.size.toLong(), 1_000_000_001, 2_000_000_002)
        var identity = id
        var directory = id.copy(inode = 41)
        var pathOfFd = "/r/s/a.bin"
        var pathStat: StatInfo? = StatInfo(true, id)
        var pos = 0
        var reads = 0
        var onRead: (FakeOps) -> Unit = {}
        val closed = mutableListOf<Int>()
        override fun open(path: String, directory: Boolean) = if (directory) 1 else 2
        override fun fstat(fd: Int) = if (fd == 1) StatInfo(false, directory) else StatInfo(true, identity)
        override fun lstat(path: String) = if (path == "/r/s") StatInfo(false, directory) else pathStat
        override fun fdPath(fd: Int) = if (fd == 1) "/r/s" else pathOfFd
        override fun read(fd: Int, buf: ByteArray, len: Int): Int {
            reads++
            onRead(this)
            val n = minOf(len, content.size - pos).coerceAtLeast(0)
            System.arraycopy(content, pos, buf, 0, n)
            pos += n
            return n
        }
        override fun close(fd: Int) { closed += fd }
    }

    private fun run(o: FakeOps, chunk: Int = 4, max: Long = 1000) =
        ConfinedFdHasher(o).hash("/r/s", "a.bin", chunk, max) { false }

    private fun code(o: FakeOps, f: () -> Unit): String =
        try { f(); "none" } catch (e: SourceHashException) { e.code + (e.details?.let { ":$it" } ?: "") }

    @Test fun digestMatchesAndMemoryIsBounded() {
        val data = ByteArray(103) { it.toByte() }
        val o = FakeOps(data)
        val r = run(o)
        assertEquals(MessageDigest.getInstance("SHA-256").digest(data).joinToString("") { "%02x".format(it) }, r.sha256)
        assertEquals(4, r.peakBufferBytes)
        assertEquals(26, r.chunkCount)
        assertEquals(listOf(2, 1), o.closed)
    }

    @Test fun parentSwapBeforeOpenIsRefusedBeforeAnyRead() {
        val o = FakeOps(ByteArray(10) { 1 })
        o.pathOfFd = "/r/s/rogue/a.bin"
        assertEquals("path_escape", code(o) { run(o) })
        assertEquals(0, o.reads)
    }

    @Test fun capturedFileIdentityAndDirectoryAreRequiredBeforeFirstHashByte() {
        val o = FakeOps(ByteArray(10) { 1 })
        val closed = ConfinedFdHasher(o).snapshotClose("/r/s", listOf("a.bin"), "close") { false }
        assertEquals("close", closed.finalizationToken)
        assertEquals(0, o.reads)
        val h = ConfinedFdHasher(o, SourceReadIdentity(closed.files.getValue("a.bin"), closed.directory))
        o.identity = o.id.copy(inode = 43)
        o.pathStat = StatInfo(true, o.identity)
        assertEquals("unstable:identityChanged", code(o) { h.hash("/r/s", "a.bin", 4, 100) { false } })
        assertEquals(0, o.reads)
        o.identity = o.id
        o.pathStat = StatInfo(true, o.id)
        o.directory = o.directory.copy(inode = 44)
        assertEquals("unstable:identityChanged", code(o) { h.hash("/r/s", "a.bin", 4, 100) { false } })
        assertEquals(0, o.reads)
    }

    @Test fun metadataReadbackAndIdentityComeFromTheSameDescriptor() {
        val bytes = "final metadata".encodeToByteArray()
        val o = FakeOps(bytes)
        o.pathOfFd = "/r/s/metadata.json"
        val captured = ConfinedFdHasher(o).snapshotClose("/r/s", listOf("metadata.json"), "close") {
            it.contentEquals(bytes)
        }
        assertEquals(o.id, captured.files.getValue("metadata.json"))
        assertTrue(o.reads > 0)
        val changed = FakeOps(bytes)
        changed.pathOfFd = o.pathOfFd
        changed.onRead = { it.identity = it.id.copy(ctimeNs = 1) }
        assertEquals("unstable:identityChanged", code(changed) {
            ConfinedFdHasher(changed).snapshotClose("/r/s", listOf("metadata.json"), "close") {
                it.contentEquals(bytes)
            }
        })
    }

    @Test fun closeSnapshotRejectsStableSwapAfterWriterDescriptorWasClosed() {
        val o = FakeOps(ByteArray(10) { 1 })
        val finished = o.id
        o.identity = finished.copy(inode = 43)
        o.pathStat = StatInfo(true, o.identity)
        assertEquals("unstable:identityChanged", code(o) {
            ConfinedFdHasher(o).snapshotClose("/r/s", listOf("a.bin"), "close", mapOf("a.bin" to finished)) { false }
        })
        assertEquals(0, o.reads)
    }

    @Test fun pathBindingLostDuringReadIsUnstable() {
        val o = FakeOps(ByteArray(10) { 1 })
        o.onRead = { if (it.reads == 2) it.pathOfFd = "/r/s/a.bin.orig/a.bin" }
        assertEquals("unstable:identityChanged", code(o) { run(o) })
    }

    @Test fun midReadMutationAndGrowthAreUnstable() {
        val m = FakeOps(ByteArray(10) { 1 })
        m.onRead = { if (it.reads == 2) it.identity = it.id.copy(mtimeNs = 5) }
        assertEquals("unstable:identityChanged", code(m) { run(m) })
        val g = FakeOps(ByteArray(10) { 1 })
        g.onRead = { if (it.reads == 1) it.content = ByteArray(11) { 1 } }
        assertEquals("unstable:grewDuringHash", code(g) { run(g) })
        val s = FakeOps(ByteArray(10) { 1 })
        s.onRead = { if (it.reads == 1) it.content = ByteArray(4) { 1 } }
        assertEquals("unstable:shrankDuringHash", code(s) { run(s) })
    }

    @Test fun pathNamingAnotherInodeIsUnstable() {
        val o = FakeOps(ByteArray(10) { 1 })
        o.onRead = { if (it.reads == 2) it.pathStat = StatInfo(true, it.id.copy(inode = 99)) }
        assertEquals("unstable:identityChanged", code(o) { run(o) })
    }

    @Test fun cancellationAndPathSyntaxAreRefused() {
        val o = FakeOps(ByteArray(10) { 1 })
        val h = ConfinedFdHasher(o)
        assertEquals("cancelled", try { h.hash("/r/s", "a.bin", 4, 100) { true }; "" } catch (e: SourceHashException) { e.code })
        for (bad in listOf("../a", "/etc/x", "a//b", "./a", "")) {
            assertEquals(bad, "path_escape", try { h.hash("/r/s", bad, 4, 100) { false }; "" } catch (e: SourceHashException) { e.code })
        }
    }

    @Test fun androidBelow33RefusesInsteadOfWholeSecondTimes() {
        val e = try { AndroidFdOps(32); null } catch (e: SourceHashException) { e }
        assertTrue(e != null && e.code == "unsupported")
    }
}
