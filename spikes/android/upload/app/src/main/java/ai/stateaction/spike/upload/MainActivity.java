package ai.stateaction.spike.upload;

import android.Manifest;
import android.app.Activity;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.pm.PackageManager;
import android.net.NetworkCapabilities;
import android.net.NetworkRequest;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import org.json.JSONObject;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class MainActivity extends Activity {
    private final ExecutorService actions = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper()); private TextView status; private EditText base;
    private CheckBox wifi, charging; private boolean visible; private boolean autoStarted;
    private final Runnable refresh = new Runnable() { public void run() { if (visible) { showState(); main.postDelayed(this, 1000); } } };
    private interface Action { void run() throws Exception; }
    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        String configuredUrl = getIntent().getStringExtra("fixtureUrl");
        if (configuredUrl != null) getSharedPreferences("spike", 0).edit().putString("baseUrl", configuredUrl).commit();
        LinearLayout layout = new LinearLayout(this); layout.setOrientation(LinearLayout.VERTICAL); layout.setPadding(24, 24, 24, 24);
        TextView title = new TextView(this); title.setText("StateAction Android upload SPIKE\nSynthetic accounts + local simulated provider. No Google login, no R2. Android 14+ only."); layout.addView(title);
        base = new EditText(this); base.setSingleLine(); base.setText(getSharedPreferences("spike", 0).getString("baseUrl", "http://127.0.0.1:8787")); layout.addView(base);
        button(layout, "Save local fixture URL", () -> {
            if (NativeUploadEngine.RUNNING.get()) throw new IllegalStateException("pause_before_reconfigure");
            getSharedPreferences("spike", 0).edit().putString("baseUrl", base.getText().toString().trim()).commit(); new ControlClient(this);
        });
        wifi = new CheckBox(this); wifi.setText("Unmetered network only (explicit override if unchecked)"); wifi.setChecked(getIntent().hasExtra("unmeteredOnly") ? getIntent().getBooleanExtra("unmeteredOnly", true) : getSharedPreferences("spike", 0).getBoolean("wifi", true)); layout.addView(wifi);
        charging = new CheckBox(this); charging.setText("Require charging (explicit override if unchecked)"); charging.setChecked(getIntent().hasExtra("requireCharging") ? getIntent().getBooleanExtra("requireCharging", true) : getSharedPreferences("spike", 0).getBoolean("charging", true)); layout.addView(charging);
        button(layout, "Fixture login: synthetic-a", () -> login("synthetic-a"));
        button(layout, "Fixture login: synthetic-b (owner-isolation test)", () -> login("synthetic-b"));
        button(layout, "Prepare immutable 128 MiB + 12,345-byte fixture", () -> NativeUploadEngine.prepareFixture(this));
        Button upload = new Button(this); upload.setText("Upload / Resume (visible user action)"); layout.addView(upload);
        upload.setOnClickListener(view -> { try { schedule(); } catch (Exception error) { status.setText("Cannot schedule: " + error.getMessage()); } });
        button(layout, "Pause upload", () -> { NativeUploadEngine.pause(this, "user_paused"); getSystemService(JobScheduler.class).cancel(UploadJobService.JOB_ID); });
        button(layout, "Sign out (preserves source + owner journal)", () -> { NativeUploadEngine.pause(this, "logout"); getSystemService(JobScheduler.class).cancel(UploadJobService.JOB_ID); new ControlClient(this).logout(); });
        status = new TextView(this); status.setTextIsSelectable(true); layout.addView(status);
        ScrollView scroll = new ScrollView(this); scroll.addView(layout); setContentView(scroll);
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
    }
    private void button(LinearLayout layout, String label, Action action) {
        Button button = new Button(this); button.setText(label); layout.addView(button);
        button.setOnClickListener(view -> actions.submit(() -> { try { action.run(); main.post(this::showState); }
            catch (Exception error) { main.post(() -> status.setText("Action needs attention: " + error.getMessage())); } }));
    }
    private void login(String owner) throws Exception {
        NativeUploadEngine.pause(this, "account_change"); getSystemService(JobScheduler.class).cancel(UploadJobService.JOB_ID); new ControlClient(this).login(owner);
    }
    private void schedule() throws Exception {
        if (!visible) throw new IllegalStateException("visible_activity_required");
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) throw new IllegalStateException("notification_permission_required");
        if (NativeUploadEngine.RUNNING.get()) throw new IllegalStateException("already_running_or_stopping");
        UploadJournal journal = new UploadJournal(this); JSONObject value = journal.read();
        if (!value.has("clientUploadId")) throw new IllegalStateException("prepare_fixture_first");
        if (!value.getString("ownerId").equals(new ControlClient(this).owner())) throw new IllegalStateException("original_owner_required");
        if (value.optString("state").equals("uploaded")) throw new IllegalStateException("already_uploaded");
        getSharedPreferences("spike", 0).edit().putBoolean("wifi", wifi.isChecked()).putBoolean("charging", charging.isChecked()).commit();
        NetworkRequest.Builder network = new NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
        if (wifi.isChecked()) network.addCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED);
        JobInfo job = new JobInfo.Builder(UploadJobService.JOB_ID, new ComponentName(this, UploadJobService.class))
                .setUserInitiated(true).setRequiredNetwork(network.build()).setRequiresCharging(charging.isChecked())
                .setEstimatedNetworkBytes(1024 * 1024, Long.parseLong(value.getString("sizeBytes"))).build();
        journal.state("scheduled", "waiting_for_constraints_or_os");
        if (getSystemService(JobScheduler.class).schedule(job) != JobScheduler.RESULT_SUCCESS) { journal.state("attention", "uidt_schedule_rejected_resume_from_visible_activity"); throw new IllegalStateException("uidt_schedule_rejected"); }
        showState();
    }
    private void showState() {
        try { JSONObject journal = new UploadJournal(this).read(); String owner = new ControlClient(this).owner();
            if (!journal.optString("ownerId", owner).equals(owner)) status.setText("Signed in as " + owner + ". Original-owner journal is hidden. Sign in as its owner to resume.");
            else status.setText("Signed in: " + (owner.isEmpty() ? "none" : owner) + "\n" + journal.toString(2));
        } catch (Exception error) { status.setText("State unavailable: " + error.getClass().getSimpleName()); }
    }
    @Override public void onResume() {
        super.onResume(); visible = true; main.post(refresh);
        if (getIntent().getBooleanExtra("spikeAuto", false) && !autoStarted) {
            autoStarted = true;
            actions.submit(() -> { try {
                login("synthetic-a"); NativeUploadEngine.prepareFixture(this);
                main.post(() -> { try { schedule(); } catch (Exception error) { status.setText("Auto schedule needs attention: " + error.getMessage()); } });
            } catch (Exception error) { main.post(() -> status.setText("Auto setup needs attention: " + error.getMessage())); } });
        }
    }
    @Override public void onPause() { visible = false; main.removeCallbacks(refresh); super.onPause(); }
}
