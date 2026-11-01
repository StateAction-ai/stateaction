package open.fpvlabs.stera.ar_recorder.data

import open.fpvlabs.stera.ar_recorder.data.h264.*
import org.junit.Assert.*
import org.junit.Test

class H264ProtocolTest {
    private fun frame(id: Long, pts: Long = id * 33_333): Map<String, Any?> = mapOf(
        "recording_id" to "test", "stream_id" to "rgb", "source_frame_id" to id.toString(), "state" to "acquired",
        "native_timestamp_ns" to (1_000_000_000L + pts * 1000).toString(), "native_clock_id" to "android.camera.sensor_timestamp",
        "mapped_capture_time_ns" to (1_800_000_000_000_000_000L + pts * 1000).toString(),
        "clock_mapping_revision" to "fixed", "calibration_id" to "rgb", "encoder_pts_us" to pts.toString(),
        "encoder_time_base" to CaptureProtocol.TIME_BASE, "native_timestamps" to mapOf("image_ns" to "9", "frame_ns" to "10"))

    private fun failure(block: () -> Unit) { try { block(); fail("Expected rejection") } catch (_: IllegalArgumentException) {} catch (_: IllegalStateException) {} }

    @Test fun originalNanosecondsSurvivePtsQuantizationAndDelayedOutput() {
        val ledger = H264FrameLedger("test")
        val original = frame(0) + ("native_timestamp_ns" to "1000000007")
        ledger.acceptEvent(original)
        ledger.acceptEvent(original + ("state" to "submitted"))
        ledger.acceptEvent(frame(1))
        val written = ledger.writtenEvent(0, 1_800_000_000_000_000_000L, 0, 0, true)
        assertEquals("1000000007", written["native_timestamp_ns"])
        assertEquals("0", written["source_frame_id"])
        ledger.acceptWritten(0, 0)
        assertEquals(listOf("1"), ledger.unresolvedIds())
        assertEquals(1L, ledger.stats()["written"])
    }

    @Test fun missingAndChangedIdentityCannotBeMatchedByCallbackOrder() {
        val ledger = H264FrameLedger("test"); ledger.acceptEvent(frame(0))
        failure { ledger.writtenEvent(1, 1_800_000_000_000_000_000L, 0, 0, true) }
        failure { ledger.writtenEvent(0, 1_800_000_000_000_000_001L, 0, 0, true) }
        failure { ledger.acceptEvent(frame(0) + mapOf("state" to "submitted", "encoder_pts_us" to "1")) }
        failure { ledger.writtenEvent(0, 1_800_000_000_000_000_000L, 1, 0, true) }
    }

    @Test fun pendingJoinBoundAndDuplicatePtsAreFinite() {
        val ledger = H264FrameLedger("test")
        repeat(4) { ledger.acceptEvent(frame(it.toLong())) }
        failure { ledger.acceptEvent(frame(4)) }
        assertEquals(4, ledger.stats()["pending_high_water"])
        val second = H264FrameLedger("test"); second.acceptEvent(frame(0))
        failure { second.acceptEvent(frame(1, 0)) }
    }

    @Test fun everyAcquisitionHasOnlyOneTerminalOutcome() {
        val ledger = H264FrameLedger("test"); val first = frame(0)
        ledger.acceptEvent(first); ledger.acceptEvent(first + mapOf("state" to "dropped", "reason" to "backpressure"))
        failure { ledger.acceptEvent(first + mapOf("state" to "dropped", "reason" to "again")) }
        failure { ledger.writtenEvent(0, 1_800_000_000_000_000_000L, 0, 0, true) }
        assertEquals(1L, ledger.stats()["dropped"])
        assertTrue(ledger.unresolvedIds().isEmpty())
    }

    @Test fun requiredMappedCaptureTimeCannotBeMissingOrNativeSubstituted() {
        val ledger = H264FrameLedger("test")
        failure { ledger.acceptEvent(frame(0) - "mapped_capture_time_ns") }
        failure { ledger.acceptEvent(frame(0) + ("mapped_capture_time_ns" to 123L)) }
        failure { ledger.acceptEvent(frame(0) + ("mapped_capture_time_ns" to "0")) }
    }

    @Test fun simulationProfileCannotMasqueradeAsProduction() {
        failure { CaptureProtocol.profile(mapOf("recording_id" to "test", "rgb_profile" to CaptureProtocol.EMULATOR_PROFILE)) }
        val profile = CaptureProtocol.profile(mapOf("recording_id" to "test", "rgb_profile" to CaptureProtocol.EMULATOR_PROFILE,
            "qualification" to "simulation_only", "mapped_timeline_semantics" to "simulation_transport_only", "production_qualified" to true))
        assertEquals(false, profile["production_qualified"])
        assertEquals(CaptureProtocol.EMULATOR_PROFILE, profile["rgb_profile"])
    }

    @Test fun malformedAndConfigurationOnlyVideoIsRejected() {
        failure { AnnexB.validateAccessUnit(byteArrayOf(0, 0, 0, 1, 0x67, 1)) }
        failure { AnnexB.validateAccessUnit(byteArrayOf(1, 2, 3)) }
        failure { AnnexB.validateAccessUnit(byteArrayOf(0, 0, 0, 1, 0x65, 0xB8.toByte())) } // IDR without SPS/PPS
        failure { AnnexB.validateAccessUnit(byteArrayOf(0, 0, 0, 1, 0x41, 0xA0.toByte())) } // B slice (first_mb=0,slice_type=1)
    }

    @Test fun strictJsonPreservesEscapesAndRejectsNonfiniteValues() {
        assertEquals("{\"ns\":\"1800000000000000001\",\"text\":\"a\\n\\u0000\"}",
            CaptureProtocol.json(mapOf("ns" to "1800000000000000001", "text" to "a\n\u0000")))
        failure { CaptureProtocol.json(mapOf("bad" to Double.NaN)) }
    }

    @Test fun newCdrFieldAndDependencyReferencesUseRosMessageSyntax() {
        for (source in listOf(ROS2SchemaDefinitions.POSE_STAMPED_SCHEMA, ROS2SchemaDefinitions.IMU_SCHEMA,
            ROS2SchemaDefinitions.IMAGE_SCHEMA, ROS2SchemaDefinitions.POINT_CLOUD_2_SCHEMA,
            ROS2SchemaDefinitions.MARKER_SCHEMA, ROS2SchemaDefinitions.CAMERA_INFO_SCHEMA,
            ROS2SchemaDefinitions.TF_MESSAGE_SCHEMA, ROS2SchemaDefinitions.PATH_SCHEMA,
            ROS2SchemaDefinitions.DEVICE_METRICS_SCHEMA)) {
            val portable = ROS2SchemaDefinitions.portableMessageDefinition(source)
            assertFalse(portable.contains("/msg/"))
            assertTrue(portable.contains("MSG: std_msgs/Header"))
            assertTrue(portable.contains("builtin_interfaces/Time stamp"))
            // Preserve historical definitions for the explicit legacy profile.
            assertTrue(source.contains("std_msgs/msg/Header"))
        }
    }

    @Test fun oneAccessUnitCannotContainTwoFirstSlicesWithoutAudDelimiters() {
        // first_mb=0, slice_type=P(0), trailing bits; no AUD is needed to detect two images.
        val predicted = byteArrayOf(0x41, 0xE0.toByte())
        val laterSlice = byteArrayOf(0x41, 0x58) // first_mb=1, slice_type=P(0)
        assertFalse(AnnexB.validateAccessUnit(AnnexB.join(listOf(predicted))))
        assertFalse(AnnexB.validateAccessUnit(AnnexB.join(listOf(predicted, laterSlice))))
        failure { AnnexB.validateAccessUnit(AnnexB.join(listOf(predicted, predicted))) }
        failure { AnnexB.validateAccessUnit(AnnexB.join(listOf(laterSlice))) }
    }

    @Test fun idrParameterSetsMustPrecedeTheImage() {
        val sps = byteArrayOf(0x67, 77, 0, 40)
        val pps = byteArrayOf(0x68, 1)
        val image = byteArrayOf(0x65, 0xB8.toByte()) // first_mb=0, slice_type=I(2)
        assertTrue(AnnexB.validateAccessUnit(AnnexB.join(listOf(sps, pps, image))))
        failure { AnnexB.validateAccessUnit(AnnexB.join(listOf(image, sps, pps))) }
    }
}
