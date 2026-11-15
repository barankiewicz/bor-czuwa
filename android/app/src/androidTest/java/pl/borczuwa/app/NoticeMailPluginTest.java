package pl.borczuwa.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.Process;
import androidx.core.content.FileProvider;
import androidx.test.core.app.ActivityScenario;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.io.FileOutputStream;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.junit.Test;

public class NoticeMailPluginTest {
    private static final String MAIL_APP = "pl.borczuwa.app.test"; // FakeMailActivity: mailto: SENDTO plus image SEND
    private static final String NOT_MAIL = "com.android.settings";
    private final Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();

    private Uri photo(String name) throws Exception {
        File directory = new File(context.getCacheDir(), "notice-mail/test");
        assertTrue(directory.isDirectory() || directory.mkdirs());
        File file = new File(directory, name);
        try (FileOutputStream stream = new FileOutputStream(file)) { stream.write(new byte[] { 1, 2, 3 }); }
        return FileProvider.getUriForFile(context, NoticeMailPlugin.authority(context), file);
    }

    private ArrayList<Uri> photos(int count) throws Exception {
        ArrayList<Uri> uris = new ArrayList<>();
        for (int index = 0; index < count; index++) uris.add(photo("p" + index + ".jpg"));
        return uris;
    }

    private Set<String> packagesOf(Intent intent) {
        Set<String> names = new HashSet<>();
        for (ResolveInfo info : context.getPackageManager().queryIntentActivities(intent, 0)) names.add(info.activityInfo.packageName);
        return names;
    }

    private Set<String> mailApps() { return packagesOf(new Intent(Intent.ACTION_SENDTO, Uri.parse("mailto:"))); }

    private boolean granted(Uri uri, String pkg) throws Exception {
        int uid = context.getPackageManager().getApplicationInfo(pkg, 0).uid;
        return context.checkUriPermission(uri, Process.myPid() + 1, uid, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            == PackageManager.PERMISSION_GRANTED;
    }

    private void assertOnlyMailApps(int count) throws Exception {
        List<Intent> intents = NoticeMailPlugin.buildMailIntents(context, "urzad@example.pl", "Zawiadomienie", "Tresc", photos(count));
        assertFalse(count + " photos: some mail app must take them", intents.isEmpty());
        Set<String> mail = mailApps();
        Set<String> offered = new HashSet<>();
        for (Intent intent : intents) {
            assertNotNull("every intent is explicit to a package", intent.getPackage());
            assertTrue(intent.getPackage() + " handles mailto:", mail.contains(intent.getPackage()));
            offered.add(intent.getPackage());
            assertEquals("Zawiadomienie", intent.getStringExtra(Intent.EXTRA_SUBJECT));
            assertEquals("Tresc", intent.getStringExtra(Intent.EXTRA_TEXT));
            assertEquals("urzad@example.pl", intent.getStringArrayExtra(Intent.EXTRA_EMAIL)[0]);
            if (count == 1) assertEquals(Intent.ACTION_SEND, intent.getAction());
            else assertEquals(Intent.ACTION_SEND_MULTIPLE, intent.getAction());
            if (count == 1) assertNotNull(intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class));
            else assertEquals(count, intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri.class).size());
        }
        assertTrue("the mail app is offered: " + offered, offered.contains(MAIL_APP));
        // Apps that accept shared images but are not mail apps exist on the device and are not offered.
        Intent plain = new Intent(Intent.ACTION_SEND);
        plain.setType("image/jpeg");
        Set<String> imageApps = packagesOf(plain);
        imageApps.removeAll(mail);
        assertFalse("the device has non-mail image apps, so this check can fail", imageApps.isEmpty());
        for (String other : imageApps) assertFalse(other + " is not a mail app", offered.contains(other));
    }

    @Test public void onePhotoGoesToMailAppsOnly() throws Exception { assertOnlyMailApps(1); }
    @Test public void threePhotosGoToMailAppsOnly() throws Exception { assertOnlyMailApps(3); }

    @Test public void aNoticeWithoutPhotosIsOneMailtoIntent() throws Exception {
        List<Intent> intents = NoticeMailPlugin.buildMailIntents(context, "urzad@example.pl", "Zawiadomienie", "Tresc", new ArrayList<>());
        assertEquals(1, intents.size());
        Intent intent = intents.get(0);
        assertEquals(Intent.ACTION_SENDTO, intent.getAction());
        assertEquals("mailto", intent.getData().getScheme());
        assertEquals("Tresc", intent.getStringExtra(Intent.EXTRA_TEXT));
        assertTrue(mailApps().containsAll(packagesOf(intent)));
    }

    private List<Intent> shareAndGrant(Uri uri) throws Exception {
        ArrayList<Uri> one = new ArrayList<>();
        one.add(uri);
        List<Intent> intents = NoticeMailPlugin.buildMailIntents(context, "urzad@example.pl", "s", "b", one);
        NoticeMailPlugin.grantAttachments(context, intents, one);
        assertTrue("the mail app can read the photo after the handoff starts", granted(uri, MAIL_APP));
        assertFalse("an app that is not a mail app cannot", granted(uri, NOT_MAIL));
        return intents;
    }

    @Test public void clearWithdrawsTheGrant() throws Exception {
        Uri uri = photo("clear.jpg");
        shareAndGrant(uri);
        NoticeMailPlugin.clearHandoff(context);
        assertFalse(granted(uri, MAIL_APP));
    }

    @Test public void theNextShareWithdrawsThePreviousGrant() throws Exception {
        Uri uri = photo("next.jpg");
        shareAndGrant(uri);
        NoticeMailPlugin.prepareHandoff(context);
        assertFalse(granted(uri, MAIL_APP));
    }

    @Test public void startingTheAppWithdrawsAGrantLeftByADeadProcess() throws Exception {
        Uri uri = photo("start.jpg");
        shareAndGrant(uri);
        try (ActivityScenario<MainActivity> ignored = ActivityScenario.launch(MainActivity.class)) {
            assertFalse(granted(uri, MAIL_APP));
        }
    }
}
