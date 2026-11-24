package open.fpvlabs.stera.ar_recorder.encoding

import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class CpuImageTimestampGateTest {
    @Test fun distinctCpuImageIsAcceptedAndRepeatedAcquisitionIsSkipped() {
        val gate = CpuImageTimestampGate()
        assertTrue(gate.accept(1_467_836_033_014_624))
        assertFalse(gate.accept(1_467_836_033_014_624))
        assertTrue(gate.accept(1_467_836_066_347_957))
    }

    @Test fun missingAndRegressingImageTimestampsFailClosed() {
        val gate = CpuImageTimestampGate()
        assertThrows(IllegalStateException::class.java) { gate.accept(0) }
        assertTrue(gate.accept(100))
        assertThrows(IllegalStateException::class.java) { gate.accept(99) }
        assertFalse(gate.accept(100))
    }
}
