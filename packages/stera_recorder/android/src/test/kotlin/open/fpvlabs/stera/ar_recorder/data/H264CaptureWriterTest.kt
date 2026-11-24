package open.fpvlabs.stera.ar_recorder.data

import open.fpvlabs.stera.ar_recorder.data.h264.AnnexB
import open.fpvlabs.stera.ar_recorder.data.h264.FramePts
import open.fpvlabs.stera.ar_recorder.data.h264.H264Evidence
import open.fpvlabs.stera.ar_recorder.encoding.CameraTimestampGate
import open.fpvlabs.stera.ar_recorder.encoding.CpuImageTimestampGate
import open.fpvlabs.stera.ar_recorder.encoding.ContractFixtures
import open.fpvlabs.stera.ar_recorder.sensors.MotionSensorKind
import open.fpvlabs.stera.ar_recorder.sensors.RawMotionEvent
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.ByteArrayOutputStream
import java.io.File

/**
 * Drives the production contract writer through a full take with the public golden H.264 source. When
 * STATEACTION_H264_JVM_OUT is set, the produced files are copied there for the independent Python validator
 * (scripts/validate_h264_capture.py), which re-reads them with the official mcap reader and the SA-50 checker.
 */
class H264CaptureWriterTest {
    @get:Rule val temp = TemporaryFolder()
    private val start = byteArrayOf(0, 0, 0, 1)
    private val root = ContractFixtures.captureDir.parentFile.parentFile.parentFile
    private val assets = File(root, "packages/stera_recorder/android/src/main/assets/stateaction/capture")
    private val recordingId = "0b6f5e1c-3d2a-4c8e-9f1a-5e2d7c4b3a19" // version 4, variant 9
    private val nals = AnnexB.nals(File(ContractFixtures.captureDir, "golden/source/baseline-5.h264").readBytes())
    private val units: List<ByteArray> = listOf(join(0, 4)) + (4 until nals.size).map { join(it, it + 1) }
    private var clock = 1_800_000_000_000_000_000L

    private fun join(from: Int, to: Int) = ByteArrayOutputStream().apply { for (n in nals.subList(from, to)) { write(start); write(n) } }.toByteArray()

    private fun writer(
        file: File,
        simulation: Boolean = false,
        anchor: H264Evidence.Anchor = H264Evidence.Anchor(1_000_000_000L, 1_800_000_000_000_000_000L, 1_000_000_100L),
    ): Pair<MCAPWriter, H264CaptureWriter> {
        val mcap = MCAPWriter()
        assertTrue(mcap.open(file, profile = "", library = "test"))
        val profile = mutableMapOf<String, Any?>("recording_id" to recordingId,
            "rgb_profile" to if (simulation) "h264_mcap_simulation_v1" else "h264_mcap_v1",
            "qualification" to if (simulation) "simulation_only" else "unqualified",
            "encoder" to mapOf("codec" to "h264", "profile" to "main", "name" to "c2.test.avc.encoder", "hardware" to false,
                "width" to 640, "height" to 480, "fps" to 30, "bitrate" to 4_000_000, "b_frames" to 0, "idr_interval_seconds" to 1),
            "limits" to mapOf("pending_frames" to 4))
        if (simulation) profile["mapped_timeline_semantics"] = "simulation_transport_only"
        val capture = H264CaptureWriter(mcap, profile, H264Evidence.clocks(recordingId, anchor, H264Evidence.CAMERA_CLOCK, true),
            { File(assets, it).readBytes() }, { clock++ })
        capture.open()
        return mcap to capture
    }

    private val plan = H264Evidence.SensorPlan(H264Evidence.CAMERA_CLOCK, imuRequested = true, accelSupported = true,
        gyroSupported = true, depthRequested = true, depthSupported = false)

    private fun acquired(id: Long) = H264Evidence.acquired(recordingId, id, 1_000_000_000L + id * 33_333_333L,
        H264Evidence.CAMERA_CLOCK, 1_800_000_000_000_000_000L + id * 33_333_333L, id * 33_333L,
        arcoreFrameNs = 77_000L + id, arcoreImageNs = 1_000_000_000L + id * 33_333_333L, metadataSensorNs = if (id % 2 == 0L) 1_000_000_000L + id * 33_333_333L else null)

    private fun export(file: File) {
        System.getenv("STATEACTION_H264_JVM_OUT")?.let { File(it).apply { mkdirs() }.let { dir -> file.copyTo(File(dir, file.name), overwrite = true) } }
    }

    @Test fun completedTakeWritesOnlyContractChannelsAndExactCounts() {
        val file = temp.newFile("jvm_completed.mcap")
        val (mcap, capture) = writer(file)
        var unit = 0
        for (id in 0L until 6L) {
            val event = acquired(id)
            capture.frameEvent(event)
            capture.pose(event, if (id == 2L) "lost" else "tracking", if (id == 2L) null else floatArrayOf(0f, 0f, id.toFloat(), 0f, 0f, 0f, 1f))
            if (id == 3L) { capture.frameEvent(event + mapOf("state" to "dropped", "reason" to "codec_input_backpressure")); continue }
            capture.frameEvent(event + ("state" to "submitted"))
            val idr = capture.accessUnit(id, (event["mapped_capture_time_ns"] as String).toLong(), (event["encoder_pts_us"] as String).toLong(), units[unit++])
            assertEquals(id == 0L, idr)
        }
        val motion = (0L until 4L).flatMap { i ->
            listOf(RawMotionEvent(MotionSensorKind.ACCEL, i, 1_000_000_000L + i * 10_000_000L, 1_000_000_050L + i * 10_000_000L, 3, 0f, 9.81f, 0.1f),
                RawMotionEvent(MotionSensorKind.GYRO, i, 1_000_000_001L + i * 10_000_000L, 1_000_000_060L + i * 10_000_000L, null, 0.01f, -0.02f, 0f))
        }
        val (result, error) = capture.motionEvents(motion, { it + 1_799_999_999_000_000_000L })
        assertNull(error)
        assertEquals(8, result.written.size)
        val (sensors, calibrations) = H264Evidence.inventory(plan, capture.acquiredCount(),
            capture.motionCount(MotionSensorKind.ACCEL), capture.motionCount(MotionSensorKind.GYRO))
        val close = capture.close("completed", null, sensors, calibrations)
        mcap.finish()
        assertEquals("completed", close["outcome"])
        assertEquals(mapOf("accel" to "4", "gyro" to "4"), close["motion_events"])
        // After Close no event can be written; it is resolved as failed, never dropped silently.
        val (late, lateError) = capture.motionEvents(motion.take(1), { it })
        assertEquals(1, late.failed.size); assertNotNull(lateError)
        assertEquals(mapOf("acquired" to "6", "submitted" to "5", "written" to "5", "dropped" to "1", "unresolved" to "0"), close["frames"])
        assertEquals("5", close["video_messages"])
        assertEquals("6", close["sensor_events"])
        assertEquals(listOf(mapOf("reason" to "codec_input_backpressure", "count" to "1")), close["drops"])
        assertEquals(5L, capture.stats()["pose_messages"])
        assertEquals(1L, capture.stats()["invalid_pose_events"])
        val declaration = capture.sourceManifestEvidence()
        assertEquals(mapOf("video_frames" to "5", "dropped_video_frames" to "1", "motion_events" to "8"), declaration["counts"])
        val declaredChannels = declaration["channels"] as List<Map<String, Any?>>
        assertEquals("5", declaredChannels.single { it["topic"] == "/camera/rgb/video" }["message_count"])
        assertEquals("1", declaredChannels.single { it["topic"] == "/stateaction/close" }["message_count"])
        assertEquals(45L, declaredChannels.sumOf { (it["message_count"] as String).toLong() })
        assertTrue(declaredChannels.all { it["clock_domain"] == "unix" })
        assertTrue((declaration["clockDomains"] as List<*>).contains(H264Evidence.CAMERA_CLOCK))
        export(file)
    }

    @Test fun unresolvedFramesNeverCloseAsCompleted() {
        val file = temp.newFile("jvm_unresolved.mcap")
        val (mcap, capture) = writer(file, simulation = true)
        val first = acquired(0)
        capture.frameEvent(first); capture.frameEvent(first + ("state" to "submitted"))
        capture.accessUnit(0, (first["mapped_capture_time_ns"] as String).toLong(), 0, units[0])
        val second = acquired(1)
        capture.frameEvent(second); capture.frameEvent(second + ("state" to "submitted"))
        val (sensors, calibrations) = H264Evidence.inventory(plan, capture.acquiredCount())
        val close = capture.close("completed", null, sensors, calibrations)
        mcap.finish()
        assertEquals("failed", close["outcome"])
        assertThrows(IllegalStateException::class.java) { capture.sourceManifestEvidence() }
        assertEquals("unresolved_frames", close["failure_reason"])
        assertEquals("1", (close["frames"] as Map<*, *>)["unresolved"])
        export(file)
    }

    @Test fun pixelClockTupleReachesHardwareProfileWriterWithOriginalIdentity() {
        val cameraStart = 1_467_836_019_878_654L
        val frameStart = 1_467_836_032_984_466L
        val imageStart = 1_467_836_033_014_624L
        val intervalNs = 33_333_333L
        val cameraClock = CameraTimestampGate()
        val cpuImageTimestamps = CpuImageTimestampGate()
        val anchor = H264Evidence.Anchor(cameraStart, 1_800_000_000_000_000_000L, cameraStart)
        val pts = FramePts()
        val (mcap, capture) = writer(temp.newFile("jvm_pixel_clocks.mcap"), anchor = anchor)
        assertEquals("h264_mcap_v1", capture.profile["rgb_profile"])
        val expectedPtsUs = listOf(0L, 33_333L, 66_666L, 99_999L, 133_333L)
        for ((index, expectedPts) in expectedPtsUs.withIndex()) {
            // The first tuple was observed on a Pixel. Subsequent tuples use simulated motion at 30 Hz.
            val delta = index * intervalNs
            val cameraNs = cameraStart + delta
            val frameNs = frameStart + delta
            val imageNs = imageStart + delta
            val accepted = cameraClock.observe(frameNs, cameraNs, cameraNs, cameraNs)
                as CameraTimestampGate.Decision.Accept
            assertNotEquals("The previous hardware equality check rejects this tuple", accepted.cameraNs, imageNs)
            assertTrue(cpuImageTimestamps.accept(imageNs))
            assertFalse("A repeated image cannot borrow a new frame identity", cpuImageTimestamps.accept(imageNs))
            assertEquals(cameraNs, accepted.cameraNs)
            val encoderPts = pts.allocate(accepted.cameraNs, cameraStart)
            assertEquals(expectedPts, encoderPts)
            val mappedNs = anchor.map(accepted.cameraNs)
            val event = H264Evidence.acquired(
                recordingId, index.toLong(), accepted.cameraNs, H264Evidence.CAMERA_CLOCK, mappedNs, encoderPts,
                frameNs, imageNs, accepted.metadataSensorNs,
            )
            assertEquals(cameraNs.toString(), event["native_timestamp_ns"])
            assertEquals(mapOf(
                "arcore_image_timestamp_ns" to imageNs.toString(),
                "arcore_frame_timestamp_ns" to frameNs.toString(),
                "metadata_sensor_timestamp_ns" to cameraNs.toString(),
            ), event["native_timestamps"])
            capture.frameEvent(event)
            capture.frameEvent(event + ("state" to "submitted"))
            capture.accessUnit(index.toLong(), mappedNs, encoderPts, units[index])
        }
        val (sensors, calibrations) = H264Evidence.inventory(plan, capture.acquiredCount())
        val close = capture.close("completed", null, sensors, calibrations)
        mcap.finish()
        assertEquals("completed", close["outcome"])
        assertEquals("5", close["video_messages"])
    }

    @Test fun zeroVideoMessagesNeverCloseAsCompleted() {
        val (mcap, capture) = writer(temp.newFile("jvm_zero_video.mcap"))
        val (sensors, calibrations) = H264Evidence.inventory(plan, capture.acquiredCount())
        val close = capture.close("completed", null, sensors, calibrations)
        mcap.finish()
        assertEquals("failed", close["outcome"])
        assertEquals("no_rgb_frames_written", close["failure_reason"])
        assertEquals("0", close["video_messages"])
        assertThrows(IllegalStateException::class.java) { capture.sourceManifestEvidence() }
    }

    @Test fun identityAndOrderingViolationsAreRejected() {
        val (mcap, capture) = writer(temp.newFile("jvm_rejects.mcap"))
        val first = acquired(0)
        capture.frameEvent(first)
        // A predicted frame cannot start the video; an unknown source frame or changed PTS cannot be written.
        assertThrows(IllegalArgumentException::class.java) { capture.accessUnit(0, (first["mapped_capture_time_ns"] as String).toLong(), 0, units[1]) }
        assertThrows(IllegalStateException::class.java) { capture.accessUnit(9, 1, 0, units[0]) }
        assertThrows(IllegalArgumentException::class.java) { capture.accessUnit(0, (first["mapped_capture_time_ns"] as String).toLong(), 7, units[0]) }
        assertThrows(IllegalArgumentException::class.java) { capture.frameEvent(first) }
        assertThrows(IllegalArgumentException::class.java) { capture.frameEvent(first + ("encoder_pts_us" to "5") + ("state" to "submitted")) }
        assertThrows(IllegalArgumentException::class.java) { capture.pose(first, "tracking", floatArrayOf(Float.NaN, 0f, 0f, 0f, 0f, 0f, 1f)) }
        mcap.finish()
    }

    @Test fun profileAndIdentityPreconditionsFailClosed() {
        val mcap = MCAPWriter()
        assertTrue(mcap.open(temp.newFile("jvm_bad.mcap"), profile = "", library = "test"))
        val anchor = H264Evidence.Anchor(1, 1_800_000_000_000_000_000L, 2)
        assertThrows(IllegalArgumentException::class.java) {
            H264CaptureWriter(mcap, mapOf("recording_id" to "session_20261101"), H264Evidence.clocks("session_20261101", anchor, H264Evidence.CAMERA_CLOCK, true), { ByteArray(0) }, { 1 })
        }
        assertThrows(IllegalArgumentException::class.java) {
            H264CaptureWriter(mcap, mapOf("recording_id" to recordingId, "rgb_profile" to "h264_mcap_simulation_v1", "qualification" to "unqualified"),
                H264Evidence.clocks(recordingId, anchor, H264Evidence.CAMERA_CLOCK, true), { ByteArray(0) }, { 1 })
        }
        mcap.finish()
    }
}
