package open.fpvlabs.stera.upload

import open.fpvlabs.stera.source_integrity.FdIdentity
import open.fpvlabs.stera.source_integrity.StatInfo
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

/** Scripted [PositionalFdOps]: proves the confinement logic, not Android's `Os` (emulator test does). */
class ConfinedSourceTest {
    private class Ops(val content: ByteArray) : PositionalFdOps {
        val id = FdIdentity(1, 42, content.size.toLong(), 1_000_000_001, 2_000_000_002)
        var identity = id
        var pathOfFd = "/r/s/a.bin"
        var pathStat: StatInfo? = StatInfo(true, id)
        var regular = true
        val closed = mutableListOf<Int>()
        override fun open(path: String, directory: Boolean) = if (directory) 1 else 2
        override fun fstat(fd: Int) = StatInfo(regular, identity)
        override fun lstat(path: String) = pathStat
        override fun fdPath(fd: Int) = if (fd == 1) "/r/s" else pathOfFd
        override fun read(fd: Int, buf: ByteArray, len: Int): Int = pread(fd, buf, 0, len)
        override fun pread(fd: Int, buf: ByteArray, offset: Long, len: Int): Int {
            val n = minOf(len.toLong(), content.size - offset).toInt().coerceAtLeast(0)
            System.arraycopy(content, offset.toInt(), buf, 0, n)
            return n
        }
        override fun close(fd: Int) { closed += fd }
    }

    private fun code(f: () -> Unit) = assertThrows(SourceException::class.java, f).code

    @Test fun readsPositionallyAndClosesBothDescriptors() {
        val o = Ops(ByteArray(50) { it.toByte() })
        val src = ConfinedSourceOpener(o).open("/r/s", "a.bin", o.id)
        val buf = ByteArray(10)
        assertEquals(10, src.readAt(20, buf, 10))
        assertArrayEquals(ByteArray(10) { (20 + it).toByte() }, buf)
        assertEquals(listOf(1), o.closed)
        src.close()
        assertEquals(listOf(1, 2), o.closed)
    }

    @Test fun refusesEscapesChangesAndNonRegularFiles() {
        val opener = { o: Ops -> ConfinedSourceOpener(o) }
        for (rel in listOf("../x", "/abs", "a//b", "./a", "a\\b", "")) {
            assertEquals(rel, "path_escape", code { opener(Ops(ByteArray(1))).open("/r/s", rel, Ops(ByteArray(1)).id) })
        }
        assertEquals("path_escape", code { opener(Ops(ByteArray(1))).open("relative", "a", Ops(ByteArray(1)).id) })
        val rogue = Ops(ByteArray(50)).apply { pathOfFd = "/r/s/rogue/a.bin" }
        assertEquals("path_escape", code { opener(rogue).open("/r/s", "a.bin", rogue.id) })
        val swapped = Ops(ByteArray(50)).apply { pathStat = StatInfo(true, id.copy(inode = 7)) }
        assertEquals("path_escape", code { opener(swapped).open("/r/s", "a.bin", swapped.id) })
        val grown = Ops(ByteArray(50))
        assertEquals("changed", code { opener(grown).open("/r/s", "a.bin", grown.id.copy(size = 49)) })
        val dir = Ops(ByteArray(50)).apply { regular = false }
        assertEquals("not_regular", code { opener(dir).open("/r/s", "a.bin", dir.id) })
        assertEquals(listOf(2, 1), dir.closed)
    }

    @Test fun verifyCatchesMutationAfterOpen() {
        val o = Ops(ByteArray(50))
        val src = ConfinedSourceOpener(o).open("/r/s", "a.bin", o.id)
        src.verify(o.id)
        o.identity = o.id.copy(mtimeNs = 5)
        o.pathStat = StatInfo(true, o.identity) // an in-place edit changes the file seen by both fstat and lstat
        assertEquals("changed", code { src.verify(o.id) })
        o.identity = o.id
        o.pathStat = StatInfo(true, o.id)
        o.pathOfFd = "/elsewhere"
        assertEquals("path_escape", code { src.verify(o.id) })
    }
}
