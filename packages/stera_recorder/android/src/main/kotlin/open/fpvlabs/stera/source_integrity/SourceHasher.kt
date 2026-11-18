package open.fpvlabs.stera.source_integrity

/** Identity of an opened descriptor (`fstat`): never guessed, never path-based. */
data class FdIdentity(
    val dev: Long,
    val inode: Long,
    val size: Long,
    val mtimeNs: Long,
    val ctimeNs: Long,
) {
    val key get() = FdKey(dev, inode)
    fun toJson() = key.toJson() + mapOf(
        "size" to size.toString(), "mtimeNs" to mtimeNs.toString(), "ctimeNs" to ctimeNs.toString(),
    )
}

/** Directory entry changes during finalization, so only its device and inode are frozen. */
data class FdKey(val dev: Long, val inode: Long) {
    fun toJson() = mapOf("dev" to dev.toString(), "inode" to inode.toString())
}

data class SourceReadIdentity(val file: FdIdentity, val directory: FdKey? = null)

data class ClosedSourceIdentity(
    val finalizationToken: String,
    val directory: FdKey,
    val files: Map<String, FdIdentity>,
) {
    fun toJson() = mapOf(
        "finalizationToken" to finalizationToken,
        "directory" to directory.toJson(),
        "files" to files.mapValues { it.value.toJson() },
    )
}

data class HashOutcome(
    val sha256: String,
    val sizeBytes: Long,
    val identity: FdIdentity,
    val peakBufferBytes: Int,
    val chunkCount: Int,
)

/** Contract: hash one file confined under [root], bound to its opened descriptor. */
interface SourceHasher {
    @Throws(SourceHashException::class)
    fun hash(
        root: String,
        relativePath: String,
        chunkBytes: Int,
        maxBytes: Long,
        isCancelled: () -> Boolean,
    ): HashOutcome
}

/** [code] is the channel error code: path_escape, not_regular, unstable, cancelled, unsupported. */
class SourceHashException(val code: String, message: String, val details: String? = null) :
    Exception(message)
