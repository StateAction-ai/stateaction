package ai.stateaction.spike.upload;

import android.content.Context;
import org.json.JSONObject;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

/** Native control-plane client; no Dart runtime, provider credentials or provider completion call. */
final class ControlClient {
    static final Object AUTH_LOCK = new Object();
    private static final java.util.concurrent.atomic.AtomicReference<String> VERIFIED_OWNER = new java.util.concurrent.atomic.AtomicReference<>();
    final Context context; final CookieVault vault; final String base; final android.net.Network network;
    static final class HttpFailure extends Exception {
        final int status; final String code;
        HttpFailure(int status, String code) { super("http_" + status + ":" + code); this.status = status; this.code = code; }
    }
    ControlClient(Context context) throws Exception { this(context, null); }
    ControlClient(Context context, android.net.Network network) throws Exception {
        this.context = context.getApplicationContext(); vault = new CookieVault(context);
        this.network = network;
        base = context.getSharedPreferences("spike", 0).getString("baseUrl", "http://127.0.0.1:8787");
        URL parsed = new URL(base);
        if (!parsed.getProtocol().equals("http") || !(parsed.getHost().equals("127.0.0.1") || parsed.getHost().equals("10.0.2.2")))
            throw new IllegalArgumentException("local_fixture_only");
    }
    String owner() throws Exception {
        String owner = VERIFIED_OWNER.get();
        if (owner == null) { VERIFIED_OWNER.compareAndSet(null, vault.read().optString("ownerId", "")); owner = VERIFIED_OWNER.get(); }
        return owner;
    }
    void login(String account) throws Exception {
        synchronized (AUTH_LOCK) {
            request("/spike/login", new JSONObject().put("ownerId", account));
            JSONObject me = request("/api/v1/me", null); JSONObject stored = vault.read(); stored.put("ownerId", me.getString("userId")); vault.write(stored); VERIFIED_OWNER.set(me.getString("userId"));
        }
    }
    void logout() throws Exception {
        synchronized (AUTH_LOCK) { try { request("/spike/logout", new JSONObject()); } finally { vault.clear(); VERIFIED_OWNER.set(""); } }
    }
    JSONObject request(String path, JSONObject body) throws Exception {
        synchronized (AUTH_LOCK) {
            if (!path.startsWith("/") || path.startsWith("//")) throw new IllegalArgumentException("control_path_required");
            JSONObject stored = vault.read(); JSONObject jar = stored.optJSONObject("cookies"); if (jar == null) jar = new JSONObject();
            HttpURLConnection connection = connection(new URL(base + path));
            connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(15000); connection.setReadTimeout(20000);
            connection.setRequestProperty("X-Stera-Client", "android-upload-spike");
            connection.setRequestProperty("Content-Type", "application/json");
            StringBuilder cookies = new StringBuilder();
            for (Iterator<String> names = jar.keys(); names.hasNext();) { String name = names.next(); if (cookies.length() > 0) cookies.append("; "); cookies.append(name).append('=').append(jar.getString(name)); }
            if (cookies.length() > 0) connection.setRequestProperty("Cookie", cookies.toString());
            try {
                if (body != null) { byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8); connection.setRequestMethod(path.endsWith("/parts/receipts") ? "PUT" : "POST"); connection.setDoOutput(true); connection.setFixedLengthStreamingMode(bytes.length); try (java.io.OutputStream out = connection.getOutputStream()) { out.write(bytes); } }
                int status = connection.getResponseCode();
                for (Map.Entry<String, List<String>> header : connection.getHeaderFields().entrySet()) {
                    if (header.getKey() == null || !header.getKey().equalsIgnoreCase("Set-Cookie")) continue;
                    for (String raw : header.getValue()) {
                        String pair = raw.split(";", 2)[0]; int equals = pair.indexOf('='); if (equals <= 0) continue;
                        String name = pair.substring(0, equals), value = pair.substring(equals + 1);
                        if (value.isEmpty() || raw.toLowerCase(java.util.Locale.ROOT).contains("max-age=0")) jar.remove(name); else jar.put(name, value);
                    }
                }
                stored.put("cookies", jar); vault.write(stored);
                InputStream stream = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
                byte[] bytes; if (stream == null) bytes = new byte[0]; else try (InputStream in = stream) { bytes = in.readNBytes(65537); }
                if (bytes.length > 65536) throw new IllegalStateException("control_response_too_large");
                JSONObject response = bytes.length == 0 ? new JSONObject() : new JSONObject(new String(bytes, StandardCharsets.UTF_8));
                if (status < 200 || status >= 300) throw new HttpFailure(status, response.optJSONObject("error") == null ? "control_failed" : response.getJSONObject("error").optString("code", "control_failed"));
                return response;
            } finally { connection.disconnect(); }
        }
    }
    HttpURLConnection connection(URL url) throws Exception { return (HttpURLConnection) (network == null ? url.openConnection() : network.openConnection(url)); }
}
