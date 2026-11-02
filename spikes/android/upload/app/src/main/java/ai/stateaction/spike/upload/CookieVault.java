package ai.stateaction.spike.upload;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import org.json.JSONObject;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;
import java.security.KeyStore;

/** Cookies never enter the upload journal or logs. Synthetic fixture only. */
final class CookieVault {
    private static final String ALIAS = "stateaction.upload.spike.cookies";
    private static final Object IO_LOCK = new Object();
    private final AtomicFile file;
    CookieVault(Context context) { file = new AtomicFile(new File(context.getNoBackupFilesDir(), "cookies.enc")); }
    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (store.containsAlias(ALIAS)) return ((KeyStore.SecretKeyEntry) store.getEntry(ALIAS, null)).getSecretKey();
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }
    JSONObject read() throws Exception { synchronized (IO_LOCK) {
        if (!file.getBaseFile().exists()) return new JSONObject().put("cookies", new JSONObject());
        byte[] bytes = file.readFully(); ByteBuffer buffer = ByteBuffer.wrap(bytes); int count = buffer.getInt();
        if (count != 12 || buffer.remaining() <= count) throw new IllegalStateException("invalid_cookie_store");
        byte[] iv = new byte[count]; buffer.get(iv); byte[] encrypted = new byte[buffer.remaining()]; buffer.get(encrypted);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, iv));
        return new JSONObject(new String(cipher.doFinal(encrypted), java.nio.charset.StandardCharsets.UTF_8));
    } }
    void write(JSONObject value) throws Exception { synchronized (IO_LOCK) {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding"); cipher.init(Cipher.ENCRYPT_MODE, key());
        byte[] encrypted = cipher.doFinal(value.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8)); byte[] iv = cipher.getIV();
        ByteBuffer bytes = ByteBuffer.allocate(4 + iv.length + encrypted.length).putInt(iv.length).put(iv).put(encrypted);
        FileOutputStream output = file.startWrite();
        try { output.write(bytes.array()); file.finishWrite(output); } catch (Exception error) { file.failWrite(output); throw error; }
    } }
    void clear() { synchronized (IO_LOCK) { file.delete(); } }
}
