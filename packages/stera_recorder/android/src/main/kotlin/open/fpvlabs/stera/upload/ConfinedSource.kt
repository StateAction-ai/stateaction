package open.fpvlabs.stera.upload

import open.fpvlabs.stera.source_integrity.FdIdentity
import open.fpvlabs.stera.source_integrity.FdOps
import open.fpvlabs.stera.source_integrity.SourceHashException

/** [FdOps] plus a positional read, so two parts never share a file offset. */
interface PositionalFdOps : FdOps {
    /** Reads up to [len] bytes at [offset] without moving any shared offset; 0 at EOF. */
    fun pread(fd: Int, buf: ByteArray, offset: Long, len: Int): Int
}

/**
 * Confined, descriptor-bound reader for upload sources: the same rules as the
 * SA-18 hasher (open the session root, open `root/rel` with O_NOFOLLOW, fstat
 * the descriptor, require its kernel path to equal `root/rel` and `lstat` to
 * name the same inode), plus the frozen identity from the sealed manifest. A
 * source that grew, shrank, was replaced or escaped its root is refused; the
 * source is only ever opened read-only.
 */
class ConfinedSourceOpener(private val ops: PositionalFdOps) : SourceOpener {

    override fun open(root: String, relativePath: String, expected: FdIdentity): OpenSource {
        val parts = relativePath.split("/")
        if (relativePath.isEmpty() || relativePath.startsWith("/") || relativePath.contains('\\') ||
            relativePath.contains('\u0000') || parts.any { it.isEmpty() || it == "." || it == ".." } ||
            !root.startsWith("/")
        ) throw SourceException("path_escape", "not a safe relative path")
        return mapped {
            val rootFd = ops.open(root, true) ?: throw SourceException("path_escape", "session root not openable")
            var fd = -1
            try {
                val rootReal = ops.fdPath(rootFd)
                val path = (if (rootReal == "/") "" else rootReal) + "/" + parts.joinToString("/")
                fd = ops.open(path, false) ?: throw SourceException("path_escape", "missing")
                val src = ConfinedOpenSource(ops, fd, path)
                src.verify(expected)
                val ok = src
                fd = -1
                ok
            } finally {
                if (fd >= 0) ops.close(fd)
                ops.close(rootFd)
            }
        }
    }

    internal companion object {
        inline fun <T> mapped(block: () -> T): T = try {
            block()
        } catch (e: SourceHashException) {
            throw SourceException(if (e.code == "unstable") "changed" else e.code, e.message ?: e.code)
        }
    }
}

internal class ConfinedOpenSource(
    private val ops: PositionalFdOps,
    private val fd: Int,
    private val path: String,
) : OpenSource {
    private var closed = false

    @Synchronized
    override fun verify(expected: FdIdentity) {
      ConfinedSourceOpener.mapped {
        check(!closed) { "source closed" }
        val st = ops.fstat(fd)
        if (!st.regular) throw SourceException("not_regular", "not a regular file")
        if (ops.fdPath(fd) != path) throw SourceException("path_escape", "descriptor path moved")
        val byPath = ops.lstat(path) ?: throw SourceException("changed", "path vanished")
        if (byPath.identity != st.identity) throw SourceException("path_escape", "path names a different file")
        if (st.identity != expected) throw SourceException("changed", "identity differs from the sealed source")
        Unit
      }
    }

    override fun readAt(offset: Long, buf: ByteArray, len: Int): Int = ConfinedSourceOpener.mapped {
        ops.pread(fd, buf, offset, len)
    }

    @Synchronized
    override fun close() {
        if (closed) return
        closed = true
        ops.close(fd)
    }
}
