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
            context.getSharedPreferences("spike", 0).edit().putString("baseUrl", arguments.getString("fixtureUrl", "http://127.0.0.1:8787")).commit();
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
            result.putString("result", "PASS"); result.putString("mode", "direct_native_engine_not_uidt");
            result.putString("journal", journal.toString()); result.putBoolean("realGoogle", false); result.putBoolean("realProvider", false);
            finish(Activity.RESULT_OK, result);
        } catch (Throwable error) {
            result.putString("result", "FAIL"); result.putString("error", error.getClass().getSimpleName() + ":" + error.getMessage()); finish(Activity.RESULT_CANCELED, result);
        }
    }
}
