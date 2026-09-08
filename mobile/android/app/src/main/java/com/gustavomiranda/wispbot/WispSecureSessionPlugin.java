package com.gustavomiranda.wispbot;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONObject;

/** Only encrypted session bytes enter app-private preferences; the key cannot leave AndroidKeyStore. */
@CapacitorPlugin(name = "WispSecureSession")
public class WispSecureSessionPlugin extends Plugin {
    private static final String ALIAS = "wisp.remote-session.v1";
    private static final String STORE = "wisp_protected_session";
    private static final byte[] AAD = "wisp.remote-session.v1".getBytes(StandardCharsets.UTF_8);

    private SharedPreferences preferences() { return getContext().getSharedPreferences(STORE, Context.MODE_PRIVATE); }
    private SecretKey key(boolean create) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(ALIAS)) return ((KeyStore.SecretKeyEntry) store.getEntry(ALIAS, null)).getSecretKey();
        if (!create) throw new IllegalStateException("Protected session key is unavailable.");
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256).setRandomizedEncryptionRequired(true).build());
        return generator.generateKey();
    }
    @PluginMethod public void read(PluginCall call) {
        try {
            String saved = preferences().getString("ciphertext", null);
            JSObject result = new JSObject();
            if (saved == null) { result.put("value", JSONObject.NULL); call.resolve(result); return; }
            JSONObject envelope = new JSONObject(saved);
            if (envelope.getInt("version") != 1) throw new IllegalStateException("Unsupported session format.");
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, Base64.decode(envelope.getString("iv"), Base64.NO_WRAP)));
            cipher.updateAAD(AAD);
            result.put("value", new String(cipher.doFinal(Base64.decode(envelope.getString("data"), Base64.NO_WRAP)), StandardCharsets.UTF_8));
            call.resolve(result);
        } catch (Exception error) { call.reject("The protected session could not be read. Clear it and pair again."); }
    }
    @PluginMethod public void write(PluginCall call) {
        String value = call.getString("value");
        if (value == null || value.getBytes(StandardCharsets.UTF_8).length > 16384) { call.reject("Invalid protected session."); return; }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key(true));
            cipher.updateAAD(AAD);
            byte[] encrypted = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            JSONObject envelope = new JSONObject().put("version", 1)
                .put("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
                .put("data", Base64.encodeToString(encrypted, Base64.NO_WRAP));
            if (!preferences().edit().putString("ciphertext", envelope.toString()).commit()) throw new IllegalStateException("Storage unavailable.");
            call.resolve();
        } catch (Exception error) { call.reject("The session could not be saved in protected storage."); }
    }
    @PluginMethod public void clear(PluginCall call) {
        try {
            if (!preferences().edit().clear().commit()) throw new IllegalStateException("Storage unavailable.");
            KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null); store.deleteEntry(ALIAS);
            call.resolve();
        } catch (Exception error) { call.reject("The protected session could not be cleared."); }
    }
}
