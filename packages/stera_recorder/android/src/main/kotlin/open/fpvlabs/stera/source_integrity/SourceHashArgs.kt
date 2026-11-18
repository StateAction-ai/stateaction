package open.fpvlabs.stera.source_integrity

/** Validated `hash` arguments. Built only by [SourceHashArgs.parse]. */
class SourceHashArgs private constructor(
    val token: String,
    val root: String,
    val relativePath: String,
    val chunkBytes: Int,
    val maxBytes: Long,
    val expectedSource: SourceReadIdentity?,
) {
    /** Parse failure: always reported as channel code `bad_args`. */
    class Invalid(message: String) : Exception(message)

    companion object {
        /** Default streaming chunk (matches Dart `SourceLimits.defaultChunkBytes`). */
        const val DEFAULT_CHUNK_BYTES = 1 shl 20

        /** Absolute chunk cap: one heap buffer of this size is allocated per call. */
        const val MAX_CHUNK_BYTES = 16 shl 20

        /** `common.v1#/$defs/fileSizeBytes` upper bound: 100 GiB. */
        const val MAX_FILE_BYTES = 107374182400L

        const val MAX_TOKEN_CHARS = 128
        const val MAX_PATH_CHARS = 4096

        /** Types are checked before any allocation; nothing here casts unchecked. */
        fun parse(arguments: Any?): SourceHashArgs {
            val m = arguments as? Map<*, *> ?: throw Invalid("arguments must be a map")
            val token = str(m, "token", MAX_TOKEN_CHARS)
            val root = str(m, "root", MAX_PATH_CHARS)
            val rel = str(m, "relativePath", MAX_PATH_CHARS)
            val chunk = integer(m, "chunkBytes")
            val max = integer(m, "maxBytes")
            if (chunk < 1 || chunk > MAX_CHUNK_BYTES) {
                throw Invalid("chunkBytes must be 1..$MAX_CHUNK_BYTES")
            }
            if (max < 1 || max > MAX_FILE_BYTES) throw Invalid("maxBytes must be 1..$MAX_FILE_BYTES")
            val expectedFile = m["expectedFile"]?.let { value ->
                val file = value as? Map<*, *> ?: throw Invalid("expectedFile must be an identity")
                FdIdentity(decimal(file, "dev"), decimal(file, "inode"), decimal(file, "size"),
                    decimal(file, "mtimeNs"), decimal(file, "ctimeNs"))
            }
            val directory = m["expectedDirectory"]?.let { value ->
                val dir = value as? Map<*, *> ?: throw Invalid("expectedDirectory must be an identity")
                FdKey(decimal(dir, "dev"), decimal(dir, "inode"))
            }
            if (directory != null && expectedFile == null) throw Invalid("expectedDirectory needs expectedFile")
            return SourceHashArgs(token, root, rel, chunk.toInt(), max,
                expectedFile?.let { SourceReadIdentity(it, directory) })
        }

        private fun decimal(m: Map<*, *>, key: String): Long {
            val text = str(m, key, 20)
            val number = text.toLongOrNull() ?: throw Invalid("$key must be a signed 64-bit decimal")
            if (number.toString() != text) throw Invalid("$key must use canonical decimal")
            return number
        }

        private fun str(m: Map<*, *>, k: String, limit: Int): String {
            val v = m[k] as? String ?: throw Invalid("$k must be a string")
            if (v.isEmpty() || v.length > limit) throw Invalid("$k length must be 1..$limit")
            return v
        }

        private fun integer(m: Map<*, *>, k: String): Long {
            return when (val v = m[k]) {
                is Int -> v.toLong()
                is Long -> v
                is Short -> v.toLong()
                is Byte -> v.toLong()
                else -> throw Invalid("$k must be an integer")
            }
        }
    }
}
