package ai.stateaction.spike.upload;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobParameters;
import android.app.job.JobService;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import java.util.concurrent.atomic.AtomicBoolean;

public final class UploadJobService extends JobService {
    static final int JOB_ID = 6201; static final int NOTICE_ID = 6201; static final String CHANNEL = "spike_upload";
    private AtomicBoolean ended;
    private Notification notification(String text) {
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent pause = PendingIntent.getBroadcast(this, 0, new Intent(this, PauseReceiver.class), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Builder(this, CHANNEL).setSmallIcon(android.R.drawable.stat_sys_upload)
                .setContentTitle("StateAction local upload SPIKE").setContentText(text).setContentIntent(open).setOngoing(true)
                .addAction(new Notification.Action.Builder(null, "Pause", pause).build()).build();
    }
    @Override public boolean onStartJob(JobParameters params) {
        ended = new AtomicBoolean(false); AtomicBoolean thisRun = ended;
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL, "Local upload spike", NotificationManager.IMPORTANCE_LOW));
        setNotification(params, NOTICE_ID, notification("Native worker; synthetic login/local storage"), JOB_END_NOTIFICATION_POLICY_REMOVE);
        Handler main = new Handler(Looper.getMainLooper());
        new Thread(() -> {
            try {
                if (params.getNetwork() == null) throw new IllegalStateException("job_network_unavailable");
                new UploadJournal(this).update(value -> { value.put("executionMode", "uidt"); value.put("jobStartedAtMs", String.valueOf(System.currentTimeMillis())); });
                NativeUploadEngine engine = new NativeUploadEngine(this, text -> main.post(() -> {
                    if (!thisRun.get()) manager.notify(NOTICE_ID, notification(text));
                }), params.getNetwork());
                engine.run();
            } catch (Exception error) {
                try { new UploadJournal(this).update(value -> value.put("lastJobError", error.getMessage())); } catch (Exception ignored) { }
            } finally {
                main.post(() -> { if (thisRun.compareAndSet(false, true)) jobFinished(params, false); });
            }
        }, "stateaction-spike-upload").start();
        return true;
    }
    @Override public boolean onStopJob(JobParameters params) {
        if (ended != null) ended.set(true);
        try { if (new UploadJournal(this).read().optString("state").equals("paused")) return false; } catch (Exception ignored) { }
        try { NativeUploadEngine.stopForSystem(this, "job_stop_reason_" + params.getStopReason()); } catch (Exception ignored) { }
        return true; // OS may retry; durable checkpoints also survive kills without this callback.
    }
}
