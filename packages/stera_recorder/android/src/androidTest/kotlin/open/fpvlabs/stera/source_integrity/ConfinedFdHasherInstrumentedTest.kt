package open.fpvlabs.stera.source_integrity

import android.os.Build
import android.system.Os
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.security.MessageDigest
import java.util.Random
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** Real `android.system.Os` descriptor operations on the device/emulator filesystem. */
@RunWith(AndroidJUnit4::class)
class ConfinedFdHasherInstrumentedTest {
    private lateinit var base: File
    private lateinit var root: File
    private lateinit var hasher: ConfinedFdHasher

    @Before fun setUp() {
        assumeTrue("needs API 33 for ns times", Build.VERSION.SDK_INT >= 33)
        base = File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, "sa18-${System.nanoTime()}")
        root = File(base.canonicalFile, "s").apply { mkdirs() }
        hasher = ConfinedFdHasher(AndroidFdOps())
    }

    @After fun tearDown() { base.deleteRecursively() }

    private fun bytes(n: Int, seed: Long) = ByteArray(n).also { Random(seed).nextBytes(it) }
    private fun sha(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }
    private fun code(f: () -> Unit) = try { f(); "none" } catch (e: SourceHashException) { e.code + (e.details?.let { ":$it" } ?: "") }
    private fun hash(rel: String, chunk: Int = 4096, cancel: () -> Boolean = { false }) =
        hasher.hash(root.path, rel, chunk, 1L shl 30, cancel)

    @Test fun hashesTheOpenedDescriptorWithNanosecondIdentity() {
        val data = bytes(1_000_003, 1)
        File(root, "a.bin").writeBytes(data)
        val r = hash("a.bin", 65536)
        assertEquals(sha(data), r.sha256)
        assertEquals(65536, r.peakBufferBytes)
        assertEquals(data.size.toLong(), r.identity.size)
        val st = Os.stat(File(root, "a.bin").path)
        assertEquals(st.st_ino, r.identity.inode)
        assertTrue(r.identity.mtimeNs % 1_000_000_000L != 0L || st.st_mtim.tv_nsec == 0L)
    }

    @Test fun symlinkAndParentSymlinkEscapeAreRefused() {
        val outside = File(base, "out").apply { mkdirs() }
        File(outside, "f.bin").writeBytes(bytes(100, 2))
        Os.symlink(File(outside, "f.bin").path, File(root, "ln.bin").path)
        Os.symlink(outside.path, File(root, "dl").path)
        assertEquals("path_escape", code { hash("ln.bin") })
        assertEquals("path_escape", code { hash("dl/f.bin") })
        assertEquals("path_escape", code { hash("../x") })
    }

    private fun swapIn() {
        File(root, "d").renameTo(File(root, "d.orig")); File(root, "rogue").renameTo(File(root, "d"))
    }

    private fun swapOut() {
        File(root, "d").renameTo(File(root, "rogue")); File(root, "d.orig").renameTo(File(root, "d"))
    }

    private fun swapFixture(): ByteArray {
        val orig = bytes(300_000, 3)
        File(root, "d").apply { mkdirs() }
        File(root, "d/f.bin").writeBytes(orig)
        File(root, "rogue").apply { mkdirs() }
        File(root, "rogue/f.bin").writeBytes(bytes(300_000, 4))
        return orig
    }

    @Test fun parentSwappedAndLeftMidReadIsUnstableAndOriginalUntouched() {
        val orig = swapFixture()
        val before = Os.stat(File(root, "d/f.bin").path)
        var n = 0
        val c = code { hash("d/f.bin", 1024) { if (++n == 20) swapIn(); false } }
        assertEquals("unstable:identityChanged", c)
        val after = Os.stat(File(root, "d.orig/f.bin").path)
        assertEquals(before.st_ino, after.st_ino)
        assertEquals(before.st_mtim.tv_nsec, after.st_mtim.tv_nsec)
        assertEquals(sha(orig), sha(File(root, "d.orig/f.bin").readBytes()))
    }

    @Test fun parentSwappedAwayAndBackHashesOnlyTheOriginalDescriptor() {
        val orig = swapFixture()
        var n = 0
        val r = hasher.hash(root.path, "d/f.bin", 1024, 1L shl 30) {
            n++
            if (n == 20) swapIn()
            if (n == 60) swapOut()
            false
        }
        assertEquals(sha(orig), r.sha256)
    }

    @Test fun midReadMutationIsUnstable() {
        val f = File(root, "m.bin").apply { writeBytes(bytes(200_000, 5)) }
        var n = 0
        val c = code {
            hasher.hash(root.path, "m.bin", 1024, 1L shl 30) {
                if (++n == 20) f.appendBytes(byteArrayOf(1, 2, 3))
                false
            }
        }
        assertEquals("unstable:grewDuringHash", c)
    }

    @Test fun cancelStopsAndKeepsOriginal() {
        val data = bytes(500_000, 6)
        val f = File(root, "c.bin").apply { writeBytes(data) }
        var n = 0
        assertEquals("cancelled", code { hash("c.bin", 1024) { ++n > 5 } })
        assertEquals(sha(data), sha(f.readBytes()))
    }

    @Test fun belowApi33RefusesAndRegularOnly() {
        assertEquals("unsupported", code { AndroidFdOps(30) })
        File(root, "dir").mkdirs()
        assertEquals("not_regular", code { hash("dir") })
    }
}
