package ai.stateaction.spike.capture

import org.junit.Assert.*
import org.junit.Test
import java.io.File

class MCAPWriterTest {
    private fun fixtureFile(name: String): File = File("build/spike-fixtures/$name").also { checkNotNull(it.parentFile).mkdirs() }
    @Test fun writesCrossLanguageFixtureWithBinaryDescriptor() {
        val file=fixtureFile("native-writer.mcap")
        val writer=MCAPWriter(); assertTrue(writer.open(file))
        val descriptor=File("src/main/assets/foxglove-compressed-video.desc").readBytes()
        val videoSchema=writer.addSchema("foxglove.CompressedVideo","protobuf",descriptor)
        val video=writer.addChannel(CaptureSink.VIDEO,"protobuf",videoSchema)
        val jsonSchema=writer.addSchema("stateaction.capture.FrameEvent.v1","jsonschema","{\"type\":\"object\"}".toByteArray())
        val frames=writer.addChannel(CaptureSink.FRAMES,"json",jsonSchema)
        val infoSchema=writer.addSchema("sensor_msgs/msg/CameraInfo","ros2msg",Cdr.CAMERA_INFO.toByteArray())
        val info=writer.addChannel(CaptureSink.CAMERA_INFO,"cdr",infoSchema)
        val epoch=1_800_000_000_123_456_789L
        val h264=checkNotNull(javaClass.classLoader!!.getResourceAsStream("synthetic-one-idr.h264")).readBytes()
        assertTrue(AnnexB.nals(h264).any { AnnexB.type(it)==5 })
        writer.addMessage(frames,epoch+1,epoch,"{\"source_frame_id\":\"0\",\"state\":\"acquired\",\"mapped_capture_time_ns\":\"$epoch\"}".toByteArray(),0)
        writer.addMessage(video,epoch+2,epoch,VideoWire.compressedVideo(epoch,h264),0)
        writer.addMessage(frames,epoch+3,epoch,"{\"source_frame_id\":\"0\",\"state\":\"written\",\"output_sequence\":0,\"mapped_capture_time_ns\":\"$epoch\"}".toByteArray(),1)
        writer.addMessage(info,epoch+4,epoch,Cdr().cameraInfo(epoch,64,48,50.0,51.0,32.0,24.0),0)
        writer.finish()
        val bytes=file.readBytes()
        assertArrayEquals(byteArrayOf(0x89.toByte(),0x4d,0x43,0x41,0x50,0x30,0x0d,0x0a),bytes.takeLast(8).toByteArray())
    }
    @Test fun hardChunkBoundIncludesMessageFramingAndPriorRecords() {
        val file=fixtureFile("hard-bound.mcap")
        val writer=MCAPWriter(); writer.open(file)
        val channel=writer.addChannel("opaque","",0)
        writer.addMessage(channel,1,1,byteArrayOf(1),0)
        writer.addMessage(channel,2,2,ByteArray(16*1024*1024-31),1)
        writer.finish()
        val bytes=file.readBytes()
        val buffer=java.nio.ByteBuffer.wrap(bytes).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        var offset=8; var chunks=0
        while (offset<bytes.size-8) {
            val op=bytes[offset].toInt() and 255
            val length=buffer.getLong(offset+1).toInt()
            if(op==6) {
                chunks++
                assertTrue(buffer.getLong(offset+9+16)<=16L*1024*1024)
            }
            offset+=9+length
        }
        assertEquals(2,chunks)
    }
    @Test(expected=IllegalArgumentException::class) fun rejectsOversizedPayload() {
        val writer=MCAPWriter(); writer.open(fixtureFile("oversized-rejected.mcap"))
        val schema=writer.addSchema("test","jsonschema","{}".toByteArray()); val channel=writer.addChannel("test","json",schema)
        try { writer.addMessage(channel,1,1,ByteArray(16*1024*1024+1),0) } finally { writer.finish() }
    }
    @Test(expected=IllegalStateException::class) fun rejectsWritesAfterClose() {
        val writer=MCAPWriter(); writer.open(fixtureFile("closed.mcap")); writer.finish()
        writer.addMessage(1,1,1,byteArrayOf(1),0)
    }
    @Test fun cdrAlignedHeaderContainsFullEpochPrecision() {
        val ns=1_800_000_000_123_456_789L
        val b=Cdr().cameraInfo(ns,1920,1080,1000.0,1001.0,960.0,540.0)
        val buffer=java.nio.ByteBuffer.wrap(b).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        assertEquals(1_800_000_000,buffer.getInt(4)); assertEquals(123_456_789,buffer.getInt(8))
        assertEquals(0,buffer.get(0).toInt()); assertEquals(1,buffer.get(1).toInt())
    }
}
