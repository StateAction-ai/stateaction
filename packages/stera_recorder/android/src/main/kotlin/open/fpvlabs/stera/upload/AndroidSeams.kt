package open.fpvlabs.stera.upload

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.BatteryManager
import android.os.Build
import android.os.ParcelFileDescriptor
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.system.StructStat
import java.io.File
import java.io.FileInputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyStore
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import open.fpvlabs.stera.source_integrity.FdIdentity
import open.fpvlabs.stera.source_integrity.SourceHashException
import open.fpvlabs.stera.source_integrity.StatInfo
import org.json.JSONArray
import org.json.JSONObject

/** fsync the journal directory after the rename so the new name is itself durable. */
class AndroidDirectorySync : DirectorySync {
    override fun sync(dir: File) {
        val fd = try {
            Os.open(dir.path, OsConstants.O_RDONLY, 0)
        } catch (e: ErrnoException) {
            throw IOException("journal directory not openable (errno ${e.errno})")
        }
        try {
            Os.fsync(fd)
        } catch (e: ErrnoException) {
            throw IOException("journal directory fsync failed (errno ${e.errno})")
        } finally {
            try { Os.close(fd) } catch (ignored: ErrnoException) {}
        }
    }
}

/**
 * Real positional descriptor operations. Needs API 33 for nanosecond times, the
 * same floor as the SA-18 hasher: a lower system cannot prove same-second
 * mutation absent, so construction refuses.
 */
class AndroidPositionalFdOps(sdkInt: Int = Build.VERSION.SDK_INT) : PositionalFdOps {
    init {
        if (sdkInt < Build.VERSION_CODES.TIRAMISU) {
            throw SourceHashException("unsupported", "Android 13 (API 33) is required for nanosecond file times; this device is API $sdkInt")
        }
    }

    private class Handle(val pfd: ParcelFileDescriptor)

    private val handles = ConcurrentHashMap<Int, Handle>()

    override fun open(path: String, directory: Boolean): Int? {
        val flags = OsConstants.O_RDONLY or OsConstants.O_NOFOLLOW or OsConstants.O_CLOEXEC or OsConstants.O_NONBLOCK
        val raw = try {
            Os.open(path, flags, 0)
        } catch (e: ErrnoException) {
            when (e.errno) {
                OsConstants.ENOENT, OsConstants.ENOTDIR -> return null
                OsConstants.ELOOP -> throw SourceHashException("path_escape", "symlink on path")
                else -> throw SourceHashException("unstable", "open errno ${e.errno}", "readFailed")
            }
        }
        val dup = try {
            ParcelFileDescriptor.dup(raw)
        } catch (e: IOException) {
            Os.close(raw)
            throw SourceHashException("unstable", "dup failed", "readFailed")
        }
        Os.close(raw)
        handles[dup.fd] = Handle(dup)
        return dup.fd
    }

    private fun h(fd: Int) = handles[fd] ?: throw IllegalStateException("closed fd $fd")

    private fun info(st: StructStat) = StatInfo(
        (st.st_mode and OsConstants.S_IFMT) == OsConstants.S_IFREG,
        FdIdentity(
            st.st_dev, st.st_ino, st.st_size,
            st.st_mtim.tv_sec * 1_000_000_000L + st.st_mtim.tv_nsec,
            st.st_ctim.tv_sec * 1_000_000_000L + st.st_ctim.tv_nsec,
        ),
    )

    override fun fstat(fd: Int): StatInfo = try {
        info(Os.fstat(h(fd).pfd.fileDescriptor))
    } catch (e: ErrnoException) {
        throw SourceHashException("unstable", "fstat errno ${e.errno}", "readFailed")
    }

    override fun lstat(path: String): StatInfo? = try {
        info(Os.lstat(path))
    } catch (e: ErrnoException) {
        if (e.errno == OsConstants.ENOENT || e.errno == OsConstants.ENOTDIR) null
        else throw SourceHashException("unstable", "lstat errno ${e.errno}", "readFailed")
    }

    override fun fdPath(fd: Int): String = try {
        Os.readlink("/proc/self/fd/$fd")
    } catch (e: ErrnoException) {
        throw SourceHashException("unsupported", "/proc/self/fd unreadable (errno ${e.errno})")
    }

    override fun read(fd: Int, buf: ByteArray, len: Int): Int = pread(fd, buf, 0, len)

    override fun pread(fd: Int, buf: ByteArray, offset: Long, len: Int): Int = try {
        Os.pread(h(fd).pfd.fileDescriptor, buf, 0, len, offset)
    } catch (e: ErrnoException) {
        throw SourceHashException("unstable", "pread errno ${e.errno}", "readFailed")
    }

    override fun close(fd: Int) {
        handles.remove(fd)?.pfd?.close()
    }
}

/** Reports what the job's own network can do (the engine re-checks it before every effect). */
class AndroidEnvProbe(private val context: Context, private val network: () -> Network?) : EnvProbe {
    override fun snapshot(): EnvSnapshot {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val net = network() ?: cm.activeNetwork
        val caps = if (net == null) null else cm.getNetworkCapabilities(net)
        val up = caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
        val unmetered = caps != null && caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
        val battery = context.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val plugged = battery?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0
        return EnvSnapshot(networkAvailable = up, unmetered = unmetered, charging = plugged != 0)
    }
}

/**
 * HTTP over the OS job's selected [Network] (or the default one). Redirects are
 * never followed, so cookies cannot be replayed to another origin, and signed
 * provider PUTs carry only their signed headers.
 */
class AndroidHttpTransport(private val network: Network?) : HttpTransport {

    private fun open(url: String): HttpURLConnection {
        val u = URL(url)
        return (if (network != null) network.openConnection(u) else u.openConnection()) as HttpURLConnection
    }

    override fun control(method: String, url: String, headers: Map<String, String>, body: ByteArray?, cancel: CancelToken): HttpResponse {
        val conn = open(url)
        val unhook = cancel.onCancel { conn.disconnect() }
        try {
            conn.instanceFollowRedirects = false
            conn.connectTimeout = 15_000
            conn.readTimeout = 30_000
            conn.requestMethod = method
            for ((k, v) in headers) conn.setRequestProperty(k, v)
            if (body != null) {
                conn.doOutput = true
                conn.setFixedLengthStreamingMode(body.size)
                conn.outputStream.use { it.write(body) }
            }
            val status = conn.responseCode
            val cookies = ArrayList<String>()
            for ((k, v) in conn.headerFields) if (k != null && k.equals("Set-Cookie", ignoreCase = true)) cookies.addAll(v)
            val stream = if (status >= 400) conn.errorStream else conn.inputStream
            val bytes = if (stream == null) ByteArray(0) else stream.use { readBounded(it, Limits.MAX_CONTROL_RESPONSE_BYTES + 1) }
            return HttpResponse(status, bytes, cookies)
        } catch (e: IOException) {
            if (cancel.cancelled) throw CancelledException()
            throw e
        } finally {
            unhook()
            conn.disconnect()
        }
    }

    override fun putFile(url: String, headers: Map<String, String>, file: File, length: Long, cancel: CancelToken): PutResponse {
        val conn = open(url)
        val unhook = cancel.onCancel { conn.disconnect() }
        try {
            conn.instanceFollowRedirects = false
            conn.connectTimeout = 20_000
            conn.readTimeout = 60_000
            conn.requestMethod = "PUT"
            conn.doOutput = true
            conn.setFixedLengthStreamingMode(length)
            for ((k, v) in headers) {
                // Host and Content-Length are set by the connection itself from the exact URL and length.
                val lower = k.lowercase()
                if (lower == "host" || lower == "content-length") continue
                conn.setRequestProperty(k, v)
            }
            val buf = ByteArray(Limits.STREAM_BUFFER_BYTES)
            var sent = 0L
            conn.outputStream.use { out ->
                FileInputStream(file).use { input ->
                    while (sent < length) {
                        cancel.check()
                        val n = input.read(buf, 0, minOf(buf.size.toLong(), length - sent).toInt())
                        if (n < 0) throw IOException("chunk shorter than its planned length")
                        out.write(buf, 0, n)
                        sent += n
                    }
                }
            }
            val status = conn.responseCode
            val etag = conn.getHeaderField("ETag")
            conn.errorStream?.use { readBounded(it, 4096) }
            return PutResponse(status, etag)
        } catch (e: IOException) {
            if (cancel.cancelled) throw CancelledException()
            throw e
        } finally {
            unhook()
            conn.disconnect()
        }
    }

    private fun readBounded(input: java.io.InputStream, max: Int): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        val buf = ByteArray(8192)
        while (out.size() < max) {
            val n = input.read(buf, 0, minOf(buf.size, max - out.size()))
            if (n < 0) break
            out.write(buf, 0, n)
        }
        return out.toByteArray()
    }
}

/** AES-GCM session cookies bound to an Android Keystore key; never written in plaintext or logged. */
class KeystoreSessionStore(dir: File, dirSync: DirectorySync = AndroidDirectorySync()) : SessionStore {
    private val file = File(dir, "session.enc")
    private val durable = DurableFile(file, dirSync)
    private val lock = Any()

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    override fun read(): SessionBundle? = synchronized(lock) {
        val raw = durable.read() ?: return null
        try {
            if (raw.size < 14) return null
            val iv = raw.copyOfRange(0, 12)
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
            decode(String(c.doFinal(raw, 12, raw.size - 12), Charsets.UTF_8))
        } catch (e: Exception) {
            // Unreadable (key lost, tampered): fail closed as "no session".
            null
        }
    }

    override fun write(bundle: SessionBundle) = synchronized(lock) {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, key())
        val enc = c.doFinal(encode(bundle).toByteArray(Charsets.UTF_8))
        durable.write(c.iv + enc)
    }

    override fun clear() = synchronized(lock) {
        file.delete()
        Unit
    }

    companion object {
        private const val ALIAS = "stateaction.native_upload.session.v1"

        fun encode(b: SessionBundle): String {
            val arr = JSONArray()
            for (c in b.cookies) {
                arr.put(
                    JSONObject().put("name", c.name).put("value", c.value).put("path", c.path)
                        .put("secure", c.secure).put("expiresAtMs", c.expiresAtMs ?: JSONObject.NULL),
                )
            }
            return JSONObject().put("ownerId", b.ownerId).put("origin", b.origin).put("revision", b.revision)
                .put("cookies", arr).toString()
        }

        fun decode(text: String): SessionBundle {
            val o = JSONObject(text)
            val arr = o.getJSONArray("cookies")
            val cookies = (0 until arr.length()).map {
                val c = arr.getJSONObject(it)
                StoredCookie(
                    c.getString("name"), c.getString("value"), c.getString("path"), c.getBoolean("secure"),
                    if (c.isNull("expiresAtMs")) null else c.getLong("expiresAtMs"),
                )
            }
            return SessionBundle(o.getString("ownerId"), o.getString("origin"), o.getLong("revision"), cookies)
        }
    }
}
