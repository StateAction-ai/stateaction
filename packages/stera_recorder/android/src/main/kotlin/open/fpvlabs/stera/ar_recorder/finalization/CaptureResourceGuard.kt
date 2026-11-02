package open.fpvlabs.stera.ar_recorder.finalization

/**
 * Pure low-storage / critical-heat policy. A violation is a reasoned, controlled STOP while enough reserve remains to
 * drain the encoder and close the container. There is no bitrate, resolution or frame-rate reduction and no action
 * that deletes anything; the only outputs are Continue and Stop.
 */
object CaptureResourceGuard {
    /** Free bytes that must remain for EOS drain, MCAP indexes/footer, metadata and the journal. */
    const val FINALIZATION_RESERVE_BYTES = 256L * 1024L * 1024L

    /** Android PowerManager.THERMAL_STATUS_CRITICAL. */
    const val THERMAL_CRITICAL = 4

    sealed class Decision {
        object Continue : Decision()
        data class Stop(val reason: String, val detail: String) : Decision()
    }

    /**
     * @param freeBytes usable bytes on the session volume now
     * @param thermalStatus PowerManager thermal status, or null when the device cannot report one
     */
    fun evaluate(freeBytes: Long, thermalStatus: Int?, reserveBytes: Long = FINALIZATION_RESERVE_BYTES): Decision {
        if (freeBytes <= reserveBytes) {
            return Decision.Stop("low_storage", "free=$freeBytes reserve=$reserveBytes")
        }
        if (thermalStatus != null && thermalStatus >= THERMAL_CRITICAL) {
            return Decision.Stop("critical_thermal", "thermal_status=$thermalStatus")
        }
        return Decision.Continue
    }
}
