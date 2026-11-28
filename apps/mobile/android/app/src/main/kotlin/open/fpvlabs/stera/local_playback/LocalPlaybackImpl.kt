package open.fpvlabs.stera.local_playback

import android.content.Context
import android.content.pm.ApplicationInfo
import android.media.MediaCodec
import android.media.MediaFormat
import android.media.MediaMuxer
import android.os.SystemClock
import android.util.Log
import open.fpvlabs.stera.ar_recorder.data.h264.AnnexB
import java.io.File
import java.nio.ByteBuffer
import java.util.UUID

/** Remuxes one playback at a time into app cache. Original source files are read-only. */
internal class LocalPlaybackImpl(private val context: Context) : LocalPlayback {
    private class Export(val dir: File) {
        val mp4 = File(dir, "playback.mp4")
        var muxer: MediaMuxer? = null
        var track = -1
        var lastPts = -1L
        var completed = false
        val startedNs = SystemClock.elapsedRealtimeNanos()
        var frames = 0
        var muxerNs = 0L
    }
    private var activeId: String? = null
    private var active: Export? = null

    override fun start(): String {
        check(active == null) { "A recording is already open for playback" }
        val id = UUID.randomUUID().toString()
        val directory = File(context.cacheDir, "recording-playback/$id")
        check(directory.mkdirs()) { "Could not create playback cache" }
        activeId = id
        active = Export(directory)
        return id
    }

    override fun append(id: String, unit: ByteArray, ptsUs: Long, width: Int, height: Int) {
        val export = export(id)
        require(!export.completed && ptsUs >= 0L && ptsUs > export.lastPts)
        require(width in 1..4096 && height in 1..4096)
        val begun = SystemClock.elapsedRealtimeNanos()
        val idr = AnnexB.validateAccessUnit(unit)
        if (export.muxer == null) {
            require(idr && ptsUs == 0L) { "Playback must start on a key frame" }
            val nals = AnnexB.nals(unit)
            val sps = nals.first { AnnexB.type(it) == 7 }
            val pps = nals.first { AnnexB.type(it) == 8 }
            val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height)
            format.setByteBuffer("csd-0", ByteBuffer.wrap(AnnexB.join(listOf(sps))))
            format.setByteBuffer("csd-1", ByteBuffer.wrap(AnnexB.join(listOf(pps))))
            val muxer = MediaMuxer(export.mp4.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
            export.muxer = muxer
            export.track = muxer.addTrack(format)
            muxer.start()
        }
        val info = MediaCodec.BufferInfo().apply {
            set(0, unit.size, ptsUs, if (idr) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0)
        }
        checkNotNull(export.muxer).writeSampleData(export.track, ByteBuffer.wrap(unit), info)
        export.lastPts = ptsUs
        export.frames++
        export.muxerNs += SystemClock.elapsedRealtimeNanos() - begun
    }

    override fun finish(id: String): String {
        val export = export(id)
        val muxer = checkNotNull(export.muxer) { "No video frames in this recording" }
        export.muxer = null
        val begun = SystemClock.elapsedRealtimeNanos()
        try {
            muxer.stop()
        } finally {
            muxer.release()
        }
        export.completed = true
        val finished = SystemClock.elapsedRealtimeNanos()
        if ((context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            Log.i("SA139PlaybackBench", "frames=${export.frames} output_bytes=${export.mp4.length()} " +
                "wall_remux_ms=${(finished - export.startedNs) / 1e6} " +
                "native_remux_ms=${(export.muxerNs + finished - begun) / 1e6}")
        }
        return export.mp4.absolutePath
    }

    override fun discard(id: String) {
        if (id == activeId) dispose()
    }

    override fun dispose() {
        val export = active ?: return
        active = null
        activeId = null
        try {
            export.muxer?.release()
        } finally {
            export.dir.deleteRecursively()
        }
    }

    private fun export(id: String): Export {
        require(id == activeId) { "Playback export has closed" }
        return checkNotNull(active)
    }
}
