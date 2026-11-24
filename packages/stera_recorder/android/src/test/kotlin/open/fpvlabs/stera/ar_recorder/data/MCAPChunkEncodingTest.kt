package open.fpvlabs.stera.ar_recorder.data

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.zip.CRC32
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class MCAPChunkEncodingTest {
    @get:Rule val directory = TemporaryFolder()

    @Test fun reusedAndOversizedChunksKeepExactLengthsCrcsAndIndexes() {
        val file = directory.newFile("chunks.mcap")
        val writer = MCAPWriter()
        val payloads = listOf(
            ByteArray(1_050_000) { (it % 251).toByte() },
            byteArrayOf(11, 22, 33),
            ByteArray(2_100_000) { (it % 191).toByte() },
            byteArrayOf(44, 55),
        )
        assertTrue(writer.open(file))
        val schema = writer.addSchema("bytes", "raw", "")
        val channel = writer.addChannel("/test", "raw", schema)
        for ((index, payload) in payloads.withIndex()) {
            writer.addMessage(channel, index + 1L, index + 1L, payload)
            if (index == 1) writer.forceFlushChunk()
        }
        writer.finish()

        val bytes = file.readBytes()
        val reader = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        reader.position(8)
        var chunks = 0
        var indexes = 0
        while (reader.position() < bytes.size - 8) {
            val start = reader.position()
            val opcode = reader.get().toInt()
            val length = reader.long.toInt()
            val end = reader.position() + length
            when (opcode) {
                0x06 -> {
                    val payload = payloads[chunks]
                    val stamp = chunks + 1L
                    assertEquals(stamp, reader.long)
                    assertEquals(stamp, reader.long)
                    val rawBytes = payload.size + 31
                    assertEquals(rawBytes.toLong(), reader.long)
                    val expectedCrc = reader.int
                    assertEquals(0, reader.int) // uncompressed
                    assertEquals(rawBytes.toLong(), reader.long)
                    assertEquals(expectedCrc, crc(bytes, reader.position(), rawBytes))
                    assertEquals(0x05, reader.get().toInt())
                    assertEquals(payload.size + 22L, reader.long)
                    assertEquals(channel, reader.short.toInt())
                    assertEquals(chunks, reader.int)
                    assertEquals(stamp, reader.long)
                    assertEquals(stamp, reader.long)
                    assertArrayEquals(payload, ByteArray(payload.size).also { reader.get(it) })
                    assertEquals(end, reader.position())
                    chunks++
                }
                0x07 -> {
                    assertEquals(chunks - 1, indexes)
                    assertEquals(channel, reader.short.toInt())
                    assertEquals(16, reader.int)
                    assertEquals(indexes + 1L, reader.long)
                    assertEquals(0L, reader.long)
                    assertEquals(end, reader.position())
                    indexes++
                }
                0x0f -> assertEquals(crc(bytes, 0, start), reader.int)
            }
            reader.position(end)
        }
        assertEquals(payloads.size, chunks)
        assertEquals(chunks, indexes)
    }

    private fun crc(bytes: ByteArray, offset: Int, length: Int): Int =
        CRC32().apply { update(bytes, offset, length) }.value.toInt()
}
