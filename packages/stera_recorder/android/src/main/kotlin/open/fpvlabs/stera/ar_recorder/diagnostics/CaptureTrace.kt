package open.fpvlabs.stera.ar_recorder.diagnostics

import android.os.Build
import android.os.Trace

internal inline fun <T> captureTrace(section: String, block: () -> T): T {
    if (Build.VERSION.SDK_INT < 29 || !Trace.isEnabled()) return block()
    Trace.beginSection(section)
    try {
        return block()
    } finally {
        Trace.endSection()
    }
}

internal fun traceCaptureIdentity(sourceFrameId: Long, cameraTimestampNs: Long) {
    if (Build.VERSION.SDK_INT < 29 || !Trace.isEnabled()) return
    Trace.setCounter("Capture source frame ID", sourceFrameId)
    Trace.setCounter("Capture camera timestamp ns", cameraTimestampNs)
}
