package ai.stateaction.spike.upload;

import android.content.Context;
import android.util.AtomicFile;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/** One source, immutable owner/content identity; transport epoch is independent. */
final class UploadJournal {
    static final Object LOCK = new Object();
    private final AtomicFile file;
    interface Mutation { void apply(JSONObject value) throws Exception; }
    UploadJournal(Context context) { file = new AtomicFile(new File(context.getNoBackupFilesDir(), "upload-journal.json")); }
    JSONObject read() throws Exception { synchronized (LOCK) { return file.getBaseFile().exists() ? new JSONObject(new String(file.readFully(), StandardCharsets.UTF_8)) : new JSONObject(); } }
    void update(Mutation mutation) throws Exception { synchronized (LOCK) { JSONObject value = read(); mutation.apply(value); write(value); } }
    void write(JSONObject value) throws Exception {
        synchronized (LOCK) {
            FileOutputStream output = file.startWrite();
            try { output.write(value.toString(2).getBytes(StandardCharsets.UTF_8)); file.finishWrite(output); }
            catch (Exception error) { file.failWrite(output); throw error; }
        }
    }
    void state(String state, String reason) throws Exception { update(value -> { value.put("state", state); value.put("reason", reason); value.put("updatedAtMs", String.valueOf(System.currentTimeMillis())); }); }
}
