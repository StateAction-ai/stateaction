package open.fpvlabs.stera.framing

import android.os.SystemClock
import android.util.Size

/** Debug-only timing report. Preview measurements count Camera2 completions. */
internal class FramingMetrics(private val preview: Size, private val analysis: Size?) {
    private val openedAt = SystemClock.elapsedRealtimeNanos()
    private var firstPreview = 0L
    private var lastPreview = 0L
    private var previewFrames = 0
    private var copies = 0
    private var copyNs = 0L
    var analysisDropped = 0
    var copyFailures = 0
    private var analysisFailures = 0
    private var lastAnalysisError: String? = null
    private var analysed = 0
    private var analysisNs = 0L
    private var analysisMaxNs = 0L

    fun previewFrame(now: Long) {
        if (previewFrames == 0) firstPreview = now
        lastPreview = now
        previewFrames++
    }

    fun analysisCopied(ns: Long) {
        copies++
        copyNs += ns
    }

    @Synchronized
    fun analysisFinished(ns: Long, error: String?) {
        analysed++
        if (error != null) {
            analysisFailures++
            lastAnalysisError = error
        }
        analysisNs += ns
        analysisMaxNs = maxOf(analysisMaxNs, ns)
    }

    @Synchronized
    fun report(): String {
        val fps = if (lastPreview > firstPreview) (previewFrames - 1) * 1e9 / (lastPreview - firstPreview) else 0.0
        val firstMs = if (firstPreview > 0) (firstPreview - openedAt) / 1e6 else null
        val copyMs = if (copies > 0) copyNs / 1e6 / copies else 0.0
        val analysisMs = if (analysed > 0) analysisNs / 1e6 / analysed else 0.0
        return "preview=$preview analysis=$analysis first_preview_ms=$firstMs preview_capture_frames=$previewFrames " +
            "preview_capture_fps=$fps analysis_completed=${analysed - analysisFailures} analysis_skipped=$analysisDropped " +
            "copy_failures=$copyFailures analysis_failures=$analysisFailures analysis_error=$lastAnalysisError " +
            "mean_copy_ms=$copyMs mean_analysis_ms=$analysisMs max_analysis_ms=${analysisMaxNs / 1e6}"
    }
}
