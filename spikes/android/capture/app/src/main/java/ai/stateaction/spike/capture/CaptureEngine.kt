package ai.stateaction.spike.capture

import android.content.Context
import android.hardware.*
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.Image
import android.os.*
import com.google.ar.core.*
import com.google.ar.core.exceptions.NotYetAvailableException
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.EnumSet
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

/** Isolated feasibility harness. Foreground only; not a production recorder or uploader. */
class CaptureEngine(private val context: Context, private val durationSeconds: Int, private val status: (String)->Unit, private val done: ()->Unit) {
    private data class Acquisition(val epochNs: Long, val evidence: JSONObject)
    private val worker=HandlerThread("stateaction-spike-camera").apply { start() }
    private val handler=Handler(worker.looper)
    private val imuThread=HandlerThread("stateaction-spike-imu").apply { start() }
    private val imuHandler=Handler(imuThread.looper)
    private val stopping=AtomicBoolean(false)
    @Volatile private var reason="user_stop"
    @Volatile private var failure: String?=null
    private var session: Session?=null
    private var gl: CaptureGl?=null
    private var encoder: HardwareAvc?=null
    private var sink: CaptureSink?=null
    private val clock=CaptureClock()
    private val id=UUID.randomUUID().toString()
    private val dir=File(context.getExternalFilesDir(null),"sessions/$id")
    private val pending=linkedMapOf<Long,Acquisition>()
    private val pts=FramePts()
    private var firstNativeNs: Long?=null
    private val cameraTimestampGate=CameraTimestampGate()
    private var timestampUnavailableUpdates=0L
    private var lastRawDepthNs=-1L
    private var acquired=0L; private var submitted=0L; private var dropped=0L
    private var highestPending=0
    private var maxPssKb=0L
    private var maxThermal=0
    private var depthEnabled=false
    private var cameraId=""
    private var startedElapsedNs=0L
    private var accelRegistered=false
    private var gyroRegistered=false
    private val motionCounts=mutableMapOf(Sensor.TYPE_ACCELEROMETER to 0L,Sensor.TYPE_GYROSCOPE to 0L)
    private val sensorManager=context.getSystemService(SensorManager::class.java)
    private val imu=object: SensorEventListener {
        override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
        override fun onSensorChanged(event: SensorEvent) {
            if (stopping.get()) return
            try {
                val type=event.sensor.type
                if (type !in listOf(Sensor.TYPE_ACCELEROMETER,Sensor.TYPE_GYROSCOPE)) return
                val count=motionCounts[type] ?: 0L; motionCounts[type]=count+1
                val row=JSONObject().put("recording_id",id).put("stream_id",if (type==Sensor.TYPE_ACCELEROMETER) "accel" else "gyro")
                    .put("event_id",count.toString()).put("native_timestamp_ns",event.timestamp.toString()).put("native_clock_id","android.elapsed_realtime")
                    .put("mapped_capture_time_ns",clock.epoch(event.timestamp).toString()).put("mapping_revision","elapsed_epoch_1")
                    .put("axes","android_device_native").put("units",if (type==Sensor.TYPE_ACCELEROMETER) "m/s^2" else "rad/s")
                    .put("includes_gravity",type==Sensor.TYPE_ACCELEROMETER).put("accuracy",event.accuracy)
                    .put("values",JSONArray(event.values.take(3))).put("sensor_name",event.sensor.name).put("sensor_vendor",event.sensor.vendor)
                checkNotNull(sink).json(if (type==Sensor.TYPE_ACCELEROMETER) CaptureSink.ACCEL else CaptureSink.GYRO,row)
            } catch(e: Exception) { fail(e) }
        }
    }
    fun start() { handler.post { initialize() } }
    fun requestStop(why: String="user_stop") { reason=why; stopping.set(true) }
    private fun fail(e: Throwable) { failure=e.toString(); reason="failure"; stopping.set(true); status("Failure: $e") }
    private fun initialize() {
        try {
            check(dir.mkdirs()) { "Cannot create session directory" }
            atomicJson(File(dir,"metadata.json"), JSONObject().put("recording_id",id).put("capture_schema","stateaction.capture.spike.android.v1").put("container_state","unclosed").put("capture_outcome","interrupted").put("production_qualified",false))
            check(dir.usableSpace>1024L*1024*1024) { "Need 1 GiB free for short spike" }
            val ar=Session(context); session=ar
            val filter=CameraConfigFilter(ar).setTargetFps(EnumSet.of(CameraConfig.TargetFps.TARGET_FPS_30)).setFacingDirection(CameraConfig.FacingDirection.BACK)
            val configs=ar.getSupportedCameraConfigs(filter)
            val configRows=JSONArray(configs.map { JSONObject().put("camera_id",it.cameraId).put("image_width",it.imageSize.width).put("image_height",it.imageSize.height).put("texture_width",it.textureSize.width).put("texture_height",it.textureSize.height).put("fps_range",it.fpsRange.toString()) })
            atomicJson(File(dir,"camera-capabilities.json"),JSONObject().put("configs",configRows))
            val chosen=configs.firstOrNull { it.imageSize.width==HardwareAvc.WIDTH && it.imageSize.height==HardwareAvc.HEIGHT }
                ?: error("ARCore has no native 1920x1080 image geometry at requested 30 fps; see camera-capabilities.json")
            ar.cameraConfig=chosen; cameraId=chosen.cameraId
            val characteristics=context.getSystemService(CameraManager::class.java).getCameraCharacteristics(cameraId)
            val timestampSource=characteristics.get(CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE)
            check(timestampSource==CameraCharacteristics.SENSOR_INFO_TIMESTAMP_SOURCE_REALTIME) { "Camera timestamp clock unverified (source=$timestampSource); no false epoch mapping allowed" }
            depthEnabled=ar.isDepthModeSupported(Config.DepthMode.AUTOMATIC)
            val arConfig=Config(ar).setUpdateMode(Config.UpdateMode.BLOCKING).setFocusMode(Config.FocusMode.AUTO).setPlaneFindingMode(Config.PlaneFindingMode.DISABLED).setLightEstimationMode(Config.LightEstimationMode.DISABLED).setImageStabilizationMode(Config.ImageStabilizationMode.OFF)
                .setDepthMode(if (depthEnabled) Config.DepthMode.AUTOMATIC else Config.DepthMode.DISABLED)
            ar.configure(arConfig)
            val graphics=CaptureGl(); gl=graphics
            val disk=CaptureSink(context,dir,clock) { fail(it) }; sink=disk
            val avc=HardwareAvc { frame ->
                val input=pending.remove(frame.ptsUs) ?: error("Encoder output PTS ${frame.ptsUs} has no acquisition")
                disk.video(frame,input.epochNs,input.evidence)
            }; encoder=avc
            graphics.attach(avc.surface)
            atomicJson(File(dir,"encoder-capabilities.json"),avc.probe)
            val accel=sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER) ?: error("Raw accelerometer unavailable")
            val gyro=sensorManager.getDefaultSensor(Sensor.TYPE_GYROSCOPE) ?: error("Raw gyroscope unavailable")
            val profile=JSONObject().put("capture_schema","stateaction.capture.spike.android.v1").put("rgb_profile","android_h264_spike_v1").put("recording_id",id)
                .put("production_qualified",false).put("app_package",context.packageName).put("device",Build.MODEL).put("manufacturer",Build.MANUFACTURER).put("android_sdk",Build.VERSION.SDK_INT).put("arcore_version","1.44.0")
                .put("camera_id",cameraId).put("encoder",avc.probe).put("encoder_time_base",JSONObject().put("numerator",1).put("denominator",1_000_000))
                .put("path","ARCore OES texture -> GPU render -> MediaCodec Surface; no CPU RGB readback; internal driver copies unmeasured")
                .put("image_width",chosen.imageSize.width).put("image_height",chosen.imageSize.height).put("texture_width",chosen.textureSize.width).put("texture_height",chosen.textureSize.height).put("camera_fps_range",chosen.fpsRange.toString())
                .put("saved_width",HardwareAvc.WIDTH).put("saved_height",HardwareAvc.HEIGHT).put("display_rotation_degrees",0).put("mirror",false)
                .put("limits",JSONObject().put("pending_visual_frames",4).put("max_access_unit_bytes",HardwareAvc.MAX_AU).put("writer_queue_bytes",CaptureSink.BYTE_LIMIT).put("writer_queue_items",8192).put("encoder_close_timeout_seconds",10))
                .put("raw_motion_requested_hz",100).put("raw_motion_max_report_latency_us",0).put("depth_supported",depthEnabled).put("depth_enabled",depthEnabled)
                .put("depth_calibration_status","not_qualified_preserve_native_depth_and_rgb_intrinsics").put("depth_clock_mapping","unverified_native_times_retained")
                .put("mesh","not_collected_spike").put("point_cloud","not_collected_spike").put("background_capture","unsupported_spike_stops_on_pause")
                .put("color_source_primaries","not_exposed_by_arcore").put("encoder_requested_color","BT709 SDR limited; inspect output VUI before qualification")
            disk.json(CaptureSink.PROFILE,profile)
            atomicJson(File(dir,"capture-profile.json"),profile)
            disk.json(CaptureSink.CLOCKS,JSONObject().put("recording_id",id).put("mapping_revision","elapsed_epoch_1").put("source_clock_id","android.elapsed_realtime").put("target_clock_id","unix_epoch_ns").put("source_anchor_ns",clock.monotonicAnchorNs.toString()).put("target_anchor_ns",clock.epochAnchorNs.toString()).put("uncertainty_ns",clock.anchorUncertaintyNs.toString()).put("status","same_domain").put("method","fixed host wall-clock anchor; CameraCharacteristics REALTIME and SensorEvent documented elapsedRealtime domain").put("arcore_frame_timestamp_mapping","unverified; retain separately; do not assume same clock"))
            accelRegistered=sensorManager.registerListener(imu,accel,10_000,0,imuHandler)
            gyroRegistered=sensorManager.registerListener(imu,gyro,10_000,0,imuHandler)
            check(accelRegistered && gyroRegistered) { "Raw IMU registration failed" }
            ar.setCameraTextureNames(intArrayOf(graphics.texture)); ar.setDisplayGeometry(android.view.Surface.ROTATION_0,HardwareAvc.WIDTH,HardwareAvc.HEIGHT); ar.resume()
            startedElapsedNs=SystemClock.elapsedRealtimeNanos()
            status("Recording $id\n1080p/30 requested, hardware H.264. Explicit stop or ${durationSeconds}s limit.\nRGB continues during AR tracking loss.")
            handler.post { frameLoop() }
        } catch(e: Throwable) { fail(e); finish() }
    }
    private fun frameLoop() {
        if (stopping.get()) { finish(); return }
        try {
            val ar=checkNotNull(session); val frame=ar.update()
            val metadataSensorNs=if (frame.timestamp>0L) try { frame.imageMetadata.getLong(ImageMetadata.SENSOR_TIMESTAMP).takeIf { it>0L } } catch(e: NotYetAvailableException) { null } catch(e: com.google.ar.core.exceptions.MetadataNotFoundException) { null } else null
            when (val decision=cameraTimestampGate.observe(frame.timestamp,frame.androidCameraTimestamp,SystemClock.elapsedRealtimeNanos(),metadataSensorNs)) {
                is CameraTimestampGate.Decision.Accept -> onFrame(frame,decision.cameraNs,decision.source,metadataSensorNs)
                is CameraTimestampGate.Decision.Reject -> error(decision.reason)
                is CameraTimestampGate.Decision.Wait -> {
                    timestampUnavailableUpdates++
                    if (timestampUnavailableUpdates<=3 || timestampUnavailableUpdates%30L==0L) {
                        sink?.json(CaptureSink.SENSORS,JSONObject().put("stream_id","camera_clock_availability").put("state","waiting").put("reason",decision.reason).put("arcore_frame_timestamp_ns",frame.timestamp.toString()).put("android_camera_timestamp_ns",frame.androidCameraTimestamp.toString()).put("host_elapsed_ns",SystemClock.elapsedRealtimeNanos().toString()).put("mapped_capture_time_ns",JSONObject.NULL))
                        status("Waiting for required camera-clock evidence; no substituted capture time (${decision.reason})")
                    }
                }
                CameraTimestampGate.Decision.Duplicate -> Unit
            }
            checkNotNull(encoder).drain()
            if (SystemClock.elapsedRealtimeNanos()-startedElapsedNs>=durationSeconds*1_000_000_000L) requestStop("duration_limit")
            if (dir.usableSpace<512L*1024*1024) requestStop("low_storage")
            if (stopping.get()) finish() else handler.post { frameLoop() }
        } catch(e: Throwable) { fail(e); finish() }
    }
    private fun onFrame(frame: Frame, nativeNs: Long, clockSource: String, metadataSensorNs: Long?) {
        val disk=checkNotNull(sink)
        val epoch=clock.epoch(nativeNs)
        val origin=firstNativeNs ?: nativeNs.also { firstNativeNs=it }
        val frameId=acquired++
        val encoderPts=pts.allocate(nativeNs,origin)
        val row=JSONObject().put("recording_id",id).put("stream_id","rgb").put("source_frame_id",frameId.toString()).put("state","acquired")
            .put("native_timestamp_ns",nativeNs.toString()).put("native_clock_id","android.camera.realtime").put("arcore_frame_timestamp_ns",frame.timestamp.toString()).put("arcore_frame_clock_id","arcore.frame.undefined")
            .put("mapped_capture_time_ns",epoch.toString()).put("mapping_revision","elapsed_epoch_1").put("camera_clock_source",clockSource).put("android_camera_timestamp_ns",frame.androidCameraTimestamp.toString()).put("metadata_sensor_timestamp_ns",metadataSensorNs?.toString() ?: JSONObject.NULL).put("calibration_id","rgb_$frameId")
            .put("encoder_pts_us",encoderPts.toString()).put("encoder_time_base",JSONObject().put("numerator",1).put("denominator",1_000_000))
        disk.json(CaptureSink.FRAMES,JSONObject(row.toString()))
        val intrinsics=frame.camera.imageIntrinsics
        val dims=intrinsics.imageDimensions; val focal=intrinsics.focalLength; val center=intrinsics.principalPoint
        check(dims[0]==HardwareAvc.WIDTH && dims[1]==HardwareAvc.HEIGHT) { "Midstream image raster changed" }
        disk.binary(CaptureSink.CAMERA_INFO,Cdr().cameraInfo(epoch,dims[0],dims[1],focal[0].toDouble(),focal[1].toDouble(),center[0].toDouble(),center[1].toDouble()))
        val tracking=frame.camera.trackingState
        val pose=frame.camera.pose
        val event=JSONObject().put("recording_id",id).put("stream_id","camera_geometry").put("event_id",frameId.toString()).put("source_frame_id",frameId.toString()).put("calibration_id","rgb_$frameId")
            .put("native_timestamp_ns",nativeNs.toString()).put("native_clock_id","android.camera.realtime").put("mapped_capture_time_ns",epoch.toString())
            .put("source_kind","ARCore camera image intrinsics and native camera pose").put("tracking_state",tracking.name).put("tracking_failure_reason",frame.camera.trackingFailureReason.name)
            .put("pose_valid",tracking==TrackingState.TRACKING).put("pose_convention","ARCore OpenGL camera: right,+up,-forward; not optical")
            .put("image_dimensions",JSONArray(dims.toList())).put("focal_length",JSONArray(focal.toList())).put("principal_point",JSONArray(center.toList()))
            .put("saved_pixel_transform","full IMAGE_NORMALIZED raster -> encoder same raster, no crop/rotate/mirror; GL texture UV corners recorded per-frame")
            .put("distortion_status","not_exposed_by_arcore; empty D is not proof of zero distortion")
        if (tracking==TrackingState.TRACKING) disk.binary(CaptureSink.POSE,Cdr().pose(epoch,pose.translation,pose.rotationQuaternion))
        try {
            val m=frame.imageMetadata
            fun optional(key: Int, name: String, value: ()->Any) {
                try { if (m.keys.contains(key.toLong())) event.put(name,value()) else event.put(name,JSONObject.NULL) }
                catch(e: Exception) { event.put(name,JSONObject.NULL) }
            }
            optional(ImageMetadata.SENSOR_EXPOSURE_TIME,"exposure_duration_ns") { m.getLong(ImageMetadata.SENSOR_EXPOSURE_TIME).toString() }
            optional(ImageMetadata.SENSOR_ROLLING_SHUTTER_SKEW,"rolling_shutter_skew_ns") { m.getLong(ImageMetadata.SENSOR_ROLLING_SHUTTER_SKEW).toString() }
            optional(ImageMetadata.SENSOR_SENSITIVITY,"sensor_iso") { m.getInt(ImageMetadata.SENSOR_SENSITIVITY) }
            optional(ImageMetadata.LENS_FOCUS_DISTANCE,"focus_distance_diopters") { m.getFloat(ImageMetadata.LENS_FOCUS_DISTANCE).toDouble() }
            optional(ImageMetadata.CONTROL_VIDEO_STABILIZATION_MODE,"video_stabilization_mode") { m.getByte(ImageMetadata.CONTROL_VIDEO_STABILIZATION_MODE).toInt() }
            optional(ImageMetadata.LENS_OPTICAL_STABILIZATION_MODE,"optical_stabilization_mode") { m.getByte(ImageMetadata.LENS_OPTICAL_STABILIZATION_MODE).toInt() }
        } catch (e: NotYetAvailableException) { event.put("camera_metadata_status","not_yet_available") }
        if (pending.size>=4) {
            row.put("state","dropped").put("reason","encoder_pending_limit"); dropped++
            disk.json(CaptureSink.FRAMES,row); disk.json(CaptureSink.SENSORS,event)
        } else {
            pending[encoderPts]=Acquisition(epoch,JSONObject(row.toString()))
            highestPending=maxOf(highestPending,pending.size)
            val uv=checkNotNull(gl).draw(frame,encoderPts,HardwareAvc.WIDTH,HardwareAvc.HEIGHT)
            event.put("texture_uv_corners_bottomleft_bottomright_topleft_topright",JSONArray(uv.toList()))
            disk.json(CaptureSink.SENSORS,event); submitted++
        }
        if (depthEnabled) collectDepth(frame,frameId)
        if (acquired%30L==0L) {
            maxPssKb=maxOf(maxPssKb,Debug.getPss())
            val thermal=context.getSystemService(PowerManager::class.java).currentThermalStatus
            maxThermal=maxOf(maxThermal,thermal)
            val battery=context.getSystemService(BatteryManager::class.java).getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
            disk.json(CaptureSink.SENSORS,JSONObject().put("stream_id","device_health").put("native_timestamp_ns",SystemClock.elapsedRealtimeNanos().toString()).put("pss_kb",Debug.getPss()).put("thermal_status",thermal).put("battery_percent",battery).put("free_bytes",dir.usableSpace.toString()))
            status("Recording $id\nacquired=$acquired submitted=$submitted dropped=$dropped pending=${pending.size}\nPSS=${maxPssKb/1024}MiB thermal=$thermal battery=$battery%")
            if (thermal>=PowerManager.THERMAL_STATUS_SEVERE) requestStop("thermal_severe")
        }
    }
    private fun collectDepth(frame: Frame, frameId: Long) {
        try {
            frame.acquireRawDepthImage16Bits().use { depth ->
                if (depth.timestamp==lastRawDepthNs) return
                frame.acquireRawDepthConfidenceImage().use { confidence ->
                    check(depth.timestamp==confidence.timestamp) { "Raw-depth confidence timestamp mismatch" }
                    val bytes=packImage(depth,2); val confidenceBytes=packImage(confidence,1)
                    val disk=checkNotNull(sink)
                    disk.binary(CaptureSink.DEPTH,Cdr().image(depth.timestamp,"camera_depth_optical",depth.width,depth.height,"16UC1",depth.width*2,bytes))
                    disk.binary(CaptureSink.CONFIDENCE,Cdr().image(confidence.timestamp,"camera_depth_optical",confidence.width,confidence.height,"mono8",confidence.width,confidenceBytes))
                    disk.json(CaptureSink.SENSORS,JSONObject().put("recording_id",id).put("stream_id","raw_depth").put("event_id",depth.timestamp.toString()).put("source_frame_id",frameId.toString()).put("source_kind","arcore_raw_depth_with_matching_raw_confidence").put("native_timestamp_ns",depth.timestamp.toString()).put("native_clock_id","arcore.depth_image").put("mapped_capture_time_ns",JSONObject.NULL).put("clock_mapping_status","unverified").put("width",depth.width).put("height",depth.height).put("precision","uint16 little endian millimetres; zero invalid").put("confidence_units","native uint8 0..255").put("calibration_status","not_qualified; RGB intrinsics retained; no invented registered depth transform").put("depth_topic",CaptureSink.DEPTH).put("confidence_topic",CaptureSink.CONFIDENCE))
                    lastRawDepthNs=depth.timestamp
                }
            }
        } catch(e: NotYetAvailableException) { /* Conditional native stream not yet delivered; final actual count is authoritative. */ }
    }
    private fun packImage(image: Image, bytesPerPixel: Int): ByteArray {
        val p=image.planes[0]; val source=p.buffer.duplicate(); val origin=source.position()
        val out=ByteArray(image.width*image.height*bytesPerPixel)
        require(out.size<=HardwareAvc.MAX_AU)
        var i=0
        for (y in 0 until image.height) for (x in 0 until image.width) for (b in 0 until bytesPerPixel) out[i++]=source.get(origin+y*p.rowStride+x*p.pixelStride+b)
        return out
    }
    private fun finish() {
        stopping.set(true)
        sensorManager.unregisterListener(imu)
        val barrier=java.util.concurrent.CountDownLatch(1); imuHandler.post { barrier.countDown() }; barrier.await(2,java.util.concurrent.TimeUnit.SECONDS)
        try { session?.pause() } catch(e: Exception) { fail(e) }
        val avc=encoder
        if (avc!=null) try {
            avc.signalEos()
            val deadline=SystemClock.elapsedRealtime()+10_000
            while (!avc.eos && SystemClock.elapsedRealtime()<deadline) avc.drain(10_000)
            check(avc.eos) { "Encoder EOS timeout" }
            check(pending.isEmpty()) { "Unresolved acquisitions: ${pending.keys}" }
        } catch(e: Throwable) { fail(e) }
        try { gl?.close() } catch(e: Exception) { fail(e) }
        try { avc?.close() } catch(e: Exception) { fail(e) }
        try { session?.close() } catch(e: Exception) { fail(e) }
        try { sink?.finish() } catch(e: Exception) { fail(e) }
        val actualVideo=sink?.writtenCounts?.get(CaptureSink.VIDEO) ?: 0L
        val unresolved=(acquired-actualVideo-dropped).coerceAtLeast(0L)
        if (unresolved>0L && failure==null) { failure="Acquisition terminal count mismatch: $unresolved unresolved"; reason="integrity_failure" }
        val elapsed=(SystemClock.elapsedRealtimeNanos()-startedElapsedNs).coerceAtLeast(0)
        val file=File(dir,"capture.mcap")
        val outcome=if (failure!=null) "failed" else if (reason in listOf("user_stop","duration_limit")) "completed" else "interrupted"
        val metadata=JSONObject().put("recording_id",id).put("capture_schema","stateaction.capture.spike.android.v1").put("rgb_profile","android_h264_spike_v1").put("production_qualified",false)
            .put("container_state",if (sink?.closed==true) "closed" else "unclosed").put("capture_outcome",outcome).put("reason",reason).put("error",failure ?: JSONObject.NULL)
            .put("acquired_frames",acquired.toString()).put("submitted_frames",submitted.toString()).put("dropped_frames",dropped.toString()).put("unresolved_frame_count",unresolved.toString()).put("unresolved_encoder_pts_us",JSONArray(pending.keys.map { it.toString() }))
            .put("writer_actual_message_counts",JSONObject(sink?.writtenCounts?.mapValues { it.value.toString() } ?: emptyMap<String,String>()))
            .put("motion_callback_counts",JSONObject(motionCounts.mapKeys { it.key.toString() }.mapValues { it.value.toString() }))
            .put("max_pending_frames",highestPending).put("writer_queue_high_water_bytes",sink?.highWaterBytes?.get() ?: 0).put("peak_sampled_pss_kb",maxPssKb).put("max_thermal_status",maxThermal)
            .put("elapsed_seconds",if (startedElapsedNs>0) elapsed/1e9 else 0.0).put("encoder_output_format",avc?.observedFormat ?: JSONObject.NULL).put("sps_profile_idc",avc?.observedSpsProfile ?: JSONObject.NULL).put("sps_level_idc",avc?.observedSpsLevel ?: JSONObject.NULL)
            .put("timestamp_unavailable_updates",timestampUnavailableUpdates.toString()).put("depth_enabled",depthEnabled).put("depth_seen",lastRawDepthNs>=0).put("camera_id",cameraId)
            .put("qualification_gaps",JSONArray(listOf("No production Flutter bridge/auth/upload", "Conditional depth clock/calibration not qualified", "No crash salvage/durable acquisition journal", "No two-hour/device quality qualification", "Foreground only; stops on Activity pause", "No mesh/point-cloud capture in isolated spike", "No independent measurement of native codec internal buffers/copies")))
        if (file.isFile && sink?.closed==true) {
            try { metadata.put("source_files",JSONArray().put(JSONObject().put("path","capture.mcap").put("role","recording").put("bytes",file.length().toString()).put("sha256",sha256(file)))) }
            catch(e: Exception) { metadata.put("hash_error",e.toString()).put("capture_outcome","failed") }
        }
        try { atomicJson(File(dir,"metadata.json"),metadata) } catch(e: Exception) { status("Metadata close failed: $e") }
        status("Stopped: $outcome ($reason)\n${dir.absolutePath}\nacquired=$acquired submitted=$submitted unresolved=${pending.size}\n${failure ?: "Inspect MCAP/metadata before using as evidence."}")
        imuThread.quitSafely(); worker.quitSafely(); done()
    }
    companion object {
        fun atomicJson(file: File, json: JSONObject) {
            val temp=File(file.parentFile,file.name+".tmp")
            FileOutputStream(temp).use { it.write((json.toString(2)+"\n").toByteArray()); it.fd.sync() }
            check(temp.renameTo(file)) { "Atomic metadata rename failed" }
        }
        fun sha256(file: File): String {
            val hash=MessageDigest.getInstance("SHA-256")
            file.inputStream().use { input -> val buffer=ByteArray(1024*1024); while(true) { val n=input.read(buffer); if(n<0) break; hash.update(buffer,0,n) } }
            return hash.digest().joinToString("") { "%02x".format(it) }
        }
    }
}
