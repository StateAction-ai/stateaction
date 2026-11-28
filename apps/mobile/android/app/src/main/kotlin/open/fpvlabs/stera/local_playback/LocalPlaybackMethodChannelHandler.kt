package open.fpvlabs.stera.local_playback

import android.content.Context
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel

internal class LocalPlaybackMethodChannelHandler(context: Context, messenger: BinaryMessenger) {
    private val playback: LocalPlayback = LocalPlaybackImpl(context)
    private val channel = MethodChannel(
        messenger, "local_recording_playback", io.flutter.plugin.common.StandardMethodCodec.INSTANCE,
        messenger.makeBackgroundTaskQueue(),
    )

    init {
        channel.setMethodCallHandler { call, result ->
            try {
                fun id() = checkNotNull(call.argument<String>("id"))
                when (call.method) {
                    "start" -> result.success(playback.start())
                    "append" -> {
                        playback.append(id(), checkNotNull(call.argument<ByteArray>("unit")),
                            checkNotNull(call.argument<Number>("ptsUs")).toLong(),
                            checkNotNull(call.argument<Int>("width")), checkNotNull(call.argument<Int>("height")))
                        result.success(null)
                    }
                    "finish" -> result.success(playback.finish(id()))
                    "discard" -> {
                        playback.discard(id())
                        result.success(null)
                    }
                    else -> result.notImplemented()
                }
            } catch (_: Exception) {
                result.error("LOCAL_PLAYBACK_FAILED", "Could not prepare this recording for playback.", null)
            }
        }
    }
}
