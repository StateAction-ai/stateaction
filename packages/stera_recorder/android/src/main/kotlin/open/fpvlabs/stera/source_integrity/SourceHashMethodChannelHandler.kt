package open.fpvlabs.stera.source_integrity

import android.os.Handler
import android.os.Looper
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Channel `ai.stateaction/source_hash`: `hash({token, root, relativePath,
 * chunkBytes, maxBytes})` (bounds in [SourceHashArgs]; violations and live
 * duplicate tokens reply `bad_args`) runs on a worker thread (bounded memory: one chunk)
 * and replies on the platform thread; `cancel({token})` stops it.
 * [hasherFactory] is created per call so an unsupported OS version reports
 * `unsupported` instead of weakening identity.
 */
class SourceHashMethodChannelHandler(
    messenger: BinaryMessenger,
    private val hasherFactory: (SourceReadIdentity?) -> SourceHasher = { ConfinedFdHasher(AndroidFdOps(), it) },
    private val executor: ExecutorService = Executors.newSingleThreadExecutor(),
) : MethodChannel.MethodCallHandler {
    private val channel = MethodChannel(messenger, CHANNEL)
    private val main = Handler(Looper.getMainLooper())
    private val cancels = ConcurrentHashMap<String, AtomicBoolean>()

    init {
        channel.setMethodCallHandler(this)
    }

    fun dispose() {
        channel.setMethodCallHandler(null)
        cancels.values.forEach { it.set(true) }
        executor.shutdown()
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        when (call.method) {
            "cancel" -> {
                // Unknown/finished token: no-op. Dart sends `cancel` only after `hash`
                // on the same ordered channel, so a live token is always registered.
                val t = (call.arguments as? Map<*, *>)?.get("token")
                if (t is String) cancels[t]?.set(true)
                result.success(null)
            }
            "hash" -> hash(call, result)
            else -> result.notImplemented()
        }
    }

    private fun hash(call: MethodCall, result: MethodChannel.Result) {
        val args = try {
            SourceHashArgs.parse(call.arguments)
        } catch (e: SourceHashArgs.Invalid) {
            return result.error("bad_args", e.message, null)
        }
        val cancelled = AtomicBoolean(false)
        // Duplicate live token: refuse, and never overwrite the running call's flag.
        if (cancels.putIfAbsent(args.token, cancelled) != null) {
            return result.error("bad_args", "duplicate token ${args.token}", null)
        }
        try {
            executor.execute {
                var reply: () -> Unit
                try {
                    val o = hasherFactory(args.expectedSource).hash(args.root, args.relativePath, args.chunkBytes, args.maxBytes) {
                        cancelled.get()
                    }
                    val map = mapOf(
                        "sha256" to o.sha256,
                        "sizeBytes" to o.sizeBytes.toString(),
                        "peakBufferBytes" to o.peakBufferBytes.toString(),
                        "chunkCount" to o.chunkCount.toString(),
                    ) + o.identity.toJson()
                    reply = { result.success(map) }
                } catch (e: SourceHashException) {
                    reply = { result.error(e.code, e.message, e.details) }
                } catch (e: Throwable) {
                    reply = { result.error("unsupported", e.message, null) }
                } finally {
                    cancels.remove(args.token, cancelled)
                }
                main.post(reply)
            }
        } catch (e: RejectedExecutionException) {
            // Disposed/shut-down executor: reply now so no method result stays pending.
            cancels.remove(args.token, cancelled)
            result.error("unsupported", "source hash executor unavailable", null)
        }
    }

    companion object {
        const val CHANNEL = "ai.stateaction/source_hash"
    }
}
