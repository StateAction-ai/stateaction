package open.fpvlabs.stera.source_integrity

import android.os.Build
import android.os.ParcelFileDescriptor
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.system.StructStat
import java.io.FileDescriptor

/**
 * Real descriptor operations through `android.system.Os`. Needs API 33 for
 * nanosecond `st_mtim`/`st_ctim`; older systems only report whole seconds,
 * which cannot prove same-second mutation absent, so construction refuses.
 */
class AndroidFdOps(sdkInt: Int = Build.VERSION.SDK_INT) : FdOps {
    companion object {
        /** Identity from an already-open writer, while its fd is still valid. */
        fun finishedWriterIdentity(fd: FileDescriptor): FdIdentity? {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return null
            return try {
                info(Os.fstat(fd)).takeIf { it.regular }?.identity
            } catch (_: Exception) {
                null
            }
        }

        private fun info(st: StructStat) = StatInfo(
            (st.st_mode and OsConstants.S_IFMT) == OsConstants.S_IFREG,
            FdIdentity(
                st.st_dev, st.st_ino, st.st_size,
                st.st_mtim.tv_sec * 1_000_000_000L + st.st_mtim.tv_nsec,
                st.st_ctim.tv_sec * 1_000_000_000L + st.st_ctim.tv_nsec,
            ),
        )
    }

    init {
        if (sdkInt < Build.VERSION_CODES.TIRAMISU) {
            throw SourceHashException(
                "unsupported",
                "Android 13 (API 33) is required for nanosecond file times; this device is API $sdkInt",
            )
        }
    }

    private class Handle(val fd: FileDescriptor, val number: ParcelFileDescriptor)

    private val handles = HashMap<Int, Handle>()

    override fun open(path: String, @Suppress("UNUSED_PARAMETER") directory: Boolean): Int? {
        // OsConstants has no O_DIRECTORY; a non-directory root simply makes
        // the child open fail with ENOTDIR.
        val flags = OsConstants.O_RDONLY or OsConstants.O_NOFOLLOW or
            OsConstants.O_CLOEXEC or OsConstants.O_NONBLOCK
        val fd = try {
            Os.open(path, flags, 0)
        } catch (e: ErrnoException) {
            when (e.errno) {
                OsConstants.ENOENT, OsConstants.ENOTDIR -> return null
                OsConstants.ELOOP -> throw SourceHashException("path_escape", "symlink on path")
                else -> throw SourceHashException("unstable", "open errno ${e.errno}", "readFailed")
            }
        }
        // Public API to learn the descriptor's number (for /proc/self/fd/N).
        val dup = try {
            ParcelFileDescriptor.dup(fd)
        } catch (e: java.io.IOException) {
            Os.close(fd)
            throw SourceHashException("unstable", "dup failed: ${e.message}", "readFailed")
        }
        Os.close(fd)
        val n = dup.fd
        handles[n] = Handle(dup.fileDescriptor, dup)
        return n
    }

    private fun h(fd: Int) = handles[fd] ?: throw IllegalStateException("closed fd $fd")

    override fun fstat(fd: Int): StatInfo = try {
        info(Os.fstat(h(fd).fd))
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

    override fun read(fd: Int, buf: ByteArray, len: Int): Int = try {
        Os.read(h(fd).fd, buf, 0, len)
    } catch (e: ErrnoException) {
        throw SourceHashException("unstable", "read errno ${e.errno}", "readFailed")
    }

    override fun close(fd: Int) {
        handles.remove(fd)?.number?.close()
    }
}
