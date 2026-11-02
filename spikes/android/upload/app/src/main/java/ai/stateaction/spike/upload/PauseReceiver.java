package ai.stateaction.spike.upload;

import android.app.job.JobScheduler;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

public final class PauseReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        try { NativeUploadEngine.pause(context, "user_paused"); } catch (Exception ignored) { }
        context.getSystemService(JobScheduler.class).cancel(UploadJobService.JOB_ID);
    }
}
