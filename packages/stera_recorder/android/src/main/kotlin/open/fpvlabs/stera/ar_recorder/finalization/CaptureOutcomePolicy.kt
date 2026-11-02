package open.fpvlabs.stera.ar_recorder.finalization

import java.io.File
import java.io.RandomAccessFile

/**
 * Separates the physical container from the capture result.
 *
 * - `container_state`: `closed` only when the MCAP writer finished and the file ends with the MCAP closing magic;
 *   otherwise `unclosed`. Malformed-in-the-middle content is not judged here; independent validators do that.
 * - `capture_outcome`: `completed`, `interrupted` (a deliberate reasoned stop such as low storage or critical heat),
 *   `failed`, `aborted` or `unresolved`.
 *
 * The recorder never decides upload admission: [recoveryState] only says whether this device must keep the source
 * quarantined. A closed file is a necessary, not a sufficient, condition for any later admission.
 */
object CaptureOutcomePolicy {
    const val CLOSED = "closed"
    const val UNCLOSED = "unclosed"
    private val MCAP_MAGIC = byteArrayOf(0x89.toByte(), 'M'.code.toByte(), 'C'.code.toByte(), 'A'.code.toByte(),
        'P'.code.toByte(), '0'.code.toByte(), '\r'.code.toByte(), '\n'.code.toByte())

    fun hasClosingMagic(file: File): Boolean {
        if (!file.isFile || file.length() < MCAP_MAGIC.size * 2L) return false
        RandomAccessFile(file, "r").use { raf ->
            val tail = ByteArray(MCAP_MAGIC.size)
            raf.seek(file.length() - tail.size)
            raf.readFully(tail)
            return tail.contentEquals(MCAP_MAGIC)
        }
    }

    fun containerState(finished: Boolean, mcap: File): String =
        if (finished && hasClosingMagic(mcap)) CLOSED else UNCLOSED

    /**
     * @param closeOutcome the value in the MCAP Close record (`completed|failed|aborted`) or null when never written
     * @param interruptionReason the reasoned stop (`low_storage`, `critical_thermal`, ...) or null
     */
    fun captureOutcome(closeOutcome: String?, interruptionReason: String?, unresolvedFrames: Long, writerFailure: String?, captureFailure: String? = null): String = when {
        closeOutcome == null -> "unresolved"
        // captureFailure covers an invalid take with no writer error (for example zero RGB frames written).
        writerFailure != null || captureFailure != null || closeOutcome == "failed" -> "failed"
        unresolvedFrames != 0L -> "unresolved"
        interruptionReason != null -> "interrupted"
        closeOutcome == "completed" -> "completed"
        else -> "aborted"
    }

    /** `none` only for a closed container whose result is completed or a clean interruption; otherwise `quarantined`. */
    fun recoveryState(containerState: String, outcome: String): String =
        if (containerState == CLOSED && (outcome == "completed" || outcome == "interrupted")) "none" else "quarantined"

    /**
     * The journal may reach FINALIZED only when the container and final sidecar are durable AND the capture result is
     * valid; an invalid capture stays quarantined (marker written, journal left at FINALIZING_METADATA).
     */
    fun mayPublishFinalized(durablyFinal: Boolean, captureFailure: String?): Boolean = durablyFinal && captureFailure == null

    /** Close-record outcome and reason for a controlled stop: an interruption is `aborted` with an explicit reason. */
    fun closeFor(interruptionReason: String?, failure: String?): Pair<String, String?> = when {
        failure != null -> "failed" to failure
        interruptionReason != null -> "aborted" to "interrupted:$interruptionReason"
        else -> "completed" to null
    }
}
