package ai.stateaction.sourceprobe

import android.app.Service
import android.content.Intent
import android.os.IBinder
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.embedding.engine.dart.DartExecutor

/** Hosts a headless FlutterEngine that runs the Dart probe (`lib/main.dart`). */
class ProbeService : Service() {
    private var engine: FlutterEngine? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (engine == null) {
            // Constructing the engine registers all pubspec plugins, including
            // stera_recorder's SteraRecorderPlugin (source_hash channel handler).
            val e = FlutterEngine(applicationContext)
            e.dartExecutor.executeDartEntrypoint(DartExecutor.DartEntrypoint.createDefault())
            engine = e
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        engine?.destroy()
        engine = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}
