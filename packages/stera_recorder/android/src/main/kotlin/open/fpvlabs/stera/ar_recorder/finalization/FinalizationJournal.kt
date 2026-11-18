package open.fpvlabs.stera.ar_recorder.finalization

import open.fpvlabs.stera.ar_recorder.data.h264.CaptureProtocol
import open.fpvlabs.stera.source_integrity.ClosedSourceIdentity
import org.json.JSONObject
import java.io.File

/** Ordered finalization phases. Only [FINALIZED] is terminal; every other persisted phase means "unresolved". */
enum class FinalizationPhase { CAPTURING, STOPPING, DRAINING_ENCODER, CLOSING_CONTAINER, FINALIZING_METADATA, FINALIZED }

/** An immutable snapshot of what the durable journal says about one session directory. */
data class JournalEntry(
    val recordingId: String,
    val sessionName: String,
    val phase: FinalizationPhase,
    val sequence: Long,
    val stopReason: String?,
    val containerState: String?,
    val captureOutcome: String?,
)

/**
 * Durable per-session recovery journal (`finalization_journal.json`). It is written atomically at Start (before any
 * capture evidence exists) and at each finalization boundary, so a crash during capture, drain, hash or metadata
 * finalization leaves a non-terminal phase on disk. The scanner treats any non-[FinalizationPhase.FINALIZED] journal
 * as recovery-required and never completes or admits it automatically.
 *
 * Phases only move forward; a regression is a programming error and throws. The journal never stores imagery,
 * credentials or user identity.
 */
class FinalizationJournal private constructor(private val file: File, private var entry: JournalEntry) {
    val current: JournalEntry get() = entry

    @Synchronized fun advance(
        phase: FinalizationPhase,
        stopReason: String? = entry.stopReason,
        containerState: String? = entry.containerState,
        captureOutcome: String? = entry.captureOutcome,
        sourceIdentity: ClosedSourceIdentity? = null,
    ): JournalEntry {
        check(phase.ordinal >= entry.phase.ordinal) { "Journal cannot move backwards from ${entry.phase} to $phase" }
        check(entry.phase != FinalizationPhase.FINALIZED) { "Journal is already finalized" }
        check(sourceIdentity == null || phase == FinalizationPhase.FINALIZED) { "Source identity requires FINALIZED" }
        val next = entry.copy(phase = phase, sequence = entry.sequence + 1, stopReason = stopReason,
            containerState = containerState, captureOutcome = captureOutcome)
        write(file, next, sourceIdentity)
        entry = next
        return next
    }

    companion object {
        const val FILE_NAME = "finalization_journal.json"
        const val VERSION = 1

        /** Creates the journal in [sessionDir] in the CAPTURING phase. Failing here must fail Start. */
        fun begin(sessionDir: File, recordingId: String): FinalizationJournal {
            val file = File(sessionDir, FILE_NAME)
            check(!file.exists()) { "A journal already exists in ${sessionDir.name}" }
            val entry = JournalEntry(recordingId, sessionDir.name, FinalizationPhase.CAPTURING, 0, null, null, null)
            write(file, entry)
            return FinalizationJournal(file, entry)
        }

        /** Reads a journal; null when absent, and a failure object when present but unreadable (never "absent"). */
        fun read(sessionDir: File): ReadResult {
            val file = File(sessionDir, FILE_NAME)
            if (!file.exists()) return ReadResult.Absent
            return try {
                val json = JSONObject(file.readText(Charsets.UTF_8))
                require(json.getInt("version") == VERSION) { "Unsupported journal version" }
                ReadResult.Present(JournalEntry(
                    json.getString("recording_id"), json.getString("session_name"),
                    FinalizationPhase.valueOf(json.getString("phase")), json.getLong("sequence"),
                    json.optString("stop_reason").ifEmpty { null }, json.optString("container_state").ifEmpty { null },
                    json.optString("capture_outcome").ifEmpty { null }))
            } catch (error: Exception) {
                ReadResult.Unreadable(error.message ?: error.javaClass.simpleName)
            }
        }

        private fun write(file: File, entry: JournalEntry, sourceIdentity: ClosedSourceIdentity? = null) {
            val fields = mutableMapOf<String, Any?>(
                "version" to VERSION, "recording_id" to entry.recordingId, "session_name" to entry.sessionName,
                "phase" to entry.phase.name, "sequence" to entry.sequence, "stop_reason" to entry.stopReason,
                "container_state" to entry.containerState, "capture_outcome" to entry.captureOutcome,
                "final" to (entry.phase == FinalizationPhase.FINALIZED))
            // Additive private evidence for upload recovery. Legacy phase readers ignore it.
            if (sourceIdentity != null) fields["source_identity"] = sourceIdentity.toJson()
            val body = CaptureProtocol.json(fields)
            AtomicFiles.write(file, body.toByteArray(Charsets.UTF_8))
        }
    }

    sealed class ReadResult {
        object Absent : ReadResult()
        data class Present(val entry: JournalEntry) : ReadResult()
        data class Unreadable(val reason: String) : ReadResult()
    }
}
