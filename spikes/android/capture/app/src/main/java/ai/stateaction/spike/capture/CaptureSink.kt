package ai.stateaction.spike.capture

import android.content.Context
import android.os.SystemClock
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

class CaptureClock {
    private val before=SystemClock.elapsedRealtimeNanos()
    val epochAnchorNs=System.currentTimeMillis()*1_000_000L
    private val after=SystemClock.elapsedRealtimeNanos()
    val monotonicAnchorNs=before+(after-before)/2
    val anchorUncertaintyNs=(after-before)/2+1_000_000L
    fun epoch(nativeElapsedNs: Long)=epochAnchorNs+(nativeElapsedNs-monotonicAnchorNs)
    fun now()=epoch(SystemClock.elapsedRealtimeNanos())
}

/** Single MCAP writer owner; producer queues bounded by both item count and bytes. */
class CaptureSink(context: Context, val dir: File, val clock: CaptureClock, onFailure: (Throwable)->Unit) {
    private data class Item(val bytes: Int, val action: ()->Unit)
    private val queue=ArrayBlockingQueue<Item>(8192)
    private val queuedBytes=AtomicInteger(0)
    val highWaterBytes=AtomicInteger(0)
    val error=AtomicReference<Throwable?>(null)
    @Volatile private var accepting=true
    @Volatile private var stop=false
    private val writer=MCAPWriter()
    private val channels=mutableMapOf<String,Int>()
    private val sequences=mutableMapOf<String,Int>()
    val writtenCounts=mutableMapOf<String,Long>() // writer thread only until finish/join
    var closed=false; private set
    private val thread: Thread
    init {
        check(writer.open(File(dir,"capture.mcap")))
        val descriptor=context.assets.open("foxglove-compressed-video.desc").use { it.readBytes() }
        val schema=writer.addSchema("foxglove.CompressedVideo","protobuf",descriptor)
        channels[VIDEO]=writer.addChannel(VIDEO,"protobuf",schema,mapOf("frame_id" to "camera_rgb_optical","capture_profile" to "android_h264_spike_v1"))
        for ((topic,name) in listOf(PROFILE to "Profile",CLOCKS to "Clocks",FRAMES to "FrameEvent",ACCEL to "MotionEvent",GYRO to "MotionEvent",SENSORS to "SensorEvent")) {
            val jsonSchema=JSONObject().put("\$schema","https://json-schema.org/draft/2020-12/schema").put("title","stateaction.capture.$name.v1").put("type","object").put("description","Experimental spike evidence; not released production contract").toString().toByteArray()
            val s=writer.addSchema("stateaction.capture.$name.v1","jsonschema",jsonSchema)
            channels[topic]=writer.addChannel(topic,"json",s)
        }
        fun cdr(topic: String, name: String, source: String, meta: Map<String,String> = emptyMap()) {
            val s=writer.addSchema(name,"ros2msg",source.toByteArray())
            channels[topic]=writer.addChannel(topic,"cdr",s,meta)
        }
        cdr(CAMERA_INFO,"sensor_msgs/msg/CameraInfo",Cdr.CAMERA_INFO,mapOf("distortion_status" to "not_exposed_by_arcore","timestamp_semantics" to "mapped_capture_epoch"))
        cdr(POSE,"geometry_msgs/msg/PoseStamped",Cdr.POSE,mapOf("pose_semantics" to "arcore_camera_pose_opengl_axes","timestamp_semantics" to "mapped_capture_epoch"))
        for (topic in listOf(DEPTH,CONFIDENCE)) cdr(topic,"sensor_msgs/msg/Image",Cdr.IMAGE,mapOf("timestamp_semantics" to "native_unmapped","clock_id" to "arcore.depth_image"))
        thread=Thread({
            try {
                while (!stop || queue.isNotEmpty()) {
                    val item=queue.poll(100,TimeUnit.MILLISECONDS) ?: continue
                    try { item.action() } finally { queuedBytes.addAndGet(-item.bytes) }
                }
                writer.finish(); closed=true
            } catch (e: Throwable) { accepting=false; error.set(e); onFailure(e) }
        },"stateaction-spike-mcap").apply { start() }
    }
    private fun offer(bytes: Int, action: ()->Unit) {
        check(accepting) { "Writer stopped: ${error.get()}" }
        val size=queuedBytes.addAndGet(bytes)
        if (size>BYTE_LIMIT) { queuedBytes.addAndGet(-bytes); throw IllegalStateException("Writer 16 MiB queue exhausted; capture must stop") }
        highWaterBytes.accumulateAndGet(size,::maxOf)
        if (!queue.offer(Item(bytes,action))) { queuedBytes.addAndGet(-bytes); throw IllegalStateException("Writer 8192-item queue exhausted") }
    }
    private fun append(topic: String, bytes: ByteArray, publish: Long, sequence: Int? = null): Int {
        val seq=sequence ?: (sequences[topic] ?: 0)
        writer.addMessage(checkNotNull(channels[topic]),clock.now(),publish,bytes,seq)
        sequences[topic]=seq+1
        writtenCounts[topic]=(writtenCounts[topic] ?: 0L)+1L
        return seq
    }
    fun json(topic: String, value: JSONObject) {
        val bytes=value.toString().toByteArray(); val publish=clock.now()
        offer(bytes.size) { append(topic,bytes,publish) }
    }
    fun binary(topic: String, bytes: ByteArray) {
        val publish=clock.now(); offer(bytes.size) { append(topic,bytes,publish) }
    }
    fun video(frame: EncodedFrame, captureNs: Long, evidence: JSONObject) {
        val wire=VideoWire.compressedVideo(captureNs,frame.annexB)
        val publish=clock.now()
        offer(wire.size+2048) {
            val seq=append(VIDEO,wire,publish)
            evidence.put("output_sequence",seq).put("is_idr",frame.idr).put("state","written")
            append(FRAMES,evidence.toString().toByteArray(),publish)
        }
    }
    fun finish() {
        accepting=false; stop=true; thread.join(15_000L)
        check(!thread.isAlive) { "Writer close timeout" }
        error.get()?.let { throw IllegalStateException("Writer failed",it) }
        check(closed)
    }
    companion object {
        const val BYTE_LIMIT=16*1024*1024
        const val VIDEO="/camera/rgb/video"
        const val PROFILE="/stateaction/capture_profile"; const val CLOCKS="/stateaction/clocks"
        const val FRAMES="/stateaction/frame_events"; const val ACCEL="/stateaction/imu/accel"; const val GYRO="/stateaction/imu/gyro"
        const val SENSORS="/stateaction/sensor_events"; const val CAMERA_INFO="/camera/rgb/camera_info"
        const val POSE="/camera/pose"; const val DEPTH="/camera/depth_raw/image"; const val CONFIDENCE="/camera/depth_raw/confidence"
    }
}
