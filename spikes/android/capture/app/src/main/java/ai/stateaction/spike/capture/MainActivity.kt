package ai.stateaction.spike.capture

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.WindowManager
import android.widget.*
import com.google.ar.core.ArCoreApk

class MainActivity: Activity() {
    private var engine: CaptureEngine?=null
    private lateinit var status: TextView
    private lateinit var start: Button
    private lateinit var stop: Button
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root=LinearLayout(this).apply { orientation=LinearLayout.VERTICAL; setPadding(32,20,32,20) }
        root.addView(TextView(this).apply { text="StateAction.ai • Android capture research spike"; textSize=22f })
        root.addView(TextView(this).apply { text="Start records your rear camera, raw accelerometer/gyro and ARCore pose/depth locally. No upload. Point at a scene you intend to record. Camera starts only after Start. This is an isolated prototype, not the collector app."; textSize=16f })
        val controls=LinearLayout(this)
        start=Button(this).apply { text="Start camera recording"; setOnClickListener { begin() } }
        stop=Button(this).apply { text="Stop and finalize"; isEnabled=false; setOnClickListener { engine?.requestStop(); isEnabled=false } }
        controls.addView(start); controls.addView(stop); root.addView(controls)
        status=TextView(this).apply { text="Ready. Requires physical ARCore Android device. Default 60 seconds; optional intent duration_seconds 10..1200.\nNo camera preview in this technical harness."; textSize=15f }
        root.addView(ScrollView(this).apply { addView(status) }); setContentView(root)
    }
    private fun begin() {
        if (checkSelfPermission(Manifest.permission.CAMERA)!=PackageManager.PERMISSION_GRANTED) { requestPermissions(arrayOf(Manifest.permission.CAMERA),40); return }
        try {
            if (ArCoreApk.getInstance().requestInstall(this,true)==ArCoreApk.InstallStatus.INSTALL_REQUESTED) { status.text="Install/update Google Play Services for AR, then press Start."; return }
            start.isEnabled=false; stop.isEnabled=true
            window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            engine=CaptureEngine(this,intent.getIntExtra("duration_seconds",60).coerceIn(10,1200),{ message -> runOnUiThread { status.text=message } },{ runOnUiThread { engine=null; start.isEnabled=true; stop.isEnabled=false; window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) } }).also { it.start() }
        } catch(e: Exception) { status.text="Cannot start: $e"; start.isEnabled=true; stop.isEnabled=false }
    }
    override fun onPause() { engine?.requestStop("activity_paused"); super.onPause() }
}
