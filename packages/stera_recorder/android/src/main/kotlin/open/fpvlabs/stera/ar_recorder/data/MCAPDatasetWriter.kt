package open.fpvlabs.stera.ar_recorder.data

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.SystemClock
import open.fpvlabs.stera.ar_recorder.geometry.CaptureGeometry
import open.fpvlabs.stera.ar_recorder.data.h264.AnnexB
import open.fpvlabs.stera.ar_recorder.data.h264.CaptureProtocol
import open.fpvlabs.stera.ar_recorder.data.h264.H264FrameLedger
import open.fpvlabs.stera.ar_recorder.data.h264.VideoWire
import open.fpvlabs.stera.ar_recorder.sensors.ImuSample
import open.fpvlabs.stera.ar_recorder.session.DepthFrameData
import open.fpvlabs.stera.ar_recorder.session.PointCloudFrameData
import java.io.BufferedWriter
import java.io.File
import java.io.FileWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID
import android.util.AtomicFile
import java.util.concurrent.atomic.AtomicReference

/**
 * MCAP-based dataset writer that writes spatial data as ROS2-compatible MCAP messages.
 * Implements the same DatasetWriter interface as DatasetWriterImpl.
 */
class MCAPDatasetWriter(
    private val context: Context,
    private val deviceModel: String,
    private val androidVersion: String
) : DatasetWriter {

    private companion object {
        private const val LOG_FLUSH_EVERY_N_ROWS = 30
        private const val REALTIME_FLUSH_INTERVAL_NS = 500_000_000L
        private const val TRAJECTORY_WRITE_INTERVAL_NS = 5_000_000_000L
        private const val WORLD_FRAME_ID = "world"
        private const val CAMERA_LINK_FRAME_ID = "camera_link"
        private const val CAMERA_OPTICAL_FRAME_ID = "camera_optical_frame"

        /** Cap the session thumbnail's long edge so it stays ≤1080p (1920×1080 for
         *  16:9). The source RGB frame can be 4K; embedded as base64 in the assets
         *  API payload that overflows the request body limit, so downscale first. */
        private const val THUMBNAIL_MAX_EDGE = 1920
        private val CAMERA_LINK_TO_OPTICAL_TRANSFORM = CDRSerializer.TFTransform(
            frameId = CAMERA_LINK_FRAME_ID,
            childFrameId = CAMERA_OPTICAL_FRAME_ID,
            tx = 0.0,
            ty = 0.0,
            tz = 0.0,
            qx = CaptureGeometry.opticalToCameraQuaternion[0],
            qy = 0.0,
            qz = 0.0,
            qw = 0.0
        )
    }

    private var baseOutputDir: File? = null
    private var sessionDir: File? = null
    private var spatialDataDir: File? = null

    // MCAP writer
    private var mcapWriter: MCAPWriter? = null
    private var mcapFile: File? = null
    private var h264Profile: Map<String, Any?>? = null
    private var h264Clocks: Map<String, Any?> = emptyMap()
    private var h264Ledger: H264FrameLedger? = null
    private val h264Channels = mutableMapOf<String, Int>()
    private val retainedChannelTopics = mutableMapOf<Int, String>()
    private val retainedChannelSequences = mutableMapOf<Int, Int>()
    private var h264VideoSequence = 0
    private var h264ContainerClosed = false
    private var epochAnchorNs = 0L
    private var elapsedAnchorNs = 0L
    private val rawMotionCounts = mutableMapOf("accel" to 0L, "gyro" to 0L)

    @Synchronized override fun configureH264Capture(profile: Map<String, Any?>?, clocks: Map<String, Any?>) {
        check(!isInitialized && mcapWriter == null) { "Capture profile can only change between sessions" }
        h264Profile = profile?.let(CaptureProtocol::profile)
        h264Clocks = clocks.toMap()
    }

    private fun transportNow(): Long = epochAnchorNs + (SystemClock.elapsedRealtimeNanos() - elapsedAnchorNs)

    // Text writers for debugging (kept outside MCAP)
    private var frameLogWriter: BufferedWriter? = null
    private var systemLogWriter: BufferedWriter? = null

    private var isInitialized = false
    private val firstWriteFailure = AtomicReference<String?>(null)

    // Channel IDs
    private var captureGeometryChannelId = 0
    private var poseChannelId = 0
    private var imuChannelId = 0
    private var compressedRgbChannelId = 0
    private var depthChannelId = 0
    private var pointCloudChannelId = 0
    private var meshChannelId = 0
    private var meshCloudChannelId = 0
    private var cameraInfoChannelId = 0
    private var depthCameraInfoChannelId = 0
    private var tfChannelId = 0
    private var trajectoryChannelId = 0
    private var deviceMetricsChannelId = 0

    // Counters
    private var rgbFrameCount = 0
    private var poseCount = 0
    private var imuSampleCount = 0
    private var pointCloudCount = 0
    private var depthFrameCount = 0
    private var frameLogRows = 0
    private var skippedDepthFrames = 0

    private var totalBytesWritten = 0L
    private var freeStorageBeforeBytes = 0L
    private var freeStorageAfterBytes = 0L
    private var writerLatencyTotalNs = 0L
    private var writerLatencySamples = 0L
    private var writersPaused = false
    private var lastRealtimeFlushTimestampNs = 0L
    private var intrinsicsJsonWritten = false
    private var thumbnailSaved = false

    // Accumulated data for end-of-session writes
    private val trajectoryPoses = mutableListOf<PoseEntry>()
    private var lastTrajectoryWriteTimestampNs = 0L
    private var lastPointCloudData: ByteArray? = null
    private var lastPointCloudDataLength = 0
    private var lastPointCloudTimestamp = 0L
    private var lastPointCloudCount = 0

    override fun createSessionDirectory(baseDir: File?): File? {
        return try {
            check(!isInitialized && mcapWriter == null) { "Close the current recording before creating another" }
            baseOutputDir = baseDir ?: File(context.filesDir, "ar_sessions")
            val outputBase = baseOutputDir ?: return null
            if (!outputBase.exists() && !outputBase.mkdirs()) {
                println("Failed to create app storage directory: ${outputBase.absolutePath}")
                return null
            }
            if (!outputBase.canWrite()) {
                println("App storage directory is not writable: ${outputBase.absolutePath}")
                return null
            }

            val timestamp = SimpleDateFormat("yyyyMMdd_HHmmss_SSS", Locale.US).format(Date())
            // Atomic mkdir must succeed; never reopen/truncate an earlier failed recording on fast retry.
            val directory = File(outputBase, "session_${timestamp}_${UUID.randomUUID().toString().take(8)}")
            check(directory.mkdir()) { "Could not create a unique session directory" }
            sessionDir = directory

            freeStorageBeforeBytes = sessionDir?.usableSpace ?: 0L
            println("Session directory created: ${sessionDir?.absolutePath}")
            sessionDir
        } catch (e: Exception) {
            println("Failed to create session directory: ${e.message}")
            null
        }
    }

    override fun pauseWriters() {
        writersPaused = true
        try {
            mcapWriter?.forceFlushChunk()
            frameLogWriter?.flush()
            systemLogWriter?.flush()
        } catch (e: Exception) { recordWriteFailure("Failed to flush paused MCAP writer", e) }
    }

    override fun resumeWriters() {
        writersPaused = false
    }

    override fun deleteSessionDirectory(): Boolean {
        val directory = sessionDir ?: return false
        return try {
            finalize()
            directory.deleteRecursively()
        } catch (e: Exception) {
            println("Failed to delete session directory: ${e.message}")
            false
        } finally {
            baseOutputDir = null
            sessionDir = null
            spatialDataDir = null
            isInitialized = false
        }
    }

    override fun initializeWriters(): Boolean {
        if (isInitialized || mcapWriter != null) return false
        return try {
            val session = sessionDir ?: return false

            check(!isInitialized) { "Cannot initialize an active MCAP recording" }
            resetSessionState()
            elapsedAnchorNs = SystemClock.elapsedRealtimeNanos()
            epochAnchorNs = System.currentTimeMillis() * 1_000_000L
            h264Ledger = h264Profile?.let { H264FrameLedger(it.getValue("recording_id").toString()) }

            // Initialize MCAP writer
            val sessionTimestamp = session.name.removePrefix("session_")
            val file = File(session, "session_data_$sessionTimestamp.mcap")
            mcapFile = file
            val writer = MCAPWriter()
            if (!writer.open(file, profile = if (h264Profile == null) "ros2" else "", library = "stateaction/stera_recorder/1.1")) {
                return false
            }
            mcapWriter = writer

            registerSchemasAndChannels()

            isInitialized = true
            if (h264Profile != null) {
                appendH264Json(CaptureProtocol.PROFILE_TOPIC, h264Profile!!)
                appendH264Json(CaptureProtocol.CLOCKS, h264Clocks + mapOf(
                    "recording_id" to h264Profile!!.getValue("recording_id"),
                    "recorder_transport" to mapOf("clock_id" to "android.elapsed_realtime", "target_clock_id" to "unix",
                        "native_anchor_ns" to elapsedAnchorNs.toString(), "epoch_anchor_ns" to epochAnchorNs.toString(),
                        "method" to "fixed_host_anchor", "revision" to "recorder_transport_v1", "status" to "same_domain",
                        "uncertainty_ns" to null, "synchronization_accuracy" to "unverified")
                ))
            }
            logSystem("MCAP session log initialized")
            logSystem("Device: $deviceModel")
            logSystem("Android: $androidVersion")
            true
        } catch (e: Exception) {
            recordWriteFailure("Failed to initialize MCAP writers", e)
            try { mcapWriter?.finish() } catch (close: Exception) { recordWriteFailure("Failed to close partial MCAP initialization", close) }
            mcapWriter = null
            isInitialized = false
            println("Failed to initialize MCAP writers: ${e.message}")
            e.printStackTrace()
            false
        }
    }

    private fun registerSchemasAndChannels() {
        val writer = mcapWriter ?: return
        val enc = ROS2SchemaDefinitions.SCHEMA_ENCODING
        val msgEnc = ROS2SchemaDefinitions.MESSAGE_ENCODING
        fun cdrSchema(name: String, encoding: String, definition: String): Int = writer.addSchema(name, encoding,
            if (h264Profile == null) definition else ROS2SchemaDefinitions.portableMessageDefinition(definition))
        fun cdrChannel(topic: String, encoding: String, schema: Int): Int {
            val mappedCalibration = topic == ROS2SchemaDefinitions.CAMERA_INFO_TOPIC
            val id = writer.addChannel(topic, encoding, schema, if (h264Profile == null) emptyMap() else mapOf(
                "timestamp_semantics" to if (mappedCalibration) "mapped_capture_epoch" else "native_unmapped",
                "clock_id" to if (mappedCalibration) "unix_mapped_capture" else "legacy.native_unqualified",
                "log_time_semantics" to "recorder_transport_unix", "publish_time_semantics" to "recorder_transport_unix",
                "association" to "use_explicit_capture_evidence", "capture_profile" to h264Profile!!.getValue("rgb_profile").toString(),
                "path_semantics" to if (topic == ROS2SchemaDefinitions.TRAJECTORY_TOPIC) "rolling_last_1024_poses" else "not_applicable"))
            retainedChannelTopics[id] = topic
            retainedChannelSequences[id] = 0
            return id
        }

        val geometrySchemaId = cdrSchema("std_msgs/msg/String", enc, "string data")
        captureGeometryChannelId = cdrChannel("/capture/frame_geometry", msgEnc, geometrySchemaId)

        val poseSchemaId = cdrSchema(
            ROS2SchemaDefinitions.POSE_STAMPED_NAME, enc, ROS2SchemaDefinitions.POSE_STAMPED_SCHEMA
        )
        poseChannelId = cdrChannel(
            ROS2SchemaDefinitions.POSE_TOPIC, msgEnc, poseSchemaId
        )

        val imuSchemaId = cdrSchema(
            ROS2SchemaDefinitions.IMU_NAME, enc, ROS2SchemaDefinitions.IMU_SCHEMA
        )
        imuChannelId = cdrChannel(
            ROS2SchemaDefinitions.IMU_TOPIC, msgEnc, imuSchemaId
        )

        val imageSchemaId = cdrSchema(
            ROS2SchemaDefinitions.IMAGE_NAME, enc, ROS2SchemaDefinitions.IMAGE_SCHEMA
        )
        depthChannelId = cdrChannel(
            ROS2SchemaDefinitions.DEPTH_TOPIC, msgEnc, imageSchemaId
        )

        if (h264Profile == null) {
            val compressedImageSchemaId = cdrSchema(
                ROS2SchemaDefinitions.COMPRESSED_IMAGE_NAME, enc, ROS2SchemaDefinitions.COMPRESSED_IMAGE_SCHEMA
            )
            compressedRgbChannelId = cdrChannel(
                ROS2SchemaDefinitions.COMPRESSED_RGB_TOPIC, msgEnc, compressedImageSchemaId
            )
        } else {
            registerH264Channels(writer)
        }

        val pc2SchemaId = cdrSchema(
            ROS2SchemaDefinitions.POINT_CLOUD_2_NAME, enc, ROS2SchemaDefinitions.POINT_CLOUD_2_SCHEMA
        )
        pointCloudChannelId = cdrChannel(
            ROS2SchemaDefinitions.POINTCLOUD_TOPIC, msgEnc, pc2SchemaId
        )

        val markerSchemaId = cdrSchema(
            ROS2SchemaDefinitions.MARKER_NAME, enc, ROS2SchemaDefinitions.MARKER_SCHEMA
        )
        meshChannelId = cdrChannel(
            ROS2SchemaDefinitions.MESH_TOPIC, msgEnc, markerSchemaId
        )

        // mesh_cloud reuses PointCloud2 schema
        meshCloudChannelId = cdrChannel(
            ROS2SchemaDefinitions.MESH_CLOUD_TOPIC, msgEnc, pc2SchemaId
        )

        val camInfoSchemaId = cdrSchema(
            ROS2SchemaDefinitions.CAMERA_INFO_NAME, enc, ROS2SchemaDefinitions.CAMERA_INFO_SCHEMA
        )
        cameraInfoChannelId = cdrChannel(
            ROS2SchemaDefinitions.CAMERA_INFO_TOPIC, msgEnc, camInfoSchemaId
        )
        depthCameraInfoChannelId = cdrChannel(
            ROS2SchemaDefinitions.DEPTH_CAMERA_INFO_TOPIC, msgEnc, camInfoSchemaId
        )

        val tfSchemaId = cdrSchema(
            ROS2SchemaDefinitions.TF_MESSAGE_NAME, enc, ROS2SchemaDefinitions.TF_MESSAGE_SCHEMA
        )
        tfChannelId = cdrChannel(
            ROS2SchemaDefinitions.TF_TOPIC, msgEnc, tfSchemaId
        )

        val pathSchemaId = cdrSchema(
            ROS2SchemaDefinitions.PATH_NAME, enc, ROS2SchemaDefinitions.PATH_SCHEMA
        )
        trajectoryChannelId = cdrChannel(
            ROS2SchemaDefinitions.TRAJECTORY_TOPIC, msgEnc, pathSchemaId
        )

        val deviceMetricsSchemaId = cdrSchema(
            ROS2SchemaDefinitions.DEVICE_METRICS_NAME, enc, ROS2SchemaDefinitions.DEVICE_METRICS_SCHEMA
        )
        deviceMetricsChannelId = cdrChannel(
            ROS2SchemaDefinitions.DEVICE_METRICS_TOPIC, msgEnc, deviceMetricsSchemaId
        )
    }

    private fun registerH264Channels(writer: MCAPWriter) {
        val descriptor = context.assets.open("stateaction/capture/foxglove-compressed-video.desc").use { it.readBytes() }
        val schema = writer.addSchema("foxglove.CompressedVideo", "protobuf", descriptor)
        h264Channels[CaptureProtocol.VIDEO] = writer.addChannel(CaptureProtocol.VIDEO, "protobuf", schema,
            mapOf("capture_profile" to h264Profile!!.getValue("rgb_profile").toString(), "frame_id" to CAMERA_OPTICAL_FRAME_ID,
                "timestamp_semantics" to "mapped_capture_epoch", "production_qualified" to "false"))
        for ((topic, name) in listOf(CaptureProtocol.PROFILE_TOPIC to "Profile", CaptureProtocol.CLOCKS to "Clocks",
            CaptureProtocol.FRAMES to "FrameEvent", CaptureProtocol.ACCEL to "MotionEvent", CaptureProtocol.GYRO to "MotionEvent",
            CaptureProtocol.SENSORS to "SensorEvent")) {
            val source = context.assets.open("stateaction/capture/$name.schema.json").use { it.readBytes() }
            val id = writer.addSchema("stateaction.capture.$name.v1", "jsonschema", source)
            h264Channels[topic] = writer.addChannel(topic, "json", id)
        }
    }

    private fun appendH264Json(topic: String, value: Map<String, Any?>) {
        val bytes = CaptureProtocol.json(value).toByteArray(Charsets.UTF_8)
        val now = transportNow()
        checkNotNull(mcapWriter).addMessage(h264Channels.getValue(topic), now, now, bytes)
        totalBytesWritten += bytes.size + 31
    }

    @Synchronized override fun writeH264FrameEvent(event: Map<String, Any?>) {
        try {
            check(isInitialized && !writersPaused && getWriteFailure() == null) { "H.264 writer unavailable" }
            val ledger = checkNotNull(h264Ledger) { "H.264 profile not configured" }
            ledger.validateEvent(event)
            appendH264Json(CaptureProtocol.FRAMES, event)
            ledger.acceptEvent(event)
        } catch (e: Exception) { recordWriteFailure("Failed to write H.264 frame evidence", e); throw e }
    }

    @Synchronized override fun writeH264AccessUnit(sourceFrameId: Long, captureTimeNs: Long, encoderPtsUs: Long, annexB: ByteArray): Boolean {
        return try {
            check(isInitialized && !writersPaused && getWriteFailure() == null) { "H.264 writer unavailable" }
            val ledger = checkNotNull(h264Ledger) { "H.264 profile not configured" }
            val idr = AnnexB.validateAccessUnit(annexB)
            val event = ledger.writtenEvent(sourceFrameId, captureTimeNs, encoderPtsUs, h264VideoSequence, idr)
            val bytes = VideoWire.compressedVideo(captureTimeNs, annexB, CAMERA_OPTICAL_FRAME_ID)
            val now = transportNow()
            checkNotNull(mcapWriter).addMessage(h264Channels.getValue(CaptureProtocol.VIDEO), now, now, bytes, h264VideoSequence)
            totalBytesWritten += bytes.size + 31
            appendH264Json(CaptureProtocol.FRAMES, event)
            ledger.acceptWritten(sourceFrameId, encoderPtsUs)
            h264VideoSequence++; rgbFrameCount++
            true
        } catch (e: Exception) { recordWriteFailure("Failed to write H.264 access unit", e); false }
    }

    @Synchronized override fun writeRawMotionEvent(sensor: String, event: Map<String, Any?>) {
        try {
            require(sensor in rawMotionCounts) { "Raw sensor must be accel or gyro" }
            check(isInitialized && !writersPaused && getWriteFailure() == null && h264Ledger != null) { "Raw motion writer unavailable" }
            require(event["recording_id"] == h264Profile!!.getValue("recording_id"))
            val id = CaptureProtocol.decimal(event, "event_id")
            require(id == rawMotionCounts.getValue(sensor)) { "Independent motion event IDs must start at zero and be contiguous" }
            require(CaptureProtocol.decimal(event, "native_timestamp_ns") > 0)
            require(event["native_clock_id"] == "android.elapsed_realtime")
            require(event["unit"] == if (sensor == "accel") "m/s^2" else "rad/s")
            require(listOf("x", "y", "z").all { event[it] is Number }) { "Original motion x/y/z required" }
            require(event["accuracy"] is Number) { "Original motion accuracy required" }
            appendH264Json(if (sensor == "accel") CaptureProtocol.ACCEL else CaptureProtocol.GYRO, mapOf(
                "axes" to "android_device", "includes_gravity" to if (sensor == "accel") true else null) + event)
            rawMotionCounts[sensor] = id + 1
        } catch (e: Exception) { recordWriteFailure("Failed to write independent raw motion", e); throw e }
    }

    @Synchronized override fun getH264CaptureStats(): Map<String, Any> = h264Ledger?.stats()?.plus(mapOf(
        "raw_accel_count" to rawMotionCounts.getValue("accel"), "raw_gyro_count" to rawMotionCounts.getValue("gyro"),
        "container_state" to if (h264ContainerClosed) "closed" else "unclosed", "production_qualified" to false
    )) ?: emptyMap()

    override fun logSystem(message: String) {
        if (!isInitialized || writersPaused) return
        val timestamp = SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US).format(Date())
        val line = "[$timestamp] $message\n"
        try {
            systemLogWriter?.write(line)
            totalBytesWritten += line.toByteArray().size.toLong()
        } catch (_: Exception) {}
    }

    override fun logError(message: String, throwable: Throwable?) {
        val suffix = throwable?.message?.let { ": $it" } ?: ""
        logSystem("ERROR: $message$suffix")
    }

    override fun recordWriteFailure(message: String, throwable: Throwable?) {
        val detail = throwable?.let { ": ${it.javaClass.simpleName}: ${it.message}" } ?: ""
        firstWriteFailure.compareAndSet(null, message + detail)
        android.util.Log.e("SteraCapture", message, throwable)
        logError(message, throwable)
    }

    override fun getWriteFailure(): String? = firstWriteFailure.get()

    @Synchronized private fun appendRetainedMessage(channelId: Int, nativeLogNs: Long, nativePublishNs: Long, data: ByteArray) {
        val writer = checkNotNull(mcapWriter) { "Retained sensor writer unavailable" }
        if (h264Profile == null) writer.addMessage(channelId, nativeLogNs, nativePublishNs, data)
        else {
            val now = transportNow()
            val sequence = retainedChannelSequences.getValue(channelId)
            val topic = retainedChannelTopics.getValue(channelId)
            val rgbFrame = if (channelId == cameraInfoChannelId) h264Ledger?.frameAtMappedTime(nativePublishNs) else null
            if (channelId == cameraInfoChannelId) require(rgbFrame != null) { "RGB calibration requires exact acquired frame association" }
            writer.addMessage(channelId, now, now, data, sequence)
            retainedChannelSequences[channelId] = sequence + 1
            appendH264Json(CaptureProtocol.SENSORS, mapOf(
                "recording_id" to h264Profile!!.getValue("recording_id"), "stream_id" to topic,
                "event_id" to sequence.toUInt().toString(),
                "native_timestamp_ns" to (rgbFrame?.get("native_timestamp_ns") ?: nativePublishNs.toString()),
                "native_clock_id" to (rgbFrame?.get("native_clock_id") ?: "legacy.native_unqualified"),
                "mapped_capture_time_ns" to rgbFrame?.get("mapped_capture_time_ns"),
                "output_channel" to topic, "output_sequence" to sequence,
                "source_kind" to if (channelId == cameraInfoChannelId) "arcore_image_intrinsics" else "retained_arcore_cdr",
                "calibration_id" to rgbFrame?.get("calibration_id"),
                "association_source_frame_id" to rgbFrame?.get("source_frame_id"),
                "clock_mapping_revision" to rgbFrame?.get("clock_mapping_revision"),
                "association_status" to if (rgbFrame == null) "unknown" else "same_acquired_frame", "native_association_timestamp_ns" to nativeLogNs.toString()
            ))
        }
    }

    override fun writeDeviceMetrics(
        timestampNs: Long,
        batteryLevel: Float,
        batteryState: Int,
        batteryStateStr: String,
        cpuUsage: Float,
        memoryUsedMb: Double,
        memoryAvailableMb: Double,
        thermalState: Int,
        thermalStateStr: String
    ) {
        if (!isInitialized || writersPaused) return
        val logTime = timestampNs
        val data = CDRSerializer.serializeDeviceMetrics(
            timestampNs = timestampNs,
            frameId = "device",
            batteryLevel = batteryLevel,
            batteryState = batteryState,
            batteryStateStr = batteryStateStr,
            cpuUsage = cpuUsage,
            memoryUsedMb = memoryUsedMb,
            memoryAvailableMb = memoryAvailableMb,
            thermalState = thermalState,
            thermalStateStr = thermalStateStr,
            deviceModel = deviceModel
        )
        appendRetainedMessage(deviceMetricsChannelId, logTime, logTime, data)
        totalBytesWritten += data.size.toLong() + 22
    }

    override fun writePoseRow(timestamp: Long, pose: FloatArray, trackingState: String) {
        if (!isInitialized || writersPaused) return
        val startNs = SystemClock.elapsedRealtimeNanos()
        try {
            val data = CDRSerializer.serializePoseStamped(
                timestampNs = timestamp,
                frameId = WORLD_FRAME_ID,
                tx = pose[0], ty = pose[1], tz = pose[2],
                qx = pose[3], qy = pose[4], qz = pose[5], qw = pose[6]
            )
            appendRetainedMessage(poseChannelId, timestamp, timestamp, data)
            poseCount++
            totalBytesWritten += data.size + 22

            // Write per-frame TF (world -> camera_link -> camera_optical_frame)
            val tfData = CDRSerializer.serializeTFMessage(
                timestampNs = timestamp,
                transforms = listOf(
                    CDRSerializer.TFTransform(
                        frameId = WORLD_FRAME_ID,
                        childFrameId = CAMERA_LINK_FRAME_ID,
                        tx = pose[0].toDouble(),
                        ty = pose[1].toDouble(),
                        tz = pose[2].toDouble(),
                        qx = pose[3].toDouble(),
                        qy = pose[4].toDouble(),
                        qz = pose[5].toDouble(),
                        qw = pose[6].toDouble()
                    ),
                    CAMERA_LINK_TO_OPTICAL_TRANSFORM
                )
            )
            appendRetainedMessage(tfChannelId, timestamp, timestamp, tfData)
            totalBytesWritten += tfData.size + 22

            // Match iOS by emitting rolling Path snapshots during recording.
            trajectoryPoses.add(PoseEntry(timestamp, pose[0], pose[1], pose[2], pose[3], pose[4], pose[5], pose[6]))
            // Full poses remain on /pose. The derived convenience Path is a bounded rolling window.
            if (h264Profile != null && trajectoryPoses.size > 1024) trajectoryPoses.removeAt(0)
            maybeWriteTrajectorySnapshot(timestamp)
        } catch (e: Exception) {
            recordWriteFailure("Failed to write pose", e)
        } finally {
            recordWriterLatency(startNs)
        }
    }

    override fun writeImuSamples(samples: List<ImuSample>) {
        if (!isInitialized || writersPaused || samples.isEmpty()) return
        val startNs = SystemClock.elapsedRealtimeNanos()
        try {
            for (sample in samples) {
                val data = CDRSerializer.serializeImu(
                    timestampNs = sample.timestampNs,
                    frameId = "device",
                    angularVelocity = Triple(
                        sample.gyroX.toDouble(), sample.gyroY.toDouble(), sample.gyroZ.toDouble()
                    ),
                    linearAcceleration = Triple(
                        sample.accelX.toDouble(), sample.accelY.toDouble(), sample.accelZ.toDouble()
                    )
                )
                appendRetainedMessage(imuChannelId, sample.timestampNs, sample.timestampNs, data)
                imuSampleCount++
                totalBytesWritten += data.size + 22
            }
        } catch (e: Exception) {
            recordWriteFailure("Failed to write IMU samples", e)
        } finally {
            recordWriterLatency(startNs)
        }
    }

    /**
     * Downscale a full-size JPEG frame to a ≤1080p thumbnail (long edge capped at
     * [THUMBNAIL_MAX_EDGE]) so it stays small on disk and when base64-embedded in
     * the assets-registration payload. Returns the original bytes unchanged if
     * decoding fails or the re-encoded result is not smaller than the source.
     */
    private fun makeThumbnailJpeg(jpegData: ByteArray): ByteArray {
        return try {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(jpegData, 0, jpegData.size, bounds)
            val longEdge = maxOf(bounds.outWidth, bounds.outHeight)
            if (longEdge <= 0) return jpegData

            // Coarse power-of-two downsample keeps peak decode memory low.
            var sample = 1
            while (longEdge / (sample * 2) >= THUMBNAIL_MAX_EDGE) sample *= 2
            val decodeOpts = BitmapFactory.Options().apply { inSampleSize = sample }
            val decoded = BitmapFactory.decodeByteArray(jpegData, 0, jpegData.size, decodeOpts)
                ?: return jpegData

            // Fine scale so the long edge lands exactly at the cap (never upscale).
            val decodedLong = maxOf(decoded.width, decoded.height)
            val scaled = if (decodedLong > THUMBNAIL_MAX_EDGE) {
                val ratio = THUMBNAIL_MAX_EDGE.toFloat() / decodedLong
                Bitmap.createScaledBitmap(
                    decoded,
                    (decoded.width * ratio).toInt().coerceAtLeast(1),
                    (decoded.height * ratio).toInt().coerceAtLeast(1),
                    true,
                )
            } else {
                decoded
            }

            val out = java.io.ByteArrayOutputStream()
            scaled.compress(Bitmap.CompressFormat.JPEG, 80, out)
            if (scaled !== decoded) scaled.recycle()
            decoded.recycle()

            val result = out.toByteArray()
            if (result.size < jpegData.size) result else jpegData
        } catch (e: Exception) {
            println("Failed to downscale thumbnail: ${e.message}")
            jpegData
        }
    }

    override fun writeCompressedRgbFrame(timestamp: Long, jpegData: ByteArray, associationTimestampNs: Long) {
        if (h264Profile != null) {
            recordWriteFailure("JPEG cannot be written to an H.264 recording")
            return
        }
        if (!isInitialized || writersPaused) return
        // Save first JPEG frame as thumbnail
        if (!thumbnailSaved) {
            try {
                sessionDir?.let { dir ->
                    File(dir, "thumbnail.jpg").writeBytes(makeThumbnailJpeg(jpegData))
                    thumbnailSaved = true
                    println("thumbnail.jpg saved in ${dir.absolutePath}")
                }
            } catch (e: Exception) {
                println("Failed to save thumbnail: ${e.message}")
            }
        }
        val startNs = SystemClock.elapsedRealtimeNanos()
        try {
            val data = CDRSerializer.serializeCompressedImage(
                timestampNs = timestamp,
                frameId = CAMERA_OPTICAL_FRAME_ID,
                format = "jpeg",
                imageData = jpegData
            )
            checkNotNull(mcapWriter) { "RGB writer unavailable" }.addMessage(compressedRgbChannelId, associationTimestampNs, timestamp, data)
            rgbFrameCount++
            totalBytesWritten += data.size + 22
        } catch (e: Exception) {
            recordWriteFailure("Failed to write compressed RGB frame", e)
        } finally {
            recordWriterLatency(startNs)
        }
    }

    override fun writeCaptureFrameInfo(timestampNs: Long, info: Map<String, Any?>) {
        if (!isInitialized || writersPaused) return
        try {
            val data = CDRSerializer.serializeString(toJsonValue(info, 0))
            appendRetainedMessage(captureGeometryChannelId, timestampNs, timestampNs, data)
            totalBytesWritten += data.size + 22
        } catch (e: Exception) {
            recordWriteFailure("Failed to write frame geometry", e)
        }
    }

    override fun writeFrameLogRow(
        frameIndex: Int,
        globalArFrameIndex: Int,
        arcoreTimestampNs: Long,
        trackingState: String,
        encoded: Boolean,
        depthAvailable: Boolean,
        pointCloudAvailable: Boolean
    ) {
        if (!isInitialized || writersPaused) return
        val startNs = SystemClock.elapsedRealtimeNanos()
        try {
            val line = "$frameIndex,$globalArFrameIndex,$arcoreTimestampNs,$trackingState,${if (encoded) 1 else 0},${if (depthAvailable) 1 else 0},${if (pointCloudAvailable) 1 else 0}\n"
            frameLogWriter?.write(line)
            frameLogRows++
            totalBytesWritten += line.toByteArray().size.toLong()
            if (frameLogRows % LOG_FLUSH_EVERY_N_ROWS == 0) {
                frameLogWriter?.flush()
                systemLogWriter?.flush()
            }
        } catch (_: Exception) {
        } finally {
            recordWriterLatency(startNs)
        }
    }

    override fun logTrackingStateTransition(previousState: String, nextState: String, timestampNs: Long) {
        logSystem("Tracking state transition: $previousState -> $nextState at $timestampNs ns")
    }

    override fun writePointCloud(timestamp: Long, frameData: PointCloudFrameData?) {
        if (frameData == null) return
        if (!isInitialized || writersPaused) {
            frameData.release()
            return
        }
        val startNs = SystemClock.elapsedRealtimeNanos()
        try {
            // Binary format: [int64 timestamp][int32 pointCount][point data...]
            val headerSize = 12
            if (frameData.validSize <= headerSize) return

            val pointData = frameData.bytes.copyOfRange(headerSize, frameData.validSize)
            val data = CDRSerializer.serializePointCloud2(
                timestampNs = timestamp,
                frameId = WORLD_FRAME_ID,
                pointCount = frameData.pointCount,
                pointData = pointData,
                pointDataOffset = 0,
                pointDataLength = pointData.size
            )
            appendRetainedMessage(pointCloudChannelId, timestamp, timestamp, data)
            totalBytesWritten += data.size + 22

            // Keep latest snapshot for compatibility stats/introspection
            lastPointCloudData = pointData
            lastPointCloudDataLength = pointData.size
            lastPointCloudTimestamp = timestamp
            lastPointCloudCount = frameData.pointCount
            pointCloudCount++

            if (frameData.pointCount <= 0) {
                logSystem("WARN: point cloud frame $timestamp has no points")
            }
        } catch (e: Exception) {
            recordWriteFailure("Failed to write point cloud", e)
        } finally {
            recordWriterLatency(startNs)
            frameData.release()
        }
    }

    override fun writeDepthFrame(timestamp: Long, frameData: DepthFrameData?, associationTimestampNs: Long): Boolean {
        if (frameData == null) return false
        if (!isInitialized || writersPaused) {
            frameData.release()
            return false
        }
        val startNs = SystemClock.elapsedRealtimeNanos()
        val expectedSize = frameData.width * frameData.height * frameData.bytesPerPixel
        if (frameData.validSize != expectedSize) {
            skippedDepthFrames++
            logSystem("WARN: skipping depth frame $timestamp, invalid size ${frameData.validSize}, expected $expectedSize")
            frameData.release()
            return false
        }

        return try {
            require(timestamp == frameData.timestampNs) { "Depth timestamps must retain Image.timestamp" }
            val data = CDRSerializer.serializeImage(
                timestampNs = timestamp,
                frameId = CAMERA_OPTICAL_FRAME_ID,
                height = frameData.height,
                width = frameData.width,
                encoding = "16UC1",
                isBigEndian = false,
                step = frameData.width * frameData.bytesPerPixel,
                imageData = frameData.bytes,
                imageDataLength = frameData.validSize
            )
            // logTime identifies the acquisition frame, publishTime/header retain native sensor time.
            appendRetainedMessage(depthChannelId, associationTimestampNs, timestamp, data)
            depthFrameCount++
            totalBytesWritten += data.size + 22
            true
        } catch (e: Exception) {
            recordWriteFailure("Failed to write depth frame", e)
            false
        } finally {
            recordWriterLatency(startNs)
            frameData.release()
        }
    }

    override fun writeIntrinsics(timestampNs: Long, intrinsics: Map<String, Any>) {
        if (!isInitialized) return

        try {
            val fx = (intrinsics["focalLengthX"] as? Number)?.toDouble() ?: 0.0
            val fy = (intrinsics["focalLengthY"] as? Number)?.toDouble() ?: 0.0
            val cx = (intrinsics["principalPointX"] as? Number)?.toDouble() ?: 0.0
            val cy = (intrinsics["principalPointY"] as? Number)?.toDouble() ?: 0.0
            val w = (intrinsics["imageWidth"] as? Number)?.toInt() ?: 0
            val h = (intrinsics["imageHeight"] as? Number)?.toInt() ?: 0

            val data = CDRSerializer.serializeCameraInfo(
                timestampNs = timestampNs,
                frameId = CAMERA_OPTICAL_FRAME_ID,
                height = h,
                width = w,
                fx = fx, fy = fy, cx = cx, cy = cy
            )
            appendRetainedMessage(cameraInfoChannelId, timestampNs, timestampNs, data)
            totalBytesWritten += data.size + 22

            intrinsicsJsonWritten = true
        } catch (e: Exception) {
            recordWriteFailure("Failed to write intrinsics", e)
        }
    }

    override fun writeDepthIntrinsics(timestampNs: Long, intrinsics: Map<String, Any>) {
        if (!isInitialized) return

        try {
            val fx = (intrinsics["focalLengthX"] as? Number)?.toDouble() ?: 0.0
            val fy = (intrinsics["focalLengthY"] as? Number)?.toDouble() ?: 0.0
            val cx = (intrinsics["principalPointX"] as? Number)?.toDouble() ?: 0.0
            val cy = (intrinsics["principalPointY"] as? Number)?.toDouble() ?: 0.0
            val w = (intrinsics["imageWidth"] as? Number)?.toInt() ?: 0
            val h = (intrinsics["imageHeight"] as? Number)?.toInt() ?: 0

            val data = CDRSerializer.serializeCameraInfo(
                timestampNs = timestampNs,
                frameId = CAMERA_OPTICAL_FRAME_ID,
                height = h,
                width = w,
                fx = fx, fy = fy, cx = cx, cy = cy
            )
            appendRetainedMessage(depthCameraInfoChannelId, timestampNs, timestampNs, data)
            totalBytesWritten += data.size + 22
        } catch (e: Exception) {
            recordWriteFailure("Failed to write depth intrinsics", e)
        }
    }

    override fun writeMetadata(metadata: Map<String, Any?>) {
        // A broken MCAP stream must not prevent correcting the independent status sidecar.
        val session = sessionDir ?: return
        try {
            val flat = mutableMapOf<String, String>()
            flattenMetadata(metadata, "", flat)
            mcapWriter?.addMetadata("session_metadata", flat)
        } catch (e: Exception) {
            recordWriteFailure("Failed to write MCAP metadata", e)
        }
        try {
            val persisted = metadata.toMutableMap()
            getWriteFailure()?.let {
                persisted["capture_result_valid"] = false
                persisted["first_writer_error"] = it
                persisted["finalization_complete"] = false
            }
            val json = toJsonValue(persisted, 0)
            if (h264Profile == null) File(session, "metadata.json").writeText(json)
            else {
                val file = AtomicFile(File(session, "metadata.json"))
                val stream = file.startWrite()
                try { stream.write(json.toByteArray(Charsets.UTF_8)); file.finishWrite(stream) }
                catch (error: Exception) { file.failWrite(stream); throw error }
            }
            totalBytesWritten += json.toByteArray().size.toLong()
            logSystem("metadata.json written")
        } catch (e: Exception) {
            recordWriteFailure("Failed to write metadata sidecar", e)
        }
    }

    override fun writeSessionSummary(summaryText: String) {
        if (!isInitialized) return
        try {
            val dataDir = spatialDataDir ?: return
            File(dataDir, "session_summary.txt").writeText(summaryText)
            totalBytesWritten += summaryText.toByteArray().size.toLong()
            logSystem("session_summary.txt written")
        } catch (e: Exception) {
            recordWriteFailure("Failed to write session summary", e)
        }
    }

    override fun writeFrameDropLog(dropLog: Map<String, Any?>): String? {
        if (!isInitialized) return null
        return try {
            val dataDir = spatialDataDir ?: return null
            val file = File(dataDir, "frame_drop_log.json")
            file.writeText(toJsonValue(dropLog, 0))
            totalBytesWritten += file.length()
            logSystem("frame_drop_log.json written")
            file.name
        } catch (e: Exception) {
            recordWriteFailure("Failed to write frame_drop_log.json", e)
            null
        }
    }

    override fun addVideoBytesWritten(videoBytes: Long) {
        if (videoBytes > 0) totalBytesWritten += videoBytes
    }

    override fun getVideoOutputPath(): String? = null

    override fun getSessionDirectory(): String? = sessionDir?.absolutePath

    @Synchronized override fun getRecordingStats(): Map<String, Any> = mapOf(
        "rgbFrameCount" to rgbFrameCount,
        "poseCount" to poseCount,
        "imuSampleCount" to if (h264Profile == null) imuSampleCount else Math.toIntExact(
            Math.addExact(rawMotionCounts.getValue("accel"), rawMotionCounts.getValue("gyro"))),
        "imuSampleCountSemantics" to if (h264Profile == null) "legacy_paired_samples" else "independent_accel_plus_gyro_events",
        "legacyPairedImuSampleCount" to imuSampleCount,
        "pointCloudCount" to pointCloudCount,
        "depthFrameCount" to depthFrameCount,
        "skippedDepthFrames" to skippedDepthFrames,
        "totalBytesWritten" to totalBytesWritten
    ) + getH264CaptureStats()

    override fun getFreeStorageBeforeBytes(): Long = freeStorageBeforeBytes
    override fun getFreeStorageAfterBytes(): Long = freeStorageAfterBytes

    override fun getWriterAverageLatencyMs(): Double {
        if (writerLatencySamples <= 0L) return 0.0
        return (writerLatencyTotalNs.toDouble() / writerLatencySamples.toDouble()) / 1_000_000.0
    }

    override fun flushRealtimeData(timestampNs: Long) {
        if (!isInitialized || writersPaused) return
        if (timestampNs - lastRealtimeFlushTimestampNs < REALTIME_FLUSH_INTERVAL_NS) return
        lastRealtimeFlushTimestampNs = timestampNs
        try {
            mcapWriter?.forceFlushChunk()
            frameLogWriter?.flush()
            systemLogWriter?.flush()
        } catch (e: Exception) {
            recordWriteFailure("Failed to flush MCAP data", e)
        }
    }

    override fun captureFreeStorageAfterSnapshot() {
        freeStorageAfterBytes = sessionDir?.usableSpace ?: 0L
    }

    override fun createSpatialDataZip(): Triple<Boolean, String?, String?> {
        val session = sessionDir ?: return Triple(false, null, "sessionDir is null")
        val file = mcapFile ?: return Triple(false, null, "mcapFile is null")

        return try {
            // Flush text writers
            frameLogWriter?.flush(); frameLogWriter?.close(); frameLogWriter = null
            systemLogWriter?.flush(); systemLogWriter?.close(); systemLogWriter = null

            // Write end-of-session messages
            writeEndOfSessionMessages()
            reconcileH264()

            // Finalize MCAP
            mcapWriter?.finish()
            mcapWriter = null
            h264ContainerClosed = h264Profile != null

            if (!file.exists() || file.length() == 0L) {
                return Triple(false, null, "session_data.mcap is empty or missing")
            }

            getWriteFailure()?.let { return Triple(false, session.absolutePath, it) }
            println("session finalized at ${session.absolutePath}")
            Triple(true, session.absolutePath, null)
        } catch (e: Exception) {
            recordWriteFailure("Failed to finalize session", e)
            println("Failed to finalize session: ${e.message}")
            e.printStackTrace()
            Triple(false, null, e.message)
        }
    }

    override fun finalize() {
        try {
            frameLogWriter?.flush(); frameLogWriter?.close(); frameLogWriter = null
            systemLogWriter?.flush(); systemLogWriter?.close(); systemLogWriter = null
            writeEndOfSessionMessages()
            reconcileH264()
            mcapWriter?.finish(); mcapWriter = null
            h264ContainerClosed = h264Profile != null
            freeStorageAfterBytes = sessionDir?.usableSpace ?: 0L
            isInitialized = false
            println("MCAP dataset writers finalized")
        } catch (e: Exception) {
            recordWriteFailure("Failed to finalize MCAP writers", e)
            println("Failed to finalize MCAP writers: ${e.message}")
        } finally {
            // Even a partial initialize/failed sidecar flush must release the MCAP file and permit retry.
            try { mcapWriter?.finish(); if (mcapWriter != null) h264ContainerClosed = h264Profile != null }
            catch (close: Exception) { recordWriteFailure("Failed to close MCAP on finalization cleanup", close) }
            mcapWriter = null
            isInitialized = false
            freeStorageAfterBytes = sessionDir?.usableSpace ?: 0L
        }
    }

    override fun release() {
        finalize()
        baseOutputDir = null
        sessionDir = null
        spatialDataDir = null
        resetSessionState()
        freeStorageBeforeBytes = 0L
        mcapWriter = null
        mcapFile = null
        println("MCAP dataset writer released")
    }

    /** Session-local state must not survive ordinary stop/start on this writer. */
    private fun resetSessionState() {
        firstWriteFailure.set(null)
        rgbFrameCount = 0
        poseCount = 0
        imuSampleCount = 0
        pointCloudCount = 0
        depthFrameCount = 0
        frameLogRows = 0
        skippedDepthFrames = 0
        totalBytesWritten = 0L
        freeStorageAfterBytes = 0L
        writerLatencyTotalNs = 0L
        writerLatencySamples = 0L
        writersPaused = false
        intrinsicsJsonWritten = false
        thumbnailSaved = false
        lastRealtimeFlushTimestampNs = 0L
        trajectoryPoses.clear()
        lastTrajectoryWriteTimestampNs = 0L
        lastPointCloudData = null
        lastPointCloudDataLength = 0
        lastPointCloudTimestamp = 0L
        lastPointCloudCount = 0
        h264Ledger = null
        h264VideoSequence = 0
        h264ContainerClosed = false
        h264Channels.clear()
        retainedChannelTopics.clear()
        retainedChannelSequences.clear()
        rawMotionCounts["accel"] = 0
        rawMotionCounts["gyro"] = 0
    }

    private fun reconcileH264() {
        val ledger = h264Ledger ?: return
        val writer = mcapWriter ?: return
        if (ledger.unresolvedIds().isNotEmpty()) recordWriteFailure("Unresolved H.264 source frame IDs: ${ledger.unresolvedIds()}")
        if (ledger.written == 0L) recordWriteFailure("H.264 recording has no written RGB frames")
        writer.addMetadata("stateaction_capture_integrity", getH264CaptureStats().mapValues { it.value.toString() })
    }

    private fun writeEndOfSessionMessages() {
        val lastTimestamp = trajectoryPoses.lastOrNull()?.timestampNs ?: return

        // Always write one final snapshot so stop captures the latest pose list.
        writeTrajectorySnapshot(lastTimestamp)

        // Note: Mesh and mesh_cloud channels are registered but may be empty on Android
        // if ARCore doesn't provide mesh data for this session
    }

    private fun maybeWriteTrajectorySnapshot(timestamp: Long) {
        if (trajectoryPoses.isEmpty()) return
        if (timestamp - lastTrajectoryWriteTimestampNs < TRAJECTORY_WRITE_INTERVAL_NS) return

        lastTrajectoryWriteTimestampNs = timestamp
        writeTrajectorySnapshot(timestamp)
    }

    private fun writeTrajectorySnapshot(timestamp: Long) {
        val writer = mcapWriter ?: return
        if (trajectoryPoses.isEmpty()) return

        val data = CDRSerializer.serializePath(
            timestampNs = timestamp,
            frameId = WORLD_FRAME_ID,
            poses = trajectoryPoses
        )
        appendRetainedMessage(trajectoryChannelId, timestamp, timestamp, data)
        totalBytesWritten += data.size + 22
    }

    private fun recordWriterLatency(startNs: Long) {
        val elapsedNs = SystemClock.elapsedRealtimeNanos() - startNs
        if (elapsedNs > 0L) {
            writerLatencyTotalNs += elapsedNs
            writerLatencySamples++
        }
    }

    private fun flattenMetadata(map: Map<String, Any?>, prefix: String, result: MutableMap<String, String>) {
        for ((key, value) in map) {
            val fullKey = if (prefix.isEmpty()) key else "$prefix.$key"
            when (value) {
                is Map<*, *> -> {
                    @Suppress("UNCHECKED_CAST")
                    flattenMetadata(value as Map<String, Any?>, fullKey, result)
                }
                null -> result[fullKey] = "null"
                else -> result[fullKey] = value.toString()
            }
        }
    }

    private fun toJsonValue(value: Any?, level: Int): String {
        return when (value) {
            null -> "null"
            is String -> "\"${escapeJson(value)}\""
            is Number, is Boolean -> value.toString()
            is Map<*, *> -> {
                if (value.isEmpty()) return "{}"
                val indent = "  ".repeat(level)
                val childIndent = "  ".repeat(level + 1)
                val entries = value.entries.joinToString(",\n") { entry ->
                    val key = entry.key?.toString() ?: "null"
                    "$childIndent\"${escapeJson(key)}\": ${toJsonValue(entry.value, level + 1)}"
                }
                "{\n$entries\n$indent}"
            }
            is List<*> -> {
                if (value.isEmpty()) return "[]"
                val indent = "  ".repeat(level)
                val childIndent = "  ".repeat(level + 1)
                val entries = value.joinToString(",\n") { "$childIndent${toJsonValue(it, level + 1)}" }
                "[\n$entries\n$indent]"
            }
            else -> "\"${escapeJson(value.toString())}\""
        }
    }

    private fun escapeJson(raw: String): String = raw
        .replace("\\", "\\\\")
        .replace("\"", "\\\"")
        .replace("\n", "\\n")
        .replace("\r", "\\r")
        .replace("\t", "\\t")
}
