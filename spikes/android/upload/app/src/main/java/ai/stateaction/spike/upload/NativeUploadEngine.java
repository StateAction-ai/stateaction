package ai.stateaction.spike.upload;

import android.content.Context;
import android.os.StatFs;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Deque;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** Isolated native feasibility implementation. File bytes never enter Flutter. */
final class NativeUploadEngine {
    static final long PART_BYTES = 64L * 1024 * 1024;
    static final long SOURCE_BYTES = 2 * PART_BYTES + 12345;
    static final AtomicBoolean RUNNING = new AtomicBoolean(false);
    static volatile NativeUploadEngine current;
    interface Progress { void update(String text); }
    private final Context context; private final UploadJournal journal; private final ControlClient api;
    private final AtomicBoolean stopped = new AtomicBoolean(false);
    private final Set<HttpURLConnection> connections = ConcurrentHashMap.newKeySet();
    private final Progress progress;
    private final File scratch;
    private String owner; private String fileId; private int epoch;
    NativeUploadEngine(Context context, Progress progress) throws Exception { this(context, progress, null); }
    NativeUploadEngine(Context context, Progress progress, android.net.Network network) throws Exception {
        this.context = context.getApplicationContext(); this.progress = progress; journal = new UploadJournal(context); api = new ControlClient(context, network);
        scratch = new File(context.getNoBackupFilesDir(), "chunks"); if (!scratch.isDirectory() && !scratch.mkdirs()) throw new IllegalStateException("scratch_unavailable");
    }
    static void pause(Context context, String reason) throws Exception {
        new UploadJournal(context).state("paused", reason);
        NativeUploadEngine running = current; if (running != null) { running.stopped.set(true); for (HttpURLConnection connection : running.connections) connection.disconnect(); }
    }
    static void stopForSystem(Context context, String reason) throws Exception {
        new UploadJournal(context).state("waiting_os", reason);
        NativeUploadEngine running = current; if (running != null) { running.stopped.set(true); for (HttpURLConnection connection : running.connections) connection.disconnect(); }
    }
    static String digest(File file) throws Exception {
        MessageDigest hash = MessageDigest.getInstance("SHA-256"); byte[] buffer = new byte[128 * 1024];
        try (InputStream in = new FileInputStream(file)) { int count; while ((count = in.read(buffer)) != -1) hash.update(buffer, 0, count); }
        StringBuilder result = new StringBuilder(); for (byte value : hash.digest()) result.append(String.format(java.util.Locale.ROOT, "%02x", value & 255)); return result.toString();
    }
    static void prepareFixture(Context context) throws Exception {
        UploadJournal journal = new UploadJournal(context); ControlClient api = new ControlClient(context); String owner = api.owner();
        if (owner.isEmpty()) throw new IllegalStateException("login_required");
        JSONObject existing = journal.read(); if (existing.has("clientUploadId")) {
            if (!existing.getString("ownerId").equals(owner)) throw new IllegalStateException("original_owner_required");
            return;
        }
        File source = new File(context.getNoBackupFilesDir(), "synthetic-source.bin"); byte[] buffer = new byte[128 * 1024]; Arrays.fill(buffer, (byte) 0x5a);
        try (FileOutputStream output = new FileOutputStream(source)) {
            long remaining = SOURCE_BYTES; while (remaining > 0) { int count = (int) Math.min(buffer.length, remaining); output.write(buffer, 0, count); remaining -= count; } output.getFD().sync();
        }
        JSONObject value = new JSONObject().put("schema", "stateaction.upload.spike.v1").put("simulatedSource", true)
                .put("ownerId", owner).put("clientRecordingId", UUID.randomUUID().toString()).put("clientUploadId", UUID.randomUUID().toString())
                .put("sourceName", source.getName()).put("sizeBytes", String.valueOf(source.length())).put("sha256", digest(source))
                .put("sourceModifiedMs", String.valueOf(source.lastModified())).put("transportEpoch", 0).put("state", "ready")
                .put("receipts", new JSONObject()).put("attempts", new JSONObject()).put("metrics", new JSONObject());
        journal.write(value);
    }
    private void check() throws Exception {
        JSONObject state = journal.read();
        if (stopped.get() || state.optString("state").equals("paused")) throw new InterruptedException("paused");
        if (!owner.equals(api.owner()) || !owner.equals(state.optString("ownerId"))) throw new IllegalStateException("original_owner_required");
        if (state.getInt("transportEpoch") != epoch) throw new IllegalStateException("stale_local_epoch");
    }
    private JSONObject epochBody() throws Exception { return new JSONObject().put("expectedTransportEpoch", epoch); }
    private void metric(String name, long amount) throws Exception {
        journal.update(value -> { JSONObject metrics = value.getJSONObject("metrics"); metrics.put(name, metrics.optLong(name) + amount); });
    }
    private void maxMetric(String name, long amount) throws Exception {
        journal.update(value -> { JSONObject metrics = value.getJSONObject("metrics"); metrics.put(name, Math.max(metrics.optLong(name), amount)); });
    }
    private void checkSource(JSONObject value) throws Exception {
        File source = new File(context.getNoBackupFilesDir(), value.getString("sourceName"));
        if (!source.getCanonicalFile().getParentFile().equals(context.getNoBackupFilesDir().getCanonicalFile())) throw new IllegalStateException("source_path_invalid");
        long before = source.lastModified();
        if (source.length() != Long.parseLong(value.getString("sizeBytes")) || before != Long.parseLong(value.getString("sourceModifiedMs")) || !digest(source).equals(value.getString("sha256"))
                || source.lastModified() != before || source.length() != Long.parseLong(value.getString("sizeBytes"))) throw new IllegalStateException("source_mutated");
    }
    String run() throws Exception {
        if (!RUNNING.compareAndSet(false, true)) return "already_running";
        current = this; ExecutorService workers = Executors.newFixedThreadPool(2);
        try {
            JSONObject value = journal.read(); owner = value.getString("ownerId");
            if (!owner.equals(api.owner())) throw new IllegalStateException("original_owner_required");
            if (value.optString("state").equals("paused")) return "paused";
            checkSource(value);
            if (!value.has("fileId")) {
                JSONObject plan = api.request("/api/v1/uploads", new JSONObject().put("clientUploadId", value.getString("clientUploadId"))
                        .put("sizeBytes", value.getString("sizeBytes")).put("sha256", value.getString("sha256")));
                if (!plan.getString("ownerId").equals(owner) || !plan.getString("partSizeBytes").equals(String.valueOf(PART_BYTES))) throw new IllegalStateException("invalid_plan");
                journal.update(j -> { j.put("fileId", plan.getString("fileId")); j.put("transportEpoch", plan.getInt("transportEpoch")); j.put("partCount", plan.getInt("partCount")); });
            }
            value = journal.read(); fileId = value.getString("fileId"); epoch = value.getInt("transportEpoch"); check();
            JSONObject remote = api.request("/api/v1/uploads/" + fileId + "/reconcile", epochBody());
            if (remote.getInt("transportEpoch") != epoch || !remote.getString("sha256").equals(value.getString("sha256"))) throw new IllegalStateException("remote_content_conflict");
            if (remote.getString("state").equals("uploaded")) { journal.state("uploaded", "reconciled_api_completion"); return "uploaded"; }
            JSONArray existing = remote.getJSONArray("parts"); JSONObject receipts = new JSONObject();
            for (int index = 0; index < existing.length(); index++) { JSONObject part = existing.getJSONObject(index); receipts.put(String.valueOf(part.getInt("partNumber")), part); }
            journal.update(j -> j.put("receipts", receipts)); metric("reconciliations", 1);
            // No native tasks from a prior process remain: only now can stale scratch files be removed.
            File[] old = scratch.listFiles(); if (old != null) for (File file : old) if (!file.delete()) throw new IllegalStateException("scratch_cleanup_failed");
            long missingBytes = Long.parseLong(value.getString("sizeBytes"));
            long reserve = Math.min(missingBytes, 3 * PART_BYTES) + 32L * 1024 * 1024;
            if (new StatFs(scratch.getAbsolutePath()).getAvailableBytes() < reserve) throw new IllegalStateException("low_disk");
            journal.state("uploading", "native_transport");
            List<Integer> missing = new ArrayList<>();
            for (int number = 1; number <= value.getInt("partCount"); number++) if (!receipts.has(String.valueOf(number))) missing.add(number);
            Deque<FilePart> ready = new ArrayDeque<>(); CompletionService<JSONObject> completions = new ExecutorCompletionService<>(workers);
            int next = 0, active = 0, completed = receipts.length();
            while (next < missing.size() || !ready.isEmpty() || active > 0) {
                check();
                while (next < missing.size() && ready.size() + active < 3) ready.add(extract(missing.get(next++)));
                while (active < 2 && !ready.isEmpty()) { FilePart part = ready.remove(); completions.submit(() -> upload(part)); active++; maxMetric("maxActivePuts", active); }
                maxMetric("maxTemporaryChunks", ready.size() + active);
                Future<JSONObject> done = completions.poll(500, TimeUnit.MILLISECONDS); if (done == null) continue;
                JSONObject receipt = done.get(); active--; check();
                api.request("/api/v1/uploads/" + fileId + "/parts/receipts", epochBody().put("parts", new JSONArray().put(receipt)));
                journal.update(j -> j.getJSONObject("receipts").put(String.valueOf(receipt.getInt("partNumber")), receipt));
                File chunk = chunk(receipt.getInt("partNumber")); if (!chunk.delete()) throw new IllegalStateException("chunk_cleanup_failed");
                completed++; progress.update("Uploaded " + completed + "/" + value.getInt("partCount") + " parts (local fixture)");
            }
            check(); checkSource(journal.read()); JSONObject result = api.request("/api/v1/uploads/" + fileId + "/complete", epochBody());
            if (!result.getString("state").equals("uploaded")) throw new IllegalStateException("completion_uncertain");
            journal.state("uploaded", "fixture_sha256_verified_not_provider_qualification"); metric("apiCompletions", 1); return "uploaded";
        } catch (Exception error) {
            Throwable cause = error instanceof ExecutionException && error.getCause() != null ? error.getCause() : error;
            String reason = cause instanceof ControlClient.HttpFailure ? cause.getMessage() : cause instanceof IllegalStateException || cause instanceof InterruptedException ? cause.getMessage() : cause.getClass().getSimpleName();
            if (!stopped.get() && !journal.read().optString("state").equals("paused")) journal.state("attention", reason);
            throw new Exception(reason, cause);
        } finally {
            stopped.set(true); for (HttpURLConnection connection : connections) connection.disconnect();
            workers.shutdownNow(); workers.awaitTermination(30, TimeUnit.SECONDS); current = null; RUNNING.set(false);
        }
    }
    private File chunk(int number) { return new File(scratch, epoch + "-" + number + ".chunk"); }
    private static final class FilePart {
        final int number; final long offset; final long length; final File file;
        FilePart(int number, long offset, long length, File file) { this.number = number; this.offset = offset; this.length = length; this.file = file; }
    }
    private FilePart extract(int number) throws Exception {
        check(); JSONObject value = journal.read(); long size = Long.parseLong(value.getString("sizeBytes"));
        long offset = (number - 1) * PART_BYTES, length = Math.min(PART_BYTES, size - offset); File target = chunk(number);
        try (RandomAccessFile source = new RandomAccessFile(new File(context.getNoBackupFilesDir(), value.getString("sourceName")), "r"); FileOutputStream output = new FileOutputStream(target)) {
            source.seek(offset); byte[] buffer = new byte[128 * 1024]; long remaining = length;
            while (remaining > 0) { check(); int count = source.read(buffer, 0, (int) Math.min(buffer.length, remaining)); if (count < 0) throw new IllegalStateException("source_short_read"); output.write(buffer, 0, count); remaining -= count; } output.getFD().sync();
        }
        long bytes = 0; File[] all = scratch.listFiles(); if (all != null) for (File file : all) bytes += file.length(); maxMetric("maxTemporaryBytes", bytes);
        if (bytes > 3 * PART_BYTES) throw new IllegalStateException("scratch_bound_exceeded");
        return new FilePart(number, offset, length, target);
    }
    private JSONObject upload(FilePart part) throws Exception {
        for (int attempt = 1; attempt <= 4; attempt++) {
            check(); int persisted = journal.read().getJSONObject("attempts").optInt(String.valueOf(part.number));
            if (persisted >= 8) throw new IllegalStateException("part_retry_budget_exhausted");
            JSONObject retryTimes = journal.read().optJSONObject("retryAfterMs");
            long notBefore = retryTimes == null ? 0 : Long.parseLong(retryTimes.optString(String.valueOf(part.number), "0"));
            while (System.currentTimeMillis() < notBefore) { check(); Thread.sleep(Math.min(250, notBefore - System.currentTimeMillis())); }
            int total = persisted + 1; long nextAttempt = System.currentTimeMillis() + Math.min(8000, 500L * (1L << (attempt - 1)));
            journal.update(j -> { j.getJSONObject("attempts").put(String.valueOf(part.number), total); JSONObject times = j.optJSONObject("retryAfterMs"); if (times == null) { times = new JSONObject(); j.put("retryAfterMs", times); } times.put(String.valueOf(part.number), String.valueOf(nextAttempt)); });
            JSONObject signed = api.request("/api/v1/uploads/" + fileId + "/parts/sign", epochBody().put("partNumbers", new JSONArray().put(part.number))).getJSONArray("parts").getJSONObject(0);
            if (Long.parseLong(signed.getString("offsetBytes")) != part.offset || Long.parseLong(signed.getString("lengthBytes")) != part.length) throw new IllegalStateException("range_conflict");
            boolean injectDelay;
            synchronized (UploadJournal.LOCK) {
                JSONObject value = journal.read(); injectDelay = !value.optBoolean("expiryInjected");
                if (injectDelay) { value.put("expiryInjected", true); journal.write(value); }
            }
            if (injectDelay) Thread.sleep(2500); // Deliberately expire the fixture's first 2-second URL.
            check(); URL url = new URL(signed.getString("url")); URL control = new URL(api.base);
            if (!url.getProtocol().equals(control.getProtocol()) || !url.getHost().equals(control.getHost()) || url.getPort() != control.getPort()) throw new IllegalStateException("fixture_provider_origin_mismatch");
            HttpURLConnection connection = api.connection(url); connections.add(connection);
            try {
                connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(15000); connection.setReadTimeout(30000);
                connection.setRequestMethod("PUT"); connection.setDoOutput(true); connection.setFixedLengthStreamingMode(part.length);
                // Never forward the control Cookie or Authorization header to a provider URL.
                try (InputStream in = new FileInputStream(part.file); OutputStream out = connection.getOutputStream()) {
                    byte[] buffer = new byte[128 * 1024]; int count; while ((count = in.read(buffer)) != -1) { check(); out.write(buffer, 0, count); }
                }
                int status = connection.getResponseCode();
                if (status == 403 || status == 408 || status == 429 || status >= 500) {
                    metric(status == 403 ? "expiredUrlRenewals" : "providerRetries", 1); Thread.sleep(Math.max(0, nextAttempt - System.currentTimeMillis())); continue;
                }
                if (status != 200) throw new IllegalStateException("provider_http_" + status);
                String etag = connection.getHeaderField("ETag"); if (etag == null || etag.isEmpty()) throw new IllegalStateException("missing_etag");
                return new JSONObject().put("partNumber", part.number).put("etag", etag).put("sizeBytes", String.valueOf(part.length));
            } catch (java.io.IOException networkFailure) {
                // A rejected PUT can fail while writing its body, before getResponseCode().
                // The next iteration obtains a fresh URL; reconciliations cover uncertain accepted PUTs.
                metric("networkRetries", 1);
                Thread.sleep(Math.max(0, nextAttempt - System.currentTimeMillis()));
            } finally { connection.disconnect(); connections.remove(connection); }
        }
        throw new IllegalStateException("part_retry_window_exhausted");
    }
}
