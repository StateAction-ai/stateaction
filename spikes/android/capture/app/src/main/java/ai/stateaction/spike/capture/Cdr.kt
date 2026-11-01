package ai.stateaction.spike.capture

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/** CDR little endian; alignment starts after the 4-byte encapsulation header. */
class Cdr {
    private val out = ByteArrayOutputStream().apply { write(byteArrayOf(0,1,0,0)) }
    private fun align(n: Int) { while ((out.size() - 4) % n != 0) out.write(0) }
    fun u32(v: Int) { align(4); out.write(ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(v).array()) }
    fun f64(v: Double) { align(8); out.write(ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN).putDouble(v).array()) }
    fun str(v: String) { val b = v.toByteArray(); u32(b.size + 1); out.write(b); out.write(0) }
    fun header(ns: Long, frameId: String) { u32((ns / 1_000_000_000L).toInt()); u32((ns % 1_000_000_000L).toInt()); str(frameId) }
    fun bytes() = out.toByteArray()
    fun image(ns: Long, frameId: String, width: Int, height: Int, encoding: String, step: Int, data: ByteArray): ByteArray {
        header(ns, frameId); u32(height); u32(width); str(encoding); out.write(0); u32(step); u32(data.size); out.write(data)
        return bytes()
    }
    fun cameraInfo(ns: Long, width: Int, height: Int, fx: Double, fy: Double, cx: Double, cy: Double): ByteArray {
        header(ns, "camera_rgb_optical"); u32(height); u32(width); str("plumb_bob"); u32(0)
        listOf(fx,0.0,cx,0.0,fy,cy,0.0,0.0,1.0).forEach(::f64)
        listOf(1.0,0.0,0.0,0.0,1.0,0.0,0.0,0.0,1.0).forEach(::f64)
        listOf(fx,0.0,cx,0.0,0.0,fy,cy,0.0,0.0,0.0,1.0,0.0).forEach(::f64)
        u32(0); u32(0); repeat(4) { u32(0) }; out.write(0)
        return bytes()
    }
    fun pose(ns: Long, position: FloatArray, rotation: FloatArray): ByteArray {
        header(ns, "arcore_world")
        position.forEach { f64(it.toDouble()) }; rotation.forEach { f64(it.toDouble()) }
        return bytes()
    }
    companion object {
        const val HEADER = "\n================================================================================\nMSG: std_msgs/Header\nbuiltin_interfaces/Time stamp\nstring frame_id\n================================================================================\nMSG: builtin_interfaces/Time\nint32 sec\nuint32 nanosec\n"
        const val IMAGE = "std_msgs/Header header\nuint32 height\nuint32 width\nstring encoding\nuint8 is_bigendian\nuint32 step\nuint8[] data\n" + HEADER
        const val CAMERA_INFO = "std_msgs/Header header\nuint32 height\nuint32 width\nstring distortion_model\nfloat64[] d\nfloat64[9] k\nfloat64[9] r\nfloat64[12] p\nuint32 binning_x\nuint32 binning_y\nsensor_msgs/RegionOfInterest roi\n" + HEADER + "\n================================================================================\nMSG: sensor_msgs/RegionOfInterest\nuint32 x_offset\nuint32 y_offset\nuint32 height\nuint32 width\nbool do_rectify\n"
        const val POSE = "std_msgs/Header header\ngeometry_msgs/Pose pose\n" + HEADER + "\n================================================================================\nMSG: geometry_msgs/Pose\ngeometry_msgs/Point position\ngeometry_msgs/Quaternion orientation\n================================================================================\nMSG: geometry_msgs/Point\nfloat64 x\nfloat64 y\nfloat64 z\n================================================================================\nMSG: geometry_msgs/Quaternion\nfloat64 x\nfloat64 y\nfloat64 z\nfloat64 w\n"
    }
}
