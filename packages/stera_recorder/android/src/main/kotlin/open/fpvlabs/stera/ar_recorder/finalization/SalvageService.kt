package open.fpvlabs.stera.ar_recorder.finalization

import open.fpvlabs.stera.ar_recorder.data.h264.CaptureProtocol
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.UUID

/**
 * Explicit, user- or operator-initiated salvage of a quarantined session. Salvage never repairs, truncates or
 * re-encodes: it byte-copies the original files into a NEW sibling directory, records the SHA-256 of every original
 * and of every copy, and gives the derived directory its own identity. The original directory (including its recovery
 * marker) is untouched, and the derived directory is declared `salvaged_unverified` and `auto_admit=false`: it still
 * needs independent validation and must not be uploaded as a complete capture.
 *
 * This hash is salvage identity only. The streaming hash and frozen manifest for upload belong to SA-18.
 */
object SalvageService {
    const val MANIFEST = "salvage_manifest.json"
    const val MAX_FILES = 256
    const val DEFAULT_DEADLINE_MS = 120_000L

    sealed class Result {
        data class Salvaged(val directory: File, val derivedRecordingId: String) : Result()
        data class Refused(val reason: String) : Result()
    }

    fun salvage(
        source: File,
        monotonicMs: () -> Long,
        wallMs: () -> Long,
        reserveBytes: Long = CaptureResourceGuard.FINALIZATION_RESERVE_BYTES,
        deadlineMs: Long = DEFAULT_DEADLINE_MS,
    ): Result {
        if (!File(source, RecoveryScanner.MARKER).isFile) return Result.Refused("source_not_quarantined")
        val files = source.listFiles { f -> f.isFile && f.name != RecoveryScanner.MARKER && !f.name.startsWith(".") }
            ?.sortedBy { it.name }.orEmpty()
        if (files.isEmpty()) return Result.Refused("source_has_no_files")
        if (files.size > MAX_FILES) return Result.Refused("too_many_files")
        val parent = checkNotNull(source.absoluteFile.parentFile)
        val total = files.sumOf { it.length() }
        if (parent.usableSpace < total + reserveBytes) return Result.Refused("insufficient_space_for_copy_and_reserve")

        val started = monotonicMs()
        val token = UUID.randomUUID().toString().take(8)
        val temp = File(parent, ".salvage_tmp_${source.name}_$token")
        val final = File(parent, "salvage_${source.name}_$token")
        check(temp.mkdir()) { "Could not create salvage staging directory" }
        try {
            val records = ArrayList<Map<String, Any?>>()
            val identityInput = StringBuilder("stateaction-salvage-v1")
            for (file in files) {
                check(monotonicMs() - started < deadlineMs) { "Salvage deadline exceeded" }
                val copy = File(temp, file.name)
                val sourceHash = copyWithHash(file, copy)
                val copyHash = sha256(copy)
                check(sourceHash == copyHash && copy.length() == file.length()) { "Copy of ${file.name} differs from the original" }
                records += mapOf("name" to file.name, "bytes" to file.length(), "sha256" to sourceHash, "copy_sha256" to copyHash)
                identityInput.append('\n').append(file.name).append(':').append(sourceHash)
            }
            val derivedId = UUID.nameUUIDFromBytes(identityInput.toString().toByteArray(Charsets.UTF_8)).toString()
            val originalId = (FinalizationJournal.read(source) as? FinalizationJournal.ReadResult.Present)?.entry?.recordingId
            val manifest = CaptureProtocol.json(mapOf(
                "version" to 1,
                "derived_recording_id" to derivedId,
                "original_recording_id" to originalId,
                "source_session" to source.name,
                "derivation" to "byte_copy_no_repair_no_reencode",
                "container_state" to "unverified",
                "capture_outcome" to "salvaged_unverified",
                "auto_admit" to false,
                "requires" to listOf("independent_container_validation"),
                "salvaged_at_unix_ms" to wallMs(),
                "files" to records,
            ))
            AtomicFiles.write(File(temp, MANIFEST), manifest.toByteArray(Charsets.UTF_8))
            check(temp.renameTo(final)) { "Could not publish salvage directory" }
            return Result.Salvaged(final, derivedId)
        } catch (error: Exception) {
            temp.deleteRecursively() // only the staging copy this call created; the original is never touched
            return Result.Refused("salvage_failed:${error.message ?: error.javaClass.simpleName}")
        }
    }

    private fun copyWithHash(from: File, to: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        FileInputStream(from).use { input ->
            FileOutputStream(to).use { output ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    digest.update(buffer, 0, read)
                    output.write(buffer, 0, read)
                }
                output.flush(); output.fd.sync()
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        FileInputStream(file).use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) { val read = input.read(buffer); if (read < 0) break; digest.update(buffer, 0, read) }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
}
