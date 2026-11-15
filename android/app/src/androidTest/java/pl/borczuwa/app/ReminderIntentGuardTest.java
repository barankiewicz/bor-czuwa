package pl.borczuwa.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.service.notification.StatusBarNotification;
import androidx.test.core.app.ActivityScenario;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/**
 * Sends the real launcher activity the intent shape the local notifications plugin builds for a tap, once
 * forged by another app and once carrying this install's guard, both to a running app (onNewIntent through
 * singleTask) and as the launch intent of a cold start (BridgeActivity.onCreate passes it to onNewIntent).
 */
public class ReminderIntentGuardTest {
    private static final int ID = 424242;
    private final Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    private NotificationManager manager;

    @Before public void postDeliveredReminder() throws Exception {
        InstrumentationRegistry.getInstrumentation().getUiAutomation()
            .executeShellCommand("pm grant " + context.getPackageName() + " android.permission.POST_NOTIFICATIONS").close();
        manager = context.getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel("guard-test", "guard", NotificationManager.IMPORTANCE_LOW));
        manager.notify(ID, new Notification.Builder(context, "guard-test").setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("reminder").build());
        awaitShown(true);
    }

    @After public void clean() { manager.cancel(ID); }

    private boolean shown() {
        for (StatusBarNotification item : manager.getActiveNotifications()) if (item.getId() == ID) return true;
        return false;
    }

    private void awaitShown(boolean wanted) throws Exception {
        for (int attempt = 0; attempt < 40 && shown() != wanted; attempt++) Thread.sleep(100);
    }

    private Intent tap(String extra) {
        Intent intent = new Intent(Intent.ACTION_MAIN);
        intent.setClassName(context.getPackageName(), MainActivity.class.getName());
        intent.addCategory(Intent.CATEGORY_LAUNCHER);
        intent.putExtra("LocalNotificationId", ID);
        intent.putExtra("LocalNotificationUserAction", "tap");
        intent.putExtra("LocalNotficationObject", "{\"id\":" + ID + ",\"extra\":" + extra + "}");
        return intent;
    }

    private void tapRunningApp(Intent intent) throws Exception {
        try (ActivityScenario<MainActivity> ignored = ActivityScenario.launch(MainActivity.class)) {
            Thread.sleep(500);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            context.startActivity(intent);
            Thread.sleep(1500);
        }
    }

    private void tapColdApp(Intent intent) throws Exception {
        try (ActivityScenario<MainActivity> ignored = ActivityScenario.launch(intent)) {
            Thread.sleep(1500);
        }
    }

    private static final String FORGED = "{\"draftReminderDay\":\"2026-11-16\",\"draftIds\":[]}";
    private static final String WRONG = "{\"draftReminderDay\":\"2026-11-16\",\"draftIds\":[],\"guard\":\"0000\"}";

    @Test public void aForgedTapOnARunningAppCannotWithdrawAReminder() throws Exception {
        tapRunningApp(tap(FORGED));
        assertTrue("forged tap without the guard must leave the reminder in the shade", shown());
    }

    @Test public void aForgedLaunchIntentCannotWithdrawAReminder() throws Exception {
        tapColdApp(tap(FORGED));
        assertTrue("forged launch intent without the guard must leave the reminder in the shade", shown());
    }

    @Test public void aWrongGuardIsRefusedOnARunningApp() throws Exception {
        tapRunningApp(tap(WRONG));
        assertTrue("a wrong guard must leave the reminder in the shade", shown());
    }

    @Test public void aWrongGuardIsRefusedOnColdStart() throws Exception {
        tapColdApp(tap(WRONG));
        assertTrue("a wrong guard must leave the reminder in the shade", shown());
    }

    private String own() {
        return "{\"draftReminderDay\":\"2026-11-16\",\"draftIds\":[],\"guard\":\"" + ReminderGuard.nonce(context) + "\"}";
    }

    @Test public void theAppsOwnTapOnARunningAppStillWithdrawsIt() throws Exception {
        tapRunningApp(tap(own()));
        awaitShown(false);
        assertEquals(false, shown());
    }

    @Test public void theAppsOwnTapOnColdStartStillWithdrawsIt() throws Exception {
        tapColdApp(tap(own()));
        awaitShown(false);
        assertEquals(false, shown());
    }
}
