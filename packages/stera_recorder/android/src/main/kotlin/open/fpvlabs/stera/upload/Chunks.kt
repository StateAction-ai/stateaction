package open.fpvlabs.stera.upload

import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.Semaphore
import java.util.concurrent.atomic.AtomicInteger
import open.fpvlabs.stera.source_integrity.FdIdentity

/**
 * Temporary chunk files. The source is only ever read; a part is copied (with a
 * bounded buffer) into a private scratch file so a retry or a concurrent
 * source change cannot alter the bytes of an in-flight PUT. At most
 * [Limits.MAX_TEMP_CHUNKS] files exist at once, whatever the caller does.
 */
class ChunkStore(
    private val dir: File,
    private val freeBytes: () -> Long,
    private val reserveBytes: Long = 256L * 1024 * 1024,
) {
    private val permits = Semaphore(Limits.MAX_TEMP_CHUNKS)
    private val live = AtomicInteger(0)
    @Volatile var maxLive: Int = 0
        private set

    class Chunk internal constructor(val file: File, val length: Long, private val release: () -> Unit) : AutoCloseable {
        private var closed = false
        @Synchronized override fun close() {
            if (closed) return
            closed = true
            file.delete()
            release()
        }
    }

    /** Deletes scratch files left by a dead process. Never touches anything outside [dir]. */
    fun sweep() {
        dir.listFiles()?.forEach { if (it.isFile && (it.name.endsWith(".chunk") || it.name.endsWith(".tmp"))) it.delete() }
    }

    /**
     * Copies part [partNumber] of the confined [source] into a scratch chunk.
     * Throws [SourceException] when the source grew, shrank, moved or changed
     * identity; the copy then never becomes a chunk.
     */
    fun extract(
        source: OpenSource,
        identity: FdIdentity,
        plan: UploadPlan,
        partNumber: Int,
        cancel: CancelToken,
    ): Chunk {
        val length = plan.partLength(partNumber)
        val offset = plan.partOffset(partNumber)
        if (freeBytes() < length + reserveBytes) throw SourceException("low_storage", "not enough free storage for a chunk")
        cancel.check()
        permits.acquire()
        val now = live.incrementAndGet()
        if (now > maxLive) maxLive = now
        val release = { live.decrementAndGet(); permits.release(); Unit }
        if (!dir.isDirectory && !dir.mkdirs()) {
            release()
            throw SourceException("scratch_unavailable", "cannot create the chunk directory")
        }
        val tmp = File(dir, "p${plan.transportEpoch}-${partNumber}.tmp")
        val done = File(dir, "p${plan.transportEpoch}-${partNumber}.chunk")
        var ok = false
        try {
            source.verify(identity)
            val buf = ByteArray(Limits.STREAM_BUFFER_BYTES)
            var copied = 0L
            var sinceVerify = 0L
            FileOutputStream(tmp).use { out ->
                while (copied < length) {
                    cancel.check()
                    val want = minOf(buf.size.toLong(), length - copied).toInt()
                    val n = source.readAt(offset + copied, buf, want)
                    if (n <= 0) throw SourceException("shrank", "source ended before the planned part")
                    out.write(buf, 0, n)
                    copied += n
                    sinceVerify += n
                    if (sinceVerify >= VERIFY_EVERY_BYTES) {
                        source.verify(identity)
                        sinceVerify = 0
                    }
                }
                out.flush()
                out.fd.sync()
            }
            // Identity is re-proved after the last byte: a file that changed while copying is refused.
            source.verify(identity)
            if (tmp.length() != length || !tmp.renameTo(done)) throw SourceException("scratch_unavailable", "chunk finalize failed")
            ok = true
            return Chunk(done, length, release)
        } finally {
            if (!ok) {
                tmp.delete()
                done.delete()
                release()
            }
        }
    }

    companion object {
        const val VERIFY_EVERY_BYTES = 16L * 1024 * 1024
    }
}
