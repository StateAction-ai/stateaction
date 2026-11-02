package open.fpvlabs.stera.ar_recorder.data.h264

/**
 * Everything the dataset writer needs to open an H.264 recording before its MCAP file exists. [inventory] is
 * evaluated once at close with the observed counts, so the Inventory reports observed state.
 */
class H264CaptureSetup(
    val profile: Map<String, Any?>,
    val clocks: Map<String, Any?>,
    val inventory: (acquiredFrames: Long, accelEvents: Long, gyroEvents: Long) -> Pair<List<Map<String, Any?>>, List<Map<String, Any?>>>,
)
