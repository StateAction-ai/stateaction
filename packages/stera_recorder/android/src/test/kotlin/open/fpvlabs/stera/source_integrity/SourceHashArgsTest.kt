package open.fpvlabs.stera.source_integrity

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class SourceHashArgsTest {
    private fun ok(): MutableMap<String, Any?> = mutableMapOf(
        "token" to "t1", "root" to "/r", "relativePath" to "a.bin",
        "chunkBytes" to SourceHashArgs.DEFAULT_CHUNK_BYTES, "maxBytes" to 10L,
    )

    private fun bad(m: Any?) = assertThrows(SourceHashArgs.Invalid::class.java) { SourceHashArgs.parse(m) }

    @Test fun acceptsBoundsAndIntegerWidths() {
        val a = SourceHashArgs.parse(ok().apply { put("maxBytes", SourceHashArgs.MAX_FILE_BYTES) })
        assertEquals(SourceHashArgs.MAX_FILE_BYTES, a.maxBytes)
        assertEquals(1 shl 20, a.chunkBytes)
        val b = SourceHashArgs.parse(ok().apply { put("chunkBytes", SourceHashArgs.MAX_CHUNK_BYTES.toLong()) })
        assertEquals(SourceHashArgs.MAX_CHUNK_BYTES, b.chunkBytes)
    }

    @Test fun refusesOversizedAndNonPositive() {
        // Dart ints beyond 32 bits arrive as Long: must not truncate or allocate.
        bad(ok().apply { put("chunkBytes", Int.MAX_VALUE) })
        bad(ok().apply { put("chunkBytes", (SourceHashArgs.MAX_CHUNK_BYTES + 1).toLong()) })
        bad(ok().apply { put("chunkBytes", 1L shl 32 or 5L) })
        bad(ok().apply { put("chunkBytes", 0) })
        bad(ok().apply { put("chunkBytes", -1) })
        bad(ok().apply { put("maxBytes", 0L) })
        bad(ok().apply { put("maxBytes", SourceHashArgs.MAX_FILE_BYTES + 1) })
        bad(ok().apply { put("maxBytes", Long.MAX_VALUE) })
    }

    @Test fun refusesWrongTypesWithoutCastCrash() {
        bad(null)
        bad("not a map")
        bad(ok().apply { put("chunkBytes", "4096") })
        bad(ok().apply { put("chunkBytes", 4096.0) })
        bad(ok().apply { put("maxBytes", 1.5) })
        bad(ok().apply { put("token", 7) })
        bad(ok().apply { put("token", "") })
        bad(ok().apply { put("token", "x".repeat(SourceHashArgs.MAX_TOKEN_CHARS + 1)) })
        bad(ok().apply { remove("root") })
        bad(ok().apply { put("relativePath", null) })
        bad(ok().apply { put("root", "r".repeat(SourceHashArgs.MAX_PATH_CHARS + 1)) })
    }
}
