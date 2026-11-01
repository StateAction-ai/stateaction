package open.fpvlabs.stera.ar_recorder.data

import java.io.BufferedOutputStream
import java.io.File
import java.io.IOException
import java.io.OutputStream
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class MCAPFailureTest {
    @get:Rule val temporary = TemporaryFolder()

    private fun writerWithFailingDisk(): MCAPDatasetWriter {
        val writer = MCAPDatasetWriter(RuntimeEnvironment.getApplication(), "test", "35")
        writer.createSessionDirectory(temporary.newFolder())
        assertTrue(writer.initializeWriters())
        writer.writeCompressedRgbFrame(100L, byteArrayOf(1, 2, 3), 200L)
        assertEquals(1, writer.getRecordingStats()["rgbFrameCount"])
        val mcapField = MCAPDatasetWriter::class.java.getDeclaredField("mcapWriter").apply { isAccessible = true }
        val mcap = mcapField.get(writer)
        val outputField = MCAPWriter::class.java.getDeclaredField("outputStream").apply { isAccessible = true }
        (outputField.get(mcap) as BufferedOutputStream).close()
        outputField.set(mcap, BufferedOutputStream(object : OutputStream() {
            override fun write(value: Int) { throw IOException("simulated disk full") }
            override fun write(bytes: ByteArray, offset: Int, length: Int) { throw IOException("simulated disk full") }
        }))
        return writer
    }

    @Test fun failureAfterGoodRgbFrameIsStickyAndDoesNotIncrementSavedCount() {
        val writer = writerWithFailingDisk()
        writer.writeCompressedRgbFrame(101L, ByteArray(1_100_000), 201L)
        assertEquals(1, writer.getRecordingStats()["rgbFrameCount"])
        assertTrue(writer.getWriteFailure()!!.contains("simulated disk full"))
        val original = writer.getWriteFailure()
        writer.recordWriteFailure("later failure")
        assertEquals(original, writer.getWriteFailure())
        writer.finalize()
    }

    @Test fun footerFailureIsReportedAndFinalStatusSidecarCanBeCorrected() {
        val writer = writerWithFailingDisk()
        assertFalse(writer.createSpatialDataZip().first)
        assertTrue(writer.getWriteFailure()!!.contains("simulated disk full"))
        // Simulate an earlier provisional success while the broken MCAP stream remains attached.
        writer.writeMetadata(mapOf("capture_result_valid" to true, "finalization_complete" to true))
        val json = File(writer.getSessionDirectory()!!, "metadata.json").readText()
        assertTrue(json.contains("\"capture_result_valid\": false"))
        assertTrue(json.contains("simulated disk full"))
        assertTrue(json.contains("\"finalization_complete\": false"))
        writer.finalize()
    }

    @Test fun footerFailureReleasesWriterSoANewSessionCanBeConfigured() {
        val writer = writerWithFailingDisk()
        val failedDirectory = File(writer.getSessionDirectory()!!)
        writer.finalize()
        assertNotNull(writer.getWriteFailure())
        writer.configureH264Capture(null)
        val next = writer.createSessionDirectory(failedDirectory.parentFile)
        assertNotNull(next)
        assertNotEquals(failedDirectory, next)
        assertTrue(failedDirectory.exists())
        assertTrue(writer.initializeWriters())
        assertNull(writer.getWriteFailure())
        writer.finalize()
    }

    @Test fun rapidDirectoryCreationNeverReusesExistingSourceBytes() {
        val base = temporary.newFolder()
        val writer = MCAPDatasetWriter(RuntimeEnvironment.getApplication(), "test", "35")
        val first = writer.createSessionDirectory(base)!!
        File(first, "diagnostic-source").writeText("original immutable bytes")
        val created = (0 until 10).map { writer.createSessionDirectory(base)!!.absolutePath }
        assertEquals(10, created.distinct().size)
        assertFalse(first.absolutePath in created)
        assertEquals("original immutable bytes", File(first, "diagnostic-source").readText())
    }
}
