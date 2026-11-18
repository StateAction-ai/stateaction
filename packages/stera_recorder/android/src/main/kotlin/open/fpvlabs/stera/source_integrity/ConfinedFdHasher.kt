package open.fpvlabs.stera.source_integrity

import java.security.MessageDigest

internal const val MAX_FINAL_METADATA_BYTES = 1 shl 20

/** Platform seam: real `Os` calls on Android, a scripted fake in JVM unit tests. */
interface FdOps {
    /** Opens with O_RDONLY|O_NOFOLLOW|O_CLOEXEC|O_NONBLOCK (+O_DIRECTORY); null if ENOENT/ENOTDIR. */
    fun open(path: String, directory: Boolean): Int?

    /** Throws [SourceHashException] ("path_escape") when the final component is a symlink (ELOOP). */
    fun fstat(fd: Int): StatInfo

    /** `lstat` of a path; null when missing. */
    fun lstat(path: String): StatInfo?

    /** Kernel path of the open descriptor (`/proc/self/fd/N`). */
    fun fdPath(fd: Int): String

    /** Reads up to [len] bytes into [buf]; 0 at EOF. */
    fun read(fd: Int, buf: ByteArray, len: Int): Int

    fun close(fd: Int)
}

data class StatInfo(val regular: Boolean, val identity: FdIdentity)

/**
 * The same algorithm as the Dart Linux reference: open root, open `root/rel`
 * with O_NOFOLLOW, fstat the descriptor, require its own kernel path to equal
 * `root/rel` and `lstat(path)` to name the same inode (before reading and
 * again after), read only from that descriptor in bounded chunks, compare
 * descriptor identity before/after. Nanosecond times are required.
 */
class ConfinedFdHasher(
    private val ops: FdOps,
    private val expectedSource: SourceReadIdentity? = null,
) : SourceHasher {
    /** Snapshot final source descriptors after the metadata sidecar is written. */
    fun snapshotClose(
        root: String,
        paths: List<String>,
        token: String,
        expectedFiles: Map<String, FdIdentity> = emptyMap(),
        metadataMatches: (ByteArray) -> Boolean,
    ): ClosedSourceIdentity =
        withRoot(root) { rootFd, rootReal ->
            require(paths.containsAll(expectedFiles.keys)) { "Expected writer files must be in the close inventory" }
            val directory = ops.fstat(rootFd).identity.key
            val files = paths.associateWith { path ->
                withFile(rootReal, path) { fd, expected, before ->
                    expectedFiles[path]?.let { identity ->
                        if (before.identity != identity) {
                            throw unstable("identityChanged", "Closed file differs from the writer descriptor")
                        }
                    }
                    if (path == "metadata.json" && !metadataMatches(readMetadata(fd, before.identity.size))) {
                        throw unstable("identityChanged", "Final metadata token does not match")
                    }
                    checkUnchanged(fd, expected, before)
                    before.identity
                }
            }
            for ((path, identity) in files) {
                if (ops.lstat("${rootReal.trimEnd('/')}/$path")?.identity != identity) {
                    throw unstable("identityChanged", "Final source changed during snapshot")
                }
            }
            checkRoot(rootFd, rootReal, root, directory)
            ClosedSourceIdentity(token, directory, files)
        }

    override fun hash(
        root: String,
        relativePath: String,
        chunkBytes: Int,
        maxBytes: Long,
        isCancelled: () -> Boolean,
    ): HashOutcome = withRoot(root) { rootFd, rootReal ->
        expectedSource?.directory?.let { checkRoot(rootFd, rootReal, root, it) }
        withFile(rootReal, relativePath) { fd, expected, before ->
            if (expectedSource != null && expectedSource.file != before.identity) {
                throw unstable("identityChanged", "File no longer matches its frozen identity")
            }
            val size = before.identity.size
            if (size == 0L) throw unstable("empty", null)
            if (size > maxBytes) throw unstable("overCap", "$size")
            val digest = MessageDigest.getInstance("SHA-256")
            val buf = ByteArray(chunkBytes)
            var read = 0L
            var peak = 0
            var chunks = 0
            while (true) {
                if (isCancelled()) throw SourceHashException("cancelled", "cancelled")
                // At most one byte past the recorded size, to notice growth.
                val want = minOf(chunkBytes.toLong(), size + 1 - read).toInt()
                val n = ops.read(fd, buf, want)
                if (n == 0) break
                if (n > peak) peak = n
                read += n
                if (read > size) throw unstable("grewDuringHash", null)
                digest.update(buf, 0, n)
                chunks++
            }
            if (read < size) throw unstable("shrankDuringHash", null)
            checkUnchanged(fd, expected, before)
            expectedSource?.directory?.let { checkRoot(rootFd, rootReal, root, it) }
            HashOutcome(
                digest.digest().joinToString("") { "%02x".format(it) },
                read, before.identity, peak, chunks,
            )
        }
    }

    private fun <T> withRoot(root: String, block: (Int, String) -> T): T {
        val fd = ops.open(root, true)
            ?: throw SourceHashException("path_escape", "session root not openable")
        try {
            return block(fd, ops.fdPath(fd))
        } finally {
            ops.close(fd)
        }
    }

    private fun <T> withFile(root: String, relativePath: String, block: (Int, String, StatInfo) -> T): T {
        val parts = relativePath.split("/")
        if (relativePath.contains('\\') || relativePath.contains('\u0000') ||
            parts.any { it.isEmpty() || it == "." || it == ".." }
        ) throw SourceHashException("path_escape", "not a safe relative path")
        val expected = "${root.trimEnd('/')}/$relativePath"
        val fd = ops.open(expected, false) ?: throw SourceHashException("path_escape", "missing")
        try {
            val before = ops.fstat(fd)
            if (!before.regular) throw SourceHashException("not_regular", "not a regular file")
            bindingProblem(fd, expected, before)?.let { throw SourceHashException("path_escape", it) }
            return block(fd, expected, before)
        } finally {
            ops.close(fd)
        }
    }

    private fun checkRoot(fd: Int, fdPath: String, requestedPath: String, key: FdKey) {
        if (ops.fdPath(fd) != fdPath || ops.fstat(fd).identity.key != key ||
            ops.lstat(requestedPath)?.identity?.key != key) {
            throw unstable("identityChanged", "Directory no longer matches its frozen identity")
        }
    }

    private fun checkUnchanged(fd: Int, path: String, before: StatInfo) {
        val after = ops.fstat(fd)
        bindingProblem(fd, path, after)?.let { throw unstable("identityChanged", it) }
        if (after.identity != before.identity) throw unstable("identityChanged", "File changed after opening")
    }

    private fun readMetadata(fd: Int, size: Long): ByteArray {
        if (size !in 1L..MAX_FINAL_METADATA_BYTES.toLong()) {
            throw unstable("overCap", "Final metadata exceeds its size limit")
        }
        val bytes = java.io.ByteArrayOutputStream(size.toInt())
        val buffer = ByteArray(8192)
        while (bytes.size() <= size) {
            val n = ops.read(fd, buffer, minOf(buffer.size, size.toInt() + 1 - bytes.size()))
            if (n == 0) break
            bytes.write(buffer, 0, n)
        }
        if (bytes.size().toLong() != size) throw unstable("identityChanged", "Final metadata size changed")
        return bytes.toByteArray()
    }

    private fun bindingProblem(fd: Int, expected: String, st: StatInfo): String? {
        val real = ops.fdPath(fd)
        if (real != expected) return "descriptor path $real != $expected"
        val byPath = ops.lstat(expected) ?: return "path vanished"
        if (byPath.identity != st.identity) return "path names a different file"
        return null
    }

    private fun unstable(reason: String, detail: String?) =
        SourceHashException("unstable", detail ?: reason, reason)
}
