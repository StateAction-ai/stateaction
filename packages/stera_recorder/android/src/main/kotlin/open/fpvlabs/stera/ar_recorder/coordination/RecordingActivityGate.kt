package open.fpvlabs.stera.ar_recorder.coordination

/** Stops frame producers before the writer queue is drained or finalized. */
class RecordingActivityGate {
    private val monitor = Any()
    @Volatile private var enabled = false

    fun get(): Boolean = enabled
    fun set(value: Boolean) = synchronized(monitor) { enabled = value }
    fun withActiveRecording(action: () -> Unit) = synchronized(monitor) {
        if (enabled) action()
    }
    fun withProducerPaused(action: () -> Unit) = synchronized(monitor) { action() }
}
