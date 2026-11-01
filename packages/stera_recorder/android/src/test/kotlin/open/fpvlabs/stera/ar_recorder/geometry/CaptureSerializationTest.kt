package open.fpvlabs.stera.ar_recorder.geometry

import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.junit.Assert.*
import org.junit.Test
import open.fpvlabs.stera.ar_recorder.data.CDRSerializer

class CaptureSerializationTest {
    @Test fun frameGeometryJsonRoundTripsWithoutTimestampRounding() {
        val json = "{\"frame_timestamp_ns\":1453692123456789,\"depth_timestamp_ns\":1453692090123456,\"tracking_state\":\"TRACKING\",\"rgb_pixel_to_depth_pixel\":[0.25,0,-15,0,0.25,-10,0,0,1]}"
        val encoded = CDRSerializer.serializeString(json)
        val length = ByteBuffer.wrap(encoded, 4, 4).order(ByteOrder.LITTLE_ENDIAN).int
        assertArrayEquals(byteArrayOf(0, 1, 0, 0), encoded.copyOfRange(0, 4))
        assertEquals(json, String(encoded, 8, length - 1, Charsets.UTF_8))
        assertEquals(0, encoded.last().toInt())
    }

    @Test fun depthImageHeaderPreservesNativeAcquisitionNanoseconds() {
        val nativeTime = 1453692090123456L
        val encoded = CDRSerializer.serializeImage(nativeTime, "camera_optical_frame", 1, 1,
            "16UC1", false, 2, byteArrayOf(0xE8.toByte(), 0x03))
        val buffer = ByteBuffer.wrap(encoded).order(ByteOrder.LITTLE_ENDIAN)
        val decodedTime = buffer.getInt(4).toLong() * 1_000_000_000L + (buffer.getInt(8).toLong() and 0xFFFFFFFFL)
        assertEquals(nativeTime, decodedTime)
    }
}
