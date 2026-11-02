package open.fpvlabs.stera.ar_recorder.data

import open.fpvlabs.stera.ar_recorder.sensors.RawMotionEvent
import open.fpvlabs.stera.ar_recorder.session.DepthFrameData
import open.fpvlabs.stera.ar_recorder.session.PointCloudFrameData
import java.io.File

interface DatasetWriter {
    /** Opt-in for the next session only; null keeps the historical JPEG profile. */
    fun configureH264Capture(setup: open.fpvlabs.stera.ar_recorder.data.h264.H264CaptureSetup?) {
        require(setup == null) { "This dataset writer does not support H.264 MCAP" }
    }
    /** The open contract writer of an initialized H.264 session, else null. Use it only on the writer thread. */
    fun h264Capture(): open.fpvlabs.stera.ar_recorder.data.H264CaptureWriter? = null
    /** Writes Inventory/Close once; later calls are ignored. */
    fun closeH264Capture(outcome: String, failureReason: String?) {}
    fun createSessionDirectory(baseDir: File? = null): File?
    fun pauseWriters()
    fun resumeWriters()
    fun deleteSessionDirectory(): Boolean
    fun initializeWriters(): Boolean
    fun logSystem(message: String)
    fun recordWriteFailure(message: String, throwable: Throwable? = null) { logError(message, throwable) }
    fun getWriteFailure(): String? = null

    /** True only when the finished container's bytes were fsynced to storage. Writers that cannot prove it stay false (never a silent no-op claim). */
    val containerDurable: Boolean get() = false

    /** Session directory sync after the container fsync: true forced, false unsupported by the filesystem, null not attempted. */
    val sessionDirectorySynced: Boolean? get() = null
    fun logError(message: String, throwable: Throwable? = null)
    fun writePoseRow(timestamp: Long, pose: FloatArray, trackingState: String)
    /**
     * Writes independent raw accelerometer/gyroscope events (never paired). Every event is
     * resolved as written, failed or discarded-while-paused so counts stay exact.
     */
    fun writeMotionEvents(events: List<RawMotionEvent>): MotionWriteResult
    /** Canonical recording UUID used by the SA-50 motion messages, once writers are initialized. */
    fun getCaptureRecordingId(): String? = null
    fun writeCaptureFrameInfo(timestampNs: Long, info: Map<String, Any?>)
    fun writeFrameLogRow(
        frameIndex: Int,
        globalArFrameIndex: Int,
        arcoreTimestampNs: Long,
        trackingState: String,
        encoded: Boolean,
        depthAvailable: Boolean,
        pointCloudAvailable: Boolean
    )
    fun writeDeviceMetrics(
        timestampNs: Long,
        batteryLevel: Float,
        batteryState: Int,
        batteryStateStr: String,
        cpuUsage: Float,
        memoryUsedMb: Double,
        memoryAvailableMb: Double,
        thermalState: Int,
        thermalStateStr: String
    )
    fun logTrackingStateTransition(previousState: String, nextState: String, timestampNs: Long)
    fun writePointCloud(timestamp: Long, frameData: PointCloudFrameData?)
    fun writeCompressedRgbFrame(timestamp: Long, jpegData: ByteArray, associationTimestampNs: Long = timestamp)
    fun writeDepthFrame(timestamp: Long, frameData: DepthFrameData?, associationTimestampNs: Long = timestamp): Boolean
    fun writeIntrinsics(timestampNs: Long, intrinsics: Map<String, Any>)
    fun writeDepthIntrinsics(timestampNs: Long, intrinsics: Map<String, Any>)
    fun writeMetadata(metadata: Map<String, Any?>)
    fun writeSessionSummary(summaryText: String)
    fun writeFrameDropLog(dropLog: Map<String, Any?>): String?
    fun addVideoBytesWritten(videoBytes: Long)
    fun getVideoOutputPath(): String?
    fun getSessionDirectory(): String?
    fun getRecordingStats(): Map<String, Any>
    fun getFreeStorageBeforeBytes(): Long
    fun getFreeStorageAfterBytes(): Long
    fun getWriterAverageLatencyMs(): Double
    fun flushRealtimeData(timestampNs: Long)
    fun captureFreeStorageAfterSnapshot()
    fun createSpatialDataZip(): Triple<Boolean, String?, String?>
    fun finalize()
    fun release()
}
