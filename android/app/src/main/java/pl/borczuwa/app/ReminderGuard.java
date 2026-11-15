package pl.borczuwa.app;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import com.capacitorjs.plugins.localnotifications.LocalNotificationManager;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import org.json.JSONObject;

/**
 * The launcher activity has to be exported, so any app can send it the intent the local notifications plugin
 * builds for a tap and make the plugin withdraw a delivered reminder or report a tap that never happened.
 * Reminders carry a secret that only this install knows, and a tap without it is stripped before the plugin sees it.
 */
final class ReminderGuard {
    // Linked to the plugin's own constants (spelling included), so an upgrade that renames them breaks the build.
    static final String ID = LocalNotificationManager.NOTIFICATION_INTENT_KEY;
    static final String OBJECT = LocalNotificationManager.NOTIFICATION_OBJ_INTENT_KEY;
    static final String ACTION = LocalNotificationManager.ACTION_INTENT_KEY;

    private ReminderGuard() {}

    static String nonce(Context context) {
        SharedPreferences store = context.getSharedPreferences("reminder_guard", Context.MODE_PRIVATE);
        String existing = store.getString("nonce", null);
        if (existing != null) return existing;
        byte[] bytes = new byte[16];
        new SecureRandom().nextBytes(bytes);
        StringBuilder hex = new StringBuilder();
        for (byte value : bytes) hex.append(String.format("%02x", value));
        store.edit().putString("nonce", hex.toString()).commit();
        return hex.toString();
    }

    /** Leaves an intent that is not a notification tap alone; strips the notification from one that lacks the guard. */
    static void admit(Context context, Intent intent) {
        if (intent == null || !intent.hasExtra(ID)) return;
        if (!carriesGuard(intent.getStringExtra(OBJECT), nonce(context))) {
            intent.removeExtra(ID);
            intent.removeExtra(OBJECT);
            intent.removeExtra(ACTION);
        }
    }

    private static boolean carriesGuard(String notification, String nonce) {
        if (notification == null) return false;
        try {
            JSONObject extra = new JSONObject(notification).optJSONObject("extra");
            String given = extra == null ? null : extra.optString("guard", null);
            return given != null && MessageDigest.isEqual(given.getBytes(StandardCharsets.UTF_8), nonce.getBytes(StandardCharsets.UTF_8));
        } catch (Exception malformed) {
            return false;
        }
    }
}
