package ai.stateaction.spike.upload;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Context;
import android.os.Bundle;
import org.json.JSONObject;

/** Explicit direct-engine test: proves native control/I/O, NOT UIDT scheduling or Google. */
public final class SpikeInstrumentation extends Instrumentation {
    private Bundle arguments;
    @Override public void onCreate(Bundle arguments) { super.onCreate(arguments); this.arguments = arguments; start(); }
    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            Context context = getTargetContext();
            String scenario = arguments.getString("scenario", "direct");
            context.getSharedPreferences("spike", 0).edit().putString("baseUrl", arguments.getString("fixtureUrl", "http://127.0.0.1:8787")).commit();
            if (scenario.equals("interrupt")) { interruptAndResume(context, result); finish(Activity.RESULT_OK, result); return; }
            ControlClient client = new ControlClient(context); client.login("synthetic-a");
            if (!client.request("/api/v1/me", null).getString("userId").equals("synthetic-a")) throw new AssertionError("me_identity");
            NativeUploadEngine.prepareFixture(context);
            String originalOwner = new UploadJournal(context).read().getString("ownerId");
            client.login("synthetic-b"); boolean refused = false;
            try { NativeUploadEngine.prepareFixture(context); } catch (IllegalStateException error) { refused = error.getMessage().equals("original_owner_required"); }
            if (!refused || !new UploadJournal(context).read().getString("ownerId").equals(originalOwner)) throw new AssertionError("owner_isolation");
            client.login("synthetic-a"); new UploadJournal(context).state("ready", "instrumentation_direct_native_engine");
            new UploadJournal(context).update(value -> value.put("executionMode", "direct_instrumentation"));
            String outcome = new NativeUploadEngine(context, text -> { }).run();
            if (!outcome.equals("uploaded")) throw new AssertionError("not_uploaded");
            JSONObject journal = new UploadJournal(context).read(); JSONObject metrics = journal.getJSONObject("metrics");
            if (metrics.getLong("maxActivePuts") > 2 || metrics.getLong("maxTemporaryChunks") > 3 || metrics.getLong("maxTemporaryBytes") > 3 * NativeUploadEngine.PART_BYTES) throw new AssertionError("bounds");
            assertNoPlaintextSecrets(context);
            result.putString("result", "PASS"); result.putString("mode", "direct_native_engine_not_uidt");
            result.putString("journal", journal.toString()); result.putBoolean("realGoogle", false); result.putBoolean("realProvider", false);
            finish(Activity.RESULT_OK, result);
        } catch (Throwable error) {
            result.putString("result", "FAIL"); result.putString("error", error.getClass().getSimpleName() + ":" + error.getMessage()); finish(Activity.RESULT_CANCELED, result);
        }
    }

    /** The Keystore-backed cookie file and the journal must never expose a session token or cookie name. */
    private static void assertNoPlaintextSecrets(Context context) throws Exception {
        java.io.File[] files = context.getNoBackupFilesDir().listFiles(); if (files == null) throw new AssertionError("no_files");
        boolean vaultSeen = false;
        for (java.io.File file : files) {
            if (!file.isFile() || file.length() > 1024 * 1024) continue;
            String text = new String(java.nio.file.Files.readAllBytes(file.toPath()), java.nio.charset.StandardCharsets.ISO_8859_1);
            if (file.getName().equals("cookies.enc")) vaultSeen = true;
            if (text.contains("spike_session") || text.contains("spike_aux") || text.contains("Set-Cookie")) throw new AssertionError("plaintext_secret_in_" + file.getName());
        }
        if (!vaultSeen) throw new AssertionError("encrypted_cookie_vault_missing");
    }

    private static String waitForState(UploadJournal journal, String wanted, long timeoutMs) throws Exception {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            JSONObject value = journal.read();
            if (value.optString("state").equals(wanted) && value.optJSONObject("metrics") != null && value.getJSONObject("metrics").optLong("maxActivePuts") >= 1 && value.getJSONObject("receipts").length() >= 1) return wanted;
            Thread.sleep(100);
        }
        throw new AssertionError("timeout_waiting_for_" + wanted);
    }

    /**
     * Account switch while PUTs are active: pause preserves original-owner journal and landed receipts, another
     * account (and a signed-out client) cannot adopt it, and same-owner reauthentication resumes without re-sending
     * landed parts. Needs a slowed fixture (SPIKE_CHUNK_DELAY_MS) so the interruption lands mid-transfer.
     */
    private static void interruptAndResume(Context context, Bundle result) throws Exception {
        ControlClient client = new ControlClient(context); client.login("synthetic-a");
        NativeUploadEngine.prepareFixture(context);
        UploadJournal journal = new UploadJournal(context);
        java.util.concurrent.ExecutorService pool = java.util.concurrent.Executors.newSingleThreadExecutor();
        java.util.concurrent.Future<String> first = pool.submit(() -> new NativeUploadEngine(context, text -> { }).run());
        waitForState(journal, "uploading", 120000);
        // Same ordering as MainActivity.login(): pause first, then change account.
        NativeUploadEngine.pause(context, "account_change"); client.login("synthetic-b");
        String firstOutcome;
        try { firstOutcome = first.get(60, java.util.concurrent.TimeUnit.SECONDS); } catch (java.util.concurrent.ExecutionException error) { firstOutcome = error.getCause().getMessage(); }
        pool.shutdownNow();
        if (firstOutcome.equals("uploaded")) throw new AssertionError("interrupt_missed_upload_finished");
        JSONObject paused = journal.read();
        if (!paused.getString("state").equals("paused") || !paused.getString("ownerId").equals("synthetic-a")) throw new AssertionError("paused_owner_journal_not_preserved");
        int landedBeforeResume = paused.getJSONObject("receipts").length();
        if (landedBeforeResume < 1) throw new AssertionError("no_landed_part_before_interrupt");
        boolean denied = false;
        try { new NativeUploadEngine(context, text -> { }).run(); } catch (Exception error) { denied = error.getMessage().equals("original_owner_required"); }
        if (!denied) throw new AssertionError("other_account_adopted_journal");
        client.logout();
        denied = false;
        try { new NativeUploadEngine(context, text -> { }).run(); } catch (Exception error) { denied = error.getMessage().equals("original_owner_required"); }
        if (!denied || !client.owner().isEmpty()) throw new AssertionError("signed_out_run_not_denied");
        if (!new java.io.File(context.getNoBackupFilesDir(), "synthetic-source.bin").isFile()) throw new AssertionError("source_removed_on_logout");
        client.login("synthetic-a"); journal.state("scheduled", "resume_after_same_owner_reauth");
        String outcome = new NativeUploadEngine(context, text -> { }).run();
        if (!outcome.equals("uploaded")) throw new AssertionError("resume_not_uploaded");
        JSONObject done = journal.read(); JSONObject metrics = done.getJSONObject("metrics");
        if (metrics.getLong("maxActivePuts") > 2 || metrics.getLong("maxTemporaryChunks") > 3 || metrics.getLong("reconciliations") < 2) throw new AssertionError("resume_bounds_or_reconcile");
        assertNoPlaintextSecrets(context);
        result.putString("result", "PASS"); result.putString("mode", "direct_native_engine_interrupt_resume_not_uidt");
        result.putInt("landedPartsBeforeResume", landedBeforeResume); result.putString("firstRunOutcome", firstOutcome);
        result.putString("journal", done.toString()); result.putBoolean("realGoogle", false); result.putBoolean("realProvider", false);
    }
}
