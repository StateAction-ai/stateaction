package open.fpvlabs.stera.ar_recorder.finalization

import java.io.File
import java.io.FileOutputStream
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption

/**
 * Durable small-file replacement shared by the journal, recovery markers and salvage manifests: write a sibling
 * temporary file, fsync it, atomically rename over the target and best-effort fsync the directory. A crash leaves
 * either the previous complete file or the new complete file, never a prefix.
 */
internal object AtomicFiles {
    fun write(target: File, bytes: ByteArray) {
        val dir = checkNotNull(target.absoluteFile.parentFile) { "Target has no parent" }
        val temp = File(dir, ".${target.name}.tmp")
        FileOutputStream(temp).use { out ->
            out.write(bytes)
            out.flush()
            out.fd.sync()
        }
        try {
            Files.move(temp.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } catch (error: AtomicMoveNotSupportedException) {
            temp.delete()
            throw java.io.IOException("Atomic replace is not supported for ${target.name}", error)
        }
        syncDirectory(dir)
    }

    /** Creates [target] only if absent (first writer wins); returns false when it already exists. */
    fun createIfAbsent(target: File, bytes: ByteArray): Boolean {
        if (target.exists()) return false
        write(target, bytes)
        return true
    }

    private fun syncDirectory(dir: File) {
        try {
            java.nio.channels.FileChannel.open(dir.toPath(), StandardOpenOption.READ).use { it.force(true) }
        } catch (_: Exception) {
            // Some filesystems cannot open a directory for sync; the file fsync above already happened.
        }
    }

    /**
     * Directory fsync that reports the truth: true = the directory entry was forced to storage, false = the
     * filesystem cannot open/force a directory (durability of the entry is then NOT claimed). An I/O error while
     * forcing a directory that did open is thrown.
     */
    fun syncDirectoryReporting(dir: File): Boolean {
        val channel = try {
            java.nio.channels.FileChannel.open(dir.toPath(), StandardOpenOption.READ)
        } catch (_: Exception) {
            return false
        }
        channel.use { it.force(true) }
        return true
    }
}
