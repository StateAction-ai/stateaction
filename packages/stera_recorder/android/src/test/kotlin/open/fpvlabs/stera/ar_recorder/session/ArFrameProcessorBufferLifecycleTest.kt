package open.fpvlabs.stera.ar_recorder.session

import org.junit.Assert.*
import org.junit.Test

class ArFrameProcessorBufferLifecycleTest {
    @Test fun previewControllerAllocatesNoRecordingPoolsAndDisabledStreamsStayEmpty() {
        val processor = ArFrameProcessorImpl()
        assertEquals(0, processor.getPointCloudPoolCapacity())
        assertEquals(0, processor.getDepthPoolCapacity())
        assertEquals(0, processor.getPointCloudPoolAvailableCount())
        processor.prepareForRecording(0, 0, 1024, 2048)
        assertEquals(0, processor.getPointCloudPoolCapacity())
        assertEquals(0, processor.getDepthPoolCapacity())
    }
    @Test fun releasedRecordingPoolsAreEmptyAndCanBePreparedForAnotherTake() {
        val processor = ArFrameProcessorImpl()
        processor.prepareForRecording(2, 3, 1024, 2048)
        assertEquals(2, processor.getPointCloudPoolAvailableCount())
        assertEquals(3, processor.getDepthPoolCapacity())
        processor.releaseRecordingBuffers()
        assertEquals(0, processor.getPointCloudPoolAvailableCount())
        assertEquals(0, processor.getDepthPoolCapacity())
        processor.prepareForRecording(1, 0, 1024, 2048)
        assertEquals(1, processor.getPointCloudPoolAvailableCount())
        assertEquals(0, processor.getDepthPoolCapacity())
    }
}
