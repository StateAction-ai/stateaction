package open.fpvlabs.stera.ar_recorder.finalization

import open.fpvlabs.stera.ar_recorder.data.h264.CaptureProtocol
import java.io.File

/**
 * Finds sessions whose finalization did not durably complete (process death, power loss, killed writer, hash or
 * metadata crash) and quarantines them with `recovery_required.json`. The scanner only ever ADDS that marker beside the
 * original files: it never rewrites, repairs, truncates, hashes, uploads, admits or deletes a source.
 *
 * Bounded: at most [maxSessions] directories and [budgetMs] per scan; anything left over is reported as `truncated`
 * and picked up by the next scan. Run it only while no recording is active (the recorder does so inside Start before
 * the new session directory exists).
 */
object RecoveryScanner {
    const val MARKER = "recovery_required.json"
    const val MAX_LISTED_FILES = 64
    const val MAX_SESSIONS = 128
    const val BUDGET_MS = 1_500L
    private const val SESSION_PREFIX = "session_"

    data class Report(
        val scanned: Int,
        val newlyQuarantined: List<String>,
        val alreadyQuarantined: List<String>,
        val finalized: Int,
        val legacyWithoutJournal: Int,
        val truncated: Boolean,
        val errors: List<String>,
    )

    fun scan(
        baseDir: File,
        monotonicMs: () -> Long,
        wallMs: () -> Long,
        maxSessions: Int = MAX_SESSIONS,
        budgetMs: Long = BUDGET_MS,
    ): Report {
        val started = monotonicMs()
        val sessions = baseDir.listFiles { f -> f.isDirectory && f.name.startsWith(SESSION_PREFIX) }?.sortedBy { it.name }.orEmpty()
        val newly = mutableListOf<String>()
        val already = mutableListOf<String>()
        val errors = mutableListOf<String>()
        var finalized = 0
        var legacy = 0
        var scanned = 0
        var truncated = false
        for (dir in sessions) {
            if (scanned >= maxSessions || monotonicMs() - started >= budgetMs) { truncated = true; break }
            scanned++
            try {
                if (File(dir, MARKER).exists()) { already += dir.name; continue }
                val reason = classify(dir)
                when {
                    reason == null -> finalized++
                    reason == LEGACY -> legacy++
                    else -> { quarantine(dir, reason, wallMs()); newly += dir.name }
                }
            } catch (error: Exception) {
                errors += "${dir.name}: ${error.message ?: error.javaClass.simpleName}"
            }
        }
        return Report(scanned, newly, already, finalized, legacy, truncated, errors)
    }

    private const val LEGACY = "legacy_without_journal"

    /** null = durably finalized; LEGACY = pre-journal session that has its own sidecar; anything else = quarantine reason. */
    private fun classify(dir: File): String? = when (val read = FinalizationJournal.read(dir)) {
        is FinalizationJournal.ReadResult.Present ->
            if (read.entry.phase == FinalizationPhase.FINALIZED) null else "journal_phase_${read.entry.phase.name.lowercase()}"
        is FinalizationJournal.ReadResult.Unreadable -> "journal_unreadable"
        FinalizationJournal.ReadResult.Absent -> when {
            File(dir, "metadata.json").exists() -> LEGACY
            dir.listFiles { f -> f.name.endsWith(".mcap") }?.isNotEmpty() == true -> "no_journal_no_metadata"
            else -> LEGACY
        }
    }

    /** Adds the quarantine marker (first writer wins). Never modifies, hashes or deletes any original file. */
    fun quarantine(dir: File, reason: String, wallMs: Long) {
        val read = FinalizationJournal.read(dir)
        val entry = (read as? FinalizationJournal.ReadResult.Present)?.entry
        val files = dir.listFiles { f -> f.isFile }?.sortedBy { it.name }.orEmpty()
        val body = CaptureProtocol.json(mapOf(
            "version" to 1,
            "session_name" to dir.name,
            "recording_id" to entry?.recordingId,
            "reason" to reason,
            "journal_phase" to entry?.phase?.name,
            "container_state" to "unverified",
            "recovery_state" to "quarantined",
            "admission" to "never_automatic",
            "original_bytes_preserved" to true,
            "detected_at_unix_ms" to wallMs,
            "files" to files.take(MAX_LISTED_FILES).map { mapOf("name" to it.name, "bytes" to it.length()) },
            "files_truncated" to (files.size > MAX_LISTED_FILES),
        ))
        AtomicFiles.createIfAbsent(File(dir, MARKER), body.toByteArray(Charsets.UTF_8))
    }
}
