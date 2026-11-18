package open.fpvlabs.stera.ar_recorder

import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.BinaryMessenger
import open.fpvlabs.stera.source_integrity.SourceHashMethodChannelHandler
import open.fpvlabs.stera.upload.NativeUploadMethodChannelHandler
import open.fpvlabs.stera.upload.VisibilityTracker
import io.flutter.view.TextureRegistry

/**
 * Registers the AR recorder method channel.
 *
 * The recorder needs an [android.app.Activity] (ARCore sessions are bound to
 * one) plus the engine's texture registry, so the handler is built on activity
 * attach and disposed on detach — the same window the host app's
 * `MainActivity.configureFlutterEngine`/`onDestroy` used before this moved into
 * a plugin.
 */
class SteraRecorderPlugin : FlutterPlugin, ActivityAware {

    private var binaryMessenger: BinaryMessenger? = null
    private var textureRegistry: TextureRegistry? = null
    private var handler: ArRecorderMethodChannelHandler? = null
    private var sourceHash: SourceHashMethodChannelHandler? = null
    private var nativeUpload: NativeUploadMethodChannelHandler? = null
    private var visibility: VisibilityTracker? = null
    private var application: android.app.Application? = null

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        binaryMessenger = binding.binaryMessenger
        textureRegistry = binding.textureRegistry
        sourceHash = SourceHashMethodChannelHandler(binding.binaryMessenger)
        // SA-57: native OS-scheduled upload bridge. Gated off by default (manifest meta-data).
        val app = binding.applicationContext.applicationContext as android.app.Application
        val tracker = VisibilityTracker()
        app.registerActivityLifecycleCallbacks(tracker)
        application = app
        visibility = tracker
        nativeUpload = NativeUploadMethodChannelHandler(binding.binaryMessenger, app, tracker)
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        disposeHandler()
        sourceHash?.dispose()
        sourceHash = null
        nativeUpload?.dispose()
        nativeUpload = null
        visibility?.let { application?.unregisterActivityLifecycleCallbacks(it) }
        visibility = null
        application = null
        binaryMessenger = null
        textureRegistry = null
    }

    override fun onAttachedToActivity(binding: ActivityPluginBinding) {
        // An activity that started before this plugin could observe it (cached engine, re-attach) is still visible.
        visibility?.seed(binding.activity)
        val messenger = binaryMessenger ?: return
        val textures = textureRegistry ?: return
        handler = ArRecorderMethodChannelHandler(binding.activity, messenger, textures)
    }

    override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) {
        onAttachedToActivity(binding)
    }

    override fun onDetachedFromActivityForConfigChanges() {
        disposeHandler()
    }

    override fun onDetachedFromActivity() {
        disposeHandler()
    }

    private fun disposeHandler() {
        handler?.let {
            println("🧹 SteraRecorderPlugin: Disposing AR recorder")
            it.dispose()
        }
        handler = null
    }
}
