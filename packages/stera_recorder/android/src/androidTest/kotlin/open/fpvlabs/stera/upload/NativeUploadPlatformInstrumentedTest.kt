package open.fpvlabs.stera.upload

import android.os.Build
import android.system.Os
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.util.Random
import open.fpvlabs.stera.source_integrity.FdIdentity
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Real Android pieces the JVM tests cannot reach: Keystore AES-GCM session
 * vault, `android.system.Os` positional confined reads, directory fsync and the
 * durable journal on the device filesystem. These are emulator results; they are
 * not UIDT/WorkManager, process-death or physical-device evidence.
 */
private const val OWNER_ID = "owner_a_0123456789"
private const val ORIGIN_URL = "https://api.test"

@RunWith(AndroidJUnit4::class)
class NativeUploadPlatformInstrumentedTest {
    private lateinit var base: File
    private lateinit var root: File

    @Before fun setUp() {
        assumeTrue("needs API 33 for ns times", Build.VERSION.SDK_INT >= 33)
        val ctx = InstrumentationRegistry.getInstrumentation().targetContext
        base = File(ctx.cacheDir, "sa57-${System.nanoTime()}")
        root = File(base.canonicalFile, "s").apply { mkdirs() }
    }

    @After fun tearDown() { base.deleteRecursively() }

    private fun identityOf(f: File): FdIdentity {
        val st = Os.stat(f.path)
        return FdIdentity(
            st.st_dev, st.st_ino, st.st_size,
            st.st_mtim.tv_sec * 1_000_000_000L + st.st_mtim.tv_nsec,
            st.st_ctim.tv_sec * 1_000_000_000L + st.st_ctim.tv_nsec,
        )
    }

    @Test fun keystoreVaultRoundTripsAndKeepsCookiesOutOfPlaintext() {
        val dir = File(base, "vault")
        val store = KeystoreSessionStore(dir, AndroidDirectorySync())
        assertNull(store.read())
        val bundle = SessionBundle(
            "owner_a_0123456789", "https://api.test", 4,
            listOf(StoredCookie("__Secure-better-auth.session_token", "top-secret-cookie-value", "/", true, null)),
        )
        store.write(bundle)
        val back = store.read()!!
        assertEquals(4L, back.revision)
        assertEquals("top-secret-cookie-value", back.cookies.single().value)
        val raw = File(dir, "session.enc").readBytes()
        assertFalse(String(raw, Charsets.ISO_8859_1).contains("top-secret-cookie-value"))
        raw[raw.size - 1] = (raw[raw.size - 1].toInt() xor 1).toByte() // tamper: GCM must fail closed
        File(dir, "session.enc").writeBytes(raw)
        assertNull(store.read())
        store.clear()
        assertFalse(File(dir, "session.enc").exists())
    }

    @Test fun confinedPositionalReadsUseTheRealDescriptor() {
        val data = ByteArray(300_000).also { Random(7).nextBytes(it) }
        val f = File(root, "a.bin").apply { writeBytes(data) }
        val expected = identityOf(f)
        val src = ConfinedSourceOpener(AndroidPositionalFdOps()).open(root.path, "a.bin", expected)
        val buf = ByteArray(5000)
        assertEquals(5000, src.readAt(123_456, buf, 5000))
        assertArrayEquals(data.copyOfRange(123_456, 128_456), buf)
        src.verify(expected)
        f.appendBytes(byteArrayOf(1))
        val e = assertThrows(SourceException::class.java) { src.verify(expected) }
        assertEquals("changed", e.code)
        src.close()
    }

    @Test fun symlinksAndIdentityMismatchAreRefusedOnTheRealFilesystem() {
        val outside = File(base, "out").apply { mkdirs() }
        File(outside, "f.bin").writeBytes(ByteArray(100))
        Os.symlink(File(outside, "f.bin").path, File(root, "ln.bin").path)
        Os.symlink(outside.path, File(root, "dl").path)
        val opener = ConfinedSourceOpener(AndroidPositionalFdOps())
        val id = identityOf(File(outside, "f.bin"))
        assertEquals("path_escape", assertThrows(SourceException::class.java) { opener.open(root.path, "ln.bin", id) }.code)
        assertEquals("path_escape", assertThrows(SourceException::class.java) { opener.open(root.path, "dl/f.bin", id) }.code)
        val real = File(root, "r.bin").apply { writeBytes(ByteArray(100)) }
        assertEquals("changed", assertThrows(SourceException::class.java) { opener.open(root.path, "r.bin", identityOf(real).copy(size = 99)) }.code)
    }

    @Test fun journalAndGateAreDurableWithDirectoryFsync() {
        val dir = File(base, "j")
        val sync = AndroidDirectorySync()
        val journal = UploadJournal(File(dir, "journal.v1.json"), sync, 100L)
        val plan = UploadPlan(
            "11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "source_mcap", 250,
            "%064x".format(7), 1, 3, "uploading", System.currentTimeMillis() + 3_600_000, 100,
        )
        val rec = TaskRecord(
            TaskRecord.keyOf(OWNER_ID, ORIGIN_URL, plan), OWNER_ID, ORIGIN_URL, 1, plan,
            SourceBinding("/s", "a.mcap", plan.sha256, FdIdentity(1, 2, 250, 3, 4)), TaskState.QUEUED, null,
            (1..plan.partCount).map { PartRecord(it) }, createdAtMs = 1, hardExpiryMs = 2, updatedAtMs = 3,
        )
        journal.insertIfAbsent(rec)
        journal.update(rec.taskKey) { it.withPart(it.part(1).copy(state = PartState.LANDED, etag = "\"x\"", sizeBytes = 100), 9) }
        val reloaded = UploadJournal(File(dir, "journal.v1.json"), sync, 100L).get(rec.taskKey)
        assertNotNull(reloaded)
        assertEquals("\"x\"", reloaded!!.part(1).etag)
        val gate = GateStore(File(dir, "gate.v1.json"), sync)
        gate.bind(OWNER_ID, ORIGIN_URL, 3)
        gate.setCapturePaused(true)
        assertTrue(GateStore(File(dir, "gate.v1.json"), sync).read().policy.capturePaused)
        assertTrue(dir.listFiles()!!.none { it.name.endsWith(".tmp") })
    }
}
