package ai.stateaction.spike.capture

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.media.MediaFormat
import android.os.Build
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.ar.core.*
import com.google.ar.core.exceptions.NotYetAvailableException
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.EnumSet

/** Automated camera actions are strictly emulator-only. No physical device can run this test. */
@RunWith(AndroidJUnit4::class)
class EmulatorCameraPathTest {
    @Test fun nativeArcoreCpuAssociationAndGpuEncoderPath() {
        check(Build.HARDWARE in listOf("ranchu","goldfish")) { "Refusing physical-device camera test: ${Build.HARDWARE}" }
        val context=InstrumentationRegistry.getInstrumentation().targetContext
        val output=File(context.filesDir,"simulation-camera").apply { mkdirs() }
        val report=JSONObject().put("kind","emulator_only_actual_native_camera_and_software_encoder").put("physical_hardware_qualified",false).put("emulator_hardware",Build.HARDWARE)
        var ar: Session?=null; var graphics: CaptureGl?=null; var codec: MediaCodec?=null
        val frames=JSONArray(); val inputPts=mutableSetOf<Long>(); val outputPts=mutableSetOf<Long>()
        var positiveCameraTimes=0; var missingCameraTimes=0; var imageUnavailable=0; var metadataUnavailable=0
        var completeFrames=0; var validImages=0; var lastFrame=-1L; var eos=false
        val clockGate=CameraTimestampGate()
        var metadataFallbackChecks=0
        val rawFile=File(output,"camera.h264")
        val raw=rawFile.outputStream()
        try {
            ar=Session(context)
            val configs=ar.getSupportedCameraConfigs(CameraConfigFilter(ar).setTargetFps(EnumSet.of(CameraConfig.TargetFps.TARGET_FPS_30)).setFacingDirection(CameraConfig.FacingDirection.BACK))
            report.put("camera_configs",JSONArray(configs.map { JSONObject().put("image_width",it.imageSize.width).put("image_height",it.imageSize.height).put("texture_width",it.textureSize.width).put("texture_height",it.textureSize.height).put("fps_range",it.fpsRange.toString()) }))
            val chosen=configs.minBy { it.imageSize.width*it.imageSize.height }
            ar.cameraConfig=chosen
            report.put("selected_width",chosen.imageSize.width).put("selected_height",chosen.imageSize.height).put("requested_production_profile","1080p30 hardware Main4.0 12Mbps, NOT what this simulation qualifies")
            val format=MediaFormat.createVideoFormat("video/avc",chosen.imageSize.width,chosen.imageSize.height).apply {
                setInteger(MediaFormat.KEY_COLOR_FORMAT,MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
                setInteger(MediaFormat.KEY_BIT_RATE,2_000_000); setInteger(MediaFormat.KEY_FRAME_RATE,30)
                setInteger(MediaFormat.KEY_I_FRAME_INTERVAL,1); setInteger(MediaFormat.KEY_MAX_B_FRAMES,0)
            }
            val encoders=MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.filter { it.isEncoder && it.supportedTypes.contains("video/avc") }
            report.put("encoders",JSONArray(encoders.map { JSONObject().put("name",it.name).put("hardware_accelerated",it.isHardwareAccelerated).put("software_only",it.isSoftwareOnly) }))
            val selected=encoders.first { it.getCapabilitiesForType("video/avc").colorFormats.contains(MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface) && it.getCapabilitiesForType("video/avc").videoCapabilities!!.areSizeAndRateSupported(chosen.imageSize.width,chosen.imageSize.height,30.0) }
            codec=MediaCodec.createByCodecName(selected.name)
            codec.configure(format,null,null,MediaCodec.CONFIGURE_FLAG_ENCODE)
            val surface=codec.createInputSurface(); codec.start()
            report.put("selected_encoder",selected.name).put("selected_encoder_hardware",selected.isHardwareAccelerated)
            graphics=CaptureGl(); graphics.attach(surface)
            ar.configure(Config(ar).setUpdateMode(Config.UpdateMode.BLOCKING).setDepthMode(Config.DepthMode.DISABLED).setPlaneFindingMode(Config.PlaneFindingMode.DISABLED).setLightEstimationMode(Config.LightEstimationMode.DISABLED))
            ar.setCameraTextureNames(intArrayOf(graphics.texture)); ar.setDisplayGeometry(0,chosen.imageSize.width,chosen.imageSize.height); ar.resume()
            val bufferInfo=MediaCodec.BufferInfo()
            fun drain(waitUs: Long) {
                while (true) {
                    val index=codec.dequeueOutputBuffer(bufferInfo,waitUs)
                    if (index==MediaCodec.INFO_TRY_AGAIN_LATER) return
                    if (index==MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) { report.put("encoder_output_format",codec.outputFormat.toString()); continue }
                    if (index<0) continue
                    try {
                        if (bufferInfo.size>0) {
                            val bytes=ByteArray(bufferInfo.size)
                            codec.getOutputBuffer(index)!!.duplicate().apply { position(bufferInfo.offset); limit(bufferInfo.offset+bufferInfo.size); get(bytes) }
                            assertEquals("Emulator emits complete AUs",0,bufferInfo.flags and MediaCodec.BUFFER_FLAG_PARTIAL_FRAME)
                            val nals=AnnexB.nals(bytes)
                            raw.write(AnnexB.join(nals))
                            if (bufferInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG==0 && nals.any { AnnexB.type(it) in listOf(1,5) }) {
                                assertTrue("No invented/repeated output PTS",outputPts.add(bufferInfo.presentationTimeUs))
                                assertTrue("Output matches exact submitted identity",inputPts.contains(bufferInfo.presentationTimeUs))
                                assertFalse("B frames disabled",nals.any(AnnexB::isBFrame)); completeFrames++
                            }
                        }
                        if (bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM!=0) { eos=true; return }
                    } finally { codec.releaseOutputBuffer(index,false) }
                }
            }
            val deadline=SystemClock.elapsedRealtime()+60_000L
            while(inputPts.size<30 && SystemClock.elapsedRealtime()<deadline) {
                val frame=ar.update()
                if (frame.timestamp<=0L || frame.timestamp==lastFrame) { drain(0); continue }
                lastFrame=frame.timestamp
                val row=JSONObject().put("arcore_frame_timestamp_ns",frame.timestamp.toString()).put("android_camera_timestamp_ns",frame.androidCameraTimestamp.toString()).put("mapped_capture_time_ns",JSONObject.NULL).put("cross_stream_clock_verified",false)
                if(frame.androidCameraTimestamp>0) positiveCameraTimes++ else missingCameraTimes++
                try {
                    frame.acquireCameraImage().use { image ->
                        val dims=frame.camera.imageIntrinsics.imageDimensions
                        assertTrue("CPU image has original native time",image.timestamp>0)
                        assertEquals(dims[0],image.width); assertEquals(dims[1],image.height)
                        row.put("cpu_image_timestamp_ns",image.timestamp.toString()).put("cpu_image_width",image.width).put("cpu_image_height",image.height).put("cpu_image_frame_association","Frame.acquireCameraImage_same_frame")
                        validImages++
                    }
                } catch(e: NotYetAvailableException) { imageUnavailable++; row.put("cpu_image_status","not_yet_available") }
                try { row.put("metadata_sensor_timestamp_ns",frame.imageMetadata.getLong(ImageMetadata.SENSOR_TIMESTAMP).toString()) }
                catch(e: Exception) { metadataUnavailable++; row.put("metadata_sensor_timestamp_ns",JSONObject.NULL) }
                val metadataSensorNs=row.optString("metadata_sensor_timestamp_ns").toLongOrNull()
                val clockDecision=clockGate.observe(frame.timestamp,frame.androidCameraTimestamp,SystemClock.elapsedRealtimeNanos(),metadataSensorNs)
                row.put("clock_gate_decision",clockDecision.toString())
                assertFalse("Real metadata/accessor clock evidence must agree",clockDecision is CameraTimestampGate.Decision.Reject)
                if(metadataSensorNs!=null && metadataSensorNs>0) {
                    assertEquals(CameraTimestampGate.Decision.Accept(metadataSensorNs,"frame_metadata_sensor_timestamp"),CameraTimestampGate().observe(frame.timestamp,0L,SystemClock.elapsedRealtimeNanos(),metadataSensorNs))
                    metadataFallbackChecks++
                }
                if (inputPts.size-outputPts.size<4) {
                    val ptsUs=inputPts.size*33_333L
                    // This is explicitly synthetic presentation timing for the software simulation,
                    // never a reconstructed physical capture timestamp or production MCAP timeline.
                    graphics.draw(frame,ptsUs,chosen.imageSize.width,chosen.imageSize.height)
                    inputPts.add(ptsUs); row.put("simulation_encoder_pts_us",ptsUs.toString())
                } else row.put("simulation_encode_outcome","backpressure_skip")
                frames.put(row); drain(10_000)
            }
            codec.signalEndOfInputStream()
            val closeDeadline=SystemClock.elapsedRealtime()+10_000L
            while(!eos && SystemClock.elapsedRealtime()<closeDeadline) drain(10_000)
            assertTrue("Encoder EOS",eos); assertEquals(inputPts,outputPts); assertTrue("Actual native CPU images acquired",validImages>0); assertEquals(30,completeFrames)
            report.put("status","passed")
        } catch(e: Throwable) { report.put("status","failed").put("error",e.toString()); throw e }
        finally {
            try { ar?.pause() } catch(e: Exception) { report.put("pause_error",e.toString()) }
            try { graphics?.close() } catch(e: Exception) { report.put("gl_close_error",e.toString()) }
            try { codec?.stop(); codec?.release() } catch(e: Exception) { report.put("encoder_close_error",e.toString()) }
            try { ar?.close() } catch(e: Exception) { report.put("arcore_close_error",e.toString()) }
            raw.close()
            report.put("frames",frames).put("valid_cpu_images",validImages).put("cpu_image_unavailable",imageUnavailable).put("metadata_unavailable",metadataUnavailable).put("positive_android_camera_timestamp_frames",positiveCameraTimes).put("missing_android_camera_timestamp_frames",missingCameraTimes).put("submitted_frames",inputPts.size).put("encoded_complete_frames",completeFrames).put("metadata_fallback_replay_checks",metadataFallbackChecks).put("eos",eos).put("h264_bytes",rawFile.length())
            File(output,"report.json").writeText(report.toString(2)+"\n")
        }
    }
}
